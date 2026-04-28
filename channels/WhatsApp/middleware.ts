// Single source of truth for ingress + egress filter logic shared by the
// HTTP handlers (handleReply / handleReact / messages.upsert listener) and
// the Redis egress consumer. Pure functions: no I/O except file-stat /
// realpath for the path-safety check.

import * as fs from "fs";
import * as path from "path";

export type AccessConfig = {
  allowFrom: string[];
  allowGroups: boolean;
  allowedGroups: string[];
  requireAllowFromInGroups: boolean;
  mentionKey: string | null;
  _present: boolean;
  _mentionRe: RegExp | null;
};

export type InboundDrop = { ok: false; reason: string };
export type InboundAccept = { ok: true };
export type InboundResult = InboundAccept | InboundDrop;

export type EgressDrop = { ok: false; reason: string };
export type EgressAccept = { ok: true };
export type EgressResult = EgressAccept | EgressDrop;

const DROP = (reason: string): InboundDrop => ({ ok: false, reason });
const EGRESS_DROP = (reason: string): EgressDrop => ({ ok: false, reason });
const ACCEPT: InboundAccept = { ok: true };
const EGRESS_ACCEPT: EgressAccept = { ok: true };

function toJid(phone: string): string {
  if (phone.includes("@")) return phone;
  return `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

export function isAllowed(access: AccessConfig, jid: string, participant?: string): boolean {
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

// Soft mirror of inbound access for the send path. Until separate
// senders/recipients scopes exist, reuse isAllowed: if the operator scoped
// inbound to specific JIDs/groups, the same set gates sends. When
// access.json is absent the send path stays open so existing installs keep
// working without one. requireAllowFromInGroups is inbound-only and is
// skipped here (we don't know who's reading on the other side).
export function isSendAllowed(access: AccessConfig, jid: string): boolean {
  if (!access._present) return true;
  return isAllowed(access, jid, undefined);
}

export type CheckInboundArgs = {
  jid: string;
  participant?: string | undefined;
  msgId: string | undefined;
  text: string;
  fromMe: boolean;
  isOwnSentId: (id: string) => boolean;
  isDuplicate: (key: string) => boolean;
  access: AccessConfig;
};

export function checkInbound(args: CheckInboundArgs): InboundResult {
  const { jid, participant, msgId, text, fromMe, isOwnSentId, isDuplicate, access } = args;

  if (fromMe && msgId && isOwnSentId(msgId)) return DROP("bot's own reply");
  if (jid.endsWith("@broadcast") || jid.endsWith("@status")) return DROP("broadcast/status");
  if (msgId && isDuplicate(`${jid}:${msgId}`)) return DROP("duplicate within dedup window");
  if (!isAllowed(access, jid, participant || undefined)) return DROP("blocked by access.json");

  if (jid.endsWith("@g.us") && access._mentionRe) {
    if (!access._mentionRe.test(text)) return DROP("mentionKey regex no match");
  }

  return ACCEPT;
}

export type CheckEgressArgs = {
  op: "reply" | "react";
  chat_id: string;
  text?: string | undefined;
  files?: string[] | undefined;
  emoji?: string | undefined;
  message_id?: string | undefined;
  access: AccessConfig;
  maxTextChars: number;
  stateDir: string;
  agent_message?: boolean;
};

export function checkEgress(args: CheckEgressArgs): EgressResult {
  const {
    op, chat_id, text, files, emoji, message_id,
    access, maxTextChars, stateDir, agent_message,
  } = args;

  if (!chat_id) return EGRESS_DROP("chat_id required");

  if (op === "reply") {
    // Either text or files must be provided, but checking that is the
    // caller's responsibility — middleware only enforces what's invariant.
    if (text && text.length > maxTextChars && !agent_message) {
      return EGRESS_DROP(
        `text too long: ${text.length} chars (limit ${maxTextChars})`
      );
    }
    if (files && files.length > 0) {
      for (const f of files) {
        try {
          assertSendable(f, stateDir);
        } catch (e) {
          return EGRESS_DROP(`unsafe file path: ${(e as Error).message}`);
        }
        try {
          const st = fs.statSync(f);
          if (st.size > 64 * 1024 * 1024) return EGRESS_DROP(`file too large: ${f}`);
        } catch {
          return EGRESS_DROP(`file not readable: ${f}`);
        }
      }
    }
  } else if (op === "react") {
    if (!message_id || !emoji) return EGRESS_DROP("message_id and emoji required for react");
  } else {
    return EGRESS_DROP(`unknown op: ${op}`);
  }

  if (!isSendAllowed(access, chat_id)) {
    return EGRESS_DROP(`chat_id ${chat_id} not permitted by access.json`);
  }

  return EGRESS_ACCEPT;
}

export function assertSendable(f: string, stateDir: string): void {
  const real = fs.realpathSync(f);
  const stateReal = fs.realpathSync(stateDir);
  const inbox = path.join(stateReal, "inbox");
  if (real.startsWith(stateReal + path.sep) && !real.startsWith(inbox + path.sep)) {
    throw new Error(`refusing to send channel state: ${f}`);
  }
}
