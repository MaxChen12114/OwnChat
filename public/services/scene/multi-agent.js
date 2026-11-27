(function () {
/**
 * Multi-character scene: the mode flag, the card ids currently on stage, and the name-matching rules
 * a model uses to call one more character onto that stage.
 *
 * Only ids are persisted. Cards are resolved from the character domain on every read — the character
 * panel is the single writer of card data, so a cached copy here would go stale the moment a card is
 * edited, with no invalidation path that does not turn into a second source of truth.
 *
 * Two rules carry the behaviour users actually notice:
 *
 *   1. Every mutation dispatches `multi-agent:changed` and then `character:changed`. The second event
 *      is compatibility, not design: the character panel still re-renders on it, and dropping it
 *      leaves a stale roster on screen.
 *   2. Summoning switches multi mode on by itself. A model that names a character expects that
 *      character to be on stage from the next turn; requiring a second instruction is the bug users
 *      report as "the AI keeps talking to itself".
 *
 * Name matching is deliberately three-tiered (exact, normalised, bidirectional substring) because
 * models re-type names with punctuation and honorifics. The substring tier requires two characters on
 * both sides, so a one-character name cannot match everything on the shelf.
 *
 * @module services/scene/multi-agent
 */

/** A role card from this module's point of view: only `id` / `name` / `icon` are ever read. */
                            
                         
               
                 
                 
 

/** The persisted key/value surface (localStorage in the browser, a plain map in tests). */
                               
                                   
                                          
 

/**
 * The character domain, as this module uses it. All three members are optional in practice — the
 * facade may not be mounted yet when the scene is read during boot — so the wiring is what degrades
 * them to empty values and no-ops. `setActiveId` receives `""` to clear the active card.
 */
                                  
                                     
                                   
                                
 

/** Change notification. The wiring owns the event names and the second (compatibility) dispatch. */
                              
                                     
 

/** Payload carried by the change event. */
                              
                   
                     
 

                             
                        
                              
                      
 

/** The members the frozen page contract exposes. */
                        
                     
                              
                          
                                      
                                 
                               
                                    
                               
                                 
                                                   
                                               
 

const KEY_MODE = "tavern_multi_agent_mode_v1";
const KEY_SCENE = "tavern_active_scene_v1";
const KEY_ACTIVE_CHAR = "tavern_active_char_id";

/** Characters whose names or ids are not strings are corrupt records; they are skipped, not coerced. */
function textOf(value         )         {
  return typeof value === "string" ? value : "";
}

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalise a name for comparison: strip the punctuation and bracketing models like to add, fold case.
 * Chinese brackets are included on purpose — `【小红】` and `小红` are the same character to a reader.
 */
function normalizeName(value         )         {
  return String(value === null || value === undefined ? "" : value)
    .replace(/[\s【】\[\]()（）「」·,，.。!！?？~]/g, "")
    .toLowerCase();
}

/**
 * Create the scene over the given ports.
 *
 * @param ports Storage, character lookups and a change sink. Nothing is read or written until a
 *   member is called, so the factory is safe during boot while the character facade is still absent.
 * @returns The ten documented members. Card objects are the *same references* the character domain
 *   returned — callers mutate them (icon, affection) and expect their edits to stick.
 */
function createScene(ports            )        {
  const storage = ports.storage;
  const characters = ports.characters;
  const events = ports.events;

  /** Fire the change event with the values the listeners will re-read anyway. */
  function emit()       {
    events.changed({ isMulti: isMulti(), sceneIds: getSceneIds() });
  }

  function isMulti()          {
    return storage.read(KEY_MODE) === "multi";
  }

  function setMulti(on         )       {
    storage.write(KEY_MODE, on ? "multi" : "single");
    emit();
  }

  /**
   * Ids on stage, in insertion order.
   *
   * A corrupt or unreachable store reads as an empty scene rather than throwing: the scene is
   * decoration around the transcript, and a failed read must not take the send path down with it.
   */
  function getSceneIds()           {
    try {
      const parsed          = JSON.parse(storage.read(KEY_SCENE) || "[]");
      if (!Array.isArray(parsed)) return [];
      const out           = [];
      for (let i = 0; i < parsed.length; i++) {
        const id          = parsed[i];
        if (typeof id === "string" && id) out.push(id);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function writeSceneIds(ids                   )       {
    storage.write(KEY_SCENE, JSON.stringify(ids));
    emit();
  }

  /**
   * Replace the whole roster in one write (roleplay checkpoint restore). Dedupes and drops
   * non-strings; one change event, not one per member, so listeners never see a half-applied scene.
   */
  function setSceneIds(ids         )           {
    const out           = [];
    const seen = new Set        ();
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i++) {
        const id          = ids[i];
        if (typeof id !== "string" || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    writeSceneIds(out);
    return getSceneIds();
  }

  function isInScene(id        )          {
    return getSceneIds().includes(id);
  }

  /** Adding an id already on stage is a no-op: no write, and therefore no change event. */
  function addToScene(id        )       {
    if (!id) return;
    const ids = getSceneIds();
    if (ids.includes(id)) return;
    ids.push(id);
    writeSceneIds(ids);
  }

  /**
   * Drop an id from the stage. When the dropped member was the active speaker, the first remaining
   * member becomes active (or the active card is cleared) — the event order is: roster first, then
   * speaker, so a listener that re-renders on the first event already sees the new roster.
   */
  function removeFromScene(id        )       {
    if (!id) return;
    const ids = getSceneIds().filter((x) => x !== id);
    writeSceneIds(ids);
    const active = storage.read(KEY_ACTIVE_CHAR) || "";
    if (active === id) characters.setActiveId(ids[0] || "");
  }

  function cardOf(value         )                   {
    return isRecord(value) ? value : null;
  }

  function idOf(card           )         {
    return textOf(card.id);
  }

  function nameOf(card           )         {
    return textOf(card.name);
  }

  /** Collect the two card pools as typed cards, keeping the original object identities. */
  function collect(source                    )              {
    const out              = [];
    for (let i = 0; i < source.length; i++) {
      const card = cardOf(source[i]);
      if (card) out.push(card);
    }
    return out;
  }

  function scenePool()              {
    return collect(characters.listAllCards());
  }

  function archetypePool()              {
    return collect(characters.archetypes());
  }

  /**
   * Cards on stage, resolved id by id. Saved cards win over archetypes with the same id; an id that
   * no longer resolves anywhere is skipped instead of yielding a hole in the roster.
   */
  function getSceneCards()              {
    const ids = getSceneIds();
    if (!ids.length) return [];
    const saved = new Map                   ();
    const cards = scenePool();
    for (let i = 0; i < cards.length; i++) saved.set(idOf(cards[i]), cards[i]);
    const archs = archetypePool();
    const out              = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let hit = saved.get(id);
      if (!hit) {
        for (let j = 0; j < archs.length; j++) {
          if (idOf(archs[j]) === id) {
            hit = archs[j];
            break;
          }
        }
      }
      if (hit) out.push(hit);
    }
    return out;
  }

  /**
   * Names of the other characters on stage, i.e. everyone a reply could hand the turn to.
   *
   * Empty in single mode (there is nobody else) and with fewer than two ids, which is the same
   * condition the console uses to decide whether to show itself at all.
   */
  function getSceneOtherNames()           {
    if (!isMulti()) return [];
    const ids = getSceneIds();
    if (ids.length < 2) return [];
    const active = storage.read(KEY_ACTIVE_CHAR) || "";
    const cards = getSceneCards();
    const byId = new Map                   ();
    for (let i = 0; i < cards.length; i++) byId.set(idOf(cards[i]), cards[i]);
    const out           = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === active) continue;
      const card = byId.get(id);
      if (!card) continue;
      const name = nameOf(card);
      if (name) out.push(name);
    }
    return out;
  }

  /**
   * Resolve a typed name to a card, saved cards first, then archetypes.
   *
   * Three tiers, tried in order: exact match on the raw name, exact match after
   * {@link normalizeName}, then bidirectional substring. The last tier is what lets `小红` find
   * `【小红】` and `小红姐姐`, and the two-character floor keeps a single-character name from matching
   * a whole shelf.
   *
   * @returns The card itself (not a copy), or `null` when nothing matches.
   */
  function findAnyCardByName(name        )                   {
    if (!name) return null;
    const pool = scenePool().concat(archetypePool());
    if (!pool.length) return null;
    const raw = name.trim();
    for (let i = 0; i < pool.length; i++) if (pool[i].name === raw) return pool[i];
    const wanted = normalizeName(raw);
    if (!wanted) return null;
    for (let i = 0; i < pool.length; i++) if (normalizeName(pool[i].name) === wanted) return pool[i];
    for (let i = 0; i < pool.length; i++) {
      const candidate = normalizeName(pool[i].name);
      if (!candidate || candidate.length < 2 || wanted.length < 2) continue;
      if (candidate.includes(wanted) || wanted.includes(candidate)) return pool[i];
    }
    return null;
  }

  /**
   * Names a model may still summon: saved cards only (archetypes are templates, not people the user
   * has agreed to), minus whoever is already on stage, minus the current speaker.
   */
  function getSummonableNames(excludeId         )           {
    const exclude = typeof excludeId === "string" ? excludeId : "";
    const scene = new Set(getSceneIds());
    const cards = scenePool();
    const out           = [];
    for (let i = 0; i < cards.length; i++) {
      const id = idOf(cards[i]);
      const name = nameOf(cards[i]);
      if (!id || !name) continue;
      if (scene.has(id) || id === exclude) continue;
      out.push(name);
    }
    return out;
  }

  /**
   * Bring a character onto the stage by name.
   *
   * Side effects, in order: multi mode is switched on if it was off, then the card is added. Both go
   * through the public members, so both emit — a summon therefore produces two change events, which
   * the console already tolerates (it re-renders idempotently).
   *
   * @returns The resolved card on success, `null` when the name matches nothing.
   */
  function summonByName(name        )                   {
    const card = findAnyCardByName(name);
    if (!card) return null;
    if (!isMulti()) setMulti(true);
    const id = idOf(card);
    if (!isInScene(id)) addToScene(id);
    return card;
  }

  return {
    isMulti,
    setMulti,
    getSceneIds,
    setSceneIds,
    isInScene,
    addToScene,
    removeFromScene,
    getSceneCards,
    getSceneOtherNames,
    getSummonableNames,
    summonByName,
  };
}

/**
 * Rounds for one relay / discussion run, as typed into the prompt: 1–1000, and the previous value
 * when the field is empty or unparsable.
 *
 * @param raw The dialog value (a string from `prompt`, but numbers are accepted).
 * @param fallback The current round limit, used when `raw` carries no number.
 */
function clampRounds(raw         , fallback        )         {
  const n = parseInt(String(raw || fallback), 10) || fallback;
  return Math.max(1, Math.min(1000, n));
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// Scene membership, mode and name matching live in services/scene/multi-agent.ts. What stays here is
// everything that needs the page: the topbar toggle, the console panel in the right-hand slot, the
// peer roster in the agent panel, and the two events the rest of the app listens to.
//
// The panel markup is here on purpose — it has exactly one consumer, itself, and every string in it
// is user-visible copy that would otherwise have to travel through a service boundary unchanged.
//
// Ports are resolved per call, never snapshotted: the emit artifact is a classic script that may run
// before the character facade exists, and slot mounting rewrites the panel's parent at runtime.
(function () {
  if (window.multiSvc) return;

  var KEY_HINT = "cfw_multi_agent_hint_seen";
  var KEY_DEV = "cfw_dev_mode_v1";

  function charFacade() {
    return window.characterSvc || null;
  }

  var api = createScene({
    storage: {
      read: function (key) {
        return window.localStorage.getItem(key);
      },
      write: function (key, value) {
        window.localStorage.setItem(key, value);
      },
    },
    characters: {
      listAllCards: function () {
        var ch = charFacade();
        return ch && ch.listAllCards ? ch.listAllCards() : [];
      },
      archetypes: function () {
        var ch = charFacade();
        return ch && ch.archetypes ? ch.archetypes : [];
      },
      setActiveId: function (id) {
        var ch = charFacade();
        if (ch && ch.setActiveId) ch.setActiveId(id);
      },
    },
    events: {
      changed: function (detail) {
        window.dispatchEvent(new CustomEvent("multi-agent:changed", { detail: detail }));
        window.dispatchEvent(new CustomEvent("character:changed"));
      },
    },
  });

  window.multiSvc = api;

  // scene-strip: removed from the UI in 4.18 in favour of model-driven turn hand-off. The renderer
  // survives only as a collector for a strip left behind by an older session.
  function renderSceneStrip() {
    var oldStrip = document.getElementById("sceneStrip");
    if (oldStrip && oldStrip.parentNode) oldStrip.parentNode.removeChild(oldStrip);
    if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
  }

  function wireTopbarToggle() {
    var btn = document.getElementById("multiAgentToggle");
    if (!btn) return;
    function refresh() {
      var on = api.isMulti();
      // Cards built from the sidebar template carry an icon span; the flat button does not.
      var iconEl = btn.querySelector(".sidebar-btn-icon");
      if (iconEl) iconEl.textContent = on ? "👥" : "🧑";
      else btn.textContent = on ? "👥" : "🧑";
      var labelEl = btn.querySelector(".sidebar-btn-label");
      if (labelEl) labelEl.textContent = on ? "多智能体" : "单智能体";
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    refresh();
    btn.addEventListener("click", function () {
      var next = !api.isMulti();
      api.setMulti(next);
      refresh();
      if (next && !window.localStorage.getItem(KEY_HINT)) {
        try {
          window.localStorage.setItem(KEY_HINT, "1");
        } catch (e) {}
        setTimeout(function () {
          alert("已切换为多人场景模式。\n\n玩法：\n① 点 🎭 打开角色面板 →「我的」标签 → 点多张卡的「+场景」加成员\n② 群聊(orchestrate)模式由智能编排自动接力：AI 喊名字让对应角色发言\n③ 吐槽姬/接龙/讨论模式：点输入框上方的群聊控制台切换发言者\n④ 好感度 / 指令模块都按当前发言者处理\n⑤ 与 Agent 模式同开时：多智能体是「给 agent 开的能力」—— 私下小会 / 派子 agent / 请角色上台（设置→Agent 里有开关），时间线仍由主 agent 说话");
        }, 100);
      }
    });
    window.addEventListener("multi-agent:changed", refresh);
    window.addEventListener("character:changed", refresh);
  }

  function getFishbowl() {
    return window.fishbowlSvc || null;
  }

  // Inline SVG rather than emoji: the console must inherit currentColor like every other control.
  function fbSvg(d, opts) {
    opts = opts || {};
    var s = opts.size || 14;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;flex:none;">' + d + '</svg>';
  }

  function endReasonLabel(r) {
    return ({
      max: "达到最大轮数",
      "end-tag": "AI 触发 [end] 标签",
      stop: "手动终止",
      error: "运行出错",
    })[r] || (r || "—");
  }

  // Group chat and relay share the left/right bubble split; roast alternates sides instead.
  function syncChatMode(mode) {
    var isRoast = mode === "relay" || mode === "discuss";
    document.body.setAttribute("data-chat-mode", isRoast ? "roast" : "group");
  }

  // The themed prompt when it is mounted, the native one otherwise — the console must not strand a
  // user behind a missing feedback module.
  function uiPrompt(message, opts) {
    try {
      if (window.feedbackSvc && window.feedbackSvc.prompt) return window.feedbackSvc.prompt(Object.assign({ message: message }, opts || {}));
    } catch (e) {}
    var v = window.prompt(message, (opts && opts.input && opts.input.value) || "");
    return Promise.resolve(v);
  }

  async function handleFbModeChip(next) {
    var fb = getFishbowl();
    if (!fb) {
      alert("鱼缸引擎未加载(fishbowl-engine.js)");
      return;
    }
    var cur = fb.getMode();
    if (next === cur) return;
    var st = fb.getState();
    if (st.state === "running" || st.state === "paused") fb.stop();
    if (st.state === "ended" && fb.resetEnded) fb.resetEnded();
    fb.setMode(next);
    if (next === "discuss") {
      var topic = await uiPrompt("请输入议题（必填）", { title: "讨论议题", okText: "开始讨论", input: { value: fb.getTopic() || "", placeholder: "例如：今晚谁洗碗" } });
      if (!topic || !topic.trim()) {
        fb.setMode(cur);
        renderAll();
        return;
      }
      fb.setTopic(topic.trim());
    }
    if (next === "relay" || next === "discuss") {
      // Developer mode skips the round cap: the run ends on the model's [end] tag or a manual stop.
      if (window.localStorage.getItem(KEY_DEV) === "1") {
        fb.start();
      } else {
        var curRounds = fb.getMaxRounds();
        var ans = await uiPrompt("最大轮数（1-1000，默认 8。仅防意外离开爆资金；随时可手动终止）", { title: "接龙轮数", okText: "开始", input: { value: String(curRounds), type: "number" } });
        // A cancelled dialog must not start the run — only an accepted one does.
        if (ans === null) {
          fb.setMode(cur);
          renderAll();
          return;
        }
        fb.setMaxRounds(clampRounds(ans, curRounds));
        fb.start();
      }
    }
    renderAll();
  }

  async function handleFbCmd(cmd) {
    var fb = getFishbowl();
    if (!fb) return;
    if (cmd === "start") fb.start();
    else if (cmd === "pause") fb.pause();
    else if (cmd === "resume") fb.resume();
    else if (cmd === "stop") fb.stop();
    else if (cmd === "topic") {
      var t = await uiPrompt("新议题", { title: "改议题", okText: "保存", input: { value: fb.getTopic() || "" } });
      if (t && t.trim()) fb.setTopic(t.trim());
    } else if (cmd === "restart") {
      if (fb.resetEnded) fb.resetEnded();
      fb.start();
    } else if (cmd === "close") {
      if (fb.resetEnded) fb.resetEnded();
      fb.setMode("orchestrate");
    }
    setTimeout(renderAll, 50);
  }

  function renderFishbowlSidePanel() {
    // Older sessions may still carry a V2 bottom bar; V3 keeps everything in the side panel.
    ["fishbowlModeRow", "fishbowlBar"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });

    var panel = document.getElementById("fishbowlSidePanel");
    var fb = getFishbowl();
    var showPanel = !!fb && api.isMulti() && api.getSceneIds().length >= 2;

    if (!showPanel) {
      if (panel) panel.style.display = "none";
      document.body.removeAttribute("data-chat-mode");
      if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
      return;
    }

    // The new mobile shell moves the whole right rail (and this slot) into its console, so desktop
    // and mobile use the same host. No body-mounted bottom sheet: that was the old mobile UI.
    var slot = window.slotRegistry.pick("fishbowlSlot");
    if (!slot) {
      if (panel) panel.style.display = "none";
      return;
    }
    // The agent console shares this slot when both run at once. The console sits above the timeline
    // so a long timeline cannot push the controls out of the viewport, and DOM order is
    // roster -> group-chat console -> agent console.
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "fishbowlSidePanel";
      panel.className = "fishbowl-side-panel";
    }
    var anchor = slot.querySelector("#__agentConsoleRoot");
    if (anchor && anchor.parentNode === slot) {
      if (panel.parentNode !== slot || panel.nextElementSibling !== anchor) {
        slot.insertBefore(panel, anchor);
      }
    } else if (panel.parentNode !== slot) {
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      slot.appendChild(panel);
    }
    panel.classList.add("in-slot");
    panel.style.display = "";

    var s = fb.getState();
    var mode = s.mode || "orchestrate";
    syncChatMode(mode);

    var safe = window.escapeSvc.esc;
    var stateLabel = ({
      idle: fbSvg('<circle cx="12" cy="12" r="7"/>') + " 待启动",
      running: fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>') + " 进行中",
      paused: fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>') + " 已暂停",
      ended: fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>') + " 已结束",
    })[s.state] || s.state;

    var modes = [
      { id: "orchestrate", label: fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>') + " 编排", title: "你手选下一句由谁说(群聊视觉)" },
      { id: "relay", label: fbSvg('<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><path d="M4 20v-4h4"/>') + " 接龙", title: "AI 轮流自动接龙(吐槽姬视觉)" },
      { id: "discuss", label: fbSvg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/>') + " 讨论", title: "围绕议题自由讨论(吐槽姬视觉)" },
    ];
    var chipsHtml = modes.map(function (m) {
      return '<button class="chip-btn fishbowl-chip' + (m.id === mode ? " active" : "") + '" data-fbmode="' + m.id + '" title="' + safe(m.title) + '">' + m.label + '</button>';
    }).join("");

    var statusHtml = "";
    if (mode === "relay" || mode === "discuss") {
      if (s.state === "ended" && s.endStats) {
        var e = s.endStats;
        statusHtml = '<div class="fb-side-ended"><div class="fb-ended-title">' + fbSvg('<path d="M6 21V4"/><path d="M6 5h11l-2 3 2 3H6"/>') + ' 已结束</div><div class="fb-ended-line">共 <b>' + e.totalRounds + '</b> 轮，用时 <b>' + e.durationSec + '</b> 秒</div>' + (mode === "discuss" && e.topic ? '<div class="fb-ended-line">议题:' + safe(e.topic) + '</div>' : "") + '<div class="fb-ended-reason">' + endReasonLabel(e.endReason) + '</div></div>';
      } else {
        var round = window.localStorage.getItem(KEY_DEV) === "1" ? (s.round || 0) + "（不限轮，开发者）" : (s.round || 0) + "/" + fb.getMaxRounds();
        var topic = mode === "discuss" ? fb.getTopic() || "(未设置)" : "";
        var speaker = s.speakerName || "—";
        // Running cost replaces a hard round cap: the user decides when to stop.
        var costLine = "";
        try {
          if (window.hostApi.cost && window.hostApi.cost.getCostStats) {
            var cs = window.hostApi.cost.getCostStats();
            if (cs && cs.total > 0) {
              costLine = '<div class="fb-info-line" style="opacity:.85;">' + fbSvg('<path d="M12 3v18"/><path d="M16 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7"/>', { size: 12 }) + ' 今日 <b>¥' + cs.today.toFixed(4) + '</b>，累计 <b>¥' + cs.total.toFixed(4) + '</b></div>';
            }
          }
        } catch (e) {}
        statusHtml = '<div class="fb-side-status"><div class="fb-state-line">' + stateLabel + '</div><div class="fb-info-line">轮次 <b>' + round + '</b></div>' + (topic ? '<div class="fb-info-line">议题:' + safe(topic) + '</div>' : "") + '<div class="fb-info-line">当前:<b>' + safe(speaker) + '</b></div>' + costLine + '</div>';
      }
    }

    var btns = [];
    if (mode === "relay" || mode === "discuss") {
      var _play = fbSvg('<path d="M8 6l9 6-9 6z" fill="currentColor" stroke="none"/>', { size: 12 });
      var _pause = fbSvg('<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>', { size: 12 });
      var _stop = fbSvg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', { size: 12 });
      var _edit = fbSvg('<path d="M14 5l5 5"/><path d="M4 20l1-4L16 5l3 3L8 19z"/>', { size: 12 });
      var _spark = fbSvg('<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" fill="currentColor" stroke="none"/>', { size: 12 });
      var _close = fbSvg('<path d="M6 6l12 12M18 6L6 18"/>', { size: 12 });
      if (s.state === "idle") btns.push('<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="start">' + _play + ' 启动</button>');
      if (s.state === "running") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="pause">' + _pause + ' 暂停</button>');
      if (s.state === "paused") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="resume">' + _play + ' 继续</button>');
      if (s.state === "running" || s.state === "paused") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="stop">' + _stop + ' 终止</button>');
      if (mode === "discuss" && s.state !== "ended") btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="topic">' + _edit + ' 改议题</button>');
      if (s.state === "ended") {
        btns.push('<button class="chip-btn fb-cmd-btn fb-primary" data-fbcmd="restart">' + _spark + ' 新一轮</button>');
        btns.push('<button class="chip-btn fb-cmd-btn" data-fbcmd="close">' + _close + ' 关闭</button>');
      }
    }

    // Orchestrate mode is not driven by the engine, and the tap-a-character strip was removed in
    // 4.18 — without this roster nothing on screen can make a chosen character say the next line.
    var orchestrateHtml = "";
    if (mode === "orchestrate") {
      var roster = api.getSceneCards();
      var activeId = ((window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard()) || {}).id || "";
      orchestrateHtml = '<div class="fb-side-status"><div class="fb-info-line">点角色让 TA 说下一句:</div><div class="fb-side-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">' +
        roster.map(function (c) {
          return '<button class="chip-btn fb-orch-speaker' + (c.id === activeId ? " active" : "") + '" data-fborch="' + safe(c.id) + '"><span>' + safe(c.icon || "\u{1F642}") + '</span> ' + safe(c.name) + '</button>';
        }).join("") +
        '</div></div>';
    }

    // Each character eats its own context, so the count shown here is that character's, not the
    // session's — without it a suddenly short context reads as a bug.
    var ctxHtml = "";
    try {
      var info = window.hostApi.app && window.hostApi.app.getContextInfo ? window.hostApi.app.getContextInfo() : null;
      if (info) {
        var who = info.speaker ? "「" + safe(info.speaker) + "」" : "";
        ctxHtml = '<div class="fb-side-ctx" style="font-size:11px;opacity:.72;padding:2px 2px 6px;">上下文：' + safe(info.label) + who + '，计入 ' + info.included + ' 条 / 共 ' + info.total + ' 条</div>';
      }
    } catch (e) {}

    panel.innerHTML = '<div class="fb-side-header">' + fbSvg('<path d="M4 5.5h13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 14V7A1.5 1.5 0 0 1 4 5.5z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="10.8" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="14.1" cy="10.5" r="1" fill="currentColor" stroke="none"/>', { size: 15 }) + ' 群聊控制台</div>' + ctxHtml + '<div class="fb-side-modes">' + chipsHtml + '</div>' + orchestrateHtml + statusHtml + (btns.length ? '<div class="fb-side-actions">' + btns.join("") + '</div>' : "");

    panel.querySelectorAll("[data-fbmode]").forEach(function (el) {
      el.addEventListener("click", function () {
        handleFbModeChip(el.dataset.fbmode);
      });
    });
    panel.querySelectorAll("[data-fbcmd]").forEach(function (el) {
      el.addEventListener("click", function () {
        handleFbCmd(el.dataset.fbcmd);
      });
    });
    // Passing the card explicitly avoids a setActiveId race; the reply then starts its own hand-off
    // chain so the group keeps talking without further clicks.
    panel.querySelectorAll("[data-fborch]").forEach(function (el) {
      el.addEventListener("click", async function () {
        var id = el.dataset.fborch;
        var card = api.getSceneCards().find(function (c) {
          return c.id === id;
        });
        if (!card) return;
        if (window.characterSvc && window.characterSvc.setActiveId) window.characterSvc.setActiveId(id);
        if (window.hostApi.app && window.hostApi.app.sendOne) {
          var reply = await window.hostApi.app.sendOne({ allowEmptyText: true, asCard: card });
          if (window.hostApi.app.continueGroupChat) {
            try {
              await window.hostApi.app.continueGroupChat(reply, card);
            } catch (e) {}
          }
        }
      });
    });

    if (window.hostApi.app && window.hostApi.app.updateSpacer) window.hostApi.app.updateSpacer();
  }

  // Peer roster in the agent panel: who is on stage (addressable for a whisper or an invitation) and
  // how many messages each of them has in its own private thread.
  function renderAgentPeers() {
    var box = document.getElementById("__agentPeers");
    if (!box) return;
    if (!api.isMulti() || api.getSceneIds().length < 2) {
      box.innerHTML = "";
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    var safe = window.escapeSvc.esc;
    var cards = api.getSceneCards();
    var info = null;
    try {
      info = window.hostApi.app && window.hostApi.app.getContextInfo ? window.hostApi.app.getContextInfo() : null;
    } catch (e) {}
    var rows = cards.map(function (c) {
      var n = null;
      try {
        n = window.hostApi.app && window.hostApi.app.getRoleContextCount ? window.hostApi.app.getRoleContextCount(c) : null;
      } catch (e) {}
      return '<span class="chip-btn" title="' + safe(c.name) + (n != null ? "（自己的单聊上下文 " + n + " 条）" : "") + '">'
        + safe(c.icon || "\u{1F642}") + " " + safe(c.name) + (n != null ? " · " + n : "") + "</span>";
    }).join("");
    box.innerHTML = '<div style="font-size:11px;opacity:.72;padding:0 2px 6px;">平级名单（可被私下咨询 / 可被请上台）'
      + (info ? "，当前上下文计入 " + info.included + "/" + info.total + " 条" : "")
      + '</div><div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 2px 8px;">' + rows + "</div>";
  }

  function renderAll() {
    renderSceneStrip();
    renderFishbowlSidePanel();
    renderAgentPeers();
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireTopbarToggle();
    // Deferred once so app.js has laid out the floating input bar the panel measures against.
    setTimeout(renderAll, 80);
    window.addEventListener("character:changed", renderAll);
    window.addEventListener("multi-agent:changed", renderAll);
    window.addEventListener("fishbowl:tick", renderAll);
    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderAll, 200);
    });
  });
})();

globalThis.createScene = createScene;
globalThis.clampRounds = clampRounds;
})();
