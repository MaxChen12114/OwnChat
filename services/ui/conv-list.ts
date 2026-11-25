/**
 * The conversation-list rules, minus the DOM: relative-time formatting, the content signature
 * that gates redraws, preview/title copy, the ⋯-menu placement geometry, and the cheap raw-
 * snapshot gate.
 *
 * Two gates keep the list cheap and non-intrusive. The RAW gate (2026-10-07 E-D) compares the
 * raw localStorage strings of the session store and slot metadata first — unchanged strings skip
 * even the full-store JSON.parse inside listConversations. The SIG gate compares a projection of
 * the rendered fields only; unchanged content means no repaint, so hover states and an in-flight
 * rename are never disturbed. A cleared lastSig ("" after explicit user actions or events) always
 * forces a repaint.
 *
 * Menu placement: anchor below the ⋯ button, flip above when the menu would overflow the bottom,
 * and clamp inside the viewport with an 8px margin — all pure math so tests can lock it.
 * @module services/ui/conv-list
 */

/** Poll interval. Instant refresh comes from 4 event listeners + focus; polling is the fallback. */
export const CL_POLL_MS = 8000;

/** localStorage keys whose raw bytes feed the cheap gate. */
export const CL_LS_SESSION_KEY = "cfw_chat_session_v1";
export const CL_LS_META_KEY = "cfw_chat_slot_meta_v1";

/** Rename input max length (also the guard against pasting a novel into the sidebar). */
export const CL_NAME_MAX = 60;

/** Relative time label. `now` is injected for testability; the wiring passes Date.now().
 * Beyond 7 days the label switches to an absolute M/D date — "51 天前" reads worse than "4/12". */
export function clFmtAgo(ts: unknown, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - Number(ts)) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  if (s < 86400 * 7) return Math.round(s / 86400) + " 天前";
  const d = new Date(Number(ts));
  return d.getMonth() + 1 + "/" + d.getDate();
}

function rec(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** Content signature over exactly the fields the row renders. Including charAvatar's presence
 * (not its URL) and running's boolean shape keeps the signature stable against irrelevant churn;
 * preview is truncated to 24 chars so a growing stream does not retrigger paints per poll. */
export function clSigOf(list: unknown[]): string {
  return JSON.stringify(
    list.map((rawItem) => {
      const c = rec(rawItem);
      const preview = typeof c["preview"] === "string" ? c["preview"] : "";
      return [
        c["convId"],
        c["name"],
        c["count"],
        c["updatedAt"],
        c["active"],
        c["charIcon"],
        Boolean(c["charAvatar"]),
        preview.slice(0, 24),
        Boolean(c["running"]),
      ];
    }),
  );
}

/** Cheap gate: skip the render entirely (no parse, no list call) when nothing the list reads has
 * changed on disk. First frame (lastSig === "") and explicit refreshes always pass through —
 * lastSig is cleared by every user action / event precisely so this gate cannot swallow them. */
export function clRawSkip(
  force: boolean,
  lastSig: string,
  childCount: number,
  raw: string | null,
  lastRaw: string | null,
  metaRaw: string | null,
  lastMetaRaw: string | null,
): boolean {
  return Boolean(
    !force &&
      lastSig !== "" &&
      childCount > 0 &&
      raw === lastRaw &&
      metaRaw === lastMetaRaw,
  );
}

/** Signature gate: skip the repaint when the rendered projection is unchanged and the list has
 * content. An empty DOM (childCount 0) always repaints so a cleared sidebar rebuilds. */
export function clSigSkip(sig: string, lastSig: string, childCount: number): boolean {
  return sig === lastSig && childCount > 0;
}

/** Preview line: with messages show the stored preview (placeholder when it is blank), without
 * messages show "暂无消息". */
export function clPreviewOf(count: unknown, preview: unknown): string {
  return count ? String(preview || "(无文字内容)") : "暂无消息";
}

/** Row tooltip: name (+ character) / message count / running marker. */
export function clRowTitle(c: unknown): string {
  const item = rec(c);
  const name = typeof item["name"] === "string" ? item["name"] : "";
  const charName = typeof item["charName"] === "string" ? item["charName"] : "";
  const count = item["count"];
  return (
    name +
    (charName ? " · " + charName : "") +
    "\n" +
    (count ? count + " 条消息" : "暂无消息") +
    (item["running"] ? "\n后台生成中…" : "")
  );
}

/** Menu placement for the ⋯ menu: below the anchor, flipped above when it would overflow the
 * bottom (keeping at least 8px from the top edge), and clamped horizontally with an 8px margin. */
export function clMenuPos(
  anchor: { right: number; bottom: number; top: number },
  menuW: number,
  menuH: number,
  winW: number,
  winH: number,
): { left: number; top: number } {
  const left = Math.min(anchor.right - menuW, winW - menuW - 8);
  let top = anchor.bottom + 4;
  if (top + menuH > winH - 8) top = Math.max(8, anchor.top - menuH - 4);
  return { left: Math.max(8, left), top };
}

/** Commit decision for a rename: a non-empty value that actually differs. Returning null means
 * "just repaint" — do not call renameConversation with a no-op or an empty name. */
export function clRenameCommit(oldName: unknown, input: unknown): string | null {
  const v = typeof input === "string" ? input.trim() : "";
  if (v && v !== oldName) return v;
  return null;
}
