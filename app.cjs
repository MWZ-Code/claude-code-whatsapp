#!/usr/bin/env node
/**
 * WhatsApp HTTP bridge — standalone Baileys server with optional Redis
 * Streams ingress publisher + egress consumer.
 *
 * Two surfaces are exposed:
 *   - HTTP API on loopback (POST /reply, /react, /download_attachment,
 *     /fetch_messages; GET /health, /status). Existing contract.
 *   - Redis Streams (additive, opt-in via subscribers.json):
 *       whatsapp:raw     — every accepted inbound message (XADD)
 *       whatsapp:egress  — outbound send queue consumed by this bridge
 *
 * The Baileys send/receive paths are unchanged. Redis fan-out is bolted
 * on via thin interfaces:
 *   - rawPublisher.publish(envelope) is called after the existing
 *     `messages.upsert` accept branch.
 *   - egressBus → EgressConsumerBase → performSend() — the same
 *     code path /reply and /react already use.
 *
 * Connection patterns based on OpenClaw's proven gateway:
 * - 515 is a normal restart request, not fatal
 * - Never process.exit in the reconnect loop
 * - Exponential backoff with jitter, reset after healthy period
 * - Watchdog detects stale connections
 * - Creds backup/restore to avoid re-pairing
 */

// Baileys is ESM-only (>=7.x) and cannot be require()'d from a .cjs file.
// Bindings are populated by loadBaileys() before the HTTP server starts.
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let downloadMediaMessage;
let fetchLatestBaileysVersion;
let makeCacheableSignalKeyStore;

async function loadBaileys() {
  const m = await import("@whiskeysockets/baileys");
  makeWASocket = m.default ?? m.makeWASocket;
  useMultiFileAuthState = m.useMultiFileAuthState;
  DisconnectReason = m.DisconnectReason;
  downloadMediaMessage = m.downloadMediaMessage;
  fetchLatestBaileysVersion = m.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = m.makeCacheableSignalKeyStore;
}
const http = require("http");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Compiled TS modules. Built by `npm run build` (esbuild). Loaded lazily
// so that pair.cjs and diag.cjs can require parts of this file's helpers
// without forcing a build to be present first.
function loadCompiled(rel) {
  const p = path.join(__dirname, "build", rel);
  if (!fs.existsSync(p)) {
    throw new Error(
      `compiled module not found: ${p}\n` +
      `Run "npm run build" before starting the bridge.`
    );
  }
  return require(p);
}

// ── Config ──────────────────────────────────────────────────────────

function resolveStateDir() {
  const env = process.env.WHATSAPP_STATE_DIR;
  if (env) return env.replace(/^~(?=\/|$)/, os.homedir());

  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const next = path.join(xdg, "whatsapp-bridge");
  const legacy = path.join(os.homedir(), ".claude", "channels", "whatsapp");

  if (!fs.existsSync(next) && fs.existsSync(path.join(legacy, "auth", "creds.json"))) {
    process.stderr.write(
      `whatsapp channel: using legacy state dir ${legacy} — set WHATSAPP_STATE_DIR or move it to ${next}\n`
    );
    return legacy;
  }
  return next;
}

const STATE_DIR = resolveStateDir();
const ACCESS_FILE = process.env.WHATSAPP_ACCESS_FILE
  ? path.resolve(process.env.WHATSAPP_ACCESS_FILE.replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(STATE_DIR, "access.json");
const SUBSCRIBERS_FILE = process.env.WHATSAPP_SUBSCRIBERS_FILE
  ? path.resolve(process.env.WHATSAPP_SUBSCRIBERS_FILE.replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(STATE_DIR, "subscribers.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const INBOX_DIR = path.join(STATE_DIR, "inbox");
const TRACE = process.env.WHATSAPP_TRACE === "1" || process.env.WHATSAPP_TRACE === "true";
const HTTP_BIND = process.env.WHATSAPP_HTTP_BIND || "127.0.0.1";
const HTTP_PORT = parseInt(process.env.WHATSAPP_HTTP_PORT || "8787", 10);
const MAX_TEXT = parseInt(process.env.WHATSAPP_MAX_TEXT_CHARS || "4096", 10);

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(INBOX_DIR, { recursive: true });

const logger = pino({ level: "silent" });
const log = (msg) => process.stderr.write(`whatsapp channel: ${msg}\n`);
const trace = TRACE ? (msg) => process.stderr.write(`whatsapp trace: ${msg}\n`) : () => {};

const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;
const STALE_TIMEOUT = 30 * 60 * 1000;
const HEALTHY_THRESHOLD = 60 * 1000;

// ── Subscribers config ──────────────────────────────────────────────

function defaultSubscribers() {
  return {
    redis: { url: "redis://127.0.0.1:6379" },
    streams: {
      raw: { enabled: false, key: "whatsapp:raw", maxLen: 10000 },
      egress: { enabled: false, key: "whatsapp:egress", consumerGroup: "bridge" },
    },
    egress: {
      idempotencyLruSize: 30,
      retry: { maxAttempts: 5, queueMaxPerChat: 100 },
    },
  };
}

function loadSubscribers() {
  const cfg = defaultSubscribers();
  try {
    const parsed = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, "utf8"));
    deepMerge(cfg, parsed);
    log(`subscribers: loaded ${SUBSCRIBERS_FILE}`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      log(`subscribers: failed to read ${SUBSCRIBERS_FILE}: ${err.message} — using defaults`);
    }
  }
  return cfg;
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
      target[k] = target[k] && typeof target[k] === "object" ? target[k] : {};
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
}

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() {
  return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false, mentionKey: null };
}

function loadAccess() {
  let access;
  let present = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    access = { ...defaultAccess(), ...parsed };
    present = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {}
    }
    access = defaultAccess();
  }
  access._present = present;
  if (access.mentionKey && typeof access.mentionKey === "string") {
    try {
      access._mentionRe = new RegExp(access.mentionKey, "i");
    } catch {
      log(`access.json: invalid mentionKey regex "${access.mentionKey}" — disabling mention filter`);
      access.mentionKey = null;
      access._mentionRe = null;
    }
  } else {
    access.mentionKey = null;
    access._mentionRe = null;
  }
  return access;
}

// ── Message caches ──────────────────────────────────────────────────

const rawMessages = new Map();
const RAW_MSG_CAP = 500;
const recentMessages = new Map();
const MAX_RECENT = 100;
const seenMessages = new Map();

const lastDeliveredAt = new Map();

const SENT_RING_CAP = 300;
const _sentRing = new Array(SENT_RING_CAP).fill(null);
const _sentSet = new Set();
let _sentRingIdx = 0;

function trackSentId(id) {
  const evicted = _sentRing[_sentRingIdx];
  if (evicted !== null) _sentSet.delete(evicted);
  _sentRing[_sentRingIdx] = id;
  _sentSet.add(id);
  _sentRingIdx = (_sentRingIdx + 1) % SENT_RING_CAP;
}
const SEEN_TTL = 20 * 60 * 1000;
const SEEN_MAX = 5000;

function isDuplicate(key) {
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, Date.now());
  if (seenMessages.size > SEEN_MAX) {
    const now = Date.now();
    for (const [k, t] of seenMessages) {
      if (now - t > SEEN_TTL) seenMessages.delete(k);
    }
  }
  return false;
}

function storeRaw(msg) {
  const id = msg.key?.id;
  if (!id) return;
  rawMessages.set(id, msg);
  if (rawMessages.size > RAW_MSG_CAP) {
    const first = rawMessages.keys().next().value;
    if (first) rawMessages.delete(first);
  }
}

function storeRecent(chatId, entry) {
  if (!recentMessages.has(chatId)) recentMessages.set(chatId, []);
  const arr = recentMessages.get(chatId);
  arr.push(entry);
  if (arr.length > MAX_RECENT) arr.shift();
}

// ── Creds backup/restore ────────────────────────────────────────────

function maybeRestoreCredsFromBackup() {
  const credsPath = path.join(AUTH_DIR, "creds.json");
  const backupPath = path.join(AUTH_DIR, "creds.json.bak");
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    JSON.parse(raw);
    return;
  } catch {}
  try {
    const backup = fs.readFileSync(backupPath, "utf8");
    JSON.parse(backup);
    fs.copyFileSync(backupPath, credsPath);
    try { fs.chmodSync(credsPath, 0o600); } catch {}
    log("restored creds.json from backup");
  } catch {}
}

let credsSaveQueue = Promise.resolve();
let saveCreds = null;

function enqueueSaveCreds() {
  if (!saveCreds) return;
  credsSaveQueue = credsSaveQueue
    .then(() => {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const backupPath = path.join(AUTH_DIR, "creds.json.bak");
      try {
        const raw = fs.readFileSync(credsPath, "utf8");
        JSON.parse(raw);
        fs.copyFileSync(credsPath, backupPath);
        try { fs.chmodSync(backupPath, 0o600); } catch {}
      } catch {}
      return saveCreds();
    })
    .then(() => {
      try { fs.chmodSync(path.join(AUTH_DIR, "creds.json"), 0o600); } catch {}
    })
    .catch((err) => {
      log(`creds save error: ${err} — retrying in 1s`);
      setTimeout(enqueueSaveCreds, 1000);
    });
}

// ── WhatsApp Connection ─────────────────────────────────────────────

let sock = null;
let connectionReady = false;
let retryCount = 0;
let connectedAt = 0;
let lastInboundAt = 0;
let watchdogTimer = null;

// Hooks fired by messages.upsert when a message has passed all filters.
// app.cjs registers a single hook that publishes to Redis (if configured).
const acceptedMessageHandlers = [];
function onAcceptedMessage(handler) {
  acceptedMessageHandlers.push(handler);
}

function computeDelay(attempt) {
  const base = Math.min(RECONNECT.initialMs * Math.pow(RECONNECT.factor, attempt), RECONNECT.maxMs);
  const jitter = base * RECONNECT.jitter * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function cleanupSocket() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  connectionReady = false;
}

async function connectWhatsApp() {
  cleanupSocket();
  maybeRestoreCredsFromBackup();

  let authState, version;
  try {
    authState = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = authState.saveCreds;
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    const delay = computeDelay(retryCount);
    retryCount++;
    log(`connectWhatsApp init error: ${err} — retrying in ${delay}ms (attempt ${retryCount})`);
    setTimeout(connectWhatsApp, delay);
    return;
  }

  sock = makeWASocket({
    auth: {
      creds: authState.state.creds,
      keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mac OS", "Safari", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      const cached = rawMessages.get(key.id);
      if (cached?.message) return cached.message;
      return { conversation: "" };
    },
  });

  sock.ev.on("creds.update", enqueueSaveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }, (code) => {
        log("scan QR code with WhatsApp > Linked Devices > Link a Device");
        process.stderr.write(code + "\n");
      });
    }

    if (connection === "close") {
      connectionReady = false;
      const reason = lastDisconnect?.error?.output?.statusCode;

      if (reason === 440) {
        log("session conflict (440) — another device replaced this connection. Re-link required.");
        return;
      }
      if (reason === DisconnectReason.loggedOut) {
        log("logged out (401) — session invalidated. Re-pair needed.");
        return;
      }
      if (reason === 515) {
        log("WhatsApp requested restart (515). Reconnecting in 2s...");
        setTimeout(connectWhatsApp, 2000);
        return;
      }
      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) {
        retryCount = 0;
      }
      if (retryCount >= 15) {
        log("max retries reached. Waiting 5 min before resetting...");
        retryCount = 0;
        setTimeout(connectWhatsApp, 5 * 60 * 1000);
        return;
      }
      const delay = computeDelay(retryCount);
      retryCount++;
      log(`connection closed (${reason}), retrying in ${delay}ms (attempt ${retryCount})`);
      setTimeout(connectWhatsApp, delay);
    }

    if (connection === "open") {
      connectionReady = true;
      connectedAt = Date.now();
      retryCount = 0;
      log("connected");

      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        if (!connectionReady) return;
        if (lastInboundAt && Date.now() - lastInboundAt > STALE_TIMEOUT) {
          log(`no messages in ${STALE_TIMEOUT / 60000}min — forcing reconnect`);
          connectWhatsApp();
        }
      }, WATCHDOG_INTERVAL);
    }
  });

  if (sock.ws && typeof sock.ws.on === "function") {
    sock.ws.on("error", (err) => log(`WebSocket error: ${err}`));
  }

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const msgId = msg.key.id;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      const participant = msg.key.participant;
      const text = extractText(msg.message);

      if (TRACE) {
        const kind = jid.endsWith("@g.us") ? "group"
          : jid.endsWith("@broadcast") ? "broadcast"
          : jid.endsWith("@status") ? "status"
          : "dm";
        const preview = text.slice(0, 80).replace(/\s+/g, " ");
        const who = participant ? ` participant=${participant}` : "";
        const self = msg.key.fromMe ? " (self)" : "";
        trace(`inbound${self} ${kind} jid=${jid}${who} id=${msgId} text=${JSON.stringify(preview)}`);
      }

      const access = loadAccess();
      const check = middleware.checkInbound({
        jid,
        participant: participant || undefined,
        msgId,
        text,
        fromMe: !!msg.key.fromMe,
        isOwnSentId: (id) => _sentSet.has(id),
        isDuplicate,
        access,
      });
      if (!check.ok) {
        trace(`  drop: ${check.reason}`);
        continue;
      }

      trace("  accept");
      try { await sock.readMessages([msg.key]); } catch {}

      lastInboundAt = Date.now();
      storeRaw(msg);
      const accepted = handleInbound(msg, jid, participant || undefined);

      // Fan out to registered handlers (e.g. raw publisher). Run in
      // parallel; a slow / failing handler must never block the WA loop.
      if (acceptedMessageHandlers.length > 0) {
        Promise.allSettled(
          acceptedMessageHandlers.map((h) => Promise.resolve().then(() => h(accepted)))
        ).then((results) => {
          for (const r of results) {
            if (r.status === "rejected") log(`accepted-message handler error: ${r.reason}`);
          }
        });
      }
    }
  });
}

// ── Message helpers ─────────────────────────────────────────────────

function extractText(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}

function extractMediaInfo(msg) {
  if (msg.imageMessage) return { type: "image", mimetype: msg.imageMessage.mimetype || "image/jpeg", size: Number(msg.imageMessage.fileLength) || 0 };
  if (msg.videoMessage) return { type: "video", mimetype: msg.videoMessage.mimetype || "video/mp4", size: Number(msg.videoMessage.fileLength) || 0 };
  if (msg.audioMessage) return { type: "audio", mimetype: msg.audioMessage.mimetype || "audio/ogg", size: Number(msg.audioMessage.fileLength) || 0 };
  if (msg.documentMessage) return { type: "document", mimetype: msg.documentMessage.mimetype || "application/octet-stream", size: Number(msg.documentMessage.fileLength) || 0, filename: msg.documentMessage.fileName };
  if (msg.stickerMessage) return { type: "sticker", mimetype: msg.stickerMessage.mimetype || "image/webp", size: Number(msg.stickerMessage.fileLength) || 0 };
  return null;
}

function mimeToExt(mimetype) {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/ogg; codecs=opus": "ogg", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
  };
  return map[mimetype] || "bin";
}

function formatJid(jid) {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
}

// ── Inbound handler ─────────────────────────────────────────────────

function handleInbound(msg, jid, participant) {
  const message = msg.message;
  const text = extractText(message);
  const media = extractMediaInfo(message);
  const msgId = msg.key.id || `${Date.now()}`;
  const senderJid = participant || jid;
  const senderNumber = formatJid(senderJid);
  const arrivedAt = Date.now();
  const ts = (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000;

  const entry = {
    id: msgId,
    from: senderNumber,
    text: text || (media ? `(${media.type})` : ""),
    ts,
    arrivedAt,
    hasMedia: !!media,
    mediaType: media?.type,
  };
  storeRecent(jid, entry);

  // Normalised envelope handed to onAcceptedMessage handlers.
  return {
    channel: "whatsapp",
    id: msgId,
    jid,
    participant: participant || null,
    from: senderNumber,
    text: entry.text,
    ts,
    arrivedAt,
    hasMedia: !!media,
    mediaType: media?.type ?? null,
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: !!msg.key.fromMe,
      id: msg.key.id,
    },
  };
}

// ── Send path (single source of truth) ──────────────────────────────

// performSend assumes middleware.checkEgress has already passed. Both
// the HTTP route handlers and the egress consumer reach Baileys through
// this function.
async function performSend(payload) {
  requireConnected();
  const { op, chat_id } = payload;

  if (op === "react") {
    await sock.sendMessage(chat_id, {
      react: { text: payload.emoji, key: { remoteJid: chat_id, id: payload.message_id } },
    });
    return { reacted: true };
  }

  // op === "reply"
  const text = payload.text;
  const files = payload.files || [];
  const quoted = payload.reply_to ? rawMessages.get(payload.reply_to) : undefined;

  if (payload.edit) {
    const editKey = { remoteJid: chat_id, fromMe: true, id: payload.edit };
    await sock.sendMessage(chat_id, { text, edit: editKey });
    return { edited_id: payload.edit };
  }

  let sentId = null;
  if (text) {
    const sent = await sock.sendMessage(chat_id, { text }, quoted ? { quoted } : undefined);
    sentId = sent?.key?.id ?? null;
    if (sentId && !payload.agent_message) {
      trackSentId(sentId);
    } else if (sentId && payload.agent_message) {
      storeRecent(chat_id, {
        id: sentId,
        from: "bot",
        text,
        ts: Date.now(),
        hasMedia: false,
        mediaType: undefined,
      });
    }
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const buf = fs.readFileSync(f);
    if (payload.send_as_document === true) {
      await sock.sendMessage(chat_id, { document: buf, mimetype: "image/png", fileName: path.basename(f) });
    } else if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      await sock.sendMessage(chat_id, { image: buf });
    } else if ([".ogg", ".mp3", ".m4a", ".wav"].includes(ext)) {
      await sock.sendMessage(chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
    } else if ([".mp4", ".mov", ".avi"].includes(ext)) {
      await sock.sendMessage(chat_id, { video: buf });
    } else {
      await sock.sendMessage(chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(f) });
    }
  }
  return { sent_id: sentId };
}

// ── HTTP handlers ───────────────────────────────────────────────────

function readJsonBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return resolve({});
      try { resolve(JSON.parse(buf.toString("utf8"))); }
      catch (e) { reject(new Error(`invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireConnected() {
  if (!sock || !connectionReady) throw httpError(503, "WhatsApp not connected");
}

function middlewareErrorToHttp(reason) {
  if (!reason) return httpError(400, "rejected");
  if (reason.includes("not permitted")) return httpError(403, reason);
  if (reason.startsWith("text too long")) return httpError(413, reason);
  if (reason.includes("file too large") || reason.startsWith("unsafe file path") || reason.startsWith("file not readable")) {
    return httpError(400, reason);
  }
  return httpError(400, reason);
}

async function handleReply(args) {
  requireConnected();
  const access = loadAccess();
  const check = middleware.checkEgress({
    op: "reply",
    chat_id: args.chat_id,
    text: args.text,
    files: args.files,
    access,
    maxTextChars: MAX_TEXT,
    stateDir: STATE_DIR,
    agent_message: args.agent_message,
  });
  if (!check.ok) throw middlewareErrorToHttp(check.reason);
  return performSend({
    op: "reply",
    chat_id: args.chat_id,
    text: args.text,
    files: args.files,
    reply_to: args.reply_to,
    edit: args.edit,
    send_as_document: args.send_as_document,
    agent_message: args.agent_message,
  });
}

async function handleReact(args) {
  requireConnected();
  const access = loadAccess();
  const check = middleware.checkEgress({
    op: "react",
    chat_id: args.chat_id,
    message_id: args.message_id,
    emoji: args.emoji,
    access,
    maxTextChars: MAX_TEXT,
    stateDir: STATE_DIR,
  });
  if (!check.ok) throw middlewareErrorToHttp(check.reason);
  return performSend({
    op: "react",
    chat_id: args.chat_id,
    message_id: args.message_id,
    emoji: args.emoji,
  });
}

async function handleDownloadAttachment(args) {
  requireConnected();
  if (!args.message_id) throw httpError(400, "message_id required");
  const raw = rawMessages.get(args.message_id);
  if (!raw?.message) throw httpError(404, "message not found in cache");
  const media = extractMediaInfo(raw.message);
  if (!media) throw httpError(404, "message has no attachments");
  const buffer = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const ext = mimeToExt(media.mimetype);
  const filename = media.filename || `${Date.now()}.${ext}`;
  const filePath = path.join(INBOX_DIR, `${Date.now()}-${filename}`);
  fs.writeFileSync(filePath, buffer);
  return { file_path: filePath, type: media.type, size_bytes: buffer.length };
}

function handleFetchMessages(args) {
  requireConnected();
  if (!args.chat_id) throw httpError(400, "chat_id required");
  const limit = Math.min(args.limit || 20, 100);
  const cursor = lastDeliveredAt.get(args.chat_id) || 0;
  const msgs = recentMessages.get(args.chat_id) || [];
  const slice = msgs
    .filter((m) => !_sentSet.has(m.id) && (m.arrivedAt || m.ts) > cursor)
    .slice(-limit);
  if (slice.length > 0) {
    lastDeliveredAt.set(args.chat_id, Math.max(...slice.map((m) => m.arrivedAt || m.ts)));
  }
  return {
    messages: slice.map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      ts: m.ts,
      arrivedAt: m.arrivedAt,
      hasMedia: !!m.hasMedia,
      mediaType: m.mediaType ?? null,
    })),
  };
}

function handleStatus() {
  return {
    connected: connectionReady,
    last_inbound_at: lastInboundAt || null,
    retry_count: retryCount,
    watchdog_age_ms: lastInboundAt ? Date.now() - lastInboundAt : null,
    subscribers: subscribersStatus(),
  };
}

const POST_ROUTES = {
  "/reply": handleReply,
  "/react": handleReact,
  "/download_attachment": handleDownloadAttachment,
  "/fetch_messages": handleFetchMessages,
};

async function dispatch(req, res) {
  const url = req.url || "/";
  const method = req.method || "GET";

  if (method === "GET" && url === "/health") return send(res, 200, { status: "ok" });
  if (method === "GET" && url === "/status") return send(res, 200, handleStatus());

  if (method === "POST" && Object.prototype.hasOwnProperty.call(POST_ROUTES, url)) {
    let body;
    try { body = await readJsonBody(req); }
    catch (err) { return send(res, 400, { error: err.message }); }
    try {
      const result = await POST_ROUTES[url](body);
      return send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      return send(res, status, { error: err.message || String(err) });
    }
  }

  send(res, 404, { error: `not found: ${method} ${url}` });
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch((err) => {
    log(`http handler crash: ${err}`);
    if (!res.headersSent) send(res, 500, { error: "internal" });
  });
});

// ── Subscribers (raw publisher + egress consumer) ───────────────────

let middleware;
let rawPublisher = null;
let egressBus = null;
let egressConsumer = null;

function subscribersStatus() {
  return {
    raw: rawPublisher
      ? { enabled: true, ...rawPublisher.stats() }
      : { enabled: false },
    egress: egressBus
      ? {
          enabled: true,
          dropped_middleware: egressConsumer?.droppedMiddleware ?? 0,
          dropped_duplicate: egressConsumer?.droppedDuplicate ?? 0,
          dropped_retry_exhausted: egressConsumer?.droppedRetryExhausted ?? 0,
          dropped_queue_full: egressConsumer?.droppedQueueFull ?? 0,
        }
      : { enabled: false },
  };
}

async function bootSubscribers() {
  const cfg = loadSubscribers();

  if (cfg.streams.raw.enabled) {
    const { RawPublisher } = loadCompiled("streams/Redis/raw_publisher.js");
    rawPublisher = new RawPublisher(
      { url: cfg.redis.url, streamKey: cfg.streams.raw.key, maxLen: cfg.streams.raw.maxLen },
      log,
    );
    onAcceptedMessage((envelope) => rawPublisher.publish(envelope));
    log(`raw publisher: enabled stream="${cfg.streams.raw.key}" maxLen=${cfg.streams.raw.maxLen}`);
  }

  if (cfg.streams.egress.enabled) {
    const { EgressBus } = loadCompiled("streams/Redis/egress_bus.js");
    const { EgressConsumerBase } = loadCompiled("channels/WhatsApp/egress_consumer_base.js");

    egressConsumer = new EgressConsumerBase({
      send: (sendPayload) => performSend(sendPayload),
      middleware: (m) => middleware.checkEgress({
        op: m.op,
        chat_id: m.chat_id,
        text: m.text,
        files: m.files,
        emoji: m.emoji,
        message_id: m.message_id,
        access: loadAccess(),
        maxTextChars: MAX_TEXT,
        stateDir: STATE_DIR,
      }),
      idempotencyLruSize: cfg.egress.idempotencyLruSize,
      maxAttempts: cfg.egress.retry.maxAttempts,
      queueMaxPerChat: cfg.egress.retry.queueMaxPerChat,
      log: (m) => process.stderr.write(`egress consumer: ${m}\n`),
    });

    egressBus = new EgressBus({
      url: cfg.redis.url,
      streamKey: cfg.streams.egress.key,
      consumerGroup: cfg.streams.egress.consumerGroup,
    }, log);

    await egressBus.start(async (msg, ack) => {
      const payload = msg.payload;
      if (!payload || typeof payload !== "object" || payload.channel !== "whatsapp") {
        log(`egress: dropping non-whatsapp payload id=${msg.id}`);
        await ack();
        return;
      }
      await egressConsumer.dispatch(payload, ack);
    });

    log(`egress consumer: enabled stream="${cfg.streams.egress.key}" group="${cfg.streams.egress.consumerGroup}"`);
  }
}

// ── Startup ─────────────────────────────────────────────────────────

process.on("unhandledRejection", (err) => {
  const msg = String(err).toLowerCase();
  if (
    (msg.includes("unable to authenticate data") || msg.includes("bad mac")) &&
    (msg.includes("baileys") || msg.includes("noise-handler") || msg.includes("signal"))
  ) {
    log("Baileys crypto error — forcing reconnect");
    setTimeout(connectWhatsApp, 2000);
    return;
  }
  log(`unhandled rejection: ${err}`);
});

process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${err}`);
});

process.setMaxListeners(50);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  try { server.close(); } catch {}
  if (egressBus) { egressBus.stop().catch(() => {}); }
  if (egressConsumer) { egressConsumer.shutdown(); }
  cleanupSocket();
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  middleware = loadCompiled("channels/WhatsApp/middleware.js");
  await loadBaileys();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(HTTP_PORT, HTTP_BIND, () => {
      server.removeListener("error", reject);
      log(`HTTP server listening on ${HTTP_BIND}:${HTTP_PORT}`);
      resolve();
    });
  });
  try {
    await bootSubscribers();
  } catch (err) {
    log(`subscribers boot failed: ${err.message ?? err} — bridge continues without Redis`);
  }
  connectWhatsApp();
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});
