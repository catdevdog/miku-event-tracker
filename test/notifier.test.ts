import { describe, expect, it, vi } from 'vitest';
import { createNotifier, dedupAlerter } from '../src/notify/notifier.js';
import type { ChannelSender, NoticeSender } from '../src/notify/types.js';
import type { Alerter } from '../src/alerts.js';

const quietLog = { warn: vi.fn(), error: vi.fn() };

function fakeBot(ready = true, fail = false): ChannelSender & { sent: { channelId: string; content?: string }[] } {
  const sent: { channelId: string; content?: string }[] = [];
  return {
    sent,
    isReady: () => ready,
    send: async (channelId, m) => {
      if (fail) throw new Error('Missing Access');
      sent.push({ channelId, content: m.content });
    },
  };
}
const fakeWebhook = (): NoticeSender & { sent: string[] } => {
  const sent: string[] = [];
  return { sent, send: async (m) => void sent.push(m.content ?? '') };
};

describe('공지 발송', () => {
  it('봇이 준비돼 있으면 봇으로 공지 채널에 보낸다', async () => {
    const bot = fakeBot();
    const webhook = fakeWebhook();
    const n = createNotifier({ bot, noticeChannelId: '1', adminChannelId: '2', webhook, log: quietLog });
    expect(await n.sendNotice({ content: '새 행사' })).toBe('bot');
    expect(bot.sent).toEqual([{ channelId: '1', content: '새 행사' }]);
    expect(webhook.sent).toEqual([]);
  });

  it('봇이 준비 전이거나 발송에 실패하면 웹후크로 보낸다', async () => {
    const webhook = fakeWebhook();
    expect(await createNotifier({ bot: fakeBot(false), noticeChannelId: '1', webhook, log: quietLog }).sendNotice({ content: 'a' })).toBe('webhook');
    expect(await createNotifier({ bot: fakeBot(true, true), noticeChannelId: '1', webhook, log: quietLog }).sendNotice({ content: 'b' })).toBe('webhook');
    expect(webhook.sent).toEqual(['a', 'b']);
  });

  it('보낼 수단이 없으면 오류를 던진다 (실패를 삼키지 않음)', async () => {
    await expect(createNotifier({ log: quietLog }).sendNotice({ content: 'x' })).rejects.toThrow(/보낼 수단/);
    await expect(
      createNotifier({ bot: fakeBot(true, true), noticeChannelId: '1', log: quietLog }).sendNotice({ content: 'x' }),
    ).rejects.toThrow(/Missing Access/);
  });

  it('봇이 나중에 준비돼도 반영된다', async () => {
    const deps: { bot?: ChannelSender } = {};
    const n = createNotifier({ get bot() { return deps.bot; }, noticeChannelId: '1', log: quietLog });
    await expect(n.sendNotice({ content: 'x' })).rejects.toThrow();
    deps.bot = fakeBot();
    expect(await n.sendNotice({ content: 'x' })).toBe('bot');
  });
});

describe('관리자 경보', () => {
  it('관리자 채널로만 보내고 웹후크(공지 채널)는 쓰지 않는다', async () => {
    const bot = fakeBot();
    const webhook = fakeWebhook();
    await createNotifier({ bot, noticeChannelId: '1', adminChannelId: '2', webhook, log: quietLog }).alerter.alert('수집 실패');
    expect(bot.sent).toEqual([{ channelId: '2', content: '⚠️ 수집 실패' }]);
    expect(webhook.sent).toEqual([]);
  });

  it('봇이 없으면 콘솔에 남긴다', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const webhook = fakeWebhook();
    await createNotifier({ webhook, log }).alerter.alert('수집 실패');
    expect(log.warn).toHaveBeenCalledWith('[관리자 경보] 수집 실패');
    expect(webhook.sent).toEqual([]);
  });

  it('2000자를 넘으면 자른다', async () => {
    const bot = fakeBot();
    await createNotifier({ bot, adminChannelId: '2', log: quietLog }).alerter.alert('가'.repeat(3000));
    expect(bot.sent[0]!.content!.length).toBe(2000);
  });

  it('같은 경보는 30분 안에 다시 보내지 않는다', async () => {
    const sent: string[] = [];
    const inner: Alerter = { alert: async (m) => void sent.push(m) };
    let now = new Date('2026-11-22T00:00:00Z');
    const a = dedupAlerter(inner, 30, () => now);
    await a.alert('DB 오류');
    await a.alert('DB 오류');
    await a.alert('다른 오류');
    now = new Date('2026-11-22T00:30:00Z');
    await a.alert('DB 오류');
    expect(sent).toEqual(['DB 오류', '다른 오류', 'DB 오류']);
  });
});
