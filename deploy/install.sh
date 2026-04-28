#!/usr/bin/env bash
# Install (or refresh) the whatsapp-http systemd --user unit.
#
# Idempotent: safe to re-run. It re-renders the template, runs daemon-reload,
# and re-enables --now. If the unit is already running, the kernel-side
# `daemon-reload + enable --now` cycle is a no-op when the rendered file is
# byte-identical, otherwise systemd picks up the new file on next start.
#
# Overrides (env vars):
#   STATE_DIR    Where the bridge keeps creds/inbox/access.json.
#                Default: $WHATSAPP_STATE_DIR or
#                ${XDG_CONFIG_HOME:-~/.config}/whatsapp-bridge.
#                Falls back to the legacy ~/.claude/channels/whatsapp when
#                that directory exists and the new default does not, so old
#                installs keep working without manual migration.
#   NODE_BIN     Absolute path to the Node binary to launch the server with.
#                Default: $(command -v node)
#   WORKING_DIR  Where app.cjs lives. Default: parent of this script.
#   UNIT_DIR     Where to write the rendered .service file.
#                Default: ~/.config/systemd/user

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/whatsapp-http.service"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install.sh: template not found at $TEMPLATE" >&2
  exit 1
fi

WORKING_DIR="${WORKING_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

# Resolve the default state dir: prefer the new XDG location, but fall back
# to the legacy ~/.claude/... if it exists and the new one does not.
DEFAULT_NEW_STATE="${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-bridge"
LEGACY_STATE="${HOME}/.claude/channels/whatsapp"
if [[ -z "${STATE_DIR:-}" && -z "${WHATSAPP_STATE_DIR:-}" ]]; then
  if [[ ! -d "$DEFAULT_NEW_STATE" && -f "$LEGACY_STATE/auth/creds.json" ]]; then
    STATE_DIR="$LEGACY_STATE"
    echo "install.sh: using legacy state dir $LEGACY_STATE — set STATE_DIR or move it to $DEFAULT_NEW_STATE to silence this." >&2
  else
    STATE_DIR="$DEFAULT_NEW_STATE"
  fi
else
  STATE_DIR="${STATE_DIR:-${WHATSAPP_STATE_DIR}}"
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
UNIT_DIR="${UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
UNIT_NAME="whatsapp-http.service"
LEGACY_UNIT_NAME="claude-whatsapp-http.service"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "install.sh: NODE_BIN is not set and 'node' is not on PATH." >&2
  echo "             Set NODE_BIN=/path/to/node and re-run." >&2
  exit 1
fi

if [[ ! -f "${WORKING_DIR}/app.cjs" ]]; then
  echo "install.sh: ${WORKING_DIR}/app.cjs not found." >&2
  echo "             Set WORKING_DIR=/path/to/repo and re-run." >&2
  exit 1
fi

# Compile the TypeScript modules under channels/ and streams/ before
# starting. Cheap (esbuild) and idempotent — skips on no-op.
if [[ -f "${WORKING_DIR}/scripts/build.cjs" ]]; then
  echo "install.sh: building TS modules"
  ( cd "${WORKING_DIR}" && npm run --silent build ) || {
    echo "install.sh: build failed — fix TS errors before continuing." >&2
    exit 1
  }
fi

# Resolve STATE_DIR's leading ~ if any (the template needs an absolute path).
case "$STATE_DIR" in
  "~"|"~/"*) STATE_DIR="${HOME}${STATE_DIR#\~}" ;;
esac

# Build a PATH that includes the Node binary's dir first so shells in the
# unit can find it without a full absolute path.
NODE_DIR="$(dirname "$NODE_BIN")"
RENDERED_PATH="${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNIT_DIR"
mkdir -p "$STATE_DIR"

# Render template -> a temp file so we can compare and only rewrite on diff.
TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_OUT"' EXIT

sed \
  -e "s|@WORKING_DIR@|${WORKING_DIR}|g" \
  -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  -e "s|@STATE_DIR@|${STATE_DIR}|g" \
  -e "s|@PATH@|${RENDERED_PATH}|g" \
  "$TEMPLATE" > "$TMP_OUT"

DEST="${UNIT_DIR}/${UNIT_NAME}"
if [[ -f "$DEST" ]] && cmp -s "$TMP_OUT" "$DEST"; then
  echo "install.sh: ${DEST} already up to date."
else
  install -m 0644 "$TMP_OUT" "$DEST"
  echo "install.sh: wrote ${DEST}"
fi

# daemon-reload is cheap and idempotent.
systemctl --user daemon-reload

# enable --now is idempotent: if the unit is already enabled+active it is a
# no-op aside from ensuring the symlink exists.
systemctl --user enable --now "$UNIT_NAME"

echo "install.sh: ${UNIT_NAME} is enabled and active."
echo "install.sh: tail logs with: journalctl --user -u ${UNIT_NAME} -f"

# Heads-up if the previous claude-whatsapp-http unit is still around — it
# would compete for the same port and confuse logs. Don't disable it
# automatically; just point it out so the user can confirm before acting.
LEGACY_UNIT_PATH="${UNIT_DIR}/${LEGACY_UNIT_NAME}"
if [[ -f "$LEGACY_UNIT_PATH" ]]; then
  echo "install.sh: legacy ${LEGACY_UNIT_NAME} still present at ${LEGACY_UNIT_PATH}." >&2
  echo "             Disable it with: systemctl --user disable --now ${LEGACY_UNIT_NAME}" >&2
  echo "             Then remove the file: rm ${LEGACY_UNIT_PATH}" >&2
fi
