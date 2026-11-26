/**
 * The developer console, minus every side effect: what a captured chat request turns into, how the
 * capture ring is capped, how an SSE response stream is re-assembled for inspection, how the
 * IndexedDB record is shaped and truncated, how the export file is composed, and how sampling
 * overrides ride into the request body.
 *
 * One non-obvious choice: the capture ring is capped at 3 entries while developer mode is off. The
 * ring is installed unconditionally (every chat request goes through it, at zero cost), but each
 * entry carries the full message history, and 25 of those can hold tens of MB. Three is exactly
 * enough for "turn the mode on and look at the request from just now".
 *
 * All capture state lives here; the wiring reaches it only through the functions below, which keeps
 * the ring and the selection testable without a DOM and without a fetch.
 * @module services/dev/console
 */

export const DEV_CONSOLE_MODE_KEY = "cfw_dev_mode_v1";
export const DEV_DEBUG_KEY = "cfw_dev_debug_v1";
export const DEV_OVERRIDES_KEY = "cfw_dev_overrides_v1";
export const DEV_HUD_KEY = "cfw_dev_hud_v1";
export const IO_RECORD_KEY = "cfw_dev_io_record_v1";
export const STREAM_PROBE_KEY = "cfw_dev_stream_probe_v1";

/** Ring cap with the mode on / off. The off cap is a memory guard, not a feature. */
export const MAX_PAYLOADS = 25;
export const MAX_PAYLOADS_OFF = 3;

/** The on-disk record store keeps 50 entries; the panel reloads at most 15 back into memory. */
export const IO_KEEP = 50;
export const IO_LOAD = 15;
/** Response-side size cap for one persisted record, in string characters (not bytes). */
export const IO_CAP = 400000;
/** Same cap for the in-memory raw stream accumulator. */
export const RAW_CAP = 400000;

/** One captured request plus everything the stream measurement fills in later. */
export interface CaptureEntry {
  at: number;
  payload: unknown;
  status: unknown;
  ms: number;
  bytes: number;
  done: boolean;
  requestBytes: number;
  msgCount: number;
  tokenEstimate: number;
  error: unknown;
  errorBody: string;
  /** Anything below is filled in by the stream measurement, the history merge, or the store. */
  [key: string]: unknown;
}

/** unknown to array, narrowed without an assertion. */
function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Read-side bridge from unknown to a plain record; arrays, nulls and scalars yield an empty one. */
function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOr(v: unknown, d: number): number {
  return typeof v === "number" && isFinite(v) ? v : d;
}

/** Rough request-size token estimate: ~3.2 characters per token, chars only, never throws. */
export function estimatePayloadTokens(payload: unknown): number {
  try {
    const p = recOf(payload);
    let chars = 0;
    for (const m of arrOf(p.messages)) {
      const c = recOf(m).content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part === "object") {
            const t = recOf(part).text;
            if (typeof t === "string") chars += t.length;
            else chars += JSON.stringify(part).length;
          } else if (part) chars += JSON.stringify(part).length;
        }
      } else if (c != null) chars += JSON.stringify(c).length;
    }
    const strFields = ["custom_system_prompt", "priorSummary", "extraSystemPrompts", "topic"];
    for (const k of strFields) {
      const v = p[k];
      if (typeof v === "string") chars += v.length;
    }
    if (p.characterCard) chars += JSON.stringify(p.characterCard).length;
    if (Array.isArray(p.lorebook)) chars += JSON.stringify(p.lorebook).length;
    return Math.ceil(chars / 3.2);
  } catch {
    return 0;
  }
}

/** Number of messages in a chat payload; 0 for anything that is not a message list. */
export function countPayloadMessages(payload: unknown): number {
  return arrOf(recOf(payload).messages).length;
}

export function ringCap(devOn: boolean): number {
  return devOn ? MAX_PAYLOADS : MAX_PAYLOADS_OFF;
}

// Capture ring. The only mutable state in this module; wiring mutates through
// the functions below and never touches the array itself.

const captures: CaptureEntry[] = [];
let selected = -1;

/**
 * Record one outgoing chat request. Trims the ring to the cap for the current mode and selects the
 * new entry. `requestBytes` arrives measured (Blob size in the wiring); pass 0 when unmeasurable.
 */
export function recordPayload(payload: unknown, at: number, requestBytes: number, devOn: boolean): CaptureEntry {
  const entry: CaptureEntry = {
    at,
    payload,
    status: null,
    ms: 0,
    bytes: 0,
    done: false,
    requestBytes,
    msgCount: countPayloadMessages(payload),
    tokenEstimate: estimatePayloadTokens(payload),
    error: null,
    errorBody: "",
  };
  captures.push(entry);
  const cap = ringCap(devOn);
  if (captures.length > cap) captures.splice(0, captures.length - cap);
  selected = captures.length - 1;
  return entry;
}

/** The entry the panel shows: the selection, or the newest one when nothing is selected. */
export function selectedCapture(): CaptureEntry | null {
  if (selected >= 0 && selected < captures.length) return captures[selected];
  return captures.length ? captures[captures.length - 1] : null;
}

export function selectCapture(i: number): void {
  selected = i;
}

/** Index of the selected entry, for list rendering; -1 means "fall back to the newest". */
export function selectedIndex(): number {
  return selected;
}

export function captureCount(): number {
  return captures.length;
}

export function captureAt(i: number): CaptureEntry | null {
  return i >= 0 && i < captures.length ? captures[i] : null;
}

export function historyCount(): number {
  let n = 0;
  for (const e of captures) if (e.fromHist) n++;
  return n;
}

/**
 * Merge records restored from the store into the ring. `recs` arrives newest-first (cursor order);
 * unshift in that order so memory ends up oldest-first, matching the live ring. The ring cap is
 * re-applied afterwards: without it, 15 restored + 25 live entries linger for the whole session,
 * which is the tens-of-MB heap that once showed up in the renderer process.
 */
export function mergeHistory(recs: unknown[]): void {
  for (const r of recs) {
    const merged: CaptureEntry = {
      ...recOf(r),
      at: numOr(recOf(r).at, Date.now()),
      payload: recOf(r).payload ?? null,
      status: recOf(r).status ?? null,
      ms: numOr(recOf(r).ms, 0),
      bytes: numOr(recOf(r).bytes, 0),
      done: !!recOf(r).done,
      requestBytes: numOr(recOf(r).requestBytes, 0),
      msgCount: numOr(recOf(r).msgCount, 0),
      tokenEstimate: numOr(recOf(r).tokenEstimate, 0),
      error: recOf(r).error ?? null,
      errorBody: strOf(recOf(r).errorBody),
      fromHist: true,
    };
    captures.unshift(merged);
  }
  if (captures.length > MAX_PAYLOADS) captures.splice(0, captures.length - MAX_PAYLOADS);
  if (selected < 0) selected = captures.length - 1;
}

/** Called after the on-disk store is cleared: history entries leave memory, live ones stay. */
export function dropHistoryCaptures(): void {
  for (let i = captures.length - 1; i >= 0; i--) if (captures[i].fromHist) captures.splice(i, 1);
  if (selected >= captures.length) selected = captures.length - 1;
}

/**
 * Sampling overrides for the next chat request: `temp` lands as `temperature`, `maxTokens` as
 * `max_tokens`. Only numeric values are applied; everything else means "use the form value".
 * The wiring re-serializes the body afterwards either way, so a request without overrides keeps
 * its parsed-and-restringified shape (the historical behavior).
 */
export function applySamplingOverrides(body: Record<string, unknown>, ovr: Record<string, unknown>): void {
  if (typeof ovr.temp === "number") body.temperature = ovr.temp;
  if (typeof ovr.maxTokens === "number") body.max_tokens = ovr.maxTokens;
}

// SSE re-assembly. The wiring owns the reader and the raw-byte cap; this parser
// turns the decoded text back into content / reasoning / usage / assembly echo.

export interface SseParser {
  feed(chunk: string): void;
  /** Flush a buffered tail that never saw a newline (end of stream). */
  finish(): void;
  content(): string;
  reasoning(): string;
  usage(): unknown;
  chunks(): number;
  dbg(): unknown;
}

/**
 * Incremental parser for the OpenAI-style SSE stream. `: __dbg__ {...}` comment lines carry the
 * server's read-only echo of the assembled prompt; only the first one wins, later echoes are
 * ignored. Non-JSON data lines are skipped, never thrown.
 */
export function createSseParser(): SseParser {
  let content = "";
  let reasoning = "";
  let usage: unknown = null;
  let chunks = 0;
  let dbg: unknown = null;
  let buf = "";

  function flushLine(line: string): void {
    const t = line.replace(/\r$/, "").trim();
    if (!t) return;
    if (t.charAt(0) === ":") {
      const k = t.indexOf("__dbg__");
      if (k >= 0 && dbg === null) {
        try {
          dbg = JSON.parse(t.slice(k + 7).trim());
        } catch {
          // Keep null: a half-written echo line must not break the stream.
        }
      }
      return;
    }
    if (t.indexOf("data:") === 0) {
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") return;
      try {
        const j = recOf(JSON.parse(d));
        chunks++;
        const choice0 = recOf(arrOf(j.choices)[0]);
        const delta = recOf(choice0.delta);
        if (typeof delta.content === "string") content += delta.content;
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
        if (j.usage) usage = j.usage;
      } catch {
        // Not JSON: ignore, same as the original probe.
      }
    }
  }

  return {
    feed(chunk: string): void {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        flushLine(line);
      }
    },
    finish(): void {
      if (buf.trim()) flushLine(buf);
      buf = "";
    },
    content: () => content,
    reasoning: () => reasoning,
    usage: () => usage,
    chunks: () => chunks,
    dbg: () => dbg,
  };
}

/**
 * Persisted-record shape: same fields as the in-memory entry so the panel, the inspector and the
 * export can consume restored records without a conversion step. The id is always regenerated
 * (timestamp + 5 random chars) — restored entries do not keep their old id.
 */
export function shapeIoRecord(e: CaptureEntry): Record<string, unknown> {
  const payload = recOf(e.payload);
  return {
    id: String(e.at || Date.now()) + "-" + Math.random().toString(36).slice(2, 7),
    at: e.at || Date.now(),
    model: payload.model || null,
    status: e.status,
    ms: e.ms || 0,
    ttfb: e.ttfb || 0,
    requestBytes: e.requestBytes || 0,
    responseBytes: e.bytes || 0,
    msgCount: e.msgCount || 0,
    tokenEstimate: e.tokenEstimate || 0,
    chunks: e.chunks || 0,
    done: !!e.done,
    error: e.error || null,
    errorBody: e.errorBody || "",
    debugStream: !!e.debugStream,
    payload: e.payload || null,
    dbg: e.dbg || null,
    content: e.content || "",
    reasoning: e.reasoning || "",
    usage: e.usage || null,
    raw: e.raw || "",
    truncated: false,
  };
}

/**
 * Bring one record under `cap` characters when serialized, in a fixed priority: drop the raw
 * stream first, then halve reasoning, then halve content, then blank the assembly echo — payload
 * is never cut, it is the thing being debugged. The loop is bounded: each pass cuts at least one
 * field in half, and a record that cannot shrink further exits instead of spinning.
 */
export function capIoRecord(rec: Record<string, unknown>, cap = IO_CAP): Record<string, unknown> {
  let s = "";
  try {
    s = JSON.stringify(rec);
  } catch {
    return rec;
  }
  if (s.length <= cap) return rec;
  rec.truncated = true;
  rec.raw = "";
  const half = (t: unknown) => (typeof t === "string" && t) ? t.slice(0, Math.floor(t.length / 2)) : "";
  for (let i = 0; i < 24; i++) {
    try {
      s = JSON.stringify(rec);
    } catch {
      break;
    }
    if (s.length <= cap) break;
    if (rec.reasoning) {
      rec.reasoning = half(rec.reasoning);
      continue;
    }
    if (rec.content) {
      rec.content = half(rec.content);
      continue;
    }
    if (rec.dbg && recOf(rec.dbg).systemContent) {
      rec.dbg = { ...recOf(rec.dbg), systemContent: "（超上限已丢弃）" };
      continue;
    }
    break;
  }
  return rec;
}

/** Whether a record may be persisted: developer mode on AND the user has not turned the flag off. */
export function ioRecordEnabled(devOn: boolean, flag: string | null): boolean {
  return devOn && (flag ?? "1") === "1";
}

export interface IoWindow {
  text: string;
  /** Start offset for the next read, or null when the window reached the end. */
  next: number | null;
  total: number;
}

/** Read one window of a (possibly 400k-character) record body. Start < 1 clamps to 1; len clamps to 8000. */
export function ioWindow(text: unknown, start: unknown, len: unknown): IoWindow {
  const str = String(text || "");
  const st = Math.max(1, parseInt(String(start || "1"), 10) || 1);
  const n = Math.min(8000, Math.max(1, parseInt(String(len || "3000"), 10) || 3000));
  const piece = str.slice(st - 1, st - 1 + n);
  return { text: piece, next: (st - 1 + n < str.length) ? (st + n) : null, total: str.length };
}

/** MM-DD HH:MM:SS from a timestamp; zero-padded, year deliberately omitted (records are recent). */
export function fmtWhen(at: number): string {
  const d = new Date(at || 0);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** One-line summary for list output; flags surface truncated / debugStream variants. */
export function fmtRecord(r: Record<string, unknown>): string {
  return "#" + strOf(r.id) + "  " + fmtWhen(numOr(r.at, 0)) + "  model=" + (r.model || "-") + "  msgs=" + numOr(r.msgCount, 0) + "  "
    + (r.error ? "ERROR" : (r.done ? "ok" : "incomplete")) + "  " + numOr(r.ms, 0) + "ms  req=" + numOr(r.requestBytes, 0) + "B resp=" + numOr(r.responseBytes, 0) + "B"
    + (r.truncated ? "  [truncated]" : "") + (r.debugStream ? "  [debugStream]" : "");
}

/** Find a record by exact id or by prefix; ids are short so prefix matching is the common path. */
export function findByIdPrefix(records: Record<string, unknown>[], idPrefix: unknown): Record<string, unknown> | null {
  const s = String(idPrefix || "").trim();
  for (let i = 0; i < records.length; i++) {
    const id = strOf(records[i].id);
    if (id === s || id.indexOf(s) === 0) return records[i];
  }
  return null;
}

// Export file. The download / clipboard / Tauri write itself is wiring; this is
// the record shape and the filename stamp.

/** The per-record shape of the exported JSON file. `request` / `assembled` keep the debug names. */
export function exportRecordsShape(entries: CaptureEntry[]): Record<string, unknown>[] {
  return entries.map((e, i) => ({
    idx: i + 1,
    at: e.at,
    time: new Date(e.at).toISOString(),
    status: e.status,
    ms: e.ms || 0,
    ttfb: e.ttfb || 0,
    requestBytes: e.requestBytes || 0,
    responseBytes: e.bytes || 0,
    msgCount: e.msgCount || 0,
    tokenEstimate: e.tokenEstimate || 0,
    chunks: e.chunks || 0,
    done: !!e.done,
    error: e.error || null,
    errorBody: e.errorBody || "",
    model: recOf(e.payload).model || null,
    request: e.payload || null,
    assembled: e.dbg || null,
    content: e.content || "",
    reasoning: e.reasoning || "",
    usage: e.usage || null,
    raw: e.raw || "",
  }));
}

/** The whole export document: timestamp, count, records. */
export function exportBundle(entries: CaptureEntry[], exportedAt: string): Record<string, unknown> {
  const records = exportRecordsShape(entries);
  return { exportedAt, count: records.length, records };
}

/** `YYYYMMDD-HHMMSS`, local time, for the export filename. */
export function stampName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + "-" + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
}

/**
 * Cost estimate for one record against the DeepSeek pricing table (per-million rates, with a
 * cache-hit discount on the cached prompt share). Unknown model, missing usage or missing rates
 * yield null — the inspector omits the row instead of showing a wrong number.
 */
export function estCostCNY(model: unknown, usage: unknown, pricing: unknown): number | null {
  const raw = recOf(pricing)[strOf(model)];
  if (!raw || !usage) return null;
  const p = recOf(raw);
  const u = recOf(usage);
  const prompt = numOr(u.prompt_tokens, 0);
  const comp = numOr(u.completion_tokens, 0);
  const cached = numOr(u.prompt_cache_hit_tokens, 0);
  const normal = Math.max(0, prompt - cached);
  return (cached * numOr(p.cache_hit, 0) + normal * numOr(p.input, 0) + comp * numOr(p.output, 0)) / 1e6;
}
