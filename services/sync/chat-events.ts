/**
 * Realtime chat event semantics, minus transport: message / event id shaping, the prev→next diff
 * that decides between an append event and a whole-session replace, and the two reducers that apply
 * those events locally.
 *
 * Pure: no clock read, no id source, no storage. `now` and `deviceId` are parameters so a replay in
 * a test produces the same ids and the same diff verdict.
 *
 * The size limits are part of the protocol, not tuning knobs: the Worker side rejects a batch above
 * {@link MAX_BATCH} and an event above {@link MAX_EVENT_BYTES}, so the client must decide to fall
 * back to a replace before sending. Keep both numbers in sync with `src/` when the protocol moves.
 * @module services/sync/chat-events
 */

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_BATCH = 50;
const MESSAGE_ID_RE = /^m_[A-Za-z0-9_-]{1,96}$/;
const EVENT_ID_RE = /^e_[A-Za-z0-9_-]{1,96}$/;
const CONV_ID_RE = /^c_[A-Za-z0-9_-]{1,80}$/;
const VALID_ROLES: Record<string, number> = { user: 1, assistant: 1, tool: 1 };
const VALID_TYPES: Record<string, number> = {
  "msg.append": 1,
  "conv.create": 1,
  "conv.meta": 1,
  "conv.delete": 1,
  "session.replace": 1,
  "conv.invalidate": 1,
};

type Json = Record<string, unknown>;

function recOf(value: unknown): Json {
  const out: Json = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** FNV-1a, base36 — the same digest the merge side uses, duplicated here to keep the module standalone. */
function hash32(input: unknown): string {
  const text = String(input == null ? "" : input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeDevice(deviceId: unknown): string {
  const text = String(deviceId || "dev").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return text || "dev";
}

/** `m_<device>_<base36 time>_<4 random chars>`; ids are opaque to the server. */
export function newMessageId(deviceId?: unknown, now?: unknown): string {
  const time = Number(now || Date.now()).toString(36);
  const salt = Math.random().toString(36).slice(2, 6);
  return "m_" + safeDevice(deviceId) + "_" + time + "_" + salt;
}

/** Same shape as {@link newMessageId} with an `e_` prefix and a wider random tail (events are rarer). */
export function newEventId(deviceId?: unknown, now?: unknown): string {
  const time = Number(now || Date.now()).toString(36);
  const salt = Math.random().toString(36).slice(2, 8);
  return "e_" + safeDevice(deviceId) + "_" + time + "_" + salt;
}

/** Structural test only: an id that fails this is treated as absent and regenerated on send. */
export function isMessageId(value: unknown): boolean {
  return typeof value === "string" && MESSAGE_ID_RE.test(value);
}

export function isValidMessage(message: unknown): boolean {
  const rec = recOf(message);
  return !!message && typeof message === "object" && VALID_ROLES[String(rec.role)] === 1
    && typeof rec.content === "string";
}

/** Identity for dedupe: the id when it looks like one, otherwise role + content + tool call. */
function messageKey(message: unknown): string {
  const rec = recOf(message);
  if (isMessageId(rec.id)) return "id:" + String(rec.id);
  return "raw:" + String(message && rec.role) + "\n" + String(message && rec.content) + "\n"
    + String((message && rec.tool_call_id) || "");
}

function sameMessage(a: unknown, b: unknown): boolean {
  const left = recOf(a);
  const right = recOf(b);
  if (isMessageId(left.id) && isMessageId(right.id)) return left.id === right.id;
  return messageKey(a) === messageKey(b);
}

/**
 * Give legacy messages a stable id. Messages that already have one are returned untouched, and the
 * input array is never mutated — the caller may be holding the live conversation.
 *
 * The legacy id is derived from `convId` + index + content, so two devices that hydrate the same
 * stored transcript mint the same ids and the sync engine does not see a phantom rewrite.
 */
export function ensureMessageIds(messages: unknown, convId: unknown, deviceId: unknown): unknown[] {
  const arr = Array.isArray(messages) ? messages : [];
  const out: unknown[] = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const message = arr[i];
    if (!message || typeof message !== "object") {
      out[i] = message;
      continue;
    }
    const rec = recOf(message);
    if (isMessageId(rec.id)) {
      out[i] = message;
      continue;
    }
    const copy: Json = {};
    for (const key of Object.keys(rec)) copy[key] = rec[key];
    copy.id = "m_legacy_" + hash32(String(convId || "") + "|" + i + "|" + messageKey(message)) + "_" + i.toString(36);
    out[i] = copy;
  }
  return out;
}

/**
 * Compare the rendered transcript with the next one.
 *
 * @returns `none` when nothing changed or `prev` is not an array (first load must not emit an
 *   event), `append` when `next` is `prev` plus a tail (carries only the tail), `replace` otherwise
 *   (carries the whole array). Deleting or editing anything mid-list therefore degrades to replace.
 */
export function diffMessages(prev: unknown, next: unknown): Json {
  if (!Array.isArray(prev)) return { mode: "none" };
  if (!Array.isArray(next)) return { mode: "replace", messages: [] };
  if (prev.length === next.length) {
    for (let i = 0; i < prev.length; i++) {
      if (!sameMessage(prev[i], next[i])) return { mode: "replace", messages: next.slice() };
    }
    return { mode: "none" };
  }
  if (next.length > prev.length) {
    let prefixSame = true;
    for (let j = 0; j < prev.length; j++) {
      if (!sameMessage(prev[j], next[j])) {
        prefixSame = false;
        break;
      }
    }
    if (prefixSame) return { mode: "append", added: next.slice(prev.length) };
  }
  return { mode: "replace", messages: next.slice() };
}

/**
 * Apply one append event. Dedupe is by {@link messageKey}, not by object identity, so a message that
 * arrives again from the poller after a local send does not double up.
 */
export function applyAppend(messages: unknown, message: unknown): Json {
  const arr = Array.isArray(messages) ? messages : [];
  if (!isValidMessage(message)) return { messages: arr, changed: false };
  const key = messageKey(message);
  for (let i = 0; i < arr.length; i++) {
    if (messageKey(arr[i]) === key) return { messages: arr, changed: false };
  }
  return { messages: arr.concat([message]), changed: true };
}

/**
 * Apply a whole-session replace. `reason` is part of the contract: `stale` means the local copy is
 * newer than the event and the engine must keep polling instead of overwriting, `no-messages` means
 * the payload was malformed and the event is dropped without touching state.
 */
export function applyReplace(messages: unknown, event: unknown, localMeta: unknown): Json {
  const arr = Array.isArray(messages) ? messages : [];
  const ev = recOf(event);
  const payload = recOf(ev.payload);
  const incoming = Array.isArray(payload.messages) ? payload.messages : null;
  if (!incoming) return { messages: arr, changed: false, reason: "no-messages" };
  const rev = Number(ev.createdAt || ev.created_at) || Number(payload.rev) || 0;
  const localRev = Number(recOf(localMeta).updatedAt) || 0;
  if (rev && localRev && rev < localRev) return { messages: arr, changed: false, reason: "stale" };
  return { messages: incoming, changed: true, reason: "applied" };
}

/** Serialized size, `Infinity` when the event cannot be stringified (send must then refuse it). */
export function eventBytes(event: unknown): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return Infinity;
  }
}

export function eventFitsLimit(event: unknown, maxBytes: unknown): boolean {
  return eventBytes(event) <= (Number(maxBytes) || MAX_EVENT_BYTES);
}

export function isValidConvId(convId: unknown): boolean {
  return typeof convId === "string" && CONV_ID_RE.test(convId);
}

export function isValidEventType(type: unknown): boolean {
  return typeof type === "string" && VALID_TYPES[type] === 1;
}
