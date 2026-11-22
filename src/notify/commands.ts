import { SlashCommandBuilder } from 'discord.js';
import type { ServiceStatus } from '../services/status.js';
import { formatKst } from './format.js';

/** 길드 슬래시 명령 정의. 길드 단위로 등록하면 바로 반영된다. */
export const commandDefinitions = [
  new SlashCommandBuilder().setName('ping').setDescription('봇과 수집기 상태를 확인합니다').toJSON(),
];

export interface PingInfo {
  status: ServiceStatus;
  wsPingMs: number;
  uptimeSec: number;
}

export function buildPingReply({ status, wsPingMs, uptimeSec }: PingInfo): string {
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const lines = [
    `pong · 게이트웨이 ${wsPingMs >= 0 ? `${wsPingMs}ms` : '측정 전'} · 가동 ${h}시간 ${m}분`,
    `소스 ${status.sourcesEnabled}/${status.sourcesTotal}개 활성 · 마지막 수집 ${formatKst(status.lastJobRunAt)}`,
  ];
  if (status.failingSources.length > 0) lines.push(`연속 실패: ${status.failingSources.join(', ')}`);
  return lines.join('\n');
}
