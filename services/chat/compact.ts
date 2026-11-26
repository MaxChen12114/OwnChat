/**
 * Auto-compaction runner shared by the ordinary chat path and the agent turn.
 *
 * The trigger, thresholds and slice planner stay in `services/chat/context.ts`; this module owns
 * the one thing the old inline block could not guarantee: a cutoff that never splits a
 * `tool_calls` / `tool` pair. It also refuses to run while the session ends in a tool exchange
 * (an in-flight call or a dangling result), so a live turn is never summarized underneath itself.
 *
 * Since T3-D the flow is three steps, in this order:
 *   1. append the original message events + the `summary` event and project `messages` in one
 *      transaction (the `archive` port; absent means a legacy host and step 1 is skipped);
 *   2. append a seq anchor to the summary text — "原文 seq X-Y 在归档，可用 history_search 回捞";
 *   3. splice the hot window (remove DOM rows, `session.splice`, persist).
 * A failed archive aborts the whole compaction: splicing without a searchable copy is data loss.
 *
 * Side effects are ports: the HTTP call, the summary table, the event archive, the DOM row removal
 * and the session array all belong to the host. The service decides *whether* to compact, *where*
 * the safe boundary is, and *what* to send; the wiring/app applies it.
 *
 * Equivalence: the ordinary-chat transcript and request shape are unchanged for sessions without
 * tool rounds (`safeCutoff` is the identity when no tool result sits on the boundary).
 * @module services/chat/compact
 */

export interface CompactConfigLike {
  enabled: boolean;
  trigger: number;
  keep: number;
  ratio: number;
}

export interface CompactPlanLike {
  cutoff: number;
  toSum: Record<string, unknown>[];
}

/** One finished turn to consider; all state is supplied by the caller. */
export interface CompactCall {
  session: unknown;
  convId: string;
  activeConvId: string;
  priorSummary: string;
  characterName: string;
  customProvider?: unknown;
  mode: string;
  model: string;
  providerId?: unknown;
  persist(): void;
  removeRows(count: number): void;
}

export interface CompactArchiveInput {
  convId: string;
  /** The exact slice being summarised (already pairing-safe). */
  messages: Record<string, unknown>[];
  /** The summary text as received from /api/summarize (before the seq anchor is appended). */
  summary: string;
}

/** What the archive answers: the seq range the anchor quotes, plus how many were new. */
export interface CompactArchiveResult {
  ok: boolean;
  appended?: number;
  fromSeq?: number;
  toSeq?: number;
  summarySeq?: number;
  error?: string;
}

export interface CompactPorts {
  config(): CompactConfigLike;
  historyEnabled(): boolean;
  shouldCompact(sessionLength: number, trigger: number): boolean;
  plan(session: unknown, keep: unknown): CompactPlanLike | null;
  readSummary(payload: unknown): string | null;
  summarizeBody(snapshot: Record<string, unknown>): Record<string, unknown>;
  /** POST /api/summarize; resolves parsed JSON, or null when the response was not usable. */
  request(body: Record<string, unknown>): Promise<unknown>;
  saveSummary(convId: string, text: string): void;
  applySummary(text: string): void;
  renderChip(): void;
  /** Show/hide the "compacting" status in the host's cost line. */
  busy(on: boolean): void;
  warn(message: string, error: unknown): void;
  /**
   * Step one of compaction: append the original message events and the summary event, projecting
   * `messages` in the same transaction. Absent means "legacy host" (tests, an old boot): the
   * compactor then behaves exactly as before and does not quote a seq anchor.
   */
  archive?(input: CompactArchiveInput): Promise<CompactArchiveResult | null>;
}

export interface CompactorApi {
  maybeCompact(call: CompactCall): Promise<boolean>;
  busy(): boolean;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/**
 * Move a raw cutoff left until the first kept message is not a `tool` result.
 *
 * A tool result is only meaningful next to its declaring assistant `tool_calls`; if the boundary
 * lands on the result, backing up to the assistant message keeps the whole exchange on one side.
 * Returns the identity when the boundary is already safe, and 0 when the only safe boundary is
 * "compress nothing".
 */
export function safeCutoff(session: unknown, cutoff: unknown): number {
  const arr = Array.isArray(session) ? session : [];
  let c = typeof cutoff === "number" && isFinite(cutoff) ? Math.floor(cutoff) : 0;
  if (c <= 0) return 0;
  if (c >= arr.length) return arr.length;
  while (c > 0) {
    const m = recOf(arr[c]);
    if (m.role !== "tool") break;
    c--;
  }
  return c;
}

/** A session whose last message is a call or a result is mid-exchange: never compact it. */
export function endsInToolExchange(session: unknown): boolean {
  const arr = Array.isArray(session) ? session : [];
  if (!arr.length) return false;
  const last = recOf(arr[arr.length - 1]);
  if (last.role === "tool") return true;
  return last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
}

/**
 * The archive anchor appended to a summary: which event seq range the original text occupies.
 * Invalid ranges return "" so a broken archive never puts a wrong pointer into the prompt.
 */
export function summaryAnchor(from: unknown, to: unknown): string {
  const a = Math.floor(Number(from));
  const b = Math.floor(Number(to));
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b < a) return "";
  return "原文 seq " + String(a) + "-" + String(b) + " 在归档，可用 history_search 回捞";
}

export function createCompactor(ports: CompactPorts): CompactorApi {
  let _busy = false;

  async function maybeCompact(call: CompactCall): Promise<boolean> {
    if (_busy) return false;
    let cfg: CompactConfigLike;
    try {
      cfg = ports.config();
    } catch (e) {
      ports.warn("auto-summarize: 读取压缩配置失败", e);
      return false;
    }
    if (!cfg.enabled) return false;
    let historyOn = false;
    try {
      historyOn = !!ports.historyEnabled();
    } catch (e) {
      return false;
    }
    if (!historyOn) return false;

    const session = Array.isArray(call.session) ? call.session : [];
    if (session.length <= 4) return false;
    if (endsInToolExchange(session)) return false;
    let should = false;
    try {
      should = !!ports.shouldCompact(session.length, cfg.trigger);
    } catch (e) {
      ports.warn("auto-summarize: 水位判定失败", e);
      return false;
    }
    if (!should) return false;

    let raw: CompactPlanLike | null;
    try {
      raw = ports.plan(session, cfg.keep);
    } catch (e) {
      ports.warn("auto-summarize: 切片计划失败", e);
      return false;
    }
    if (!raw || !Array.isArray(raw.toSum)) return false;
    const cutoff = safeCutoff(session, raw.cutoff);
    if (cutoff <= 0 || cutoff >= session.length) return false;
    const toSum = raw.toSum.slice(0, cutoff);
    if (!toSum.length) return false;

    _busy = true;
    ports.busy(true);
    try {
      const body = ports.summarizeBody({
        messages: toSum,
        priorSummary: call.priorSummary,
        characterName: call.characterName,
        customProvider: call.customProvider,
        mode: call.mode,
        model: call.model,
        providerId: call.providerId,
      });
      const payload = await ports.request(body);
      const text = ports.readSummary(payload);
      if (text === null) return false;
      // Step one (T3-D): archive the originals + the summary event, projecting `messages` in the
      // same transaction. Only when that succeeded may the hot window be spliced — otherwise the
      // text would vanish from the transcript without a searchable copy. Legacy hosts (no archive
      // port) keep the old behaviour and simply get no seq anchor.
      let summaryText = text;
      const archivePort = ports.archive;
      if (typeof archivePort === "function") {
        let archived: CompactArchiveResult | null = null;
        try {
          archived = await archivePort({ convId: call.convId, messages: toSum, summary: text });
        } catch (e) {
          ports.warn("auto-summarize: 归档原文失败，保留原文不压缩", e);
          return false;
        }
        // `null` is the wiring's "no archive service in this build" answer: keep the legacy flow
        // (tests and old shells) but do not claim a seq anchor. `{ok:false}` is a real failure.
        if (archived) {
          if (archived.ok !== true) {
            ports.warn("auto-summarize: 归档原文失败，保留原文不压缩", archived.error || null);
            return false;
          }
          const anchor = summaryAnchor(archived.fromSeq, archived.toSeq);
          if (anchor) summaryText = text + "\n\n" + anchor;
        }
      }
      ports.saveSummary(call.convId, summaryText);
      if (call.convId === call.activeConvId) ports.applySummary(summaryText);
      call.removeRows(cutoff);
      session.splice(0, cutoff);
      call.persist();
      ports.renderChip();
      return true;
    } catch (e) {
      ports.warn("auto-summarize failed:", e);
      return false;
    } finally {
      _busy = false;
      ports.busy(false);
    }
  }

  return {
    maybeCompact,
    busy: function () { return _busy; },
  };
}
