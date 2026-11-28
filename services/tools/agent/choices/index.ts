/**
 * `offer_choices` — the clickable branch chips above the composer.
 *
 * `autoSend` is not a detail: a chip that only fills the input leaves the user to press Enter, and
 * the point of offering a branch is that one click commits to it. The renderer is called with
 * `autoSend: true` for exactly that reason, and the note lives here so the next reader does not
 * "fix" it by turning it off.
 *
 * Input normalisation is part of the contract too: callers hand over plain strings, but a chip can
 * also arrive as `{label}`, and anything empty is dropped rather than rendered as a blank piece of
 * furniture. An empty list is a refusal, not an empty render.
 *
 * The tool never drives the conversation itself — it hands the choice to the user and returns.
 *
 * @module services/tools/agent/choices
 */

export interface ChoicesFacade {
  renderChoices(options: string[], opts: { includeMeta: boolean; autoSend: boolean }): void;
}

export interface ChoicesDeps {
  /** The choice-chip renderer, looked up per call. */
  choices(): ChoicesFacade | null;
}

export interface ChoicesInput {
  options?: unknown;
  include_meta?: unknown;
}

export interface ChoicesResult {
  ok: boolean;
  count?: number;
  options?: string[];
  error?: string;
}

export interface ChoicesApi {
  run(input: ChoicesInput): Promise<ChoicesResult>;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}
function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

export function createChoicesTools(deps: ChoicesDeps): ChoicesApi {
  async function run(input: ChoicesInput): Promise<ChoicesResult> {
    const args = recOf(input);
    const renderer = deps.choices();
    if (!renderer || typeof renderer.renderChoices !== "function") {
      return { ok: false, error: "选项模块未就绪 (choices.js / window.choicesSvc)" };
    }

    const raw = Array.isArray(args.options) ? args.options : [];
    const options = raw
      .map(function (o: unknown) {
        if (typeof o === "string") return o.trim();
        return text(recOf(o).label).trim();
      })
      .filter(Boolean);
    if (!options.length) return { ok: false, error: "options 至少要有一个非空选项" };

    try {
      // Matches choices.js's real signature: renderChoices(options, { includeMeta, autoSend }).
      // autoSend:true makes a click send the label as the user's next message, which is what starts
      // the following turn.
      renderer.renderChoices(options, {
        includeMeta: args.include_meta === false ? false : true,
        autoSend: true,
      });
      return { ok: true, count: options.length, options: options };
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "渲染选项失败: " + text(err.message || e) };
    }
  }

  return { run };
}
