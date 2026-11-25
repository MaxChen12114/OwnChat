/**
 * Decision rules for the single-character narrative autopilot, with no DOM, timers or host calls.
 * The wiring owns localStorage, the send loop, TTS gating and the frozen global facade.
 *
 * Driver exclusivity is decided from a snapshot of the other engines rather than live globals:
 * a streaming bubble is this engine's own output in flight, so it MUST NOT yield the wheel.
 * @module services/agent/autopilot
 */

/** Storage keys; the wiring is the only reader and writer. */
export const AUTOPILOT_LS = {
  mode: "cfw_autopilot_mode_v1",
  auto: "cfw_autopilot_auto_v1",
  maxSeg: "cfw_autopilot_max_segments_v1",
  gateTts: "cfw_autopilot_gate_tts_v1",
  address: "cfw_address_mode_v1",
  choices: "cfw_choices_freq_v1",
  pacing: "cfw_reply_pacing_delay_v1",
};

/** Segment cap mirrors the fishbowl engine; any stored value is clamped into [1, 1000]. */
export const AUTOPILOT_HARD_CAP = 1000;
/** Default segment count when the stored value is missing or not a number. */
export const AUTOPILOT_DEFAULT_MAX_SEG = 12;

/** Parse a stored integer; @returns the fallback when parseInt yields NaN. */
export function apNum(v: unknown, d: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
}

/** @returns n clamped to the closed interval [lo, hi]. */
export function apClamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** @returns the effective segment cap for a raw stored value. */
export function apMaxSegments(raw: unknown): number {
  return apClamp(apNum(raw, AUTOPILOT_DEFAULT_MAX_SEG), 1, AUTOPILOT_HARD_CAP);
}

/** A missing value means half-auto; an explicit empty string means full-auto. */
export function apAuto(raw: unknown): string {
  return raw == null ? "half" : String(raw);
}

/** @returns whether the loop pauses for a user decision after each segment. */
export function apIsHalf(raw: unknown): boolean {
  return apAuto(raw) === "half";
}

/** @returns the full-auto pacing delay in ms. */
export function apPacingMs(raw: unknown): number {
  return apNum(raw, 2200);
}

/** @returns whether the segment must wait for local TTS to finish. */
export function apGateTts(raw: unknown): boolean {
  return raw === "1";
}

/** Legacy "rp" is normalised on read; @returns the mode the loop acts on. */
export function apModeOf(raw: unknown): string {
  const mode = raw == null ? "" : String(raw);
  return mode === "rp" ? "novel" : mode;
}

/**
 * Start gate, in the original order: mode validity, then driver exclusivity. A running fishbowl
 * may be stopped only on an explicit request; every other driver is a hard refusal.
 * @returns the plan, including the mode value the wiring must persist for the legacy alias.
 */
export function apStartPlan(
  rawMode: unknown,
  other: string | null,
  autoStopOthers: boolean,
  alreadyRunning: boolean,
): { ok: boolean; reason: string; mode: string; persistMode: string; stopFishbowl: boolean } {
  const mode = apModeOf(rawMode);
  const persistMode = rawMode === "rp" ? "novel" : "";
  if (alreadyRunning) return { ok: false, reason: "already-running", mode, persistMode, stopFishbowl: false };
  if (!mode || mode === "off") return { ok: false, reason: "mode-off", mode, persistMode, stopFishbowl: false };
  if (mode === "work") return { ok: false, reason: "work-uses-agent-loop", mode, persistMode, stopFishbowl: false };
  if (other) {
    if (other === "fishbowl" && autoStopOthers) {
      return { ok: true, reason: "", mode, persistMode, stopFishbowl: true };
    }
    return { ok: false, reason: "busy:" + other, mode, persistMode, stopFishbowl: false };
  }
  return { ok: true, reason: "", mode, persistMode, stopFishbowl: false };
}

/** @returns the address-mode instruction appended to the director prompt. */
export function apAddressContract(raw: unknown): string {
  const addr = raw == null ? "dialogue" : String(raw);
  switch (addr) {
    case "immersive": return "用第二人称直接对“你”说话，可含动作 / 心理 / 场景旁白，旁白用 *…* 或（…）包裹（朗读自动跳过）";
    case "narration": return "用第三人称小说叙事推进剧情";
    default: return "用第二人称直接对“你”说话，不写旁白、不写动作描写、不做第三人称叙述";
  }
}

/** @returns the [options] rule, or an empty string when options are disabled. */
export function apChoicesRule(raw: unknown): string {
  const freq = raw == null ? "fork" : String(raw);
  if (freq === "off") return "";
  if (freq === "every") return "本段末尾追加 [选项] ①… ②…（2-4 条，每条一句走向）[/选项]";
  return "仅当出现 ≥2 个合理走向、需要我拍板方向时，本段末才追加 [选项]（2-4 条）[/选项]；连贯推进 / 高潮 / 动作中段不要给";
}

/**
 * @returns the director prompt. A user-authored continuation bypasses every appended rule;
 * the prompt text is user-facing Chinese and is intentionally kept verbatim.
 */
export function apDirectorPrompt(userText: string, address: unknown, choices: unknown): string {
  if (userText) return userText;
  const parts = ["继续推进剧情一拍，约 200-300 字，承接上文，不要收尾", apAddressContract(address)];
  const rule = apChoicesRule(choices);
  if (rule) parts.push(rule);
  parts.push("剧情自然走到尽头时输出 [end]");
  return "（" + parts.join("；") + "）";
}

/**
 * Exclusivity snapshot: fishbowl state wins over the agent loop, which wins over a streaming
 * bubble. The caller supplies the snapshot because reading globals is the wiring's job.
 */
export function apOtherDriver(fbState: string, kernelActive: boolean, streaming: boolean): string | null {
  if (fbState === "running" || fbState === "paused") return "fishbowl";
  if (kernelActive) return "agent-loop";
  if (streaming) return "sending";
  return null;
}

/** A streaming bubble is our own send in flight; yielding on it would stop the loop mid-turn. */
export function apShouldYield(busy: string | null): boolean {
  return !!busy && busy !== "sending";
}

/** @returns whether the generated segment closes the story. */
export function apEndTag(text: string): boolean {
  return /\[end\]/i.test(text);
}

/** @returns the final end reason; an abort only fills in a missing reason. */
export function apWrapReason(reason: string, aborted: boolean): string {
  return reason || (aborted ? "aborted" : "");
}
