# access.json

Channel access-control file consumed by `app.cjs`. Lives at
`$WHATSAPP_STATE_DIR/access.json` (default:
`${XDG_CONFIG_HOME:-~/.config}/whatsapp-bridge/access.json`; existing installs
on the legacy `~/.claude/channels/whatsapp/access.json` still work — see the
README for the back-compat resolution rules). Override the path with
`WHATSAPP_ACCESS_FILE`.

`app.cjs` re-reads this file on every inbound message and on every
outbound `/reply` or `/react` — edits take effect without restarting the
server. If the file is missing, the channel falls back to **open defaults**
(inbound: all DMs accepted, all groups blocked; outbound: any `chat_id`
permitted). If the file is present but corrupt, the server renames it to
`access.json.corrupt-<ts>` and also falls back to open defaults.

## Outbound gating

When `access.json` is **present**, the same allow-set used for inbound also
gates outbound `/reply` and `/react`: the supplied `chat_id` must satisfy
`allowGroups` / `allowedGroups` (for groups) or appear in `allowFrom` (for
DMs, when `allowFrom` is non-empty). Calls to a non-permitted `chat_id`
return `403 chat_id … not permitted by access.json`. `requireAllowFromInGroups`
is inbound-only; it does not constrain who you can reply to.

When `access.json` is **absent**, the send path stays wide open — existing
installs without an access file keep working unchanged.

## Schema (5 keys, all optional)

| Key | Type | Default | Purpose |
|---|---|---|---|
| `allowFrom` | `string[]` | `[]` | DM allowlist. Each entry is a bare phone number (country code first, digits only, no `+`) or a full JID like `15551234567@s.whatsapp.net`. Empty array = accept DMs from anyone. **Also serves as the recipient list for outbound permission requests.** |
| `allowGroups` | `boolean` | `false` | Master switch for group chats. When `false`, every group message is dropped. |
| `allowedGroups` | `string[]` | `[]` | Group allowlist. Each entry is a group JID ending in `@g.us`. Empty array (with `allowGroups=true`) = accept all groups. |
| `requireAllowFromInGroups` | `boolean` | `false` | When `true`, a group message is accepted only if the sending participant's JID matches an entry in `allowFrom`. Lets the bot sit in a public group but only react to specific people. No effect when `allowGroups=false`. |
| `mentionKey` | `string \| null` | `null` | Case-insensitive regex applied to group message text. When set, group messages whose text does not match are silently dropped before reaching Claude. DMs are never filtered. Invalid patterns disable the filter with a logged warning. |

## Common shapes

**DM-only, single owner**

```json
{ "allowFrom": ["15551234567"], "allowGroups": false }
```

**Single group, anyone in it can talk to the bot**

```json
{
  "allowFrom": ["15551234567"],
  "allowGroups": true,
  "allowedGroups": ["1234567890-1234567890@g.us"],
  "requireAllowFromInGroups": false
}
```

`allowFrom` is still required here — that's where permission-request DMs are
sent if/when Claude Code asks for tool approval.

**Single group, gated to specific senders**

```json
{
  "allowFrom": ["15551234567", "447700900000"],
  "allowGroups": true,
  "allowedGroups": ["1234567890-1234567890@g.us"],
  "requireAllowFromInGroups": true
}
```

## Finding the group JID

Run the server with `WHATSAPP_TRACE=1` (see the README's Debugging section)
and send any message in the target group. Grep stderr for
`whatsapp trace: inbound group` — the JID prints inline. Group JIDs always
end in `@g.us` and look like `1234567890-1234567890@g.us`.
