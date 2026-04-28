// Egress consumer base — receives normalised egress messages (from any
// transport, e.g. Redis Streams) and pushes them through the existing
// channel send path. The bus owns transport details; this class owns
// idempotency, middleware filtering, and transient-failure retry.
//
// Failure modes:
//   - middleware rejection      → log + ACK (silent-fail; no producer feedback in v1)
//   - send throws (transient)   → leave un-ACK'd, queue for in-memory retry
//   - retry attempts exhausted  → drop + log + ACK; bump dropped counter
//
// Subclass and override `scheduleRetry` to replace the in-memory queue
// with a state-machine / persistent retry implementation.

import type { SendPayload, SendResult } from "./server";
import type { EgressResult } from "./middleware";

export type EgressMessage = {
  channel: "whatsapp";
  op: "reply" | "react";
  chat_id: string;
  text?: string;
  files?: string[];
  reply_to?: string;
  message_id?: string;
  emoji?: string;
  request_id: string;
  producer_id: string;
};

export type AckFn = () => Promise<void>;

export type EgressConsumerOptions = {
  send: (payload: SendPayload) => Promise<SendResult>;
  middleware: (m: EgressMessage) => EgressResult;
  idempotencyLruSize?: number;
  maxAttempts?: number;
  queueMaxPerChat?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  log?: (msg: string) => void;
};

type RetryEntry = {
  payload: EgressMessage;
  attempt: number;
  ack: AckFn;
  timer: NodeJS.Timeout;
};

export class EgressConsumerBase {
  protected readonly send: (payload: SendPayload) => Promise<SendResult>;
  protected readonly middleware: (m: EgressMessage) => EgressResult;
  protected readonly idempotencyLruSize: number;
  protected readonly maxAttempts: number;
  protected readonly queueMaxPerChat: number;
  protected readonly retryBaseMs: number;
  protected readonly retryMaxMs: number;
  protected readonly log: (msg: string) => void;

  // request_id -> last seen timestamp (LRU via insertion-order Map)
  private readonly seen = new Map<string, number>();
  // chat_id -> array of pending retry entries
  private readonly retryQueue = new Map<string, RetryEntry[]>();

  // Counters for diagnostics
  public droppedRetryExhausted = 0;
  public droppedMiddleware = 0;
  public droppedDuplicate = 0;
  public droppedQueueFull = 0;

  constructor(opts: EgressConsumerOptions) {
    this.send = opts.send;
    this.middleware = opts.middleware;
    this.idempotencyLruSize = opts.idempotencyLruSize ?? 30;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.queueMaxPerChat = opts.queueMaxPerChat ?? 100;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    this.retryMaxMs = opts.retryMaxMs ?? 30000;
    this.log = opts.log ?? ((m) => process.stderr.write(`egress consumer: ${m}\n`));
  }

  /**
   * Entry point called by the transport for every received message.
   * Must not throw — handles its own failures and ACK lifecycle.
   */
  async dispatch(payload: EgressMessage, ack: AckFn): Promise<void> {
    if (!payload.request_id) {
      this.log(`drop: missing request_id (producer=${payload.producer_id})`);
      await this.safeAck(ack);
      return;
    }

    if (this.seen.has(payload.request_id)) {
      this.droppedDuplicate++;
      this.log(`drop: duplicate request_id ${payload.request_id}`);
      await this.safeAck(ack);
      return;
    }
    this.markSeen(payload.request_id);

    const check = this.middleware(payload);
    if (!check.ok) {
      this.droppedMiddleware++;
      this.log(`drop: middleware rejected request_id=${payload.request_id} reason="${check.reason}"`);
      await this.safeAck(ack);
      return;
    }

    await this.tryDispatch(payload, ack, 1);
  }

  private async tryDispatch(payload: EgressMessage, ack: AckFn, attempt: number): Promise<void> {
    const sendPayload = this.toSendPayload(payload);
    try {
      await this.send(sendPayload);
      await this.safeAck(ack);
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      if (attempt >= this.maxAttempts) {
        this.droppedRetryExhausted++;
        this.log(
          `drop: send failed after ${attempt} attempts request_id=${payload.request_id} err="${errMsg}"`
        );
        await this.safeAck(ack);
        return;
      }
      const queued = this.scheduleRetry(payload, attempt + 1, ack);
      if (!queued) {
        this.droppedQueueFull++;
        this.log(
          `drop: retry queue full for chat=${payload.chat_id} request_id=${payload.request_id}`
        );
        await this.safeAck(ack);
      } else {
        this.log(
          `retry: scheduled attempt=${attempt + 1} request_id=${payload.request_id} err="${errMsg}"`
        );
      }
    }
  }

  /**
   * Default in-memory retry strategy. Returns true if scheduled, false if
   * the per-chat queue is full. Subclasses can override to implement a
   * state-machine / persistent retry.
   */
  protected scheduleRetry(payload: EgressMessage, attempt: number, ack: AckFn): boolean {
    const list = this.retryQueue.get(payload.chat_id) ?? [];
    if (list.length >= this.queueMaxPerChat) return false;

    const delayMs = Math.min(this.retryBaseMs * Math.pow(2, attempt - 2), this.retryMaxMs);
    const entry: RetryEntry = {
      payload,
      attempt,
      ack,
      timer: setTimeout(() => {
        const arr = this.retryQueue.get(payload.chat_id);
        if (arr) {
          const idx = arr.indexOf(entry);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this.retryQueue.delete(payload.chat_id);
        }
        this.tryDispatch(payload, ack, attempt).catch((err) => {
          this.log(`retry handler error: ${err}`);
        });
      }, delayMs),
    };
    list.push(entry);
    this.retryQueue.set(payload.chat_id, list);
    return true;
  }

  protected toSendPayload(m: EgressMessage): SendPayload {
    if (m.op === "reply") {
      return {
        op: "reply",
        chat_id: m.chat_id,
        ...(m.text !== undefined ? { text: m.text } : {}),
        ...(m.files ? { files: m.files } : {}),
        ...(m.reply_to ? { reply_to: m.reply_to } : {}),
      };
    }
    return {
      op: "react",
      chat_id: m.chat_id,
      message_id: m.message_id ?? "",
      emoji: m.emoji ?? "",
    };
  }

  private markSeen(id: string): void {
    this.seen.set(id, Date.now());
    while (this.seen.size > this.idempotencyLruSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private async safeAck(ack: AckFn): Promise<void> {
    try {
      await ack();
    } catch (err) {
      this.log(`ack failed: ${err}`);
    }
  }

  /** For shutdown: cancel all pending retry timers. */
  shutdown(): void {
    for (const list of this.retryQueue.values()) {
      for (const e of list) clearTimeout(e.timer);
    }
    this.retryQueue.clear();
  }
}
