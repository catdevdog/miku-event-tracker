import cron, { type ScheduledTask } from 'node-cron';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { llmCalls, rawItems, sources } from '../db/schema.js';
import type { Alerter } from '../alerts.js';
import { acquireLock, releaseLock } from '../scheduler/lock.js';
import { judgeKeywords, loadKeywordSet } from './keywordFilter.js';
import {
  CONFIDENCE_THRESHOLD,
  LlmConfigError,
  PRIMARY_MODEL,
  REVIEW_MODEL,
  TransientLlmError,
  costUsd,
  type ExtractCall,
  type Extractor,
} from './extract.js';
import { mergeExtraction, sweepStatuses } from './merge.js';
import { purgeExpiredItems } from './purge.js';
import { fetchPageText, naverReadableUrl } from './pageText.js';
import { planForChange } from '../notify/planner.js';
import { planReminders } from '../notify/reminders.js';
import { sendQueued, type DmSender } from '../notify/sender.js';
import type { Notifier } from '../notify/notifier.js';

/** 본문이 이보다 짧으면(링크 텍스트·잘린 RSS 설명) 원문 페이지를 가져와 LLM에 넘긴다. */
const SHORT_BODY = 500;

/**
 * 짧은 항목이 키워드에서 떨어지면 원문 페이지 전체로 한 번 더 판정하는 어댑터.
 * 행사 이름에는 미쿠가 없고 출연진·타임테이블에만 있는 경우를 잡기 위해서다
 * (예: '원더리벳 2026' 라인업의 'TAK with 하츠네 미쿠 & 카사네 테토' 무대).
 * x_crawl(트윗 주소는 본문을 못 가져옴), kopis(상세 API로 따로 처리), naver(규칙 9)는 뺀다.
 */
const PAGE_RECHECK_ADAPTERS = new Set(['html_diff', 'rss', 'ticket']);

/** 네이버 검색 결과의 원문 페이지가 이보다 짧으면 본문을 못 가져온 것으로 본다 */
const NAVER_MIN_PAGE = 200;

export interface PipelineDeps {
  db: Db;
  /** ANTHROPIC_API_KEY가 없으면 undefined: 키워드 판정까지만 하고 원문은 pending으로 남긴다 */
  extractor?: Extractor;
  alerter: Alerter;
  fetchPage?: (url: string) => Promise<string>;
  now?: () => Date;
  batchSize?: number;
}

export interface ProcessResult {
  skipped: number;
  irrelevant: number;
  merged: number;
  queued: number;
  errors: number;
  /** API 일시 장애로 멈췄으면 true (남은 원문은 다음 틱에) */
  paused: boolean;
}

/**
 * pending 원문 처리: 키워드 판정 → (필요하면 원문 페이지) → Claude 추출(낮으면 Sonnet 재판정) → 병합·상태 → 알림 큐
 */
export async function processPendingItems(deps: PipelineDeps): Promise<ProcessResult> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchPageText(u));
  const result: ProcessResult = { skipped: 0, irrelevant: 0, merged: 0, queued: 0, errors: 0, paused: false };
  const keywords = await loadKeywordSet(db);

  const rows = await db
    .select({ item: rawItems, source: sources })
    .from(rawItems)
    .innerJoin(sources, eq(sources.id, rawItems.sourceId))
    .where(eq(rawItems.llmStatus, 'pending'))
    .orderBy(asc(rawItems.id))
    .limit(deps.batchSize ?? 20);

  for (const { item, source } of rows) {
    const config = JSON.parse(source.config) as { implicit_context?: boolean };
    const implicitContext = config.implicit_context ?? (source.adapter === 'kopis' || source.adapter === 'ticket');
    let verdict = judgeKeywords(`${item.title ?? ''}\n${item.body ?? ''}`, keywords, { implicitContext });
    let pageBody: string | undefined;
    // 본문 비교·JSON 모드 항목은 출처 페이지 자체를 가리키므로 다시 가져와도 새 내용이 없다
    if (!verdict.pass && item.url && item.url !== source.target && (item.body ?? '').length < SHORT_BODY && PAGE_RECHECK_ADAPTERS.has(source.adapter)) {
      const page = await fetchPage(item.url).catch(() => undefined);
      if (page) {
        const recheck = judgeKeywords(`${item.title ?? ''}\n${page}`, keywords, { implicitContext });
        if (recheck.pass) {
          verdict = recheck;
          pageBody = page;
        }
      }
    }
    if (!verdict.pass) {
      await db.update(rawItems).set({ keywordHit: verdict.hit, llmStatus: 'skipped' }).where(eq(rawItems.id, item.id));
      result.skipped++;
      continue;
    }
    await db.update(rawItems).set({ keywordHit: verdict.hit }).where(eq(rawItems.id, item.id));
    if (!deps.extractor) continue; // 키가 생기면 다음 틱에 처리

    try {
      // LLM 입력 본문. 네이버 검색 결과는 약관상 LLM에 넣지 않고 원문 페이지를 다시 가져온다 (규칙 9).
      let body = pageBody ?? item.body ?? '';
      if (pageBody !== undefined) {
        // 키워드 재판정에서 이미 원문 페이지를 가져왔다
      } else if (source.adapter === 'naver') {
        if (!item.url) throw new SkipItem();
        body = await fetchPage(naverReadableUrl(item.url)).catch(() => {
          throw new SkipItem(); // 회원 전용 카페 글 등
        });
        // 본문을 못 가져온 경우(회원 전용 카페 글은 제목·메뉴만 옴)는 LLM을 건너뛴다 (docs/naver.md 4)
        if (body.length < NAVER_MIN_PAGE) throw new SkipItem();
      } else if (item.url && body.length < SHORT_BODY && (source.adapter === 'html_diff' || source.adapter === 'rss')) {
        body = await fetchPage(item.url).catch(() => body);
      }

      const input = {
        sourceName: source.name,
        sourceLayer: source.layer,
        url: item.url,
        publishedAt: item.publishedAt,
        title: source.adapter === 'naver' ? null : item.title,
        body,
        now: now(),
      };
      const logCall = async (c: ExtractCall) => {
        await db.insert(llmCalls).values({
          rawItemId: item.id,
          model: c.model,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          costUsd: costUsd(c.model, c.inputTokens, c.outputTokens),
          createdAt: now().toISOString(),
        });
      };

      let call = await deps.extractor.extract(input, PRIMARY_MODEL);
      await logCall(call);
      if (call.result.confidence < CONFIDENCE_THRESHOLD) {
        call = await deps.extractor.extract(input, REVIEW_MODEL); // 규칙 4
        await logCall(call);
      }
      const ext = call.result;
      if (!ext.is_relevant) {
        await db.update(rawItems).set({ llmStatus: 'done' }).where(eq(rawItems.id, item.id));
        result.irrelevant++;
        continue;
      }
      const merged = await mergeExtraction(db, ext, {
        rawItemId: item.id,
        model: call.model,
        needsReview: ext.confidence < CONFIDENCE_THRESHOLD,
        fromKopis: source.adapter === 'kopis',
        now: now(),
      });
      result.queued += await planForChange(db, merged.event, merged);
      await db.update(rawItems).set({ llmStatus: 'done' }).where(eq(rawItems.id, item.id));
      result.merged++;
    } catch (err) {
      if (err instanceof SkipItem) {
        await db.update(rawItems).set({ llmStatus: 'skipped' }).where(eq(rawItems.id, item.id));
        result.skipped++;
        continue;
      }
      if (err instanceof TransientLlmError) {
        result.paused = true; // 남은 원문은 pending 그대로
        break;
      }
      if (err instanceof LlmConfigError) {
        result.paused = true; // 키·요청 형식 문제: 원문은 그대로 두고 한 번 알린다 (같은 문구는 30분간 중복 억제)
        await deps.alerter.alert(`추출 중단: ${err.message}`);
        break;
      }
      await db.update(rawItems).set({ llmStatus: 'error' }).where(eq(rawItems.id, item.id));
      result.errors++;
      await deps.alerter.alert(`추출 실패 (raw_item ${item.id}, ${source.name}): ${err instanceof Error ? err.message : String(err)}`.slice(0, 1500));
    }
  }
  return result;
}

class SkipItem extends Error {}

export interface PipelineRunnerDeps extends PipelineDeps {
  notifier: Notifier;
  /** true면 알림을 큐에만 쌓고 보내지 않는다 */
  notifyPaused?: boolean;
  noticeChannelId?: string;
  bot?: () => DmSender | undefined;
}

/** 1분마다: 원문 처리 → 시간 경과 상태 전이 → 리마인더 → 알림 발송 */
export function createPipelineRunner(deps: PipelineRunnerDeps) {
  const owner = `pipeline-${randomUUID()}`;
  const now = deps.now ?? (() => new Date());
  let task: ScheduledTask | undefined;
  let running = false;

  async function tick() {
    if (!(await acquireLock(deps.db, 'pipeline', owner, 15, now()))) return null;
    try {
      // 하루 1회: 보관 기한(purge_after)이 지난 원문 삭제 (네이버 검색 결과, 규칙 9). 락을 풀지 않아 24시간에 한 번만 돈다.
      if (await acquireLock(deps.db, 'purge_daily', owner, 24 * 60, now())) {
        const purged = await purgeExpiredItems(deps.db, now());
        if (purged > 0) console.log(`보관 기한이 지난 원문 ${purged}건 삭제`);
      }
      const processed = await processPendingItems(deps);
      let queued = processed.queued;
      for (const { event } of await sweepStatuses(deps.db, now())) {
        queued += await planForChange(deps.db, event, { created: false, statusChanged: true });
      }
      queued += await planReminders(deps.db, now());
      const sent = deps.notifyPaused
        ? { sent: 0, failed: 0 }
        : await sendQueued({ db: deps.db, notifier: deps.notifier, noticeChannelId: deps.noticeChannelId, bot: deps.bot?.(), now });
      return { processed, queued, sent };
    } finally {
      await releaseLock(deps.db, 'pipeline', owner);
    }
  }

  return {
    tick,
    start() {
      task = cron.schedule('* * * * *', async () => {
        if (running) return;
        running = true;
        try {
          await tick();
        } catch (err) {
          await deps.alerter.alert(`파이프라인 실패: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          running = false;
        }
      });
    },
    async stop() {
      await task?.stop();
    },
  };
}
