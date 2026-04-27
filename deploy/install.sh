#!/usr/bin/env bash
# Install (or refresh) the claude-whatsapp-http systemd --user unit.
#
# Idempotent: safe to re-run. It re-renders the template, runs daemon-reload,
# and re-enables --now. If the unit is already running, the kernel-side
# `daemon-reload + enable --now` cycle is a no-op when the rendered file is
# byte-identical, otherwise systemd picks up the new file on next start.
#
# Overrides (env vars):
#   STATE_DIR    Where the channel keeps creds/inbox/access.json.
#                Default: $WHATSAPP_STATE_DIR or ~/.claude/channels/whatsapp
#   NODE_BIN     Absolute path to the Node binary to launch the server with.
#                Default: $(command -v node)
#   WORKING_DIR  Where server.cjs lives. Default: parent of this script.
#   UNIT_DIR     Where to write the rendered .service file.
#                Default: ~/.config/systemd/user

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/claude-whatsapp-http.service"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install.sh: template not found at $TEMPLATE" >&2
  exit 1
fi

WORKING_DIR="${WORKING_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
STATE_DIR="${STATE_DIR:-${WHATSAPP_STATE_DIR:-${HOME}/.claude/channels/whatsapp}}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
UNIT_DIR="${UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
UNIT_NAME="claude-whatsapp-http.service"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "install.sh: NODE_BIN is not set and 'node' is not on PATH." >&2
  echo "             Set NODE_BIN=/path/to/node and re-run." >&2
  exit 1
fi

if [[ ! -f "${WORKING_DIR}/server.cjs" ]]; then
  echo "install.sh: ${WORKING_DIR}/server.cjs not found." >&2
  echo "             Set WORKING_DIR=/path/to/claude-code-whatsapp and re-run." >&2
  exit 1
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
