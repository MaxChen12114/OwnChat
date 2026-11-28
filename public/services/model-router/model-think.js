(function () {
/**
 * Thinking-level table: which levels the picker offers for a given model.
 *
 * Kept as its own module because model capabilities move with upstream releases (new levels, a model
 * going from switchable to always-on). This is data plus a matcher; editing it must never require
 * touching request assembly in app.js.
 *
 * The table decides only *which levels the UI shows*. How a level is put on the wire
 * (`thinking:{type}` / `chat_template_kwargs` / `reasoning_effort` / `output_config.effort`) is the
 * channel dialect's business (vllm / effort / default), and stays there.
 *
 * Data source: ZCode `resources/config/provider/zcode-builtin.json` →
 * `modelConfigRules.modelRules[].config.optionSpecs.reasoningLevel.values`.
 *
 * Levels vocabulary: `disabled`/`none` mean "can be off"; `enabled` means "on, no strength"; the
 * rest are strengths. A model with no off switch simply has no `disabled`/`none` entry.
 * @module services/model-router/model-think
 */

                             
            
                
 

                            
             
                   
 

/** Matching is on the model id with any `vendor/` prefix stripped. */

const LEVELS               = [
  { v: "minimal", label: "极低" },
  { v: "low", label: "低" },
  { v: "medium", label: "中" },
  { v: "high", label: "高" },
  { v: "xhigh", label: "更高" },
  { v: "max", label: "最高" },
];

// Order matters: specific patterns first, broad families last. First match wins.
const RULES              = [
  // Models that cannot think at all: embeddings, moderation, code completion, instruction bases.
  { re: /(embed|guard|safety|detector|retriever|chatqa)/i, levels: [] },
  { re: /(^|[-_/])(coder|coding)([-_/.]|$)/i, levels: [] },
  { re: /(^|[-_/])instruct([-_/.]|$)/i, levels: [] },
  { re: /^deepseek-chat/i, levels: [] },

  // DeepSeek
  { re: /^deepseek-reasoner/i, levels: ["disabled", "low", "high", "max"] },
  { re: /^deepseek-(v4([.-]\d+)?-)?(flash|pro)/i, levels: ["disabled", "low", "high", "max"] },

  // GLM
  { re: /^glm-5\.3/i, levels: ["low", "high", "max"] },
  { re: /^glm-5\.2/i, levels: ["high", "max"] },
  { re: /^glm-(5|4\.[5-7])/i, levels: ["disabled", "enabled"] },

  // Qwen
  { re: /^qwen3\.8-omni-flash/i, levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { re: /^qwen3\.8-(max|flash)/i, levels: ["low", "medium", "xhigh"] },
  { re: /^qwen3\.(5|6|7)/i, levels: ["disabled", "enabled"] },
  { re: /^qwen(3-vl)?-(plus|flash)/i, levels: ["disabled", "enabled"] },

  // Kimi
  { re: /^(kimi-)?k3/i, levels: ["low", "high", "max"] },
  { re: /^kimi-k2\.7-code/i, levels: ["enabled"] },
  { re: /^kimi-k2\.[56]/i, levels: ["disabled", "enabled"] },

  // MiniMax / MiMo
  { re: /^minimax-m3/i, levels: ["disabled", "enabled"] },
  { re: /^minimax-m2\.[57]/i, levels: ["enabled"] },
  { re: /^mimo-v2\.[56]/i, levels: ["disabled", "enabled"] },

  // OpenAI / GPT
  { re: /^gpt-5\.6/i, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  { re: /^gpt-5\.3-codex/i, levels: ["low", "medium", "high", "xhigh"] },
  { re: /^gpt-6-astra/i, levels: ["low", "medium", "high", "xhigh", "max"] },
  { re: /^gpt-5\.4-pro/i, levels: ["medium", "high", "xhigh"] },
  { re: /^gpt-5\.4/i, levels: ["none", "low", "medium", "high", "xhigh"] },

  // Anthropic and the rest
  { re: /^claude-.*-5/i, levels: ["low", "medium", "high", "xhigh", "max"] },
  { re: /^grok-4\.6/i, levels: ["low", "medium", "high", "xhigh"] },
  { re: /^hy3/i, levels: ["none", "low", "high"] },
  { re: /^hy4-preview/i, levels: ["none", "high"] },
];

const LABEL                         = {};
for (let i = 0; i < LEVELS.length; i++) LABEL[LEVELS[i].v] = LEVELS[i].label;
LABEL["enabled"] = "开启";

function label(v        )         {
  return LABEL[v] || "中";
}

// Levels for the third dialect, `effort`, which only sends `reasoning_effort`. Such endpoints have
// no "do not think" value: off means "send nothing" and let the model decide, so a `disabled` entry
// is always offered and reads as "no parameter", not as "certainly off".
//
// Precedence: what the channel declares > the model rule > the generic default. The declaration has
// to be able to narrow the list — AMD accepts only xhigh/medium/low and rejects `high`, and offering
// a level upstream refuses costs the user a whole round trip (the retry silently drops thinking).
const EFFORT_VALUES = ["low", "medium", "high"]; // generic default when the endpoint declares nothing
const EFFORT_ALL = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortLevels(model         , allowed           )           {
  const id = String(model || "").split("/").pop().toLowerCase();
  let rule                   = null;
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(id)) { rule = RULES[i]; break; }
  }
  if (rule && !rule.levels.length) return []; // listed as "cannot think" (embed/coder/instruct…)
  const declared = Array.isArray(allowed)
    ? allowed.filter(function (v) { return EFFORT_ALL.indexOf(v) >= 0; })
    : [];
  if (declared.length) return ["disabled"].concat(declared);
  if (rule) {
    const picked = rule.levels.filter(function (v) { return EFFORT_VALUES.indexOf(v) >= 0; });
    return ["disabled"].concat(picked.length ? picked : EFFORT_VALUES);
  }
  return ["disabled"].concat(EFFORT_VALUES);
}

/**
 * Levels the current model supports; an unmatched model falls back per dialect. Returns values
 * only — the `offAllowed` / `mustOn` UI meaning is derived by the caller.
 */
function levelsFor(model         , style         , allowed           )           {
  if (style === "effort") return effortLevels(model, allowed);
  const id = String(model || "").split("/").pop().toLowerCase();
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(id)) return RULES[i].levels.slice();
  }
  return style === "vllm"
    ? ["disabled", "enabled"]
    : ["disabled", "low", "medium", "high", "max"];
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// Written against `globalThis`, verbatim as the old file was: the think-control vm test runs with
// the window object as the global context, where `window` need not exist. In a browser
// `globalThis === window`, so behaviour is identical.
(function (g) {
  if (g.__modelThink) return;
  g.__modelThink = {
    version: 1,
    levels: LEVELS,
    values: LEVELS.map(function (l) { return l.v; }),
    rules: RULES,
    label: label,
    levelsFor: levelsFor,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.LEVELS = LEVELS;
globalThis.RULES = RULES;
globalThis.label = label;
globalThis.levelsFor = levelsFor;
})();
