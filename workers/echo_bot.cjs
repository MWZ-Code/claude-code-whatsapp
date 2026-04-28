#!/usr/bin/env node
/**
 * echo_bot — success-criterion worker for the Redis Streams subscriber
 * design. Reads accepted inbound messages from `whatsapp:raw`, builds an
 * echo reply, publishes it to `whatsapp:egress`, then ACKs the raw entry.
 *
 * Speaks only Redis — no channel imports. Run as a separate process:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 node workers/echo_bot.cjs
 *
 * Self-loop guard: relies on the bridge's `_sentSet` filter (in app.cjs)
 * to drop the echo's own `messages.upsert` event before it ever reaches
 * `whatsapp:raw`. If you see echos echo-ing each other, that filter is
 * broken — fix it there, not here.
 */

const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const RAW_STREAM = process.env.RAW_STREAM || "whatsapp:raw";
const EGRESS_STREAM = process.env.EGRESS_STREAM || "whatsapp:egress";
const CONSUMER_GROUP = process.env.CONSUMER_GROUP || "echo-bot";
const CONSUMER_NAME = process.env.CONSUMER_NAME || `echo-bot-${process.pid}`;
const BLOCK_MS = parseInt(process.env.BLOCK_MS || "5000", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "10", 10);

function log(msg) {
  process.stderr.write(`echo_bot: ${msg}\n`);
}

async function ensureGroup(client) {
  try {
    await client.xGroupCreate(RAW_STREAM, CONSUMER_GROUP, "$", { MKSTREAM: true });
    log(`created consumer group "${CONSUMER_GROUP}" on "${RAW_STREAM}"`);
  } catch (err) {
    if (!String(err.message).includes("BUSYGROUP")) throw err;
  }
}

function buildEcho(envelope) {
  return {
    channel: "whatsapp",
    op: "reply",
    chat_id: envelope.jid,
    text: `echo: ${envelope.text || ""}`,
    request_id: `echo-${envelope.id}`,
    producer_id: "echo_bot_v1",
  };
}

let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

async function main() {
  const reader = createClient({ url: REDIS_URL });
  const writer = createClient({ url: REDIS_URL });
  reader.on("error", (e) => log(`reader error: ${e}`));
  writer.on("error", (e) => log(`writer error: ${e}`));

  await reader.connect();
  await writer.connect();
  await ensureGroup(reader);

  log(`consuming raw=${RAW_STREAM} → egress=${EGRESS_STREAM} as ${CONSUMER_NAME}`);

  while (running) {
    let result;
    try {
      result = await reader.xReadGroup(
        CONSUMER_GROUP,
        CONSUMER_NAME,
        [{ key: RAW_STREAM, id: ">" }],
        { COUNT: BATCH_SIZE, BLOCK: BLOCK_MS }
      );
    } catch (err) {
      log(`read error: ${err.message ?? err} — backing off 1s`);
      await sleep(1000);
      continue;
    }
    if (!result) continue;

    for (const stream of result) {
      for (const entry of stream.messages) {
        await processOne(reader, writer, entry).catch((err) => {
          log(`process error id=${entry.id}: ${err.message ?? err} — leaving un-ACK'd`);
        });
      }
    }
  }

  log("shutting down");
  try { await reader.quit(); } catch {}
  try { await writer.quit(); } catch {}
}

async function processOne(reader, writer, entry) {
  const raw = entry.message?.payload;
  let envelope;
  try {
    envelope = raw ? JSON.parse(raw) : null;
  } catch (err) {
    log(`parse error id=${entry.id}: ${err.message} — ACKing to skip`);
    await reader.xAck(RAW_STREAM, CONSUMER_GROUP, entry.id);
    return;
  }
  if (!envelope || envelope.channel !== "whatsapp") {
    await reader.xAck(RAW_STREAM, CONSUMER_GROUP, entry.id);
    return;
  }

  // Skip messages the bridge sent (defense-in-depth against echo loops).
  // if (envelope.key?.fromMe) {
  //   await reader.xAck(RAW_STREAM, CONSUMER_GROUP, entry.id);
  //   return;
  // }

  // Skip empty-text messages (media-only) — echoing nothing is a no-op.
  if (!envelope.text || envelope.text.startsWith("(")) {
    await reader.xAck(RAW_STREAM, CONSUMER_GROUP, entry.id);
    return;
  }

  const reply = buildEcho(envelope);
  await writer.xAdd(
    EGRESS_STREAM,
    "*",
    { payload: JSON.stringify(reply) },
    { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10000 } }
  );
  await reader.xAck(RAW_STREAM, CONSUMER_GROUP, entry.id);
  log(`echoed id=${envelope.id} chat=${envelope.jid}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log(`fatal: ${err.message ?? err}`);
  process.exit(1);
});
