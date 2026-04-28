---
name: whatsapp-channel
description: >
  Talk to a paired WhatsApp account through the local whatsapp-http bridge.
  Use this skill whenever you need to fetch new inbound WhatsApp messages,
  send a reply, edit a previously sent reply, react to a message, or download
  an attachment. The transport is plain HTTP on loopback — polling-based, no
  MCP, no push notifications, no webhook. Trigger this skill any time the
  user mentions WhatsApp, the bot, replying to a chat, fetching messages, or
  any of the routes listed below.
user-invocable: false
---

# WhatsApp Channel (HTTP)

The WhatsApp bridge runs as its own long-lived process
(`whatsapp-http.service`, see `deploy/`) and exposes an RPC-flat HTTP
API on `127.0.0.1:8787` (override with `WHATSAPP_HTTP_BIND` /
`WHATSAPP_HTTP_PORT`). All operations are `curl`-friendly. There is no auth on
the loopback interface and no push channel — **this is polling-based. No push
notifications, no MCP.** Consumers fetch new messages on a cadence of their
choosing.

## Quick orientation

- Base URL: `http://127.0.0.1:8787`
- All bodies: `Content-Type: application/json`
- All responses: JSON. Success = `2xx`. Failure = non-2xx with
  `{"error": "<reason>"}`.
- WhatsApp not yet connected? Any route that depends on the WhatsApp socket
  (`/reply`, `/react`, `/download_attachment`, `/fetch_messages`) returns
  **HTTP 503** `{"error": "WhatsApp not connected"}`. Treat that as transient
  and retry. `/health` and `/status` always succeed.
- The HTTP server may not be running. A connection-refused / ECONNREFUSED
  error means the systemd unit is down — surface it to the user and stop the
  current task; do not try to recover the bridge from this layer.

## Endpoints

### `GET /health`

Liveness probe. Returns `200 {"status":"ok"}` whenever the process is up
(regardless of WhatsApp connection state).

```bash
curl -s http://127.0.0.1:8787/health
# → {"status":"ok"}
```

### `GET /status`

Runtime status. Use this to check whether the WhatsApp socket is connected
before depending on a mutating call.

```bash
curl -s http://127.0.0.1:8787/status
# → {"connected":true,"last_inbound_at":1730000000000,"retry_count":0,"watchdog_age_ms":12345}
```

| Field | Type | Meaning |
|---|---|---|
| `connected` | bool | True iff Baileys socket is open and authenticated. |
| `last_inbound_at` | number\|null | Epoch ms of the last inbound message accepted (post access.json filter). `null` if none yet this run. |
| `retry_count` | number | Current reconnect-attempt counter. Resets to 0 once a connection has been healthy >60s. |
| `watchdog_age_ms` | number\|null | Milliseconds since `last_inbound_at`. After 30 min the watchdog forces a reconnect. |

### `POST /fetch_messages`

Pop new inbound messages for a chat since the last call (server-side cursor).
Calling it twice returns disjoint sets — the channel maintains the cursor
per `chat_id` in memory. This is the only way to read messages.

Request body:

```json
{ "chat_id": "1234567890-1234567890@g.us", "limit": 20 }
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `chat_id` | string | yes | — | WhatsApp JID (e.g. `5511999999999@s.whatsapp.net` for a DM, `<id>@g.us` for a group). |
| `limit` | number | no | 20 | Capped at 100. |

Response:

```json
{
  "messages": [
    {
      "id": "3EB0...",
      "from": "5511999999999",
      "text": "Hello bot",
      "ts": 1730000000000,
      "arrivedAt": 1730000000123,
      "hasMedia": false,
      "mediaType": null
    }
  ]
}
```

Empty result is `{"messages": []}` — not an error.

```bash
curl -s -X POST http://127.0.0.1:8787/fetch_messages \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"1234567890-1234567890@g.us"}'
```

### `POST /reply`

Send a new WhatsApp message, or edit a previously sent message.

Request body:

```json
{
  "chat_id": "1234567890-1234567890@g.us",
  "text": "Hello!",
  "edit": null,
  "reply_to": null,
  "files": [],
  "send_as_document": false,
  "agent_message": false
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `chat_id` | string | yes | Target JID. |
| `text` | string | conditional | Required unless only sending files. Server enforces `WHATSAPP_MAX_TEXT_CHARS` (default 4096); over-limit returns **HTTP 413** with a `text too long` error — switch to the report pipeline and resend as document. |
| `edit` | string | no | Message ID to edit. When set, the call updates that existing message in place. Only works on messages previously sent by the bot. |
| `reply_to` | string | no | Message ID to quote-reply to. Ignored when `edit` is set. |
| `files` | string[] | no | Absolute paths to attach. Each must be ≤ 64 MiB; refusing path = anything inside the channel state dir other than the `inbox/` subtree. |
| `send_as_document` | bool | no | Force every file to be sent as a document (preserves quality, bypasses WhatsApp image compression). |
| `agent_message` | bool | no | Skip dedup tracking so the message is observable via `fetch_messages` (used for round-trip diagnostics). |

Response:

```json
{ "sent_id": "3EB0..." }
```

Or, when `edit` was set:

```json
{ "edited_id": "3EB0..." }
```

```bash
curl -s -X POST http://127.0.0.1:8787/reply \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"1234567890-1234567890@g.us","text":"hello from HTTP"}'
```

Two-step "Working on…" pattern:

```bash
# 1. Send placeholder, capture the ID
PID=$(curl -s -X POST http://127.0.0.1:8787/reply \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<JID>","text":"⏳ Working on — fetching pnl"}' | jq -r .sent_id)

# 2. Run the task...

# 3. Edit the placeholder with the final answer
curl -s -X POST http://127.0.0.1:8787/reply \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg id "$PID" --arg t "🛰️ LIVE TOOL DATA"$'\n'"─────────────────"$'\n'"BTC: \$67k" \
        '{chat_id:"<JID>", edit:$id, text:$t}')"
```

### `POST /react`

Add an emoji reaction.

```json
{ "chat_id": "<JID>", "message_id": "3EB0...", "emoji": "👍" }
```

```bash
curl -s -X POST http://127.0.0.1:8787/react \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<JID>","message_id":"3EB0...","emoji":"👍"}'
# → {"reacted":true}
```

### `POST /download_attachment`

Materialize an inbound media message to disk. The downloaded file is written
to `${WHATSAPP_STATE_DIR}/inbox/`.

```json
{ "chat_id": "<JID>", "message_id": "3EB0..." }
```

Response:

```json
{
  "file_path": "/home/user/.config/whatsapp-bridge/inbox/1730000000000-photo.jpg",
  "type": "image",
  "size_bytes": 184321
}
```

```bash
curl -s -X POST http://127.0.0.1:8787/download_attachment \
  -H 'Content-Type: application/json' \
  -d '{"chat_id":"<JID>","message_id":"3EB0..."}'
```

Errors: `404 message not found in cache` (the in-memory raw-message buffer
holds the last 500 messages; older IDs cannot be re-downloaded).

## Error semantics

| HTTP status | Meaning | Recovery |
|---|---|---|
| 200 | Success. | — |
| 400 | Bad request body (missing field, invalid JSON, body too large). | Fix the request. |
| 404 | Unknown route OR `download_attachment` for an unknown message ID. | — |
| 413 | `reply` text over `WHATSAPP_MAX_TEXT_CHARS`. | Use the report pipeline (send as document) and retry. |
| 500 | Unhandled handler error. | Surface to user; the body's `error` field has the details. |
| 503 | WhatsApp socket not connected. | Transient; retry after polling `/status` for `connected:true`. |
| ECONNREFUSED at the TCP layer | The HTTP server itself is down (systemd unit stopped or crashed). | Tell the user; do NOT attempt to start it from inside an agent task. |

## Access control (`access.json`)

The HTTP server filters inbound messages against `${WHATSAPP_STATE_DIR}/access.json`
(or whatever `WHATSAPP_ACCESS_FILE` points at). The file is hot-reloaded —
edits take effect on the next inbound message, no restart required. Outbound
operations (`/reply`, `/react`, `/download_attachment`) are NOT gated by this
file; anything with HTTP access can send.

Schema (see `access.json.md` in this repo for the full reference):

```json
{
  "allowFrom": ["5511999999999"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "mentionKey": null
}
```

| Field | Default | Effect |
|---|---|---|
| `allowFrom` | `[]` | Phone numbers allowed to DM. Empty = anyone. |
| `allowGroups` | `false` | Master switch for group chats. |
| `allowedGroups` | `[]` | Specific group JIDs to allow when `allowGroups: true`. Empty = all groups. |
| `requireAllowFromInGroups` | `false` | When true, a group message is only accepted if `participant` is in `allowFrom`. |
| `mentionKey` | `null` | Case-insensitive regex string. When set, group messages must match for the channel to forward them. DMs are never filtered by this. |

## Polling guidance

- There is no push channel and no long-poll. You **must** call
  `/fetch_messages` on a cadence to discover new messages.
- The server-side cursor means you do not have to track which messages you
  have already seen — every call returns only what arrived since your last
  call for that `chat_id`.
- A typical foreground bot polls every 5 seconds. A background watcher can
  poll less often. There is no minimum interval — the server caches inbound
  messages until the next `fetch_messages` call.
- The in-memory buffer holds at most 100 messages per chat. If the bot is
  offline long enough for more than 100 messages to arrive in a single chat,
  the oldest are dropped silently.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `connection refused` on every call | systemd unit not running. | `systemctl --user start whatsapp-http.service`, then check `journalctl --user -u whatsapp-http.service`. |
| `503 WhatsApp not connected` after the unit restarts | Baileys still reconnecting. | Wait, then poll `/status` until `connected: true`. |
| `404 message not found in cache` | Message ID is older than the 500-entry raw buffer or never arrived this process lifetime. | The attachment is unrecoverable from this layer; ask the sender to resend. |
| `413 text too long` on `/reply` | Text exceeds `WHATSAPP_MAX_TEXT_CHARS`. | Render to a file (e.g. via `tools/render_report.py`) and re-`/reply` with `files=[<path>], send_as_document=true`. |
