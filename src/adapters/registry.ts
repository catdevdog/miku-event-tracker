import type { AdapterRegistry } from './types.js';

/**
 * 구현된 어댑터 목록. 3단계부터 채운다.
 * 여기에 없는 어댑터의 소스는 실행 때 job_runs에 'skipped'로만 남는다.
 */
export const adapters: AdapterRegistry = {};
