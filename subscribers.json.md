# subscribers.json — Redis Streams subscriber config

Optional config consumed by `app.cjs` to enable the Redis Streams ingress
publisher and/or egress consumer. Lives at
`${WHATSAPP_STATE_DIR:-${XDG_CONFIG_HOME:-~/.config}/whatsapp-bridge}/subscribers.json`,
overridable via `WHATSAPP_SUBSCRIBERS_FILE`.

When the file is absent both subscribers are disabled and the bridge
behaves byte-identically to the v0.2.x release. When `streams.raw.enabled`
is `true`, every accepted inbound message is XADD'd to `streams.raw.key`.
When `streams.egress.enabled` is `true`, the bridge runs an XREADGROUP
consumer on `streams.egress.key` and dispatches each entry through the
same internal send path that powers `POST /reply` and `POST /react`.

## Schema

| Key | Default | Description |
|-----|---------|-------------|
| `redis.url` | `"redis://127.0.0.1:6379"` | Redis connection URL. Used by both publisher and egress consumer. |
| `streams.raw.enabled` | `false` | Enable the inbound publisher. |
| `streams.raw.key` | `"whatsapp:raw"` | Stream key for the raw inbound publisher (XADD). |
| `streams.raw.maxLen` | `10000` | Approximate cap (`MAXLEN ~`) on the raw stream. |
| `streams.egress.enabled` | `false` | Enable the egress consumer. |
| `streams.egress.key` | `"whatsapp:egress"` | Stream key the egress consumer reads from (XREADGROUP). |
| `streams.egress.consumerGroup` | `"bridge"` | Consumer group name. Created with `MKSTREAM` if missing. |
| `egress.idempotencyLruSize` | `30` | Number of recent `request_id` values cached for dedup. |
| `egress.retry.maxAttempts` | `5` | Transient send failures are retried up to this many times before being dropped. |
| `egress.retry.queueMaxPerChat` | `100` | Per-chat cap on the in-memory retry queue. Prevents one stuck chat from exhausting memory. |

## Wire schemas

### `whatsapp:raw` (bridge → downstream consumers)

Each entry has a single `payload` field containing JSON:

```json
{
  "channel": "whatsapp",
  "id": "ABC...",
  "jid": "5511999999999@s.whatsapp.net",
  "participant": null,
  "from": "5511999999999",
  "text": "hi",
  "ts": 1735000000000,
  "arrivedAt": 1735000000123,
  "hasMedia": false,
  "mediaType": null,
  "key": { "remoteJid": "5511999999999@s.whatsapp.net", "fromMe": false, "id": "ABC..." }
}
```

### `whatsapp:egress` (producers → bridge)

```json
{
  "channel": "whatsapp",
  "op": "reply",
  "chat_id": "5511999999999@s.whatsapp.net",
  "text": "hello",
  "files": [],
  "reply_to": null,
  "request_id": "uuid-or-stable-key",
  "producer_id": "my_bot_v1"
}
```

For reactions:

```json
{
  "channel": "whatsapp",
  "op": "react",
  "chat_id": "5511999999999@s.whatsapp.net",
  "message_id": "ABC...",
  "emoji": "👍",
  "request_id": "uuid",
  "producer_id": "my_bot_v1"
}
```

`request_id` is the idempotency key. The egress consumer dedups on it via
an in-memory LRU sized by `egress.idempotencyLruSize`.

## Failure semantics

- **Middleware rejection** (e.g. `chat_id` blocked by `access.json`,
  text exceeds `WHATSAPP_MAX_TEXT_CHARS`, file too large): silent-fail.
  The entry is logged and ACK'd. There is no producer feedback channel
  in v1.
- **Transient send failures** (Baileys throws / not connected): leave
  un-ACK'd, retry in-memory with exponential backoff up to
  `egress.retry.maxAttempts`. After exhaustion the entry is dropped and
  ACK'd; the `dropped_retry_exhausted` counter on `GET /status` ticks.
- **Redis disconnect during XADD** on `whatsapp:raw`: drop with logged
  counter (`dropped_no_connection`). Never blocks the WhatsApp event
  loop.
- **Egress consumer disconnect**: the loop sleeps 1s and retries.
  Un-ACK'd entries become available for XCLAIM by sibling consumers.

## Observability

`GET /status` returns subscriber counters under `subscribers`:

```json
{
  "connected": true,
  "subscribers": {
    "raw": { "enabled": true, "published": 142, "droppedNoConnection": 0, "droppedError": 0 },
    "egress": {
      "enabled": true,
      "dropped_middleware": 0,
      "dropped_duplicate": 0,
      "dropped_retry_exhausted": 0,
      "dropped_queue_full": 0
    }
  }
}
```
