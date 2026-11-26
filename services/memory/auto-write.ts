/**
 * End-of-reply memory writer shared by the agent turn and the ordinary chat path.
 *
 * One decision point for the three rules that must never drift:
 *   - the switch is `cfw_mem_auto_v1` (default off; one extra extraction call per reply);
 *   - only a non-empty final reply is written — tool-round text, empty replies and failed/aborted
 *     turns never reach this function;
 *   - a failed write is reported through the `warn` port and never breaks the reply.
 *
 * The caller decides *when* a reply finished; this module decides *whether* and *what* to write.
 * Exactly one call per reply is the caller's contract (both call sites invoke it once).
 * @module services/memory/auto-write
 */

/** The subset of a character card the writer needs. */
export interface AutoWriteCardLike {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface AutoWritePorts {
  /** The effective cfw_mem_auto_v1 switch (combined with the master switch by the facade). */
  enabled(): boolean;
  /** The facade's remember(); resolves with the write result, rejects on storage failure. */
  remember(text: string, opts: Record<string, unknown>): Promise<unknown>;
  /** Report a failed write; never throws. */
  warn(message: string, error?: unknown): void;
}

export interface AutoWriter {
  /**
   * Write one finished reply into memory.
   * @param text - the final visible answer.
   * @param card - the speaking card, or null for a card-less conversation.
   * @param convId - fallback bank when there is no card.
   * @returns whether a write was actually started.
   */
  afterReply(text: unknown, card: unknown, convId: unknown): boolean;
}

function recOf(value: unknown): AutoWriteCardLike {
  const out: AutoWriteCardLike = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

export function createAutoWriter(ports: AutoWritePorts): AutoWriter {
  function afterReply(text: unknown, card: unknown, convId: unknown): boolean {
    let on = false;
    try {
      on = !!ports.enabled();
    } catch (e) {
      ports.warn("[memory] 自动写入开关读取失败，已跳过", e);
      return false;
    }
    if (!on) return false;
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return false;
    const c = recOf(card);
    const cid = typeof c.id === "string" ? c.id : "";
    const name = typeof c.name === "string" ? c.name : "";
    const fallback = String(convId == null ? "" : convId);
    if (!cid && !fallback) return false;
    const opts: Record<string, unknown> = cid
      ? { speakerCid: cid, kind: "said" }
      : { cid: fallback, kind: "observed" };
    try {
      const write = ports.remember(name ? "【" + name + "】" + raw : raw, opts);
      // Fire-and-forget: a slow extraction must not delay the reply, and a rejected storage
      // transaction must surface as a warning rather than an unhandled rejection.
      if (write && typeof write.catch === "function") {
        write.catch(function (e: unknown) { ports.warn("[memory] 自动写入失败（回合不受影响）", e); });
      }
      return true;
    } catch (e) {
      ports.warn("[memory] 自动写入失败（回合不受影响）", e);
      return false;
    }
  }
  return { afterReply };
}
