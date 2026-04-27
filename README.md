# WhatsApp Channel for Claude Code

A standalone WhatsApp bridge using [Baileys](https://github.com/WhiskeySockets/Baileys) v7
(WhatsApp Web Multi-Device protocol). Runs as its own long-lived HTTP server
(systemd `--user` unit) and exposes a small RPC-flat HTTP API on loopback.
Consumed by any agent through the bundled `whatsapp-channel` skill — no MCP,
no plugin runtime coupling.

> **Note:** This is a personal project that I've open-sourced for the community. It works for my 24/7 setup and I'm sharing it as-is. PRs are welcome.

## How it works

```
WhatsApp (phone)
    ↕ Baileys v7.0.0-rc.9 (Multi-Device protocol)
server.cjs (HTTP server on 127.0.0.1:8787)
    ↕ HTTP POST /reply, /react, /download_attachment, /fetch_messages
    ↕ HTTP GET  /health, /status
Any consumer (Claude Code agent via skill, curl, your own script)
```

The server runs independently of any agent runtime. Inbound messages are
buffered in memory; consumers poll `POST /fetch_messages` to pop new messages
(server-side per-chat cursor). There is no push channel.

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
- **systemd** with `--user` units enabled (Linux). Other init systems work too — just adapt `deploy/claude-whatsapp-http.service` by hand.
- **WhatsApp** account (regular or Business)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/MWZ-Code/claude-code-whatsapp.git
cd claude-code-whatsapp
npm install
```

### 2. Pair with WhatsApp

```bash
mkdir -p ~/.claude/channels/whatsapp/auth
WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp node pair.cjs
```

The script shows both a **QR code** and a **pairing code**. On your phone:
- **QR:** WhatsApp > Linked Devices > Link a Device — scan the QR
- **Code:** WhatsApp > Linked Devices > Link a Device > Link with phone number — enter the code

Wait for "✅ WhatsApp connected!" before closing.

### 3. Install the systemd unit

```bash
bash deploy/install.sh
```

This renders `deploy/claude-whatsapp-http.service` into
`~/.config/systemd/user/` (paths and the Node binary are detected from your
environment), runs `systemctl --user daemon-reload`, then
`systemctl --user enable --now claude-whatsapp-http.service`. It's safe to
re-run any time — it diffs the rendered unit and only rewrites on change.

Override paths via env vars if needed:

```bash
NODE_BIN=/home/user/.local/bin/node \
STATE_DIR=~/.claude/channels/whatsapp \
WORKING_DIR=/path/to/claude-code-whatsapp \
bash deploy/install.sh
```

Confirm it's up:

```bash
curl -s http://127.0.0.1:8787/health
# → {"status":"ok"}

curl -s http://127.0.0.1:8787/status
# → {"connected":true,"last_inbound_at":...,"retry_count":0,"watchdog_age_ms":...}
```

Tail logs with `journalctl --user -u claude-whatsapp-http.service -f`.

### 4. Wire the skill (Claude Code consumers only)

This repo ships a `whatsapp-channel` skill under `skills/whatsapp-channel/`.
When Claude Code loads this directory as a plugin, the skill auto-loads and
documents every endpoint with curl examples and request/response shapes for
the agent. There is no `.mcp.json` to register — the skill is the contract.

For non-Claude-Code consumers, just hit the HTTP API directly. The skill is a
human-and-agent-readable reference that lives next to the server.

### 5. Access control (optional)

Create `~/.claude/channels/whatsapp/access.json`:

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
curl examples. Or read the handlers directly in `server.cjs`.

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
WHATSAPP_TRACE=1 WHATSAPP_STATE_DIR=~/.claude/channels/whatsapp \
  node server.cjs 2>&1 | grep '^whatsapp trace:'
```

Each inbound message produces two lines: the `inbound …` line classifies the
chat (`dm` / `group` / `broadcast` / `status`) and shows the JID, sender
participant (groups only), message id, and an 80-char text preview; the
indented follow-up line shows the decision (`accept` or `drop: <reason>`).

**Finding a group's JID.** Group JIDs look like `1234567890-1234567890@g.us`
and aren't exposed in the WhatsApp UI. With trace enabled, send any message
in the target group and grep:

```bash
WHATSAPP_TRACE=1 node server.cjs 2>&1 | grep 'whatsapp trace: inbound group'
```

The first hit gives you the JID to paste into `access.json` under
`allowedGroups`.

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `connection refused` from curl | systemd unit not running | `systemctl --user start claude-whatsapp-http.service` |
| `503 WhatsApp not connected` | Auth expired or not paired, or still reconnecting | Run `pair.cjs` if needed; otherwise wait and poll `/status` |
| Error 515 in journal | Normal — WhatsApp requested restart | Auto-handled (reconnect in 2s) |
| Error 440 in journal | Two devices competing | Unlink in phone settings, re-pair |
| Error 401 in journal | Logged out | Session invalidated, re-pair |
| Rate limit on pairing | Too many rapid attempts | Wait 1-2 hours, try ONCE |
| Messages stop without error | Zombie connection | Watchdog detects in 30min. Or `systemctl --user restart claude-whatsapp-http.service` |
| `creds.json` corrupted | Crash during save | Restored from backup automatically on next boot |

## Changelog

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
