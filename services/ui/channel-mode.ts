/**
 * The topbar mode pill and the mode switch behind it: for each of the three channel states (guest,
 * preset, custom) it decides the word, glyph and tooltip the button shows, plus which mode a click
 * moves to and which preset a custom-channel click falls back to.
 *
 * Two shapes here are load-bearing and look like bugs if "fixed". A preset channel never prints its
 * own name on the pill: the free/fast pills are mode switches, not channel read-outs, so they stay
 * two characters wide and the channel name lives in the tooltip — printing the channel title there
 * reflows the whole topbar. Only a custom channel prints a name, truncated by code point to four
 * slots, because a half-cut emoji is worse than an ellipsis.
 *
 * Reading providers state and writing the DOM stay in the wiring; this module only answers what the
 * pill should say and what the next mode is.
 * @module services/ui/channel-mode
 */

export type ModeId = "free" | "fast";
export type ChannelKind = "preset" | "custom";

/** What the wiring resolved from the providers module; `mode` is the channel's paired mode. */
export interface ActiveChannel {
  kind: ChannelKind;
  name: string;
  mode?: unknown;
}

export interface PillPlan {
  /** Emoji text assigned before the glyph is drawn; null leaves `textContent` alone. */
  text: string | null;
  icon: string;
  /** Word handed to the icon painter — the visible label for the two preset states. */
  label: string;
  title: string;
}

/** Anything but the literal `fast` reads as the free mode; a corrupt stored mode must not blank the pill. */
export function cmMode(v: unknown): ModeId {
  return v === "fast" ? "fast" : "free";
}

export function cmNextMode(v: unknown): ModeId {
  return cmMode(v) === "fast" ? "free" : "fast";
}

/** The preset that pairs with a mode; a custom channel is explicitly switched back to it on click. */
export function cmPresetFor(v: unknown): string {
  return "preset:" + (cmMode(v) === "fast" ? "deepseek" : "nvidia");
}

/** Only a non-empty id can be a custom channel; `custom:` is the prefix the providers module writes. */
export function cmIsCustomActive(activeId: unknown): boolean {
  if (!activeId) return false;
  return String(activeId).indexOf("custom:") === 0;
}

/** Four slots max: longer names keep three characters plus an ellipsis so the topbar does not reflow. */
export function cmCustomLabel(name: unknown): string {
  const chars = Array.from(String(name || "").trim());
  return chars.length > 4 ? chars.slice(0, 3).join("") + "…" : chars.join("");
}

/**
 * The pill for the current state. A guest with no channel gets the guest pill; a guest that does
 * have a custom channel still sees that channel, because it is the guest's own key.
 *
 * @returns `{ text, icon, label, title }` — `text` is non-null only for the two channel-less states,
 *   so the caller must skip the `textContent` write when it is null and let the icon painter own it.
 */
export function cmPillPlan(input: { mode: unknown; guest: boolean; channel: ActiveChannel | null }): PillPlan {
  const ch = input.channel;
  if (!ch) {
    if (input.guest) {
      return {
        text: "访客",
        icon: "modeFree",
        label: "访客",
        title: "访客模式：请在 设置 → 模型 API 填自己的渠道和 Key",
      };
    }
    const fast = cmMode(input.mode) === "fast";
    return {
      text: fast ? "\u26A1 快速" : "\u{1F7E2} 免费",
      icon: fast ? "modeFast" : "modeFree",
      label: fast ? "快速" : "免费",
      title: fast
        ? "当前：快速档（按量计费）；渠道与默认模型见 设置→模型 API"
        : "当前：免费档；渠道与默认模型见 设置→模型 API",
    };
  }
  if (ch.kind === "preset") {
    // The channel's own paired mode wins over the current mode: an active preset defines the tier.
    const fast = ch.mode === "fast";
    return {
      text: null,
      icon: fast ? "modeFast" : "modeFree",
      label: fast ? "快速" : "免费",
      title:
        "当前：" + (fast ? "快速档" : "免费档") + "（渠道 " + ch.name + "）；点击切换免费/快速 · 渠道详情见 设置→模型 API",
    };
  }
  return {
    text: null,
    icon: "modeFast",
    label: cmCustomLabel(ch.name),
    title: "当前渠道：" + ch.name + "；点击切换免费/快速预设（渠道详情见 设置→模型 API）",
  };
}

/**
 * Whether a providers-changed event has to move the mode, and to what.
 *
 * @returns the target mode, or null when the event only needs a repaint. Anything outside the two
 *   known modes returns null: the pill must not adopt a value the request path cannot honour.
 */
export function cmFollowPlan(current: unknown, want: unknown): ModeId | null {
  if (want !== "fast" && want !== "free") return null;
  return want === current ? null : want;
}
