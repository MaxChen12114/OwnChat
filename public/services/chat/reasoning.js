(function () {
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
                            
                                      
                                            
 

/** Environment ports, injected by the wiring layer. */
                                 
                     
 

/** Minimal shape of the fold block (.reasoning-block); both a real DOM element and the test stub satisfy it. */
                              
                                                                           
                             
                
 

/**
 * Read the thinking text from one SSE delta. Providers differ on the field: thinking-mode upstreams
 * use `reasoning_content`, effort-dialect ones (AMD and friends) use `reasoning`. The first non-empty
 * string wins; a whitespace-only or absent value degrades to empty so callers can just test truthiness.
 * The asymmetry is deliberate: `reasoning_content` must be non-empty to win, while `reasoning` is
 * returned whenever it is a string (matching both send paths before this was shared).
 */
function reasoningDelta(delta         )         {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return "";
  const d                          = {};
  for (const [k, v] of Object.entries(delta)) d[k] = v;
  const primary = d["reasoning_content"];
  if (typeof primary === "string" && primary) return primary;
  const alternate = d["reasoning"];
  return typeof alternate === "string" ? alternate : "";
}

/** 4.70 thinking display preference: show = expanded, collapse = folded, hide = hidden. */
                                                            

/** The dropdown's options; values and labels are one list so the UI cannot drift from the reader. */
const THINK_DISPLAY_MODES                                                                              = [
  { value: "collapse", label: "折叠(默认)" },
  { value: "show", label: "展开" },
  { value: "hide", label: "隐藏" },
];

function createReasoning(ports                ) {
  const LS_THINK_DISPLAY = "cfw_think_display_v1";
  function getThinkDisplay()                   {
    const v = ports.storage.getItem(LS_THINK_DISPLAY);
    return (v === "show" || v === "hide") ? v : "collapse";
  }
  /** Persist the preference; an unknown value is stored as `collapse` (same rule as the reader). */
  function setThinkDisplay(mode         )                   {
    const v = mode === "show" || mode === "hide" ? mode : "collapse";
    ports.storage.setItem(LS_THINK_DISPLAY, v);
    return v;
  }
  function applyThinkDisplay(reasoningEl                                )       {
    if (!reasoningEl) return;
    const rt = reasoningEl.querySelector(".reasoning-text");
    const hasContent = !!(rt && rt.textContent && rt.textContent.trim());
    const mode = getThinkDisplay();
    if (!hasContent || mode === "hide") { reasoningEl.style.display = "none"; return; }
    reasoningEl.style.display = "";
    reasoningEl.open = (mode === "show");
  }
  // Pull the plain text of <think>...</think> blocks out of the body, to capture it rather than drop it
  function extractThinkText(text        )         {
    if (!text) return "";
    const out           = [];
    const re = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
    let m                        ;
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
  function buildReasoningArchive(nativeReasoning         , inlineThink         , jailbreakThink         )         {
    const sections = [
      { label: "模型推理", text: String(nativeReasoning == null ? "" : nativeReasoning).trim() },
      { label: "内联思考", text: String(inlineThink == null ? "" : inlineThink).trim() },
      { label: "解限回显", text: String(jailbreakThink == null ? "" : jailbreakThink).trim() },
    ].filter(function (s) { return s.text; });
    if (!sections.length) return "";
    const norm = function (t        )         { return t.replace(/\s+/g, " ").trim(); };
    const kept                                    = [];
    for (const s of sections) {
      const ns = norm(s.text);
      const dup = kept.some(function (k) {
        const nk = norm(k.text);
        return nk === ns || nk.indexOf(ns) >= 0 || ns.indexOf(nk) >= 0;
      });
      if (!dup) kept.push(s);
    }
    const seen = new Set        ();
    const out           = [];
    for (const s of kept) {
      const uniq           = [];
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

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/chat/reasoning.ts; the display preference is read and
// written through the storage port.
(function () {
  if (window.__reasoning) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
  };
  var rs = createReasoning(ports);
  window.__reasoning = {
    getThinkDisplay: rs.getThinkDisplay,
    setThinkDisplay: rs.setThinkDisplay,
    THINK_DISPLAY_MODES: THINK_DISPLAY_MODES,
    applyThinkDisplay: rs.applyThinkDisplay,
    extractThinkText: rs.extractThinkText,
    buildReasoningArchive: rs.buildReasoningArchive,
    reasoningDelta: rs.reasoningDelta,
  };
})();

globalThis.reasoningDelta = reasoningDelta;
globalThis.THINK_DISPLAY_MODES = THINK_DISPLAY_MODES;
globalThis.createReasoning = createReasoning;
})();
