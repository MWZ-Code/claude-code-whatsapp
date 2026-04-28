// Abstract base for the channel "server" — the thing that knows how to
// receive accepted messages from Baileys and send messages back out. The
// concrete implementation in app.cjs wraps the existing Baileys logic;
// keeping the surface abstract here lets the egress consumer and any
// future channel orchestration depend on the contract, not Baileys.

export type AcceptedMessage = {
  channel: "whatsapp";
  id: string;
  jid: string;
  participant: string | null;
  from: string;
  text: string;
  ts: number;
  arrivedAt: number;
  hasMedia: boolean;
  mediaType: string | null;
  key: { remoteJid: string; fromMe: boolean; id: string };
};

export type SendReplyPayload = {
  op: "reply";
  chat_id: string;
  text?: string;
  files?: string[];
  reply_to?: string;
  edit?: string;
  send_as_document?: boolean;
  agent_message?: boolean;
};

export type SendReactPayload = {
  op: "react";
  chat_id: string;
  message_id: string;
  emoji: string;
};

export type SendPayload = SendReplyPayload | SendReactPayload;

export type SendResult = { sent_id: string | null } | { edited_id: string } | { reacted: true };

export type ServerStatus = {
  connected: boolean;
  last_inbound_at: number | null;
  retry_count: number;
  watchdog_age_ms: number | null;
};

export type AcceptedHandler = (msg: AcceptedMessage) => void | Promise<void>;

export abstract class WhatsAppServer {
  abstract onAcceptedMessage(handler: AcceptedHandler): void;
  abstract send(payload: SendPayload): Promise<SendResult>;
  abstract isReady(): boolean;
  abstract status(): ServerStatus;
}
