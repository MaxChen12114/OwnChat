/**
 * Session events: the append-only truth of a conversation.
 *
 * `session_events` is the only source; `messages` is its projection and the FTS surface
 * `history_search` reads. Every write does both inside one transaction (T1's collect-then-commit
 * contract), so a projection failure rolls the event back with it — replay can never resurrect a
 * message the UI never had, and no caller may write `messages` alone.
 *
 * Why `seq` is allocated by reading `MAX(seq)+1` before the transaction: D1 has no interactive
 * transactions and reads inside `transaction` are forbidden (see core/db.ts). A concurrent append
 * can therefore pick the same seq; the unique index `(conv_id, seq)` rejects the loser and the
 * append retries with a fresh read. That is the portable optimistic-concurrency shape for all
 * three runtimes.
 *
 * Projection semantics:
 *   · `deriveMessages` is the full projection (every message event, summarised or not). `replay`
 *     rebuilds the `messages` table from it, so archived originals stay searchable forever.
 *   · `deriveLiveMessages` drops the seq ranges covered by `summary` events — that is the
 *     transcript a reload should show. The originals remain in the event log for `history_search`.
 *   · `summary` events also project into the `summaries` table (the persistent copy of the hot
 *     summary the client reads from localStorage), in the same transaction.
 *
 * Missing `turn/end` repair is replay-only and happens once: each repair carries `turnSeq`, so a
 * second replay sees the turn closed and appends nothing. Detection keeps a list of open turn
 * starts (not a single flag) so two unterminated turns are both repaired exactly once.
 *
 * `session/truncate` is the rollback truth: a checkpoint restore replaces the live array, and the
 * event log must forget the messages after the restore point or the next boot's hydration brings
 * them back. The latest truncate governs (`toSeq` = highest message seq kept); its projection is a
 * same-transaction `DELETE FROM messages WHERE seq > toSeq`, so search and the archive dedupe see
 * the rollback immediately. Later appends have a higher seq and are unaffected, which is what makes
 * a second rollback to an older point (a lower `toSeq`) still correct.
 *
 * Boundary: SQL and projection only. No DOM, no localStorage, no fetch — the host injects a
 * DbPort-shaped object.
 * @module services/session/events
 */

/**
 * The seven event types. A new one needs a projection rule and a test: six of them carry the
 * transcript, `session/truncate` carries the rollback boundary.
 */
export type SessionEventType =
  | "turn/start"
  | "user/message"
  | "assistant/message"
  | "tool/result"
  | "turn/end"
  | "summary"
  | "session/truncate";

const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "turn/start", "user/message", "assistant/message", "tool/result", "turn/end", "summary",
  "session/truncate",
];

/** Message-shaped event types (the ones with a `messages` projection). */
const MESSAGE_EVENT_TYPES: Record<string, 1> = {
  "user/message": 1,
  "assistant/message": 1,
  "tool/result": 1,
};

/** A message as the session array carries it; values stay opaque here except `role`/`id`. */
export type EventMessage = Record<string, unknown>;

/** One event row, as read back. */
export interface EventRecord {
  id: string;
  convId: string;
  seq: number;
  type: SessionEventType;
  payload: Record<string, unknown>;
  ts: number;
}

/** The DbPort subset this service uses; the real port satisfies it structurally. */
export interface SessionEventsDb {
  exec(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(fn: (tx: { exec(sql: string, params?: unknown[]): void }) => Promise<T> | T): Promise<T>;
  search(surface: "messages", scope: { conv?: string }, q: string, limit?: number): Promise<Record<string, unknown>[]>;
}

export interface SessionEventsPorts {
  /** Late lookup: the facade may not have selected an adapter when this script loads. */
  db(): SessionEventsDb;
  now?(): number;
}

export interface AppendOptions {
  /** Explicit seq (migration/import). Omit to allocate `MAX(seq)+1`. */
  seq?: number;
  ts?: number;
}

export interface AppendResult {
  ok: boolean;
  seq?: number;
  id?: string;
  error?: string;
}

export interface EventInput {
  type: string;
  payload: Record<string, unknown>;
  seq?: number;
  ts?: number;
}

export interface BatchResult {
  ok: boolean;
  seqs?: Array<{ id: string; seq: number }>;
  appended?: number;
  error?: string;
}

export interface ArchiveResult {
  ok: boolean;
  appended?: number;
  /** Every input message id now present in the projection (existing + just appended). */
  known?: string[];
  seqs?: Array<{ id: string; seq: number }>;
  fromSeq?: number;
  toSeq?: number;
  summarySeq?: number;
  error?: string;
}

export interface ReplayResult {
  ok: boolean;
  messages?: number;
  repaired?: number;
  lastSeq?: number;
  error?: string;
}

export interface RemoveResult {
  ok: boolean;
  error?: string;
}

export interface SessionEventsApi {
  v: 1;
  SESSION_EVENT_TYPES: readonly SessionEventType[];
  append(convId: string, type: string, payload?: Record<string, unknown>, opts?: AppendOptions): Promise<AppendResult>;
  appendBatch(convId: string, items: EventInput[]): Promise<BatchResult>;
  readEvents(convId: string): Promise<EventRecord[]>;
  deriveMessages(convId: string): Promise<EventMessage[]>;
  deriveLiveMessages(convId: string): Promise<EventMessage[]>;
  replay(convId: string): Promise<ReplayResult>;
  appendSummary(convId: string, text: string, from: unknown, to: unknown, dropped?: unknown): Promise<AppendResult>;
  archiveMessages(convId: string, messages: unknown): Promise<ArchiveResult>;
  archiveCompact(convId: string, messages: unknown, summaryText: unknown): Promise<ArchiveResult>;
  archivedIds(convId: string): Promise<string[]>;
  /**
   * Roll the transcript back to `toSeq` (messages with a higher seq stop being live and leave the
   * search projection in the same transaction). The latest truncate event governs; a later append
   * is unaffected because it gets a higher seq.
   */
  truncate(convId: string, toSeq: unknown, reason?: unknown): Promise<AppendResult>;
  /**
   * The checkpoint-restore entry: derive the boundary from the kept messages themselves so callers
   * never have to know seqs. Messages the projection never saw (still in the hot window) contribute
   * nothing; an all-hot kept set truncates to 0, which is a no-op when nothing was archived.
   */
  truncateToMessages(convId: string, messages: unknown, reason?: unknown): Promise<AppendResult>;
  search(convId: string, q: string, limit?: number): Promise<Record<string, unknown>[]>;
  removeConv(convId: string): Promise<RemoveResult>;
  clearAll(): Promise<RemoveResult>;
  /** Adapter for services/session/store.ts (cold projection + archive queue). */
  coldPort(): {
    load(convId: string): Promise<EventMessage[]>;
    archive(convId: string, messages: unknown): Promise<{ ok: boolean; known?: string[]; appended?: number; error?: string }>;
    remove(convId: string): Promise<unknown>;
    clearAll(): Promise<unknown>;
  };
}

/* ── small value bridges (no assertions, no `as`) ───────────────────────────────────────────── */

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function strOf(value: unknown): string {
  return value == null ? "" : String(value);
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return String(e);
}

/** Object view of a row; the drivers hand over null-prototype objects. */
function rowOf(value: unknown): Record<string, unknown> {
  return recOf(value);
}

function isUniqueError(e: unknown): boolean {
  return /unique|constraint/i.test(errText(e));
}

/** FNV-1a over UTF-16 code units. Only used to mint ids for legacy messages with none. */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Deterministic event id: `<conv>_<seq>` under an `evt_` prefix, matching the schema comment. */
function eventIdOf(convId: string, seq: number): string {
  return "evt_" + convId + "_" + String(seq);
}

/** Deterministic message id for an event whose payload carried none. */
function messageIdOf(convId: string, seq: number): string {
  return "m_evt_" + convId + "_" + String(seq);
}

/** The text a message event contributes to `messages.content` (arrays are vision payloads). */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

/** A payload value that must survive as JSON: arrays/objects pass, scalars pass, functions drop. */
function jsonSafe(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value;
  return undefined;
}

/** Copy the whitelisted keys of `source` into a fresh payload; absent keys stay absent. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = jsonSafe(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const USER_KEYS = [
  "id", "content", "files", "images", "speakerId", "speakerName", "speakerIcon",
  "sc", "to", "model", "baseId", "ts",
];
const ASSISTANT_KEYS = [
  "id", "content", "reasoning_content", "tool_calls", "agentPreamble", "files", "images",
  "speakerId", "speakerName", "speakerIcon", "sc", "to", "_meta", "_uiOnly", "model", "baseId", "ts",
];
const TOOL_KEYS = ["id", "content", "tool_call_id", "name", "_tool", "sc", "to", "ts"];
const TURN_START_KEYS = ["turnId", "source", "mode", "model", "ts"];
const TURN_END_KEYS = ["turnId", "status", "reason", "repair", "turnSeq", "ts"];
const SUMMARY_KEYS = ["text", "from", "to", "dropped", "ts"];
const TRUNCATE_KEYS = ["toSeq", "keep", "reason", "ts"];

/**
 * Validate and shape one payload. Unknown types and malformed required fields are refused here —
 * a caller mistake must be loud, not a silently skipped message.
 */
function normalizePayload(type: string, payload: unknown): Record<string, unknown> {
  if (type !== "turn/start" && type !== "user/message" && type !== "assistant/message"
    && type !== "tool/result" && type !== "turn/end" && type !== "summary"
    && type !== "session/truncate") {
    throw new Error("session-events: unknown type " + String(type));
  }
  const p = recOf(payload);
  if (type === "user/message" || type === "assistant/message") {
    const keys = type === "user/message" ? USER_KEYS : ASSISTANT_KEYS;
    const out = pick(p, keys);
    const content = out["content"];
    if (content !== undefined && typeof content !== "string" && !Array.isArray(content)) {
      throw new Error("session-events: " + type + " content 必须是 string 或数组");
    }
    const toolCalls = out["tool_calls"];
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new Error("session-events: assistant/message tool_calls 必须是数组");
    }
    if (typeof out["content"] !== "string" && !Array.isArray(out["content"])) out["content"] = "";
    return out;
  }
  if (type === "tool/result") {
    const out = pick(p, TOOL_KEYS);
    if (typeof out["tool_call_id"] !== "string" || !out["tool_call_id"]) {
      throw new Error("session-events: tool/result 缺 tool_call_id");
    }
    if (typeof out["content"] !== "string") out["content"] = contentText(p["content"]);
    return out;
  }
  if (type === "summary") {
    const out = pick(p, SUMMARY_KEYS);
    const text = typeof out["text"] === "string" ? out["text"].trim() : "";
    if (!text) throw new Error("session-events: summary 缺 text");
    const from = numOr(out["from"], 0);
    const to = numOr(out["to"], 0);
    if (from <= 0 || to < from) throw new Error("session-events: summary 的 from/to 非法");
    out["text"] = text;
    out["from"] = from;
    out["to"] = to;
    return out;
  }
  if (type === "session/truncate") {
    const out = pick(p, TRUNCATE_KEYS);
    if (!Object.prototype.hasOwnProperty.call(out, "toSeq")) {
      throw new Error("session-events: session/truncate 缺 toSeq");
    }
    const toSeq = Math.floor(numOr(out["toSeq"], -1));
    if (!isFinite(toSeq) || toSeq < 0) throw new Error("session-events: session/truncate 的 toSeq 非法");
    out["toSeq"] = toSeq;
    return out;
  }
  return pick(p, type === "turn/start" ? TURN_START_KEYS : TURN_END_KEYS);
}

/** Turn a session message into its event shape; null when the role has no projection. */
function messageToEvent(message: unknown): { id: string; type: SessionEventType; payload: Record<string, unknown>; ts: number } | null {
  const m = recOf(message);
  const role = strOf(m["role"]);
  const type: SessionEventType | "" = role === "user" ? "user/message"
    : role === "assistant" ? "assistant/message"
      : role === "tool" ? "tool/result" : "";
  if (!type) return null;
  const payload = normalizePayload(type, m);
  const ts = numOr(m["ts"], 0);
  if (ts > 0) payload["ts"] = ts;
  return { id: "", type, payload, ts };
}

/** A stable id for a message that predates `ensureMessageIds`; identical input → identical id. */
function stableMessageId(convId: string, event: { type: string; payload: Record<string, unknown> }): string {
  const p = event.payload;
  const seed = [
    convId,
    event.type,
    contentText(p["content"]),
    strOf(p["tool_call_id"]),
    strOf(p["ts"]),
    p["tool_calls"] === undefined ? "" : contentText(p["tool_calls"]),
  ].join("|");
  return "m_evt_h" + hash32(seed);
}

/* ── row builders ──────────────────────────────────────────────────────────────────────────── */

const EVT_INSERT = "INSERT INTO session_events (id, conv_id, seq, type, payload, ts) VALUES (?,?,?,?,?,?)";
const MSG_INSERT = "INSERT INTO messages (id, conv_id, seq, role, content, tool_calls, tool_call_id, reasoning_content, sc, speaker_name, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
const SUMMARY_UPSERT = "INSERT INTO summaries (conv_id, text, ts) VALUES (?,?,?) ON CONFLICT(conv_id) DO UPDATE SET text=excluded.text, ts=excluded.ts";

/** The projection row for one message event; null for non-message types. */
function projectionOf(evt: EventRecord): Record<string, unknown> | null {
  if (!MESSAGE_EVENT_TYPES[evt.type]) return null;
  const p = evt.payload;
  const role = evt.type === "user/message" ? "user" : (evt.type === "assistant/message" ? "assistant" : "tool");
  const id = typeof p["id"] === "string" && p["id"] ? p["id"] : messageIdOf(evt.convId, evt.seq);
  const toolCalls = Array.isArray(p["tool_calls"]) ? JSON.stringify(p["tool_calls"]) : null;
  return {
    id,
    conv_id: evt.convId,
    seq: evt.seq,
    role,
    content: contentText(p["content"]),
    tool_calls: toolCalls,
    tool_call_id: typeof p["tool_call_id"] === "string" ? p["tool_call_id"] : null,
    reasoning_content: typeof p["reasoning_content"] === "string" ? p["reasoning_content"] : null,
    sc: typeof p["sc"] === "string" ? p["sc"] : null,
    speaker_name: typeof p["speakerName"] === "string" ? p["speakerName"] : null,
    ts: numOr(p["ts"], evt.ts) || evt.ts,
  };
}

/** Bind one projection row into the transaction. */
function projectRow(tx: { exec(sql: string, params?: unknown[]): void }, evt: EventRecord, insertSql: string): void {
  // A rollback is a projection too: the truncated messages leave `messages` in the same
  // transaction as the event, so search and the archive dedupe cannot observe a stale tail.
  if (evt.type === "session/truncate") {
    tx.exec("DELETE FROM messages WHERE conv_id = ? AND seq > ?", [evt.convId, numOr(evt.payload["toSeq"], 0)]);
    return;
  }
  const row = projectionOf(evt);
  if (!row) {
    if (evt.type === "summary") {
      tx.exec(SUMMARY_UPSERT, [evt.convId, strOf(evt.payload["text"]), numOr(evt.payload["ts"], evt.ts) || evt.ts]);
    }
    return;
  }
  tx.exec(insertSql, [
    row["id"], row["conv_id"], row["seq"], row["role"], row["content"], row["tool_calls"],
    row["tool_call_id"], row["reasoning_content"], row["sc"], row["speaker_name"], row["ts"],
  ]);
}

/** Insert a list of events plus their projections in ONE collected transaction. */
async function writeEvents(port: SessionEventsDb, events: EventRecord[], insertSql: string): Promise<void> {
  await port.transaction(function (tx) {
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      tx.exec(EVT_INSERT, [evt.id, evt.convId, evt.seq, evt.type, JSON.stringify(evt.payload), evt.ts]);
      projectRow(tx, evt, insertSql);
    }
  });
}

/** Structural test for a stored type; an unknown type is corrupt data, not a new event kind. */
function isEventType(value: string): value is SessionEventType {
  return value === "turn/start" || value === "user/message" || value === "assistant/message"
    || value === "tool/result" || value === "turn/end" || value === "summary"
    || value === "session/truncate";
}

/** A message event rebuilt from a `session_events` row; payload corruption reads as `{}`. */
function eventOfRow(rowValue: unknown): EventRecord | null {
  const row = rowOf(rowValue);
  const type = strOf(row["type"]);
  if (!type || !isEventType(type)) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = recOf(JSON.parse(strOf(row["payload"]) || "{}"));
  } catch (e) {
    payload = {};
  }
  return {
    id: strOf(row["id"]),
    convId: strOf(row["conv_id"]),
    seq: numOr(row["seq"], 0),
    type: type,
    payload: payload,
    ts: numOr(row["ts"], 0),
  };
}

/** Full projection: every message event, in seq order. Pure and repeatable. */
function projectEvents(events: EventRecord[], liveOnly: boolean): EventMessage[] {
  // Summary events are appended after the originals they cover, so the ranges must be collected
  // in a first pass — filtering while walking would drop only messages after the summary.
  const ranges: Array<{ from: number; to: number }> = [];
  // The LATEST truncate governs: a later rollback to an older point has a lower toSeq and must not
  // be shadowed by the earlier, higher boundary. `at` is the truncate event's own seq — messages
  // appended AFTER it are new and stay live even though their seq is above `toSeq`.
  let truncateTo = -1;
  let truncateAt = -1;
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type === "session/truncate") {
      truncateTo = Math.floor(numOr(evt.payload["toSeq"], -1));
      truncateAt = evt.seq;
      continue;
    }
    if (!liveOnly || evt.type !== "summary") continue;
    const from = numOr(evt.payload["from"], 0);
    const to = numOr(evt.payload["to"], 0);
    if (from > 0 && to >= from) ranges.push({ from, to });
  }
  const messages: EventMessage[] = [];
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type === "summary" || evt.type === "session/truncate") continue;
    if (!MESSAGE_EVENT_TYPES[evt.type]) continue;
    // Both projections honour the rollback: deriveMessages feeds replay (which rebuilds the search
    // surface), deriveLiveMessages feeds boot hydration. A rolled-back message must not survive in
    // either, or it comes back to the transcript on the next reload. Only events that existed
    // before the truncate are covered (`evt.seq < truncateAt`); later appends are the new tail.
    if (truncateTo >= 0 && evt.seq > truncateTo && evt.seq < truncateAt) continue;
    const p = evt.payload;
    const role = evt.type === "user/message" ? "user" : (evt.type === "assistant/message" ? "assistant" : "tool");
    const out: EventMessage = {};
    for (const [k, v] of Object.entries(p)) out[k] = v;
    out["role"] = role;
    if (typeof out["id"] !== "string" || !out["id"]) out["id"] = messageIdOf(evt.convId, evt.seq);
    if (typeof out["content"] !== "string") out["content"] = contentText(p["content"]);
    if (!numOr(out["ts"], 0)) out["ts"] = evt.ts;
    out["seq"] = evt.seq;
    let covered = false;
    if (liveOnly) {
      for (let r = 0; r < ranges.length; r++) {
        if (evt.seq >= ranges[r].from && evt.seq <= ranges[r].to) { covered = true; break; }
      }
    }
    if (!covered) messages.push(out);
  }
  return messages;
}

/** Turn starts still open when the log ends — each needs exactly one repair event. */
function missingTurnEnds(events: EventRecord[]): number[] {
  const open: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type === "turn/start") { open.push(evt.seq); continue; }
    if (evt.type !== "turn/end") continue;
    const turnSeq = numOr(evt.payload["turnSeq"], 0);
    if (turnSeq > 0) {
      const at = open.indexOf(turnSeq);
      if (at >= 0) open.splice(at, 1);
    } else if (open.length) {
      open.pop();
    }
  }
  return open;
}

/* ── factory ───────────────────────────────────────────────────────────────────────────────── */

export function createSessionEvents(ports: SessionEventsPorts): SessionEventsApi {
  if (!ports || typeof ports.db !== "function") {
    throw new Error("session-events: 缺 db 端口（没有数据面就无法写事件真源）");
  }
  const now = typeof ports.now === "function" ? ports.now : function () { return Date.now(); };

  function port(): SessionEventsDb {
    const p = ports.db();
    if (!p || typeof p.exec !== "function" || typeof p.transaction !== "function") {
      throw new Error("session-events: db 端口不可用");
    }
    return p;
  }

  /** MAX(seq)+1 for a conversation; the unique index is the real guard against races. */
  async function nextSeq(p: SessionEventsDb, convId: string): Promise<number> {
    const out = await p.exec("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM session_events WHERE conv_id = ?", [convId]);
    const row = rowOf((out && out.rows && out.rows[0]) || {});
    const seq = Math.floor(numOr(row["seq"], 1));
    return seq > 0 ? seq : 1;
  }

  function makeEvent(convId: string, type: SessionEventType, payload: Record<string, unknown>, seq: number, ts: number): EventRecord {
    return { id: eventIdOf(convId, seq), convId, seq, type, payload, ts };
  }

  async function readEvents(convId: string): Promise<EventRecord[]> {
    const conv = strOf(convId);
    if (!conv) return [];
    const out = await port().exec(
      "SELECT id, conv_id, seq, type, payload, ts FROM session_events WHERE conv_id = ? ORDER BY seq ASC",
      [conv],
    );
    const rows = (out && Array.isArray(out.rows)) ? out.rows : [];
    const list: EventRecord[] = [];
    for (let i = 0; i < rows.length; i++) {
      const evt = eventOfRow(rows[i]);
      if (evt) list.push(evt);
    }
    return list;
  }

  function deriveFrom(events: EventRecord[], liveOnly: boolean): EventMessage[] {
    return projectEvents(events, liveOnly);
  }

  async function deriveMessages(convId: string): Promise<EventMessage[]> {
    return deriveFrom(await readEvents(convId), false);
  }

  async function deriveLiveMessages(convId: string): Promise<EventMessage[]> {
    return deriveFrom(await readEvents(convId), true);
  }

  async function append(
    convId: string,
    type: string,
    payload?: Record<string, unknown>,
    opts?: AppendOptions,
  ): Promise<AppendResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    if (!isEventType(type)) return { ok: false, error: "session-events: unknown type " + String(type) };
    let norm: Record<string, unknown>;
    try {
      norm = normalizePayload(type, payload || {});
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    let p: SessionEventsDb;
    try {
      p = port();
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const explicit = opts && opts.seq !== undefined ? Math.floor(numOr(opts.seq, 0)) : 0;
    const ts = opts && opts.ts !== undefined ? numOr(opts.ts, now()) : now();
    let lastError = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      let seq = explicit;
      if (!(seq > 0)) {
        try {
          seq = await nextSeq(p, conv);
        } catch (e) {
          return { ok: false, error: errText(e) };
        }
      }
      const evt = makeEvent(conv, type, norm, seq, ts);
      try {
        await writeEvents(p, [evt], MSG_INSERT);
        return { ok: true, seq: seq, id: evt.id };
      } catch (e) {
        lastError = errText(e);
        if (explicit > 0 || !isUniqueError(e)) break;
      }
    }
    return { ok: false, error: lastError || "session-events: append failed" };
  }

  async function appendBatch(convId: string, items: EventInput[]): Promise<BatchResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    if (!Array.isArray(items) || !items.length) return { ok: true, seqs: [], appended: 0 };
    const prepared: Array<{ type: SessionEventType; payload: Record<string, unknown>; ts: number; seq: number }> = [];
    for (let i = 0; i < items.length; i++) {
      const item = recOf(items[i]);
      const type = strOf(item["type"]);
      if (!isEventType(type)) return { ok: false, error: "session-events: unknown type " + type };
      try {
        prepared.push({
          type: type,
          payload: normalizePayload(type, item["payload"]),
          ts: numOr(item["ts"], now()) || now(),
          seq: Math.floor(numOr(item["seq"], 0)),
        });
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    }
    let p: SessionEventsDb;
    let base: number;
    try {
      p = port();
      base = await nextSeq(p, conv);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const seqs: Array<{ id: string; seq: number }> = [];
    let appended = 0;
    const CHUNK = 60; // 2 statements per message event; stays under the 200-statement tx cap
    for (let start = 0; start < prepared.length; start += CHUNK) {
      const slice = prepared.slice(start, start + CHUNK);
      const events: EventRecord[] = [];
      for (let i = 0; i < slice.length; i++) {
        const item = slice[i];
        const seq = item.seq > 0 ? item.seq : base + i;
        const evt = makeEvent(conv, item.type, item.payload, seq, item.ts);
        events.push(evt);
        seqs.push({ id: evt.id, seq: seq });
      }
      try {
        await writeEvents(p, events, MSG_INSERT);
        appended += events.length;
        const used = events.map(function (e) { return e.seq; });
        base = Math.max.apply(null, used) + 1;
      } catch (e) {
        return { ok: false, error: errText(e), appended: appended, seqs: seqs };
      }
    }
    return { ok: true, seqs: seqs, appended: appended };
  }

  /** id → seq for messages already projected; the archive dedupe source. */
  async function existingSeqs(p: SessionEventsDb, conv: string, ids: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const CHUNK = 100;
    for (let start = 0; start < ids.length; start += CHUNK) {
      const slice = ids.slice(start, start + CHUNK);
      const marks = slice.map(function () { return "?"; }).join(",");
      const out = await p.exec(
        "SELECT id, seq FROM messages WHERE conv_id = ? AND id IN (" + marks + ")",
        [conv].concat(slice),
      );
      const rows = (out && Array.isArray(out.rows)) ? out.rows : [];
      for (let i = 0; i < rows.length; i++) {
        const row = rowOf(rows[i]);
        const id = strOf(row["id"]);
        if (id) map.set(id, Math.floor(numOr(row["seq"], 0)));
      }
    }
    return map;
  }

  /** Prepare message events for archiving; unprojectable roles are skipped (count kept). */
  function prepareMessages(conv: string, messages: unknown): Array<{ id: string; type: SessionEventType; payload: Record<string, unknown>; ts: number }> {
    const list = Array.isArray(messages) ? messages : [];
    const out: Array<{ id: string; type: SessionEventType; payload: Record<string, unknown>; ts: number }> = [];
    for (let i = 0; i < list.length; i++) {
      const built = messageToEvent(list[i]);
      if (!built) continue;
      const declared = strOf(recOf(list[i])["id"]);
      const id = declared || stableMessageId(conv, built);
      built.payload["id"] = id;
      out.push({ id: id, type: built.type, payload: built.payload, ts: built.ts });
    }
    return out;
  }

  /**
   * Per-conversation archive lock. The store queue (eviction) and the compactor can both archive
   * the same message id within milliseconds of each other; without serialisation both read the
   * same "missing" set and one batch loses the primary-key race. The lock makes the dedupe read
   * and the write one critical section per conversation.
   */
  const archiveChain: Record<string, Promise<unknown>> = {};
  function withArchiveLock<T>(conv: string, fn: () => Promise<T>): Promise<T> {
    const prev = archiveChain[conv] || Promise.resolve();
    const run = prev.then(fn, fn);
    archiveChain[conv] = run.then(function () {}, function () {});
    return run;
  }

  async function archiveMessagesNow(convId: string, messages: unknown): Promise<ArchiveResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    const prepared = prepareMessages(conv, messages);
    if (!prepared.length) return { ok: true, appended: 0, known: [], seqs: [] };
    let p: SessionEventsDb;
    try {
      p = port();
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const ids = prepared.map(function (m) { return m.id; });
    let existing: Map<string, number>;
    try {
      existing = await existingSeqs(p, conv, ids);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const seqById = new Map<string, number>(existing);
    const missing = prepared.filter(function (m) { return !existing.has(m.id); });
    let appended = 0;
    const CHUNK = 60;
    for (let start = 0; start < missing.length; start += CHUNK) {
      const slice = missing.slice(start, start + CHUNK);
      let base: number;
      try {
        base = await nextSeq(p, conv);
      } catch (e) {
        return { ok: false, error: errText(e), appended: appended, known: ids };
      }
      const events: EventRecord[] = [];
      for (let i = 0; i < slice.length; i++) {
        const item = slice[i];
        const seq = base + i;
        seqById.set(item.id, seq);
        events.push(makeEvent(conv, item.type, item.payload, seq, item.ts || now()));
      }
      try {
        await writeEvents(p, events, MSG_INSERT);
        appended += events.length;
      } catch (e) {
        return { ok: false, error: errText(e), appended: appended, known: ids };
      }
    }
    const seqs: Array<{ id: string; seq: number }> = [];
    let fromSeq = 0;
    let toSeq = 0;
    for (let i = 0; i < ids.length; i++) {
      const seq = seqById.get(ids[i]) || 0;
      seqs.push({ id: ids[i], seq: seq });
      if (!seq) continue;
      if (!fromSeq || seq < fromSeq) fromSeq = seq;
      if (seq > toSeq) toSeq = seq;
    }
    return { ok: true, appended: appended, known: ids, seqs: seqs, fromSeq: fromSeq, toSeq: toSeq };
  }

  /**
   * Compact archive: original messages + the summary event, projected in one transaction (the
   * summary rides the final chunk's transaction; earlier chunks are still per-chunk atomic). The
   * summary payload carries the seq range the anchor text quotes.
   */
  async function archiveCompactNow(convId: string, messages: unknown, summaryText: unknown): Promise<ArchiveResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    const text = typeof summaryText === "string" ? summaryText.trim() : "";
    if (!text) return { ok: false, error: "session-events: 摘要为空" };
    const prepared = prepareMessages(conv, messages);
    if (!prepared.length) return { ok: false, error: "session-events: 没有可归档的原文" };
    let p: SessionEventsDb;
    try {
      p = port();
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const ids = prepared.map(function (m) { return m.id; });
    let existing: Map<string, number>;
    try {
      existing = await existingSeqs(p, conv, ids);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const seqById = new Map<string, number>(existing);
    const missing = prepared.filter(function (m) { return !existing.has(m.id); });
    const CHUNK = 60;
    let appended = 0;
    let summarySeq = 0;
    let summaryTs = 0;
    try {
      for (let start = 0; start < missing.length; start += CHUNK) {
        const slice = missing.slice(start, start + CHUNK);
        const isLast = start + CHUNK >= missing.length;
        const base = await nextSeq(p, conv);
        const events: EventRecord[] = [];
        for (let i = 0; i < slice.length; i++) {
          const item = slice[i];
          const seq = base + i;
          seqById.set(item.id, seq);
          events.push(makeEvent(conv, item.type, item.payload, seq, item.ts || now()));
        }
        let fromSeq = 0;
        let toSeq = 0;
        for (let i = 0; i < ids.length; i++) {
          const seq = seqById.get(ids[i]) || 0;
          if (!seq) continue;
          if (!fromSeq || seq < fromSeq) fromSeq = seq;
          if (seq > toSeq) toSeq = seq;
        }
        summaryTs = now();
        summarySeq = base + slice.length;
        if (isLast) {
          const summaryEvent = makeEvent(conv, "summary", {
            text: text, from: fromSeq, to: toSeq, dropped: prepared.length,
          }, summarySeq, summaryTs);
          events.push(summaryEvent);
        }
        await writeEvents(p, events, MSG_INSERT);
        appended += slice.length;
      }
      if (!missing.length) {
        const base = await nextSeq(p, conv);
        let fromSeq = 0;
        let toSeq = 0;
        for (let i = 0; i < ids.length; i++) {
          const seq = seqById.get(ids[i]) || 0;
          if (!seq) continue;
          if (!fromSeq || seq < fromSeq) fromSeq = seq;
          if (seq > toSeq) toSeq = seq;
        }
        summaryTs = now();
        summarySeq = base;
        const summaryEvent = makeEvent(conv, "summary", {
          text: text, from: fromSeq, to: toSeq, dropped: prepared.length,
        }, summarySeq, summaryTs);
        await writeEvents(p, [summaryEvent], MSG_INSERT);
      }
    } catch (e) {
      return { ok: false, error: errText(e), appended: appended, known: ids };
    }
    let fromSeq = 0;
    let toSeq = 0;
    const seqs: Array<{ id: string; seq: number }> = [];
    for (let i = 0; i < ids.length; i++) {
      const seq = seqById.get(ids[i]) || 0;
      seqs.push({ id: ids[i], seq: seq });
      if (!seq) continue;
      if (!fromSeq || seq < fromSeq) fromSeq = seq;
      if (seq > toSeq) toSeq = seq;
    }
    return {
      ok: true, appended: appended, known: ids, seqs: seqs,
      fromSeq: fromSeq, toSeq: toSeq, summarySeq: summarySeq,
    };
  }

  function archiveMessages(convId: string, messages: unknown): Promise<ArchiveResult> {
    const conv = strOf(convId);
    if (!conv) return Promise.resolve({ ok: false, error: "session-events: convId 不能为空" });
    return withArchiveLock(conv, function () { return archiveMessagesNow(conv, messages); });
  }

  function archiveCompact(convId: string, messages: unknown, summaryText: unknown): Promise<ArchiveResult> {
    const conv = strOf(convId);
    if (!conv) return Promise.resolve({ ok: false, error: "session-events: convId 不能为空" });
    return withArchiveLock(conv, function () { return archiveCompactNow(conv, messages, summaryText); });
  }

  async function appendSummary(convId: string, text: string, from: unknown, to: unknown, dropped?: unknown): Promise<AppendResult> {
    return append(convId, "summary", { text: text, from: from, to: to, dropped: dropped });
  }

  /**
   * Append a rollback boundary. The projection deletes the messages above it inside the same
   * transaction; the event keeps the decision replayable. `toSeq = 0` means "everything archived
   * before this point is gone", which is the honest answer for a restore to an empty transcript.
   */
  async function truncate(convId: string, toSeq: unknown, reason?: unknown): Promise<AppendResult> {
    const payload: Record<string, unknown> = { toSeq: toSeq };
    if (reason !== undefined) payload["reason"] = reason;
    return append(convId, "session/truncate", payload);
  }

  /**
   * Boundary from the kept messages: the highest projected seq among them, 0 when none of them has
   * been projected yet. The checkpoint flow calls this — it holds messages, not seqs.
   */
  async function truncateToMessages(convId: string, messages: unknown, reason?: unknown): Promise<AppendResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    const prepared = prepareMessages(conv, messages);
    if (!prepared.length) return truncate(conv, 0, reason);
    let p: SessionEventsDb;
    try {
      p = port();
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    let existing: Map<string, number>;
    try {
      existing = await existingSeqs(p, conv, prepared.map(function (m) { return m.id; }));
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    let boundary = 0;
    let matched = 0;
    existing.forEach(function (seq) {
      matched++;
      if (seq > boundary) boundary = seq;
    });
    // Fail closed: a kept set with no projected message means the ids in the payload do not match
    // the projection (a checkpoint taken before ids existed). Truncating then would delete the whole
    // archived transcript while the caller believes it restored a prefix — refuse and report instead.
    if (prepared.length > 0 && matched === 0) {
      return { ok: false, error: "session-events: 回滚点无法定位（保留消息不在投影里），已拒绝截断以免误删原文" };
    }
    return truncate(conv, boundary, reason);
  }

  async function archivedIds(convId: string): Promise<string[]> {
    const conv = strOf(convId);
    if (!conv) return [];
    const out: string[] = [];
    const p = port();
    const PAGE = 500;
    for (let offset = 0; ; offset += PAGE) {
      const res = await p.exec(
        "SELECT id FROM messages WHERE conv_id = ? ORDER BY seq ASC LIMIT " + PAGE + " OFFSET " + offset,
        [conv],
      );
      const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
      for (let i = 0; i < rows.length; i++) {
        const id = strOf(rowOf(rows[i])["id"]);
        if (id) out.push(id);
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async function replay(convId: string): Promise<ReplayResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    let p: SessionEventsDb;
    try {
      p = port();
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    let events: EventRecord[];
    try {
      events = await readEvents(conv);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    const derived = deriveFrom(events, false);
    const repairs = missingTurnEnds(events);
    // The latest summary event is the truth for the `summaries` projection; replay rebuilds it too
    // (a fresh database after import must answer the same summary as the event log).
    let summaryText = "";
    let summaryTs = 0;
    for (let i = 0; i < events.length; i++) {
      if (events[i].type !== "summary") continue;
      const text = strOf(events[i].payload["text"]).trim();
      if (text) {
        summaryText = text;
        summaryTs = numOr(events[i].payload["ts"], events[i].ts) || events[i].ts;
      }
    }
    let lastSeq = 0;
    for (let i = 0; i < events.length; i++) if (events[i].seq > lastSeq) lastSeq = events[i].seq;
    const repairEvents: EventRecord[] = [];
    for (let i = 0; i < repairs.length; i++) {
      const seq = lastSeq + i + 1;
      repairEvents.push(makeEvent(conv, "turn/end", {
        repair: true, reason: "missing-turn-end", turnSeq: repairs[i],
      }, seq, now()));
    }
    try {
      await p.transaction(function (tx) {
        for (let i = 0; i < repairEvents.length; i++) {
          const evt = repairEvents[i];
          tx.exec(EVT_INSERT, [evt.id, evt.convId, evt.seq, evt.type, JSON.stringify(evt.payload), evt.ts]);
        }
        tx.exec("DELETE FROM messages WHERE conv_id = ?", [conv]);
        tx.exec("DELETE FROM summaries WHERE conv_id = ?", [conv]);
        if (summaryText) tx.exec(SUMMARY_UPSERT, [conv, summaryText, summaryTs || now()]);
        for (let i = 0; i < derived.length; i++) {
          const evt: EventRecord = {
            id: "", convId: conv, seq: numOr(derived[i]["seq"], 0),
            type: strOf(derived[i]["role"]) === "user" ? "user/message"
              : (strOf(derived[i]["role"]) === "tool" ? "tool/result" : "assistant/message"),
            payload: derived[i], ts: numOr(derived[i]["ts"], 0) || now(),
          };
          projectRow(tx, evt, MSG_INSERT);
        }
      });
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    return {
      ok: true, messages: derived.length, repaired: repairEvents.length,
      lastSeq: lastSeq + repairEvents.length,
    };
  }

  async function search(convId: string, q: string, limit?: number): Promise<Record<string, unknown>[]> {
    const conv = strOf(convId);
    if (!conv) return [];
    const query = strOf(q).trim();
    if (!query) return [];
    return port().search("messages", { conv: conv }, query, limit);
  }

  async function removeConv(convId: string): Promise<RemoveResult> {
    const conv = strOf(convId);
    if (!conv) return { ok: false, error: "session-events: convId 不能为空" };
    return withArchiveLock(conv, async function () {
      try {
        const p = port();
        await p.transaction(function (tx) {
          tx.exec("DELETE FROM session_events WHERE conv_id = ?", [conv]);
          tx.exec("DELETE FROM messages WHERE conv_id = ?", [conv]);
          tx.exec("DELETE FROM summaries WHERE conv_id = ?", [conv]);
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    });
  }

  async function clearAll(): Promise<RemoveResult> {
    try {
      // Let every in-flight archive settle first; otherwise a late commit would resurrect rows
      // the user just cleared.
      await Promise.all(Object.keys(archiveChain).map(function (k) { return archiveChain[k]; }));
      const p = port();
      await p.transaction(function (tx) {
        tx.exec("DELETE FROM session_events", []);
        tx.exec("DELETE FROM messages", []);
        tx.exec("DELETE FROM summaries", []);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  function coldPort() {
    return {
      load: function (convId: string) { return deriveLiveMessages(convId); },
      archive: function (convId: string, messages: unknown) {
        return archiveMessages(convId, messages).then(function (res) {
          return { ok: res.ok, known: res.known, appended: res.appended, error: res.error };
        });
      },
      remove: function (convId: string) { return removeConv(convId); },
      clearAll: function () { return clearAll(); },
    };
  }

  return {
    v: 1,
    SESSION_EVENT_TYPES: SESSION_EVENT_TYPES,
    append: append,
    appendBatch: appendBatch,
    readEvents: readEvents,
    deriveMessages: deriveMessages,
    deriveLiveMessages: deriveLiveMessages,
    replay: replay,
    appendSummary: appendSummary,
    archiveMessages: archiveMessages,
    archiveCompact: archiveCompact,
    archivedIds: archivedIds,
    truncate: truncate,
    truncateToMessages: truncateToMessages,
    search: search,
    removeConv: removeConv,
    clearAll: clearAll,
    coldPort: coldPort,
  };
}
