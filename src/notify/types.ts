/** 디스코드로 보내는 메시지. embeds는 디스코드 API의 embed 객체 그대로. */
export interface OutgoingMessage {
  content?: string;
  embeds?: Record<string, unknown>[];
}

/** 봇 채널 발송 추상화. 테스트에서는 가짜로 바꾼다. */
export interface ChannelSender {
  isReady(): boolean;
  send(channelId: string, message: OutgoingMessage): Promise<void>;
}

export interface NoticeSender {
  send(message: OutgoingMessage): Promise<void>;
}
