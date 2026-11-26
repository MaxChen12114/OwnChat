/**
 * Roleplay checkpoint UI plan: the pure decisions behind the "save here / restore to here" entry.
 *
 * The store (`services/data/checkpoints.ts`) already sorts by time descending, so the plan only
 * re-sorts defensively (same rule) and shapes rows for rendering. A pre-restore checkpoint is a
 * normal checkpoint with kind `pre-restore`; undoing a restore is restoring to it, which is why
 * the plan only needs to produce its put arguments.
 * @module services/ui/roleplay-checkpoint-plan
 */

/** One checkpoint row as `__checkpoints.list` returns it (subset the UI renders). */
export interface CheckpointEntry {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  readonly ts: number;
}

/** Rendering shape for the list panel. */
export interface CheckpointEntryView {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  /** `HH:MM:SS` of the checkpoint time, local timezone. */
  readonly time: string;
  /** True for the automatic snapshot taken right before a restore (the undo target). */
  readonly isPreRestore: boolean;
  /** Two-character tag shown before the subject. */
  readonly tag: string;
}

/** Text shown when `applyRoleplay` refuses (a turn is live). The wiring alerts with it verbatim. */
export const RESTORE_REFUSAL = "有回复正在生成，先停止再回退";

/** unknown -> plain-object view; arrays, null and scalars all become null. */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Defensive re-sort: time descending, id ascending as the tiebreak (mirrors the store). */
export function sortEntries(rows: unknown[]): CheckpointEntry[] {
  const out: CheckpointEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rec = recOf(rows[i]);
    if (rec === null) continue;
    const id = typeof rec["id"] === "string" ? rec["id"] : "";
    const ts = typeof rec["ts"] === "number" && isFinite(rec["ts"]) ? rec["ts"] : 0;
    if (id === "") continue;
    out.push({
      id: id,
      subject: typeof rec["subject"] === "string" ? rec["subject"] : "",
      kind: typeof rec["kind"] === "string" && rec["kind"] ? rec["kind"] : "manual",
      ts: ts,
    });
  }
  out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  return out;
}

/** Local `HH:MM:SS`; the date itself is not shown (the list covers today's session work). */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

/** Shape one row for the list panel. */
export function entryView(cp: CheckpointEntry): CheckpointEntryView {
  const isPreRestore = cp.kind === "pre-restore";
  return {
    id: cp.id,
    kind: cp.kind,
    subject: cp.subject,
    time: formatTime(cp.ts),
    isPreRestore: isPreRestore,
    tag: isPreRestore ? "恢复前自动存档" : cp.kind === "manual" ? "手动存档" : cp.kind,
  };
}

/** The arguments for `__checkpoints.put` that snapshot the state right before restoring. */
export interface PreRestorePlan {
  readonly scope: "roleplay";
  readonly scopeId: string;
  readonly payload: unknown;
  readonly opts: { readonly kind: "pre-restore"; readonly subject: string; readonly at: number };
}

/**
 * Build the pre-restore put arguments.
 * @param convId - the conversation the checkpoints belong to.
 * @param targetId - the checkpoint about to be restored; becomes the `before:` subject.
 * @param captured - the live `captureRoleplay()` payload (already taken by the caller).
 * @param now - the checkpoint timestamp.
 * @returns `{ ok, plan }`, or `{ ok: false, error }` when the target id is empty.
 */
export function preRestorePlan(
  convId: string,
  targetId: string,
  captured: unknown,
  now: number,
): { ok: true; plan: PreRestorePlan } | { ok: false; error: string } {
  const sid = typeof convId === "string" ? convId.trim() : "";
  const tid = typeof targetId === "string" ? targetId.trim() : "";
  if (sid === "") return { ok: false, error: "当前没有会话，无法存档" };
  if (tid === "") return { ok: false, error: "回退目标缺失" };
  return {
    ok: true,
    plan: {
      scope: "roleplay",
      scopeId: sid,
      payload: captured,
      opts: { kind: "pre-restore", subject: "before:" + tid, at: now },
    },
  };
}
