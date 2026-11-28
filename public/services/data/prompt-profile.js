(function () {
/**
 * Prompt-tier assembly: reads and writes the base tier, the neutral tier, the state layer, per-card
 * char capabilities, generation params and the web-search switch, and shapes the fields each of
 * them contributes to an /api/chat body.
 *
 * Dependencies arrive through {@link PromptProfilePorts}: storage, the two tier catalogues,
 * baseSwitchMode, the host callbacks (isUseBuiltin / setIcon), the personaToggle element and an
 * active-card accessor. baseSwitchMode and personaToggle are snapshotted at creation time — that is
 * the old semantics, do not switch them to call-time lookups.
 *
 * This layer only decides which fields are left out. The server keeps its own whitelist fallback
 * (unknown or missing ids fall back to the default tier), so this is not a security boundary and
 * validation does not belong here. Per-case assertions: test/prompt-profile.test.mjs.
 * @module services/data/prompt-profile
 */

/** Key-value storage port: window.localStorage in the browser, a Map in the Node tests. */
                            
                                      
                                            
 

/** Minimal shape of the top-bar tier button; only title and setAttribute are used. */
                             
                 
                                                  
 

/** Minimal card shape; the console's __charCaps.ui reads id and name. */
                                 
             
               
 

/** Environment ports. The window bridge and every try/catch live in the wiring layer. */
                                     
                     
                                                                                                   
                     
                                                           
                       
                                                                                                  
                            
                                                               
                          
                                      
                                                                    
                                                                           
                                     
                                                                            
                                      
 

/** Tier description: `ids` is the whole catalogue, `label` the effective tier (falls back to the first). */
                                      
                
                
 

/** Per-card capability set: base / instruction modules / skills / model overrides for one card. Shape is loose and narrowed on read. */
                                              

/** Public surface, name for name identical to what window.__promptProfile.create() returned. */
                                   
                          
                            
                          
                            
                                     
                                                            
                             
                                           
                                             
                                        
                                         
                                                             
                                     
                                                         
                                              
                                               
                                              
                                                
 

// Storage keys: values are byte-identical to the old code; changing one is changing the contract.
const LS_BASE_ID = "cfw_base_id_v1";
const LS_CUSTOM_ID = "cfw_custom_id_v1";
const LS_BASE_REGISTRY = "cfw_base_registry_v1";
const LS_UNLOCKED = "cfw_unlocked_v1";
const LS_NEUTRAL_ID = "cfw_neutral_id_v1";
const LS_STATE_LAYER = "cfw_state_layer_v1";
const LS_WEB_SEARCH = "cfw_web_search_v1";
const LS_WEB_SEARCH_DEEP = "cfw_web_search_deep_v1";
// DeepSeek full-kit toggles, written by the model-API settings card. Server-side built-in tools are
// only mounted on the DeepSeek channel; every other provider ignores the payload.
const LS_DS_READ_URL = "cfw_deepseek_read_url_v1";
const LS_DS_SAFETY = "cfw_deepseek_safety_v1";
const LS_GEN_PARAMS = "cfw_gen_params_v1";
const LS_CHAR_CAPS = "cfw_char_caps_v1";

/**
 * Create a tier-assembly instance. BASE_SWITCH_MODE and the personaToggle reference are frozen at
 * creation time and never re-read.
 * @param ports - storage, tier catalogues, host callbacks and the two creation-time snapshots.
 * @returns Name for name the surface window.__promptProfile.create() used to return.
 */
function createPromptProfile(ports                    )                   {
  const storage = ports.storage;
  // Both snapshots mirror the old semantics: BASE_SWITCH_MODE is a load-time constant, personaToggle
  // is a load-time element reference (later repaints reuse it rather than looking the element up again)
  const BASE_SWITCH_MODE = ports.baseSwitchMode();
  const personaToggle = ports.personaToggle();

  /** Safe read: any throw reads as null, which is what the old per-call try/catch did. */
  function read(key        )                {
    try {
      return storage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /** Safe write: failures are swallowed, as in the old `catch (e) {}`. */
  function write(key        , value        )       {
    try {
      storage.setItem(key, value);
    } catch (e) {}
  }

  /** Read as an object map; non-object, array and broken JSON all read as {}. */
  function readMap(key        )                          {
    const raw = read(key);
    try {
      const parsed          = JSON.parse(raw === null ? "{}" : raw);
      const rec = recOf(parsed);
      return rec === null ? {} : rec;
    } catch (e) {
      return {};
    }
  }

  /**
   * unknown -> plain-object copy; arrays, null and scalars become null. Copied through
   * Object.entries because `typeof x === "object"` narrows to object only, and TS will not accept
   * it as a Record.
   */
  function recOf(value         )                                 {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const out                          = {};
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
    return out;
  }

  /** Catalogue entries; keeps non-empty strings only, matching the old `filter(typeof === "string" && x)`. */
  function stringList(value         )           {
    if (!Array.isArray(value)) return [];
    const out           = [];
    for (let i = 0; i < value.length; i++) {
      const item          = value[i];
      if (typeof item === "string" && item !== "") out.push(item);
    }
    return out;
  }

  function baseIdsList()           {
    return stringList(ports.baseIds());
  }

  function customIdsList()           {
    return stringList(ports.customIds());
  }

  function currentBaseId()         {
    const v = read(LS_BASE_ID);
    return v === null ? "" : v;
  }

  function currentCustomId()         {
    const v = read(LS_CUSTOM_ID);
    return v === null ? "" : v;
  }

  function currentRegistryIsCustom()          {
    return BASE_SWITCH_MODE && read(LS_BASE_REGISTRY) === "custom";
  }

  // Both catalogues resolve the current tier the same way: nothing selected, or an id that no longer
  // exists, falls back to the first entry
  function registryDescribe(useCustom         )                      {
    const ids = useCustom ? customIdsList() : baseIdsList();
    const cur = useCustom ? currentCustomId() : currentBaseId();
    const label = cur !== "" && ids.indexOf(cur) >= 0 ? cur : (ids.length > 0 ? ids[0] : "");
    return { ids: ids, label: label };
  }

  function paintPersonaButton()       {
    if (personaToggle === null) return;
    if (BASE_SWITCH_MODE) {
      // Copy discipline: title and aria-label are fixed whole strings, never built by concatenation —
      // a concatenated string has no dictionary entry, so it leaks Chinese into the English UI (that is
      // how the "thinking mode" batch leaked). The tier name itself is shown in the settings card.
      const useCustom = currentRegistryIsCustom();
      ports.setIcon(personaToggle, "personaBuiltin", useCustom ? "自定义" : "内置");
      personaToggle.title = useCustom
        ? "基座目录：自定义（src/prompts/custom/）。点击切回内置"
        : "基座目录：内置（src/prompts/bases/）。点击切到自定义";
      personaToggle.setAttribute("aria-label", useCustom ? "切回内置基座" : "切到自定义基座");
      return;
    }
    const builtin = ports.isUseBuiltin();
    ports.setIcon(personaToggle, builtin ? "personaBuiltin" : "personaCustom", builtin ? "内置" : "自定义");
  }

  // Generation params (temperature / max_tokens), edited in settings -> model API -> generation card
  // (mountGenParamsCard in settings.js). The default is "do not interfere": unset fields are not sent,
  // so the upstream keeps its own defaults instead of being overridden by a guessed value.
  function readGenParams()                          {
    return readMap(LS_GEN_PARAMS);
  }

  // Fragment spread into the /api/chat body; the worker accepts temperature / top_p / max_tokens and
  // only applies them when explicitly provided
  function genParamPayload()                          {
    const g = readGenParams();
    const out                          = {};
    const temperature          = g.temperature;
    if (typeof temperature === "number" && temperature >= 0) out.temperature = temperature;
    const maxTokens          = g.maxTokens;
    if (typeof maxTokens === "number" && maxTokens > 0) out.max_tokens = Math.floor(maxTokens);
    return out;
  }

  // Per-card capabilities live in cfw_char_caps_v1 as { [cardId]: { baseId?, presetIds?, skillNames?, model? } }.
  // Unset (no entry, or empty field) means "follow the global setting", so an unconfigured card behaves
  // exactly as before. Per-card lorebook binding is handled by lorebook.js via scope:'perCard' plus
  // boundCardId and is deliberately not duplicated here.
  function charCapMap()                          {
    return readMap(LS_CHAR_CAPS);
  }

  function charCap(card         )                 {
    let id = "";
    if (typeof card === "string") {
      id = card;
    } else if (card !== null && typeof card === "object") {
      const value          = card["id"];
      if (typeof value === "string") id = value;
    }
    if (id === "") return null;
    return recOf(charCapMap()[id]);
  }

  function setCharCap(cardId        , patch         )                 {
    if (cardId === "") return null;
    const all = charCapMap();
    const prev = recOf(all[cardId]);
    const extra = recOf(patch);
    const merged                          = {};
    if (prev !== null) {
      const baseKeys = Object.keys(prev);
      for (let i = 0; i < baseKeys.length; i++) merged[baseKeys[i]] = prev[baseKeys[i]];
    }
    if (extra !== null) {
      const patchKeys = Object.keys(extra);
      for (let i = 0; i < patchKeys.length; i++) merged[patchKeys[i]] = extra[patchKeys[i]];
    }
    all[cardId] = merged;
    write(LS_CHAR_CAPS, JSON.stringify(all));
    return merged;
  }

  function clearCharCap(cardId        )       {
    const all = charCapMap();
    delete all[cardId];
    write(LS_CHAR_CAPS, JSON.stringify(all));
  }

  // Ids only, never prompt text. With no tier selected, or while locked, no baseId goes out (the locked
  // path sends neutralId instead, see below) and the worker falls back to the default tier. The server
  // keeps its own whitelist fallback (resolveBaseId), so this is about omitting noise, not security.
  // Both payload sites (sendOneAgent and sendOne) need it — updating only one is the bug hit on 4.69 BYO.
  // 2026-10-08: a speaker card may be passed in; if that card carries a baseId (per-card capability) it
  // wins, otherwise the global tier applies.
  function baseIdPayload(card          )                          {
    // Public channel: two catalogues (bases/ built-in, custom/ user), the top-bar button picks one, and
    // each tier id goes through its own whitelist. With no tier chosen, send no id at all so the server
    // falls back to that catalogue's default tier, matching the "default" entry in settings.
    if (BASE_SWITCH_MODE) {
      if (currentRegistryIsCustom()) {
        const cid = currentCustomId();
        return cid !== "" ? { use_custom_base: true, customId: cid } : { use_custom_base: true };
      }
      const bid = currentBaseId();
      return bid !== "" ? { baseId: bid } : {};
    }
    if (read(LS_UNLOCKED) !== "1") return {};
    const cap = charCap(card);
    const capBase          = cap === null ? undefined : cap["baseId"];
    const id = typeof capBase === "string" && capBase !== "" ? capBase : currentBaseId();
    return id !== "" ? { baseId: id } : {};
  }

  // Locked-state "base behaviour guidelines", mutually exclusive with baseId: unlocked sends baseId,
  // locked sends neutralId. The server reads whichever catalogue its own lock state points at
  // (src/prompts/registry.js); this side only avoids sending a useless field.
  function neutralIdPayload()                          {
    if (read(LS_UNLOCKED) === "1") return {};
    const id = read(LS_NEUTRAL_ID);
    return id !== null && id !== "" ? { neutralId: id } : {};
  }

  // Character state layer, toggled in settings. Only the "off" state sends a field (default is on, the
  // server tests `payload.stateLayer !== false`). This is the switch behind "why is RP the default":
  // whenever a card is active the current-state block is injected, and turning this off stops it.
  function stateLayerPayload()                          {
    return read(LS_STATE_LAYER) === "0" ? { stateLayer: false } : {};
  }

  // 2026-10-07 web search: the field is sent only when the switch is on (default off, and the server
  // mounts no search tool). Deep search (Exa) rides on top of it; a worker without EXA_API_KEY
  // downgrades to the free search on its own.
  function webSearchPayload()                          {
    if (read(LS_WEB_SEARCH) !== "1") return {};
    return { webSearch: true, webSearchDeep: read(LS_WEB_SEARCH_DEEP) === "1" };
  }

  // 2026-11-25: server-side built-in tools (read_url / safety_check) from the DeepSeek kit card.
  // The field is omitted entirely unless at least one toggle is on, so non-DeepSeek channels and
  // old deployments see no change at all.
  function deepseekKitPayload()                          {
    const readUrl = read(LS_DS_READ_URL) === "1";
    const safety = read(LS_DS_SAFETY) === "1";
    if (!readUrl && !safety) return {};
    return { deepseekKit: { readUrl: readUrl, safetyCheck: safety } };
  }

  return {
    baseIdsList: baseIdsList,
    customIdsList: customIdsList,
    currentBaseId: currentBaseId,
    currentCustomId: currentCustomId,
    currentRegistryIsCustom: currentRegistryIsCustom,
    registryDescribe: registryDescribe,
    paintPersonaButton: paintPersonaButton,
    readGenParams: readGenParams,
    genParamPayload: genParamPayload,
    charCapMap: charCapMap,
    charCap: charCap,
    setCharCap: setCharCap,
    clearCharCap: clearCharCap,
    baseIdPayload: baseIdPayload,
    neutralIdPayload: neutralIdPayload,
    stateLayerPayload: stateLayerPayload,
    webSearchPayload: webSearchPayload,
    deepseekKitPayload: deepseekKitPayload,
  };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract names
// (both `__promptProfile` and `__charCaps`). The implementation lives in
// services/data/prompt-profile.ts, so every window bridge, every `document` lookup and the
// alert/prompt dialogs are here — the old code inlined them inside `create()`.
// Two things are captured once at create time, as before: __baseSwitchMode (a load-time constant)
// and #personaToggle (a load-time element). __charCaps is still created inside `create()`, because
// callers reach for it immediately afterwards.
(function () {
  if (window.__promptProfile) return;

  var storage = {
    getItem: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },
  };

  function activeCard() {
    try {
      var c = window.characterSvc && window.characterSvc.getActiveCard && window.characterSvc.getActiveCard();
      if (c && c.id) return { id: c.id, name: c.name };
    } catch (e) {}
    return null;
  }

  window.__promptProfile = {
    create: function (host) {
      host = host || {};
      var ports = {
        storage: storage,
        baseIds: function () { return window.APP_BASE_IDS; },
        customIds: function () { return window.APP_CUSTOM_IDS; },
        baseSwitchMode: function () { return !!window.__baseSwitchMode; },
        isUseBuiltin: typeof host.isUseBuiltin === "function" ? host.isUseBuiltin : function () { return true; },
        setIcon: typeof host.setIcon === "function" ? host.setIcon : function () {},
        personaToggle: function () { return document.getElementById("personaToggle"); },
        activeCard: activeCard,
      };
      var pp = createPromptProfile(ports);

      // The v1 entry point: call `__charCaps.ui()` in the console and it prompts for the active
      // character's base / instruction modules / skills / model. The proper editor-side panel is a
      // later batch; storage and assembly are already wired end to end.
      window.__charCaps = {
        get: pp.charCap,
        all: pp.charCapMap,
        set: pp.setCharCap,
        clear: pp.clearCharCap,
        ui: function () {
          var card = activeCard();
          if (!card || !card.id) {
            alert("先挂一张角色卡（左栏角色面板）—— 能力档是「每张卡一套」的。");
            return;
          }
          var cur = pp.charCap(card) || {};
          var baseId = prompt("「" + card.name + "」的底座 id（留空=跟随全局；可用 __charCaps 查看/清空）：", cur.baseId || "");
          if (baseId === null) return;
          var presetIds = prompt("指令模块 id 列表（逗号分隔；留空=跟随全局的勾选）：", Array.isArray(cur.presetIds) ? cur.presetIds.join(",") : "");
          if (presetIds === null) return;
          var skillNames = prompt("技能名列表（逗号分隔；留空=全部已启用技能）：", Array.isArray(cur.skillNames) ? cur.skillNames.join(",") : "");
          if (skillNames === null) return;
          var patch = {
            baseId: baseId.trim(),
            presetIds: presetIds.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
            skillNames: skillNames.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
          };
          window.__charCaps.set(card.id, patch);
          alert("已保存「" + card.name + "」的能力档：\n底座 " + (patch.baseId || "(跟随全局)") + "\n指令模块 " + (patch.presetIds.length || "(跟随全局)") + " 个\n技能 " + (patch.skillNames.length || "(全部)") + " 个\n（下次发消息生效）");
        },
      };

      return pp;
    },
  };
})();

globalThis.createPromptProfile = createPromptProfile;
})();
