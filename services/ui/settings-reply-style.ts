/**
 * Reply-style setting: the single home for `cfw_reply_style_v1`, read by three consumers —
 * services/chat/request.ts (main path), services/agent/peer-calls.ts (peer calls) and
 * services/conv/app-mode.ts (work-mode gate).
 *
 * All four sites used to spell out the same `read(key) || "default"` independently, and none of them
 * validated the value. A dirty localStorage entry (or a bad write from an older build) would be
 * passed straight through to the prompt layer instead of falling back. The whitelist, the default
 * and the safe read now live here once; an equivalence lock pins each consumer's read to this rule.
 *
 * The `isWork()` gate that forces "default" in work mode is a higher-level decision and stays in
 * app-mode.ts — this module owns only "which style is legal and what an absent/dirty value means".
 *
 * Zero window, zero casts: storage arrives through {@link ReplyStylePorts}, and the wiring owns the
 * try/catch around localStorage.
 * @module services/ui/settings-reply-style
 */

export const REPLY_STYLE_KEY = "cfw_reply_style_v1";
export type ReplyStyle = "default" | "wechat" | "verbose";
export const REPLY_STYLES: readonly ReplyStyle[] = ["default", "wechat", "verbose"];

export interface ReplyStylePorts {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReplyStyleApi {
  /** Whitelisted style; absent, dirty or unknown values all read as "default". */
  read(): ReplyStyle;
  /** Persist only a legal style; an unknown value falls back to "default". */
  write(value: unknown): ReplyStyle;
  /** The legal values, for the card's <select> options. */
  styles(): readonly ReplyStyle[];
}

/** Legal values only; everything else — including a missing key — is "default". */
export function normalizeReplyStyle(v: unknown): ReplyStyle {
  const s = typeof v === "string" ? v : "";
  return s === "wechat" || s === "verbose" ? s : "default";
}

export function createSettingsReplyStyle(ports: ReplyStylePorts): ReplyStyleApi {
  return {
    read: () => {
      let raw: string | null = null;
      try {
        raw = ports.getItem(REPLY_STYLE_KEY);
      } catch (e) {
        return "default";
      }
      return normalizeReplyStyle(raw);
    },
    write: (value) => {
      const style = normalizeReplyStyle(value);
      try {
        ports.setItem(REPLY_STYLE_KEY, style);
      } catch (e) {
      }
      return style;
    },
    styles: () => REPLY_STYLES,
  };
}
