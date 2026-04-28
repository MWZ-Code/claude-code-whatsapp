#!/usr/bin/env node
/**
 * diag.cjs — Diagnostic tool for the WhatsApp HTTP bridge.
 *
 * Validates channel configuration using test_access.json instead of the
 * production access.json.  Equivalent to running app.cjs with:
 *   WHATSAPP_ACCESS_FILE=<state_dir>/test_access.json
 *
 * Usage:
 *   node diag.cjs
 *   WHATSAPP_STATE_DIR=~/.config/whatsapp-bridge node diag.cjs
 *
 * Exit codes:
 *   0 — all checks passed (warnings allowed)
 *   1 — one or more checks failed
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Resolve paths ────────────────────────────────────────────────────

function expandHome(p) {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

function resolveStateDir() {
  const env = process.env.WHATSAPP_STATE_DIR;
  if (env) return expandHome(env);

  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const next = path.join(xdg, "whatsapp-bridge");
  const legacy = path.join(os.homedir(), ".claude", "channels", "whatsapp");

  if (!fs.existsSync(next) && fs.existsSync(path.join(legacy, "auth", "creds.json"))) {
    return legacy;
  }
  return next;
}

const STATE_DIR = resolveStateDir();

const TEST_ACCESS_FILE = path.join(STATE_DIR, "test_access.json");
const AUTH_DIR         = path.join(STATE_DIR, "auth");
const INBOX_DIR        = path.join(STATE_DIR, "inbox");
const PROD_ACCESS_FILE = path.join(STATE_DIR, "access.json");

// ── Result accumulator ───────────────────────────────────────────────

const results = [];
let failCount = 0;

function ok(label, detail)   { results.push({ status: "pass", label, detail }); }
function bad(label, detail)  { results.push({ status: "fail", label, detail }); failCount++; }
function note(label, detail) { results.push({ status: "warn", label, detail }); }

// ── Helpers ──────────────────────────────────────────────────────────

function tryReadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function checkPhoneOrJid(entry) {
  if (typeof entry !== "string") return false;
  const stripped = entry.trim();
  if (!stripped) return false;
  // accept bare numbers, E.164 (+...), or JIDs
  return /^[+0-9@.\-_:]+$/.test(stripped);
}

// ── 1. State directory ───────────────────────────────────────────────

if (fs.existsSync(STATE_DIR)) {
  ok("state_dir", STATE_DIR);
} else {
  bad("state_dir", `not found: ${STATE_DIR}`);
}

// ── 2. test_access.json ──────────────────────────────────────────────

let access = null;

if (!fs.existsSync(TEST_ACCESS_FILE)) {
  bad("test_access.json",
    `not found: ${TEST_ACCESS_FILE}\n` +
    `  Create it based on access.json — it is safe to use a restricted allow-list for tests.`
  );
} else {
  try {
    access = tryReadJson(TEST_ACCESS_FILE);
    ok("test_access.json", TEST_ACCESS_FILE);
  } catch (e) {
    bad("test_access.json", `parse error: ${e.message}`);
  }
}

// ── 3. Validate access fields ────────────────────────────────────────

if (access !== null) {
  // allowFrom
  if (!Array.isArray(access.allowFrom)) {
    bad("access.allowFrom", `expected array, got ${typeof access.allowFrom}`);
  } else if (access.allowFrom.length === 0) {
    note("access.allowFrom", "empty — all direct messages are allowed (no allowlist)");
  } else {
    const invalid = access.allowFrom.filter((a) => !checkPhoneOrJid(a));
    if (invalid.length > 0) {
      bad("access.allowFrom", `invalid entries: ${JSON.stringify(invalid)}`);
    } else {
      ok("access.allowFrom", access.allowFrom.join(", "));
    }
  }

  // allowGroups
  if (access.allowGroups !== undefined && typeof access.allowGroups !== "boolean") {
    bad("access.allowGroups", `expected boolean, got ${typeof access.allowGroups}`);
  } else {
    ok("access.allowGroups", String(access.allowGroups ?? false));
  }

  // allowedGroups
  if (access.allowedGroups !== undefined && !Array.isArray(access.allowedGroups)) {
    bad("access.allowedGroups", `expected array, got ${typeof access.allowedGroups}`);
  } else if (access.allowGroups && Array.isArray(access.allowedGroups)) {
    if (access.allowedGroups.length === 0) {
      note("access.allowedGroups",
        "empty — all groups allowed (allowGroups=true); add JIDs to restrict"
      );
    } else {
      const nonJid = access.allowedGroups.filter((g) => !g.endsWith("@g.us"));
      if (nonJid.length > 0) {
        note("access.allowedGroups",
          `${nonJid.length} entry(ies) lack @g.us suffix: ${nonJid.join(", ")}`
        );
      } else {
        ok("access.allowedGroups", `${access.allowedGroups.length} group JID(s)`);
      }
    }
  }

  // requireAllowFromInGroups consistency
  if (access.requireAllowFromInGroups) {
    if (!access.allowGroups) {
      note("access.requireAllowFromInGroups",
        "set but allowGroups=false — has no effect"
      );
    } else if (!Array.isArray(access.allowFrom) || access.allowFrom.length === 0) {
      note("access.requireAllowFromInGroups",
        "true but allowFrom is empty — will block all group messages"
      );
    } else {
      ok("access.requireAllowFromInGroups", "true");
    }
  }

  // Check for unrecognised keys (non-fatal)
  const known = new Set([
    "allowFrom", "allowGroups", "allowedGroups", "requireAllowFromInGroups",
  ]);
  const extra = Object.keys(access).filter((k) => !known.has(k));
  if (extra.length > 0) {
    note("test_access.json (unknown keys)", extra.join(", "));
  }
}

// ── 4. Production access.json ────────────────────────────────────────

if (fs.existsSync(PROD_ACCESS_FILE)) {
  ok("access.json (prod)", "present");
} else {
  note("access.json (prod)", `not found: ${PROD_ACCESS_FILE} (will use open defaults)`);
}

// ── 5. Auth credentials ──────────────────────────────────────────────

if (!fs.existsSync(AUTH_DIR)) {
  bad("auth_dir", `not found: ${AUTH_DIR} — run pair.cjs to initialise`);
} else {
  ok("auth_dir", AUTH_DIR);

  const credsPath   = path.join(AUTH_DIR, "creds.json");
  const backupPath  = path.join(AUTH_DIR, "creds.json.bak");

  if (!fs.existsSync(credsPath)) {
    bad("creds.json", "not found — device is not paired (run pair.cjs)");
  } else {
    try {
      tryReadJson(credsPath);
      const stat = fs.statSync(credsPath);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== "600") {
        note("creds.json", `present but permissions are ${mode} (recommend 600)`);
      } else {
        ok("creds.json", "valid JSON, permissions 600");
      }
    } catch (e) {
      bad("creds.json", `corrupt or unreadable: ${e.message}`);
      if (fs.existsSync(backupPath)) {
        note("creds.json.bak", "backup exists — server will auto-restore on next start");
      }
    }
  }
}

// ── 6. Inbox directory ───────────────────────────────────────────────

if (!fs.existsSync(INBOX_DIR)) {
  note("inbox_dir", `not found — will be created on first use (${INBOX_DIR})`);
} else {
  let count;
  try { count = fs.readdirSync(INBOX_DIR).length; } catch { count = "?"; }
  ok("inbox_dir", `${count} file(s) — ${INBOX_DIR}`);
}

// ── Report ───────────────────────────────────────────────────────────

const WIDTH = 35;
const icons = { pass: "✓", fail: "✗", warn: "⚠" };

console.log();
console.log("WhatsApp channel diagnostic");
console.log("=".repeat(60));
console.log(`  state_dir:        ${STATE_DIR}`);
console.log(`  test_access_file: ${TEST_ACCESS_FILE}`);
console.log();

for (const { status, label, detail } of results) {
  const icon = icons[status];
  // Multi-line detail: indent continuation lines
  const lines = detail.split("\n");
  const first = lines[0];
  const rest  = lines.slice(1).map((l) => " ".repeat(4 + WIDTH) + l).join("\n");
  const row = `  ${icon}  ${label.padEnd(WIDTH)} ${first}`;
  console.log(rest ? row + "\n" + rest : row);
}

console.log();
if (failCount > 0) {
  console.error(`FAIL — ${failCount} check(s) failed`);
  process.exit(1);
} else {
  console.log("PASS — all checks OK");
  console.log();
  console.log("Run app.cjs with test access config:");
  console.log(
    `  WHATSAPP_STATE_DIR=${STATE_DIR} \\`
  );
  console.log(
    `  WHATSAPP_ACCESS_FILE=${TEST_ACCESS_FILE} \\`
  );
  console.log(
    `  node app.cjs`
  );
  process.exit(0);
}
