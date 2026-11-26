/**
 * The ambience "director": hidden tags in a reply that drive the two-track mixer in `theme.js`.
 *
 * Two channels, one execution path. The model may write `[[amb:id|volume]]`, `[[mus:…]]`, `[[voice:…]]`
 * or `[[amb:off]]` in its reply text, and it may also call the `set_ambient` tool. Both end up in
 * `tag()`, so the tag form and the tool form can never diverge.
 *
 * The track list is never written down here — it is generated from `__ambient.tracks`, which is the
 * single registry. Renaming or adding a track is a one-file change in `theme.js`, and both the prompt
 * and the tag parser follow automatically.
 *
 * Two behaviours are deliberate and easy to "fix" wrongly:
 *   · `extract` returns the text **unchanged** when there is no tag — no whitespace normalisation, no
 *     touching of code-block indentation. Cleanup only runs when something was actually removed.
 *   · An unrecognised track is still **stripped** from the text, just not executed. Leaving it in
 *     would leak the tag into the bubble the user reads.
 *
 * Track resolution goes exact id → exact label → unique substring → first variant. Models routinely
 * write half a name ("雨打窗" for two variants); taking the first variant matches intent better than
 * refusing to act.
 *
 * Lock: `test/ambient-tools.test.mjs` (written with the migration).
 * @module services/agent/ambient-tools
 */

export type AmbientDeck = "amb" | "mus" | "voice";

export interface AmbientAction {
  deck: string;
  id: string | null;
  vol: number | null;
  raw: string;
}

export interface AmbientMixerLike {
  tracks: Record<string, Array<[string, string]>>;
  tag(deck: string, id: string | null, vol?: number): { amb?: { id?: string }; mus?: { id?: string } };
  get(): Record<string, { id?: string; vol?: number }>;
  trackLabel(deck: string, id: string): string;
}

export interface AmbientEnv {
  /** `window.__ambient`, or null when the theme mixer is not loaded. */
  mixer(): AmbientMixerLike | null;
}

export interface AmbientToolsApi {
  resolveId(deck: unknown, raw: unknown): string | null;
  extract(text: unknown): { clean: string; actions: AmbientAction[] };
  apply(text: unknown): { clean: string; actions: AmbientAction[] };
  directorPrompt(): string;
  defineTools(registry: unknown): unknown;
}

/** Tag aliases → mixer deck. `voice` is a breath pad and lives on the ambience track. */
const AMBIENT_DECK_ALIAS: Record<string, string> = { amb: "amb", music: "mus", mus: "mus", bgm: "mus", voice: "voice" };
const AMBIENT_OFF_RE = /^(off|stop|none|mute|关闭|关掉|停止|停|静音|无)$/i;
const AMBIENT_TAG_RE = /\[\[\s*(amb|mus|music|bgm|voice)\s*[:：]\s*([^\]|]*?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/gi;

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function tracksOf(mixer: AmbientMixerLike | null, deck: string): Array<[string, string]> {
  if (!mixer) return [];
  const list = mixer.tracks ? mixer.tracks[deck === "voice" ? "amb" : deck] : undefined;
  return Array.isArray(list) ? list : [];
}

interface AmbientRegistryLike {
  define(def: Record<string, unknown>): unknown;
}

function isRegistry(value: unknown): value is AmbientRegistryLike {
  return typeof recOf(value).define === "function";
}

export function createAmbientTools(env: AmbientEnv): AmbientToolsApi {
  /**
   * Resolves a tag/tool track reference.
   * @returns the canonical id, or null when the mixer is absent or nothing matches.
   */
  function resolveId(deck: unknown, raw: unknown): string | null {
    const m = env.mixer();
    if (!m || !raw) return null;
    const key = text(raw).trim();
    if (!key) return null;
    const keyLow = key.toLowerCase();
    const list = tracksOf(m, text(deck));
    let hit = list.find((t) => t[0] === keyLow);
    if (hit) return hit[0];
    hit = list.find((t) => t[1] === key);
    if (hit) return hit[0];
    const subs = list.filter((t) => t[0].indexOf(keyLow) >= 0 || t[1].indexOf(key) >= 0);
    return subs.length ? subs[0][0] : null;
  }

  /** `0–1` is a ratio, above that is a percentage — models write both. */
  function parseVolume(raw: unknown): number | null {
    if (raw == null || raw === "") return null;
    const n = parseFloat(text(raw).replace("%", "").trim());
    if (!isFinite(n)) return null;
    if (n <= 1) return Math.max(0, Math.min(1, n));
    return Math.max(0, Math.min(1, n / 100));
  }

  /**
   * Pulls the tags out of a reply.
   * @returns the text with the tags removed plus the actions they encoded. When nothing matched the
   * input is returned verbatim — normalising whitespace here would reflow code blocks.
   */
  function extract(value: unknown): { clean: string; actions: AmbientAction[] } {
    const s = text(value);
    const actions: AmbientAction[] = [];
    let clean = s.replace(AMBIENT_TAG_RE, function (whole: string, deckRaw: string, idRaw: string, volRaw: string) {
      const deck = AMBIENT_DECK_ALIAS[text(deckRaw).toLowerCase()] || "amb";
      const id = text(idRaw).trim();
      if (!id) return ""; // `[[amb:]]` — an empty shell, just strip it.
      if (AMBIENT_OFF_RE.test(id)) {
        actions.push({ deck: deck, id: null, vol: null, raw: whole });
        return "";
      }
      const rid = resolveId(deck, id);
      if (!rid) {
        try {
          console.warn("[ambient] 标签里的轨道无法识别，已忽略:", deck, id);
        } catch (e) {
          // A host without console still gets the tag stripped.
        }
        return "";
      }
      actions.push({ deck: deck, id: rid, vol: parseVolume(volRaw), raw: whole });
      return "";
    });
    if (!actions.length) return { clean: s, actions: actions };
    // Only once something was actually removed: clear the blank lines a standalone tag left behind,
    // without touching the normal line breaks of the body.
    clean = clean
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { clean: clean, actions: actions };
  }

  /** Extracts, then hands each action to the mixer. @returns the cleaned text and what was applied. */
  function apply(value: unknown): { clean: string; actions: AmbientAction[] } {
    const res = extract(value);
    const m = env.mixer();
    const done: AmbientAction[] = [];
    if (m) {
      for (let i = 0; i < res.actions.length; i++) {
        const a = res.actions[i];
        try {
          m.tag(a.deck, a.id, a.vol == null ? undefined : a.vol);
          done.push(a);
        } catch (e) {
          // One bad track must not stop the rest.
        }
      }
    }
    return { clean: res.clean, actions: done };
  }

  /** The per-turn director block: live track lists and the current state, both read fresh. */
  function directorPrompt(): string {
    const m = env.mixer();
    if (!m) return "";
    const fmt = (list: Array<[string, string]>) => list.map((t) => t[1] + "=" + t[0]).join(" · ");
    const st = m.get();
    const cur = (deck: string) => {
      const d = recOf(st[deck]);
      return d.id ? m.trackLabel(deck, text(d.id)) + "(" + Math.round(Number(d.vol) * 100) + ")" : "无";
    };
    return [
      "【氛围音·导演】你可以用隐藏标签指挥环境声与背景音乐(标签不会显示给用户,客户端解析执行):",
      "  [[amb:轨道id|音量]] 环境声   [[mus:轨道id|音量]] 背景音乐   [[voice:轨道id|音量]] 气息垫(并入环境声轨)",
      "  音量 0-100,可省略(沿用该轨上次音量);[[amb:off]] / [[mus:off]] 关闭对应轨;两条轨可同时播放。",
      "  环境声: " + fmt(tracksOf(m, "amb")),
      "  音乐: " + fmt(tracksOf(m, "mus")),
      "  当前: 环境=" + cur("amb") + " · 音乐=" + cur("mus"),
      "用法:只在场景/情绪真的需要时调用(雨夜、咖啡馆、告白、亲昵、清晨、酒馆…),同一氛围别反复重发;",
      "用户说「放点音乐 / 安静点 / 换个氛围」时按字面执行;id 用上面清单里的原文。",
    ].join("\n");
  }

  function defineTools(registry: unknown): unknown {
    if (!isRegistry(registry)) return registry;
    registry.define({
      name: "set_ambient",
      description:
        "指挥氛围音:环境声(amb)/背景音乐(mus)两条独立音轨可同时播放,voice 是气息垫(轻息,并入环境轨)。" +
        'id 用系统提示「氛围音·导演」清单里的轨道 id;id 传 "off" 关闭该轨;volume 0-100 可选。' +
        "聊天正文里写 [[amb:id|音量]] 标签是等价写法。",
      parameters: {
        type: "object",
        properties: {
          deck: { type: "string", enum: ["amb", "mus", "voice"], description: "amb=环境声,mus=背景音乐,voice=气息垫" },
          id: { type: "string", description: '轨道 id(见氛围音·导演清单),或 "off" 关闭该轨' },
          volume: { type: "number", description: "音量 0-100,省略则沿用上次" },
        },
        required: ["deck", "id"],
        additionalProperties: false,
      },
      async run(args: unknown) {
        const m = env.mixer();
        if (!m) return { ok: false, error: "氛围音模块未就绪 (theme.js / window.__ambient)" };
        const a = recOf(args);
        const deck = AMBIENT_DECK_ALIAS[text(a.deck).toLowerCase()] || null;
        if (!deck) return { ok: false, error: "deck 只能是 amb / mus / voice" };
        const rawId = text(a.id).trim();
        const vol = parseVolume(a.volume);
        if (!rawId) return { ok: false, error: 'id 不能为空(传 "off" 关闭该轨)' };
        if (AMBIENT_OFF_RE.test(rawId)) {
          m.tag(deck, null, vol == null ? undefined : vol);
          return { ok: true, stopped: deck === "voice" ? "amb" : deck };
        }
        const rid = resolveId(deck, rawId);
        if (!rid) {
          const list = tracksOf(m, deck);
          return { ok: false, error: "未知轨道 id: " + rawId, available: list.map((t) => t[0]).join(", ") };
        }
        const st = m.tag(deck, rid, vol == null ? undefined : vol);
        return {
          ok: true,
          now: { amb: st.amb && st.amb.id, mus: st.mus && st.mus.id },
          applied: { deck: deck, id: rid, volume: vol == null ? "沿用" : Math.round(vol * 100) },
        };
      },
    });
    return registry;
  }

  return {
    resolveId: resolveId,
    extract: extract,
    apply: apply,
    directorPrompt: directorPrompt,
    defineTools: defineTools,
  };
}
