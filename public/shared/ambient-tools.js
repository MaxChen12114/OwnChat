// public/shared/ambient-tools.js — 氛围音「导演」接入层（2026-10-06）
//
// 把 theme.js 的双轨混音器（window.__ambient）接给模型，两条通道：
//   1) 标签协议：正文里写 [[amb:轨道id|音量]] / [[mus:轨道id|音量]] / [[voice:轨道id|音量]] /
//      [[amb:off]]，客户端解析执行后从显示文本剥离（与 [好感±N] / [[发图:…]] 同一套处理位）。
//      普通聊天（sendOne）与 Agent 模式两条回复收尾路径都会调用 apply()。
//   2) Agent 工具：set_ambient(deck, id, volume) —— 与标签共用 tag() 执行路径。
//      本模块用裸 registry.define 注册（不走 tools.js 的分档包装），所以「Agent 工具集」
//      core/full 两档都拿得到；工具很小、只读改音量状态、不发网络请求，常驻没有负担。
//
// 音轨清单不写死在本文件：直接从 __ambient.tracks 生成（唯一来源 = theme.js 的注册表），
// 新增/改名音轨只改 theme.js 一处，提示词与标签解析自动跟上。
(function (global) {
  "use strict";

  // 标签里的 deck 别名 → 混音器 deck。voice（气息垫）在混音器里落环境轨。
  const DECK_ALIAS = { amb: "amb", music: "mus", mus: "mus", bgm: "mus", voice: "voice" };
  const OFF_RE = /^(off|stop|none|mute|关闭|关掉|停止|停|静音|无)$/i;
  const TAG_RE = /\[\[\s*(amb|mus|music|bgm|voice)\s*[:：]\s*([^\]|]*?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/gi;

  function mixer() {
    return global.__ambient || null;
  }

  /** 轨道解析：精确 id → 精确中文名 → 唯一子串 → 多义取第一支（模型常写「雨打窗」这种半截名，
   *  对应 I/II 两个变体；取 I 支比整条不执行更符合意图） */
  function resolveId(deck, raw) {
    const m = mixer();
    if (!m || !raw) return null;
    const key = String(raw).trim();
    if (!key) return null;
    const keyLow = key.toLowerCase();
    const list = m.tracks[deck === "voice" ? "amb" : deck] || [];
    let hit = list.find((t) => t[0] === keyLow);
    if (hit) return hit[0];
    hit = list.find((t) => t[1] === key);
    if (hit) return hit[0];
    const subs = list.filter((t) => t[0].indexOf(keyLow) >= 0 || t[1].indexOf(key) >= 0);
    return subs.length ? subs[0][0] : null;
  }

  /** 音量：0-1 视为比例；1 以上视为百分数（模型两种写法都有） */
  function parseVolume(raw) {
    if (raw == null || raw === "") return null;
    const n = parseFloat(String(raw).replace("%", "").trim());
    if (!isFinite(n)) return null;
    if (n <= 1) return Math.max(0, Math.min(1, n));
    return Math.max(0, Math.min(1, n / 100));
  }

  /** 从文本抽出标签：返回 { clean, actions }；未知轨道会被剥离但不执行（防止标签泄漏进气泡）。
   *  没有标签时**原样返回**（零副作用：不归一空白、不碰代码块缩进）。 */
  function extract(text) {
    const s = String(text == null ? "" : text);
    const actions = [];
    let clean = s.replace(TAG_RE, function (whole, deckRaw, idRaw, volRaw) {
      const deck = DECK_ALIAS[String(deckRaw).toLowerCase()] || "amb";
      const id = String(idRaw || "").trim();
      if (!id) return ""; // [[amb:]] 空壳：只清掉
      if (OFF_RE.test(id)) {
        actions.push({ deck: deck, id: null, vol: null, raw: whole });
        return "";
      }
      const rid = resolveId(deck, id);
      if (!rid) {
        try { console.warn("[ambient] 标签里的轨道无法识别，已忽略:", deck, id); } catch (e) {}
        return "";
      }
      actions.push({ deck: deck, id: rid, vol: parseVolume(volRaw), raw: whole });
      return "";
    });
    if (!actions.length) return { clean: s, actions: actions };
    // 有标签被摘掉，才做轻量收尾：清掉标签独占行留下的空行 / 行尾空格，不动正文正常换行
    clean = clean
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return { clean: clean, actions: actions };
  }

  /** 执行标签：抽出 → 交给 __ambient.tag() → 返回剥离后的干净正文 */
  function apply(text) {
    const res = extract(text);
    const m = mixer();
    const done = [];
    if (m) {
      for (let i = 0; i < res.actions.length; i++) {
        const a = res.actions[i];
        try {
          m.tag(a.deck, a.id, a.vol == null ? undefined : a.vol);
          done.push(a);
        } catch (e) {}
      }
    }
    return { clean: res.clean, actions: done };
  }

  /** 系统提示里的导演说明（音轨清单与当前状态每轮实时生成） */
  function directorPrompt() {
    const m = mixer();
    if (!m) return "";
    const fmt = (list) => list.map((t) => t[1] + "=" + t[0]).join(" · ");
    const st = m.get();
    const cur = (deck) => {
      const d = st[deck];
      return (d && d.id) ? (m.trackLabel(deck, d.id) + "(" + Math.round(d.vol * 100) + ")") : "无";
    };
    return [
      "【氛围音·导演】你可以用隐藏标签指挥环境声与背景音乐(标签不会显示给用户,客户端解析执行):",
      "  [[amb:轨道id|音量]] 环境声   [[mus:轨道id|音量]] 背景音乐   [[voice:轨道id|音量]] 气息垫(并入环境声轨)",
      "  音量 0-100,可省略(沿用该轨上次音量);[[amb:off]] / [[mus:off]] 关闭对应轨;两条轨可同时播放。",
      "  环境声: " + fmt(m.tracks.amb),
      "  音乐: " + fmt(m.tracks.mus),
      "  当前: 环境=" + cur("amb") + " · 音乐=" + cur("mus"),
      "用法:只在场景/情绪真的需要时调用(雨夜、咖啡馆、告白、亲昵、清晨、酒馆…),同一氛围别反复重发;",
      "用户说「放点音乐 / 安静点 / 换个氛围」时按字面执行;id 用上面清单里的原文。",
    ].join("\n");
  }

  function defineTools(registry) {
    if (!registry || typeof registry.define !== "function") return registry;
    registry.define({
      name: "set_ambient",
      description:
        "指挥氛围音:环境声(amb)/背景音乐(mus)两条独立音轨可同时播放,voice 是气息垫(轻息,并入环境轨)。" +
        "id 用系统提示「氛围音·导演」清单里的轨道 id;id 传 \"off\" 关闭该轨;volume 0-100 可选。" +
        "聊天正文里写 [[amb:id|音量]] 标签是等价写法。",
      parameters: {
        type: "object",
        properties: {
          deck: { type: "string", enum: ["amb", "mus", "voice"], description: "amb=环境声,mus=背景音乐,voice=气息垫" },
          id: { type: "string", description: "轨道 id(见氛围音·导演清单),或 \"off\" 关闭该轨" },
          volume: { type: "number", description: "音量 0-100,省略则沿用上次" },
        },
        required: ["deck", "id"],
        additionalProperties: false,
      },
      async run(args) {
        const m = mixer();
        if (!m) return { ok: false, error: "氛围音模块未就绪 (theme.js / window.__ambient)" };
        const deck = DECK_ALIAS[String((args && args.deck) || "").toLowerCase()] || null;
        if (!deck) return { ok: false, error: "deck 只能是 amb / mus / voice" };
        const rawId = String((args && args.id) || "").trim();
        const vol = parseVolume(args && args.volume);
        if (!rawId) return { ok: false, error: "id 不能为空(传 \"off\" 关闭该轨)" };
        if (OFF_RE.test(rawId)) {
          m.tag(deck, null, vol == null ? undefined : vol);
          return { ok: true, stopped: deck === "voice" ? "amb" : deck };
        }
        const rid = resolveId(deck, rawId);
        if (!rid) {
          const list = m.tracks[deck === "voice" ? "amb" : deck] || [];
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

  global.__ambientTags = { extract: extract, apply: apply, directorPrompt: directorPrompt, resolveId: resolveId };
  global.AmbientTools = { defineTools: defineTools, directorPrompt: directorPrompt, extract: extract, apply: apply };
})(window);
