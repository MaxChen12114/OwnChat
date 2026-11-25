/**
 * Thinking output: display preference, extraction, folding and the three-source archive.
 *
 * The display preference is read through {@link ReasoningPorts} (it used to read localStorage
 * directly). applyThinkDisplay takes a structural minimal interface for the fold block
 * (querySelector / style / open) instead of importing a DOM global, so a real element in the
 * browser and a stub in Node both fit.
 *
 * Red line carried over from the old comment: never touch the unlock prompt. The model still emits
 * `<think>` blocks and the [^420]/[^69] sentinels, but instead of guessing what to delete we capture
 * the inline thinking into the .reasoning-block fold. Fail-open: even when the split misjudges, the
 * body text survives inside the fold and can be expanded back, rather than being heuristically
 * deleted into nothing.
 * @module services/chat/reasoning
 */

/** Key-value storage port: window.localStorage in the browser, a Map in the Node tests. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Environment ports, injected by the wiring layer. */
export interface ReasoningPorts {
  storage: KvStorage;
}

/** Minimal shape of the fold block (.reasoning-block); both a real DOM element and the test stub satisfy it. */
export interface ReasoningEl {
  querySelector(selectors: string): { textContent?: string | null } | null;
  style: { display: string };
  open: boolean;
}

/**
 * Read the thinking text from one SSE delta. Providers differ on the field: thinking-mode upstreams
 * use `reasoning_content`, effort-dialect ones (AMD and friends) use `reasoning`. The first non-empty
 * string wins; a whitespace-only or absent value degrades to empty so callers can just test truthiness.
 * The asymmetry is deliberate: `reasoning_content` must be non-empty to win, while `reasoning` is
 * returned whenever it is a string (matching both send paths before this was shared).
 */
export function reasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return "";
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(delta)) d[k] = v;
  const primary = d["reasoning_content"];
  if (typeof primary === "string" && primary) return primary;
  const alternate = d["reasoning"];
  return typeof alternate === "string" ? alternate : "";
}

/** 4.70 thinking display preference: show = expanded, collapse = folded, hide = hidden. */
export type ThinkDisplayMode = "show" | "collapse" | "hide";

/** The dropdown's options; values and labels are one list so the UI cannot drift from the reader. */
export const THINK_DISPLAY_MODES: ReadonlyArray<{ readonly value: ThinkDisplayMode; readonly label: string }> = [
  { value: "collapse", label: "折叠(默认)" },
  { value: "show", label: "展开" },
  { value: "hide", label: "隐藏" },
];

export function createReasoning(ports: ReasoningPorts) {
  const LS_THINK_DISPLAY = "cfw_think_display_v1";
  function getThinkDisplay(): ThinkDisplayMode {
    const v = ports.storage.getItem(LS_THINK_DISPLAY);
    return (v === "show" || v === "hide") ? v : "collapse";
  }
  /** Persist the preference; an unknown value is stored as `collapse` (same rule as the reader). */
  function setThinkDisplay(mode: unknown): ThinkDisplayMode {
    const v = mode === "show" || mode === "hide" ? mode : "collapse";
    ports.storage.setItem(LS_THINK_DISPLAY, v);
    return v;
  }
  function applyThinkDisplay(reasoningEl: ReasoningEl | null | undefined): void {
    if (!reasoningEl) return;
    const rt = reasoningEl.querySelector(".reasoning-text");
    const hasContent = !!(rt && rt.textContent && rt.textContent.trim());
    const mode = getThinkDisplay();
    if (!hasContent || mode === "hide") { reasoningEl.style.display = "none"; return; }
    reasoningEl.style.display = "";
    reasoningEl.open = (mode === "show");
  }
  // Pull the plain text of <think>...</think> blocks out of the body, to capture it rather than drop it
  function extractThinkText(text: string): string {
    if (!text) return "";
    const out: string[] = [];
    const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    const open = text.match(/<think(?:ing)?>([\s\S]*)$/i);
    if (open && !/<\/think(?:ing)?>/i.test(open[0])) out.push(open[1]);
    return out.join("\n").trim();
  }

  // 4.71 archive merge: with thinking mode and unlock both on, the fold collects three sources —
  //   1 native reasoning_content from thinking mode, 2 inline <think> in the body, 3 the unlock
  //   sentinel ([^420]/[^69]) echo. The old version glued them with "——" without dedup or labels, so
  //   the fold came out noisy and repetitive. Here each source gets a section heading, plus section-level
  //   and line-level dedup. A single source gets no heading, so ordinary thinking is not wrapped in a shell.
  function buildReasoningArchive(nativeReasoning: unknown, inlineThink: unknown, jailbreakThink: unknown): string {
    const sections = [
      { label: "模型推理", text: String(nativeReasoning == null ? "" : nativeReasoning).trim() },
      { label: "内联思考", text: String(inlineThink == null ? "" : inlineThink).trim() },
      { label: "解限回显", text: String(jailbreakThink == null ? "" : jailbreakThink).trim() },
    ].filter(function (s) { return s.text; });
    if (!sections.length) return "";
    const norm = function (t: string): string { return t.replace(/\s+/g, " ").trim(); };
    const kept: { label: string; text: string }[] = [];
    for (const s of sections) {
      const ns = norm(s.text);
      const dup = kept.some(function (k) {
        const nk = norm(k.text);
        return nk === ns || nk.indexOf(ns) >= 0 || ns.indexOf(nk) >= 0;
      });
      if (!dup) kept.push(s);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of kept) {
      const uniq: string[] = [];
      for (const ln of s.text.split("\n")) {
        const key = ln.trim();
        if (!key) { uniq.push(ln); continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(ln);
      }
      const body = uniq.join("\n").trim();
      if (body) out.push((kept.length > 1 ? "【" + s.label + "】\n" : "") + body);
    }
    return out.join("\n\n──────\n\n");
  }

  return {
    getThinkDisplay,
    setThinkDisplay,
    applyThinkDisplay,
    extractThinkText,
    buildReasoningArchive,
    reasoningDelta,
  };
}
