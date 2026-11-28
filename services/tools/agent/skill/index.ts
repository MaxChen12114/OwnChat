/**
 * `load_skill` — level 2 of the three-tier skill disclosure.
 *
 * The system prompt lists only names and one-line summaries. This tool pulls a skill's full body, and
 * the contract has to be strict about *why* it refuses: "not found" and "exists but not enabled" are
 * different answers, and the second one must tell the model not to act on the skill at all rather
 * than letting it guess from the summary. That is why both failures carry the list of available
 * names — the model's next move should be to pick one of them, not to retry with a variation.
 *
 * Read-only: this never flips an enabled flag. Enabling belongs to the settings surface.
 *
 * @module services/tools/agent/skill
 */

export interface SkillFacade {
  getByName(name: string): unknown;
  getAll?(): unknown;
  isGlobalEnabled?(): boolean;
}

export interface SkillDeps {
  /** The skill store, looked up per call — it is a classic script loaded before this bundle. */
  skills(): SkillFacade | null;
}

export interface SkillInput {
  name?: unknown;
}

export interface SkillResult {
  ok: boolean;
  name?: string;
  description?: string;
  content?: string;
  available?: string[];
  error?: string;
}

export interface SkillApi {
  run(input: SkillInput): Promise<SkillResult>;
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

export function createSkillTools(deps: SkillDeps): SkillApi {
  async function run(input: SkillInput): Promise<SkillResult> {
    const args = recOf(input);
    const store = deps.skills();
    if (!store || typeof store.getByName !== "function") {
      return { ok: false, error: "技能系统未就绪 (skills.js / window.skillsSvc)" };
    }

    try {
      const want = text(args.name).trim();
      if (!want) return { ok: false, error: "name 必填：填【可用技能目录】里列出的技能名" };

      const rawAll = typeof store.getAll === "function" ? store.getAll() : [];
      const all: unknown[] = Array.isArray(rawAll) ? rawAll : [];
      const nameOf = (x: unknown): string => text(recOf(x).name).trim();
      const available = all.filter((x) => recOf(x).enabled).map(nameOf);

      const hit = store.getByName(want);
      if (!hit) return { ok: false, error: '技能 "' + want + '" 不存在', available: available };

      const card = recOf(hit);
      const on = typeof store.isGlobalEnabled === "function" ? !!store.isGlobalEnabled() : true;
      if (!on || !card.enabled) {
        return {
          ok: false,
          error: '技能 "' + nameOf(hit) + '" 未列入目录（不可加载）—— 不要按它行事；要让用户去 设置·技能 勾选',
          available: available,
        };
      }
      return {
        ok: true,
        name: nameOf(hit),
        description: text(card.description),
        content: text(card.content),
      };
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "技能加载失败: " + text(err.message || e) };
    }
  }

  return { run };
}
