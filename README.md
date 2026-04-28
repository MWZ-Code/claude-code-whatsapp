# WhatsApp HTTP Bridge

A standalone WhatsApp bridge using [Baileys](https://github.com/WhiskeySockets/Baileys) v7
(WhatsApp Web Multi-Device protocol). Runs as its own long-lived HTTP server
(systemd `--user` unit) and exposes a small RPC-flat HTTP API on loopback.
Any consumer can drive it: `curl`, a cron job, or — via the bundled
`whatsapp-channel` skill — a Claude Code agent. The HTTP API is the contract;
the skill is one supported consumer that ships in the same repo.

> **Note:** This is a personal project that I've open-sourced for the community. It works for my 24/7 setup and I'm sharing it as-is. PRs are welcome.
>
> **Credits:** Originally forked from [diogo85/claude-code-whatsapp](https://github.com/diogo85/claude-code-whatsapp), which provided the initial Claude Code WhatsApp channel plugin. This fork has since diverged — replacing the MCP-over-stdio transport with a standalone HTTP bridge (v0.1.0) and decoupling defaults, naming, and framing from Claude Code (v0.2.0) — so the projects target different use cases. Thanks to [@diogo85](https://github.com/diogo85) for the starting point.

## How it works

```
WhatsApp (phone)
    ↕ Baileys v7.0.0-rc.9 (Multi-Device protocol)
app.cjs (HTTP server on 127.0.0.1:8787)
    ↕ HTTP POST /reply, /react, /download_attachment, /fetch_messages
    ↕ HTTP GET  /health, /status
    ↕ Redis Streams (optional): XADD whatsapp:raw, XREADGROUP whatsapp:egress
Any consumer (Claude Code agent via skill, curl, your own worker, ...)
```

The server runs independently of any agent runtime. Two consumer surfaces:

1. **HTTP** — inbound messages buffered in memory; consumers poll
   `POST /fetch_messages` to pop new messages (server-side per-chat
   cursor). Sends are synchronous via `POST /reply` / `POST /react`.
2. **Redis Streams (optional, opt-in via `subscribers.json`)** — every
   accepted inbound message is XADD'd to `whatsapp:raw`; multiple
   consumer groups can fan out independently with replay/durability.
   Outbound producers XADD to `whatsapp:egress`; the bridge runs an
   XREADGROUP consumer that dispatches through the same internal send
   path the HTTP routes use. See [`subscribers.json.md`](subscribers.json.md).

When `subscribers.json` is absent both Redis surfaces are off and the
bridge behaves exactly like v0.2.x.

## Features

- **Production-grade stability** — connection patterns based on [OpenClaw](https://github.com/openclaw/openclaw)'s proven WhatsApp gateway
- **515 is normal** — WhatsApp restart requests are handled gracefully (reconnect in 2s, not crash)
- **Never crashes the process** — only stops on 440 (conflict) or 401 (logout); everything else reconnects
- **Exponential backoff with jitter** — factor 1.8, jitter 25%, max 30s, reset after healthy period
- **Watchdog** — detects stale connections (30 min timeout) and forces reconnect
- **Credential backup** — auto-backup before each save, auto-restore if corrupted
- **getMessage handler** — required for E2EE retry in Baileys v7
- **Crypto error recovery** — Baileys crypto errors trigger reconnect instead of crash
- **Graceful shutdown** — clean exit on SIGTERM/SIGINT
- **Hot-reloaded access control** — `access.json` re-read on every inbound message

## Requirements

- **Node.js** 22+ (Bun is NOT supported — lacks WebSocket events Baileys needs)
- **systemd** with `--user` units enabled (Linux). Other init systems work too — just adapt `deploy/whatsapp-http.service` by hand.
- **WhatsApp** account (regular or Business)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/MWZ-Code/claude-code-whatsapp.git
cd claude-code-whatsapp
npm install
npm run build   # compile TS modules under channels/ + streams/
```

`npm run build` is required once before first start, and any time you
edit a `.ts` file under `channels/` or `streams/`. It runs esbuild
(zero-config, ~10ms). `npm start` runs build automatically via
`prestart`.

### 2. Pair with WhatsApp

```bash
mkdir -p ~/.config/whatsapp-bridge/auth
node pair.cjs
```

By default the bridge stores creds, inbox, and `access.json` in
`${XDG_CONFIG_HOME:-~/.config}/whatsapp-bridge/`. Override with
`WHATSAPP_STATE_DIR=/some/other/path`.

The script shows both a **QR code** and a **pairing code**. On your phone:
- **QR:** WhatsApp > Linked Devices > Link a Device — scan the QR
- **Code:** WhatsApp > Linked Devices > Link a Device > Link with phone number — enter the code

Wait for "✅ WhatsApp connected!" before closing.

### 3. Install the systemd unit

```bash
bash deploy/install.sh
```

This renders `deploy/whatsapp-http.service` into
`~/.config/systemd/user/` (paths and the Node binary are detected from your
environment), runs `systemctl --user daemon-reload`, then
`systemctl --user enable --now whatsapp-http.service`. It's safe to
re-run any time — it diffs the rendered unit and only rewrites on change.

Override paths via env vars if needed:

```bash
NODE_BIN=/home/user/.local/bin/node \
STATE_DIR=~/.config/whatsapp-bridge \
WORKING_DIR=/path/to/repo \
bash deploy/install.sh
```

Confirm it's up:

```bash
curl -s http://127.0.0.1:8787/health
# → {"status":"ok"}

curl -s http://127.0.0.1:8787/status
# → {"connected":true,"last_inbound_at":...,"retry_count":0,"watchdog_age_ms":...}
```

Tail logs with `journalctl --user -u whatsapp-http.service -f`.

### 4. Wire the skill (Claude Code consumers only)

This repo ships a `whatsapp-channel` skill under `skills/whatsapp-channel/`.
When Claude Code loads this directory as a plugin, the skill auto-loads and
documents every endpoint with curl examples and request/response shapes for
the agent. There is no `.mcp.json` to register — the skill is the contract.

For non-Claude-Code consumers, just hit the HTTP API directly. The skill is a
human-and-agent-readable reference that lives next to the server.

### 5. Access control (optional)

Create `~/.config/whatsapp-bridge/access.json`:

```json
{
  "allowFrom": ["5511999999999"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "mentionKey": null
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `allowFrom` | `[]` | Phone numbers allowed to DM the bot. Empty = anyone. |
| `allowGroups` | `false` | Whether the bot listens to group chats at all. |
| `allowedGroups` | `[]` | Specific group JIDs to allow (when `allowGroups: true`). Empty = all groups. |
| `requireAllowFromInGroups` | `false` | When `true`, group messages are only processed if the sender is in `allowFrom`. |
| `mentionKey` | `null` | Regex pattern (case-insensitive). When set, group messages are only processed if their text matches this pattern. DMs are never filtered. |

Changes to `access.json` take effect immediately — no restart required.

#### Mention key

The `mentionKey` field is a JavaScript regex string applied case-insensitively to every inbound group message. Only messages whose text matches are forwarded to consumers; everything else is silently ignored.

```json
{ "mentionKey": "@pricebot|hey pricebot" }
```

> **⚠️ Choose a low-collision pattern.** A pattern like `\bb\b` or `ok` will match too many ordinary messages and make the bot noisy. Use a short, unique string — e.g. your bot's handle or a distinctive prefix — so accidental triggers are rare.

## HTTP API summary

All routes accept/return JSON. Default base URL `http://127.0.0.1:8787`,
overridable via `WHATSAPP_HTTP_BIND` and `WHATSAPP_HTTP_PORT`.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/health`              | Liveness probe. Always `200 {"status":"ok"}` if the process is up. |
| GET    | `/status`              | `{connected, last_inbound_at, retry_count, watchdog_age_ms}`. |
| POST   | `/fetch_messages`      | Pop new messages for a chat (server-side cursor). |
| POST   | `/reply`               | Send or edit a WhatsApp message; supports file attachments. |
| POST   | `/react`               | Add an emoji reaction. |
| POST   | `/download_attachment` | Materialize an inbound media message into `<state>/inbox/`. |

See `skills/whatsapp-channel/SKILL.md` for full request/response schemas and
curl examples. Or read the handlers directly in `app.cjs`.

## Redis Streams (optional)

The bridge can fan out inbound messages and accept queued sends via
Redis Streams. Enable by creating a `subscribers.json` next to
`access.json`:

```json
{
  "redis": { "url": "redis://127.0.0.1:6379" },
  "streams": {
    "raw":    { "enabled": true, "key": "whatsapp:raw",    "maxLen": 10000 },
    "egress": { "enabled": true, "key": "whatsapp:egress", "consumerGroup": "bridge" }
  }
}
```

Restart the bridge. `GET /status` now reports `subscribers` counters.
See [`subscribers.json.md`](subscribers.json.md) for the full schema and
wire-format reference.

### Worked example: echo bot

A reference downstream worker lives at `workers/echo_bot.cjs`. It reads
`whatsapp:raw`, builds an `echo: <text>` reply for every non-self DM,
publishes to `whatsapp:egress`, and ACKs the raw entry. It speaks only
Redis — no Baileys, no channel imports.

```bash
# 1. Make sure Redis is running and subscribers.json enables both streams.
# 2. Restart the bridge.
# 3. In another shell:
REDIS_URL=redis://127.0.0.1:6379 npm run echo-bot
```

End-to-end:

1. Send a WhatsApp message to the paired account.
2. The bridge accepts it → `XADD whatsapp:raw`.
3. `echo_bot` reads the entry → `XADD whatsapp:egress` with the reply.
4. The bridge's egress consumer reads it → middleware → `performSend()`.
5. The original sender receives `echo: <your text>`.

The bridge's `_sentSet` filter prevents the echo's own `messages.upsert`
event from re-entering `whatsapp:raw` and triggering an infinite loop.

## Stability Design

This server was rewritten based on analysis of [OpenClaw's WhatsApp extension](https://github.com/openclaw/openclaw/tree/main/extensions/whatsapp), which runs 24/7 without issues. Key patterns:

| Pattern | Description |
|---------|-------------|
| 515 = reconnect | WhatsApp sends 515 regularly. It's a normal restart request, not an error |
| Never process.exit | Only stop on 440 (conflict) or 401 (logout). Everything else reconnects |
| New socket each time | Never reuse a dead socket — create fresh on every reconnect |
| Backoff with jitter | Prevents thundering herd. Reset after 60s of healthy connection |
| Watchdog timer | 30min without inbound messages = force reconnect (detects zombie connections) |
| Creds backup | Auto-backup before each save. Auto-restore if JSON is corrupted |
| Listener cleanup | Remove all event listeners before creating new socket (prevents leaks) |

## Debugging

Set `WHATSAPP_TRACE=1` to log every inbound message and the decision applied
to it (accept / drop reason). Trace lines go to stderr (and into journald
when run under systemd) and are prefixed `whatsapp trace:`. Disabled by
default — zero overhead when off.

```bash
WHATSAPP_TRACE=1 node app.cjs 2>&1 | grep '^whatsapp trace:'
```

Each inbound message produces two lines: the `inbound …` line classifies the
chat (`dm` / `group` / `broadcast` / `status`) and shows the JID, sender
participant (groups only), message id, and an 80-char text preview; the
indented follow-up line shows the decision (`accept` or `drop: <reason>`).

**Finding a group's JID.** Group JIDs look like `1234567890-1234567890@g.us`
and aren't exposed in the WhatsApp UI. With trace enabled, send any message
in the target group and grep:

```bash
WHATSAPP_TRACE=1 node app.cjs 2>&1 | grep 'whatsapp trace: inbound group'
```

The first hit gives you the JID to paste into `access.json` under
`allowedGroups`.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `connection refused` from curl | systemd unit not running | `systemctl --user start whatsapp-http.service` |
| `503 WhatsApp not connected` | Auth expired or not paired, or still reconnecting | Run `pair.cjs` if needed; otherwise wait and poll `/status` |
| Error 515 in journal | Normal — WhatsApp requested restart | Auto-handled (reconnect in 2s) |
| Error 440 in journal | Two devices competing | Unlink in phone settings, re-pair |
| Error 401 in journal | Logged out | Session invalidated, re-pair |
| Rate limit on pairing | Too many rapid attempts | Wait 1-2 hours, try ONCE |
| Messages stop without error | Zombie connection | Watchdog detects in 30min. Or `systemctl --user restart whatsapp-http.service` |
| `creds.json` corrupted | Crash during save | Restored from backup automatically on next boot |

## Changelog

### v0.3.0 (2026-04-28)

- **Redis Streams subscriber interface (additive, opt-in).** New
  `subscribers.json` config gates two surfaces:
  - `streams.raw` — the bridge XADDs every accepted inbound message to
    `whatsapp:raw`. Lets multiple downstream consumer groups fan out
    independently with replay/durability instead of polling
    `/fetch_messages`.
  - `streams.egress` — the bridge runs an XREADGROUP consumer on
    `whatsapp:egress` and dispatches each entry through the same
    internal send path that powers `POST /reply` / `POST /react`.
    Producers no longer have to hold an HTTP connection open through
    the Baileys round-trip; idempotency is per-entry via `request_id`.
  When `subscribers.json` is absent both surfaces are off and behavior
  is byte-identical to v0.2.x. See `subscribers.json.md`.
- **Entry point renamed `server.cjs` → `app.cjs`.** Re-run
  `bash deploy/install.sh` to update the systemd unit. The install
  script now also runs `npm run build` before enabling the unit so the
  compiled TS modules are present.
- **TypeScript modules** added under `channels/WhatsApp/` and
  `streams/Redis/` (built with esbuild → CJS in `build/`). Existing
  inline access/dedup/path-safety/text-cap checks consolidated into
  `channels/WhatsApp/middleware.ts` so HTTP and queue paths share one
  source of truth.
- **`workers/echo_bot.cjs`** added as the success-criterion worker —
  reference downstream that imports no channel code, speaks only
  Redis. Run with `npm run echo-bot`.
- **`GET /status`** now returns subscriber counters under
  `subscribers` for raw publisher (`published`, `droppedNoConnection`,
  `droppedError`) and egress consumer (`dropped_middleware`,
  `dropped_duplicate`, `dropped_retry_exhausted`, `dropped_queue_full`).

### v0.2.0 (2026-04-27)

- **Default state directory** moved from `~/.claude/channels/whatsapp/` to
  `${XDG_CONFIG_HOME:-~/.config}/whatsapp-bridge/`. Existing installs keep
  working: `app.cjs`, `pair.cjs`, `diag.cjs`, and `deploy/install.sh` fall
  back to the legacy path when the new directory does not exist and the
  legacy one holds a paired `creds.json`. Set `WHATSAPP_STATE_DIR` to pin
  either explicitly. To migrate, stop the unit and `mv ~/.claude/channels/whatsapp ~/.config/whatsapp-bridge`.
- **Systemd unit renamed** from `claude-whatsapp-http.service` to
  `whatsapp-http.service` (template + identifier + log prefix). Re-run
  `bash deploy/install.sh` and disable the old unit:
  `systemctl --user disable --now claude-whatsapp-http.service` then
  `rm ~/.config/systemd/user/claude-whatsapp-http.service`. The install
  script prints this hint when it detects the legacy unit file.
- **Framing:** the HTTP API is now described as the contract; the
  `whatsapp-channel` skill is one supported consumer that ships in-tree.

### v0.1.0 (2026-04-27)

- **Breaking:** Replaced MCP-over-stdio transport with a long-running HTTP server (`127.0.0.1:8787` by default, override via `WHATSAPP_HTTP_BIND`/`WHATSAPP_HTTP_PORT`).
- Endpoints: `GET /health`, `GET /status`, `POST /reply`, `POST /react`, `POST /download_attachment`, `POST /fetch_messages`.
- Dropped `@modelcontextprotocol/sdk` dependency.
- Removed permission-relay handler (no consumer was using it).
- Removed stdin-close shutdown trigger; SIGTERM/SIGINT only.
- Added `deploy/claude-whatsapp-http.service` (template) + `deploy/install.sh` (idempotent renderer + `systemctl --user enable --now`).
- Added `skills/whatsapp-channel/SKILL.md` documenting the HTTP contract (curl per endpoint, schemas, access.json reference, polling guidance).
- Deleted `.mcp.json`.

### v0.0.5 (2026-04-27)
- **Trace logging** — set `WHATSAPP_TRACE=1` to log every inbound message and the decision applied (accept or drop-with-reason). Zero overhead when off. See the Debugging section, including the recipe for discovering group JIDs.

### v0.0.4 (2026-04-24)
- **Mention-key trigger** — new `mentionKey` field in `access.json`: a case-insensitive regex that gates group messages. Only messages whose text matches are forwarded to Claude; DMs are unaffected. Invalid patterns fall back to no filter with a logged warning. Hot-reload supported.

### v0.0.3 (2026-03-24)
- **Breaking:** Rewrote connection lifecycle based on OpenClaw patterns
- 515 treated as normal reconnect (was fatal `process.exit`)
- Never `process.exit` in reconnect loop (only 440/401 stop)
- Exponential backoff with jitter + reset after healthy period (60s)
- Watchdog detects stale connections (30min timeout)
- Credential backup/restore before each save
- `getMessage` handler for E2EE retry (required in Baileys v7)
- Crypto error handler (reconnect instead of crash)
- Permission relay capability (`claude/channel/permission`)
- `process.setMaxListeners(50)` to avoid warnings
- Full listener cleanup before reconnecting

### v0.0.2 (2026-03-23)
- `browser` fixed to `["Mac OS", "Safari", "1.0.0"]` (valid for Baileys v7)
- Basic exponential backoff + max retries
- Creds save with retry
- Permission relay (outbound + inbound)

### v0.0.1 (2026-03-21)
- Initial implementation based on OpenClaw's architecture
- Baileys v7.0.0-rc.9
- MCP server with channel capability
- 4 tools: reply, react, download_attachment, fetch_messages
- Access control via allowlist
- Deduplication cache (20min TTL)

## License

MIT
