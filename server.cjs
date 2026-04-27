#!/usr/bin/env node
/**
 * WhatsApp channel for Claude Code — HTTP server
 *
 * Self-contained HTTP server using Baileys (WhatsApp Web Multi-Device).
 * Runs with Node.js CJS — Bun lacks WebSocket events Baileys requires.
 *
 * Replaces the previous MCP-over-stdio transport. The four operations are
 * exposed as RPC-flat HTTP routes (POST /reply, POST /react,
 * POST /download_attachment, POST /fetch_messages) plus GET /health and
 * GET /status. Bind/port configurable via WHATSAPP_HTTP_BIND and
 * WHATSAPP_HTTP_PORT (default 127.0.0.1:8787).
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

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(), ".claude", "channels", "whatsapp");
const ACCESS_FILE = process.env.WHATSAPP_ACCESS_FILE
  ? path.resolve(process.env.WHATSAPP_ACCESS_FILE.replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const INBOX_DIR = path.join(STATE_DIR, "inbox");
const TRACE = process.env.WHATSAPP_TRACE === "1" || process.env.WHATSAPP_TRACE === "true";
const HTTP_BIND = process.env.WHATSAPP_HTTP_BIND || "127.0.0.1";
const HTTP_PORT = parseInt(process.env.WHATSAPP_HTTP_PORT || "8787", 10);

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(INBOX_DIR, { recursive: true });

const logger = pino({ level: "silent" });
const log = (msg) => process.stderr.write(`whatsapp channel: ${msg}\n`);
const trace = TRACE ? (msg) => process.stderr.write(`whatsapp trace: ${msg}\n`) : () => {};

// Reconnect policy (like OpenClaw)
const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;     // check every 1 min
const STALE_TIMEOUT = 30 * 60 * 1000;    // 30 min without messages = stale
const HEALTHY_THRESHOLD = 60 * 1000;     // 60s connected = healthy (reset backoff)

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() {
  return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false, mentionKey: null };
}

function loadAccess() {
  let access;
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    access = { ...defaultAccess(), ...parsed };
  } catch (err) {
    if (err.code !== "ENOENT") {
      try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {}
    }
    access = defaultAccess();
  }
  // Compile mentionKey regex once; fall back to null on invalid pattern
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

function toJid(phone) {
  if (phone.includes("@")) return phone;
  return `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

function isAllowed(access, jid, participant) {
  const isGroup = jid.endsWith("@g.us");
  if (isGroup) {
    if (!access.allowGroups) return false;
    if (access.allowedGroups.length > 0 && !access.allowedGroups.includes(jid)) return false;
    if (access.requireAllowFromInGroups && participant) {
      return access.allowFrom.some((a) => toJid(a) === participant || a === participant);
    }
    return true;
  }
  if (access.allowFrom.length === 0) return true;
  return access.allowFrom.some((a) => toJid(a) === jid || a === jid);
}

// ── Path safety ─────────────────────────────────────────────────────

function assertSendable(f) {
  try {
    const real = fs.realpathSync(f);
    const stateReal = fs.realpathSync(STATE_DIR);
    const inbox = path.join(stateReal, "inbox");
    if (real.startsWith(stateReal + path.sep) && !real.startsWith(inbox + path.sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  } catch (e) {
    if (e.message?.startsWith("refusing")) throw e;
  }
}

// ── Message caches ──────────────────────────────────────────────────

const rawMessages = new Map();
const RAW_MSG_CAP = 500;
const recentMessages = new Map();
const MAX_RECENT = 100;
const seenMessages = new Map();

// Server-side delivery cursor — tracks the last arrivedAt timestamp delivered
// to the bot via fetch_messages, per chat. Only messages arriving AFTER the
// cursor are returned on each call, eliminating reliance on Claude's in-context
// deduplication (which breaks after context compression).
const lastDeliveredAt = new Map();

// Ring buffer of IDs for messages sent by the bot via the reply tool.
// Entries are excluded from fetch_messages results to prevent echo loops.
// fromMe already blocks these from entering recentMessages, but this is an
// explicit guard that survives any Baileys edge-cases around that flag.
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

// ── Creds backup/restore (like OpenClaw) ────────────────────────────

function maybeRestoreCredsFromBackup() {
  const credsPath = path.join(AUTH_DIR, "creds.json");
  const backupPath = path.join(AUTH_DIR, "creds.json.bak");
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    JSON.parse(raw); // validate
    return; // creds valid
  } catch {}
  try {
    const backup = fs.readFileSync(backupPath, "utf8");
    JSON.parse(backup); // validate backup
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
      // Backup before save
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const backupPath = path.join(AUTH_DIR, "creds.json.bak");
      try {
        const raw = fs.readFileSync(credsPath, "utf8");
        JSON.parse(raw); // validate before backing up
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
  // Cleanup previous socket completely (like OpenClaw — new socket each time)
  cleanupSocket();

  // Restore creds from backup if corrupted
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
    // getMessage handler (required for E2EE retry in Baileys)
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

      // 440 = session conflict — another device replaced. Stop permanently.
      if (reason === 440) {
        log("session conflict (440) — another device replaced this connection. Re-link required.");
        return; // stop, don't reconnect
      }

      // 401 = logged out — creds invalidated
      if (reason === DisconnectReason.loggedOut) {
        log("logged out (401) — session invalidated. Re-pair needed.");
        return; // stop, don't reconnect (user must re-pair)
      }

      // 515 = restart requested by WhatsApp — NORMAL event, reconnect quickly
      if (reason === 515) {
        log("WhatsApp requested restart (515). Reconnecting in 2s...");
        setTimeout(connectWhatsApp, 2000);
        return;
      }

      // Reset backoff if connection was healthy (>60s uptime)
      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) {
        retryCount = 0;
      }

      // Max retries reached — wait longer then reset (never exit!)
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

      // Start watchdog — detect stale connections
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

  // WebSocket error handler
  if (sock.ws && typeof sock.ws.on === "function") {
    sock.ws.on("error", (err) => log(`WebSocket error: ${err}`));
  }

  // Message handler
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const msgId = msg.key.id;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      const participant = msg.key.participant;

      if (TRACE) {
        const kind = jid.endsWith("@g.us") ? "group"
          : jid.endsWith("@broadcast") ? "broadcast"
          : jid.endsWith("@status") ? "status"
          : "dm";
        const preview = extractText(msg.message).slice(0, 80).replace(/\s+/g, " ");
        const who = participant ? ` participant=${participant}` : "";
        const self = msg.key.fromMe ? " (self)" : "";
        trace(`inbound${self} ${kind} jid=${jid}${who} id=${msgId} text=${JSON.stringify(preview)}`);
      }

      // Skip only messages the bot itself sent (tracked in _sentSet).
      // Do NOT do a blanket fromMe filter — WZ messages from their own phone
      // also arrive as fromMe:true on a linked-device session.
      if (msg.key.fromMe && msgId && _sentSet.has(msgId)) { trace("  drop: bot's own reply"); continue; }

      if (jid.endsWith("@broadcast") || jid.endsWith("@status")) { trace("  drop: broadcast/status"); continue; }

      if (msgId && isDuplicate(`${jid}:${msgId}`)) { trace("  drop: duplicate within dedup window"); continue; }

      const access = loadAccess();
      if (!isAllowed(access, jid, participant || undefined)) { trace("  drop: blocked by access.json"); continue; }

      // Mention-key filter: group messages must match the regex (case-insensitive)
      if (jid.endsWith("@g.us") && access._mentionRe) {
        const text = extractText(msg.message);
        if (!access._mentionRe.test(text)) { trace("  drop: mentionKey regex no match"); continue; }
      }

      trace("  accept");
      try { await sock.readMessages([msg.key]); } catch {}

      lastInboundAt = Date.now();
      storeRaw(msg);
      handleInbound(msg, jid, participant || undefined);
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
  storeRecent(jid, {
    id: msgId,
    from: senderNumber,
    text: text || (media ? `(${media.type})` : ""),
    ts: (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000,
    arrivedAt,
    hasMedia: !!media,
    mediaType: media?.type,
  });
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

async function handleReply(args) {
  requireConnected();
  const chatId = args.chat_id;
  const text = args.text;
  const files = args.files || [];
  if (!chatId) throw httpError(400, "chat_id required");
  for (const f of files) {
    assertSendable(f);
    if (fs.statSync(f).size > 64 * 1024 * 1024) throw new Error(`file too large: ${f}`);
  }
  const quoted = args.reply_to ? rawMessages.get(args.reply_to) : undefined;
  const MAX_TEXT = parseInt(process.env.WHATSAPP_MAX_TEXT_CHARS || "4096", 10);
  if (text && text.length > MAX_TEXT && !args.agent_message) {
    throw httpError(413, `text too long: ${text.length} chars (limit ${MAX_TEXT}). Use render_report.py and send as document instead.`);
  }
  // Edit path: update an existing bot message instead of sending new.
  if (args.edit) {
    const editKey = { remoteJid: chatId, fromMe: true, id: args.edit };
    await sock.sendMessage(chatId, { text, edit: editKey });
    return { edited_id: args.edit };
  }

  let sentId = null;
  if (text) {
    const sent = await sock.sendMessage(chatId, { text }, quoted ? { quoted } : undefined);
    sentId = sent?.key?.id ?? null;
    if (sentId && !args.agent_message) {
      trackSentId(sentId);
    } else if (sentId && args.agent_message) {
      // Store directly in recentMessages so fetch_messages can observe it
      // (fromMe=true messages are skipped by the Baileys event handler, so
      //  we inject the entry here for round-trip / diagnostic testing)
      storeRecent(chatId, {
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
    if (args.send_as_document === true) {
      await sock.sendMessage(chatId, { document: buf, mimetype: "image/png", fileName: path.basename(f) });
    } else if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      await sock.sendMessage(chatId, { image: buf });
    } else if ([".ogg", ".mp3", ".m4a", ".wav"].includes(ext)) {
      await sock.sendMessage(chatId, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
    } else if ([".mp4", ".mov", ".avi"].includes(ext)) {
      await sock.sendMessage(chatId, { video: buf });
    } else {
      await sock.sendMessage(chatId, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(f) });
    }
  }
  return { sent_id: sentId };
}

async function handleReact(args) {
  requireConnected();
  if (!args.chat_id || !args.message_id || !args.emoji) {
    throw httpError(400, "chat_id, message_id, emoji required");
  }
  await sock.sendMessage(args.chat_id, {
    react: { text: args.emoji, key: { remoteJid: args.chat_id, id: args.message_id } },
  });
  return { reacted: true };
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

// ── Startup ─────────────────────────────────────────────────────────

// Baileys crypto errors → reconnect instead of crash (like OpenClaw)
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
  cleanupSocket();
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function main() {
  await loadBaileys();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(HTTP_PORT, HTTP_BIND, () => {
      server.removeListener("error", reject);
      log(`HTTP server listening on ${HTTP_BIND}:${HTTP_PORT}`);
      resolve();
    });
  });
  connectWhatsApp();
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});
