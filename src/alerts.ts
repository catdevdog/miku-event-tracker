/** 관리자 경보. 2단계에서 디스코드 관리자 채널 구현으로 바꾼다. */
export interface Alerter {
  alert(message: string): Promise<void>;
}

export const consoleAlerter: Alerter = {
  async alert(message) {
    console.warn(`[관리자 경보] ${message}`);
  },
};
