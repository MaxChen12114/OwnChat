/**
 * `adjust_affinity` — the only tool that writes persistent relationship state.
 *
 * The return shape carries both `delta` (what was asked for) and `value` (what the store reports
 * after clamping). They are not the same number: the affinity store clamps to its own range, and a
 * caller that echoes only `delta` reads back a change that did not happen. `value` is optional
 * because the store is allowed not to report one, and a missing number must not become 0.
 *
 * @module services/tools/agent/character
 */

export interface CharacterFacade {
  adjustActiveAffection(delta: unknown): unknown;
}

export interface CharacterDeps {
  /** The character store, looked up per call. */
  character(): CharacterFacade | null;
}

export interface AffinityInput {
  delta?: unknown;
  reason?: unknown;
}

export interface AffinityResult {
  ok: boolean;
  delta?: unknown;
  value?: number;
  error?: string;
}

export interface CharacterApi {
  adjustAffinity(input: AffinityInput): Promise<AffinityResult>;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

export function createCharacterTools(deps: CharacterDeps): CharacterApi {
  async function adjustAffinity(input: AffinityInput): Promise<AffinityResult> {
    const args = recOf(input);
    const store = deps.character();
    if (!store || typeof store.adjustActiveAffection !== "function") {
      return { ok: false, error: "好感模块未就绪 (character.js / window.characterSvc)" };
    }
    const value = await store.adjustActiveAffection(args.delta);
    return { ok: true, delta: args.delta, value: typeof value === "number" ? value : undefined };
  }

  return { adjustAffinity };
}
