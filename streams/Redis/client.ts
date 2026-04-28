// Shared Redis connection helpers. The `redis` npm package handles
// reconnect/backoff internally — we just configure a sensible policy and
// expose two factory functions:
//
//   getSharedClient(url)     — one process-wide client for non-blocking
//                              ops (XADD, etc). Lazily connected.
//   createBlockingClient(url)— dedicated client for blocking consumers
//                              (XREADGROUP). Each consumer owns its own.
//
// Connection failures are non-fatal: callers must handle the rejected
// promise / `error` event and decide whether to drop or queue. This
// module never throws on failure paths into the WhatsApp hot loop.

import { createClient, RedisClientType } from "redis";

export type RedisLike = RedisClientType<any, any, any>;

let sharedClient: RedisLike | null = null;
let sharedConnectPromise: Promise<RedisLike> | null = null;
let sharedUrl: string | null = null;

function buildClient(url: string): RedisLike {
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => {
        // exponential backoff capped at 30s, with light jitter
        const base = Math.min(2000 * Math.pow(1.8, retries), 30000);
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        return Math.max(250, Math.round(base + jitter));
      },
    },
  }) as RedisLike;

  client.on("error", (err) => {
    process.stderr.write(`redis client: ${err}\n`);
  });

  return client;
}

export async function getSharedClient(url: string): Promise<RedisLike> {
  if (sharedClient && sharedClient.isOpen) return sharedClient;
  if (sharedConnectPromise) return sharedConnectPromise;

  sharedUrl = url;
  const c = buildClient(url);
  sharedConnectPromise = c.connect().then(() => {
    sharedClient = c;
    sharedConnectPromise = null;
    return c;
  }).catch((err) => {
    sharedConnectPromise = null;
    throw err;
  });
  return sharedConnectPromise;
}

export async function createBlockingClient(url: string): Promise<RedisLike> {
  const c = buildClient(url);
  await c.connect();
  return c;
}

export async function shutdownShared(): Promise<void> {
  if (sharedClient) {
    try { await sharedClient.quit(); } catch {}
    sharedClient = null;
    sharedUrl = null;
  }
}

export function isSharedConnected(): boolean {
  return !!sharedClient && sharedClient.isOpen;
}
