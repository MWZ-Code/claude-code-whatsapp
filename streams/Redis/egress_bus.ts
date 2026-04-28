// XREADGROUP consumer for the egress stream. Each iteration blocks for
// up to `blockMs`, hands every received message to the user's handler
// along with an `ack` callback that does the XACK on success. ACK is
// the consumer's responsibility — leaving an entry un-ACK'd makes it
// available for XCLAIM by another consumer or the same one after restart.
//
// On Redis errors the loop sleeps and retries. On startup, a missing
// stream/group is auto-created (XGROUP CREATE ... MKSTREAM).

import { createBlockingClient, type RedisLike } from "./client";

export type EgressBusOptions = {
  url: string;
  streamKey: string;
  consumerGroup: string;
  consumerName?: string;
  blockMs?: number;
  batchSize?: number;
};

export type EgressBusMessage = {
  id: string;
  payload: unknown;
};

export type EgressBusHandler = (
  msg: EgressBusMessage,
  ack: () => Promise<void>
) => Promise<void>;

export class EgressBus {
  private readonly url: string;
  private readonly streamKey: string;
  private readonly consumerGroup: string;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly batchSize: number;
  private readonly log: (msg: string) => void;

  private client: RedisLike | null = null;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(opts: EgressBusOptions, log?: (msg: string) => void) {
    this.url = opts.url;
    this.streamKey = opts.streamKey;
    this.consumerGroup = opts.consumerGroup;
    this.consumerName = opts.consumerName ?? `bridge-${process.pid}`;
    this.blockMs = opts.blockMs ?? 5000;
    this.batchSize = opts.batchSize ?? 10;
    this.log = log ?? ((m) => process.stderr.write(`egress bus: ${m}\n`));
  }

  async start(handler: EgressBusHandler): Promise<void> {
    if (this.running) return;
    this.client = await createBlockingClient(this.url);
    await this.ensureGroup();
    this.running = true;
    this.loopPromise = this.runLoop(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      try { await this.loopPromise; } catch {}
      this.loopPromise = null;
    }
    if (this.client) {
      try { await this.client.quit(); } catch {}
      this.client = null;
    }
  }

  private async ensureGroup(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.xGroupCreate(this.streamKey, this.consumerGroup, "$", {
        MKSTREAM: true,
      });
      this.log(`created consumer group "${this.consumerGroup}" on "${this.streamKey}"`);
    } catch (err) {
      const m = (err as Error).message ?? String(err);
      if (!m.includes("BUSYGROUP")) {
        throw err;
      }
    }
  }

  private async runLoop(handler: EgressBusHandler): Promise<void> {
    while (this.running) {
      try {
        await this.iterate(handler);
      } catch (err) {
        this.log(`loop error: ${(err as Error).message ?? err}`);
        // Back off briefly to avoid tight error spin
        await sleep(1000);
      }
    }
  }

  private async iterate(handler: EgressBusHandler): Promise<void> {
    if (!this.client) return;
    const result = await this.client.xReadGroup(
      this.consumerGroup,
      this.consumerName,
      [{ key: this.streamKey, id: ">" }],
      { COUNT: this.batchSize, BLOCK: this.blockMs }
    );
    if (!result) return;

    for (const stream of result) {
      for (const entry of stream.messages) {
        const id = entry.id;
        const raw = entry.message?.payload;
        let parsed: unknown = null;
        try {
          parsed = raw ? JSON.parse(raw) : entry.message;
        } catch (err) {
          this.log(`parse error for id=${id}: ${(err as Error).message} — ACKing to skip`);
          await this.ack(id);
          continue;
        }

        const ack = async () => this.ack(id);
        try {
          await handler({ id, payload: parsed }, ack);
        } catch (err) {
          // Handler is expected to ack on its own success path; if it
          // throws the entry stays un-ACK'd so a retry / sibling worker
          // can pick it up via XCLAIM.
          this.log(`handler threw for id=${id}: ${(err as Error).message ?? err} — leaving un-ACK'd`);
        }
      }
    }
  }

  private async ack(id: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.xAck(this.streamKey, this.consumerGroup, id);
    } catch (err) {
      this.log(`ack error for id=${id}: ${(err as Error).message ?? err}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
