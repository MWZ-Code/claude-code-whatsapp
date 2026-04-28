// Generic Redis Streams `XADD` wrapper. Channel-agnostic: the caller
// supplies the stream key and a serialisable envelope; the publisher
// stringifies it to a single `payload` field for compactness.
//
// Failure semantics: never throw into the hot path. If Redis is down or
// connecting, drop the message and bump a counter. The bridge keeps
// running; downstream consumers will lose those entries, which is the
// explicit trade-off for "subscribers must not block WhatsApp event
// processing".

import { getSharedClient } from "./client";

export type RawPublisherOptions = {
  url: string;
  streamKey: string;
  maxLen?: number;          // approximate cap via MAXLEN ~
};

export class RawPublisher<T extends object = object> {
  private readonly url: string;
  private readonly streamKey: string;
  private readonly maxLen: number;
  private readonly log: (msg: string) => void;

  public droppedNoConnection = 0;
  public droppedError = 0;
  public published = 0;

  constructor(opts: RawPublisherOptions, log?: (msg: string) => void) {
    this.url = opts.url;
    this.streamKey = opts.streamKey;
    this.maxLen = opts.maxLen ?? 10000;
    this.log = log ?? ((m) => process.stderr.write(`raw publisher: ${m}\n`));
  }

  /**
   * Fire-and-forget publish. Returns a promise so callers can await if
   * they want, but never rejects — failures are swallowed and counted.
   */
  async publish(envelope: T): Promise<void> {
    let client;
    try {
      client = await getSharedClient(this.url);
    } catch (err) {
      this.droppedNoConnection++;
      if (this.droppedNoConnection % 50 === 1) {
        this.log(`dropped (no connection): ${(err as Error).message} — total ${this.droppedNoConnection}`);
      }
      return;
    }

    if (!client.isOpen) {
      this.droppedNoConnection++;
      if (this.droppedNoConnection % 50 === 1) {
        this.log(`dropped (client not open) — total ${this.droppedNoConnection}`);
      }
      return;
    }

    try {
      await client.xAdd(
        this.streamKey,
        "*",
        { payload: JSON.stringify(envelope) },
        { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.maxLen } }
      );
      this.published++;
    } catch (err) {
      this.droppedError++;
      if (this.droppedError % 50 === 1) {
        this.log(`dropped (xadd error): ${(err as Error).message} — total ${this.droppedError}`);
      }
    }
  }

  stats(): { published: number; droppedNoConnection: number; droppedError: number } {
    return {
      published: this.published,
      droppedNoConnection: this.droppedNoConnection,
      droppedError: this.droppedError,
    };
  }
}
