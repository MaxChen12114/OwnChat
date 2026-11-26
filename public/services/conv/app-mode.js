(function () {
/**
 * The top-level "work / role-play" mode, minus the button: the payload the request assembler should
 * get for each mode, the reply-style gate, and how the mode follows a conversation switch.
 *
 * `work` is delivery-oriented: it sends the "assist" prompt profile, skips the role-state layer, and
 * forces the default reply style. Its temperature stabiliser only fills a gap — a temperature the
 * user set in settings is respected, never overwritten.
 *
 * The mode is stored twice on purpose: a global default (`cfw_app_mode_v1`) that new conversations
 * inherit, and a per-conversation `appMode` field that follows the conversation — switching back to a
 * role-play conversation returns to role-play, not to whatever the top bar said last.
 *
 * Deliberately unrelated: the private unlock gate (a different axis), and the agent work loop
 * (`cfw_agent_mode_v1`, a "who drives" axis) — tying either to this button would force every chat
 * through multi-turn tool calls or break the unlock flow.
 * @module services/conv/app-mode
 */

const APP_MODE_LS_KEY = "cfw_app_mode_v1";
const META_FIELD = "appMode";
const MODE_WORK = "work";
const MODE_RP = "rp";

function normMode(v         )         {
  return v === MODE_WORK ? MODE_WORK : MODE_RP;
}

                              
                      
                                       
                                      
 

                                  
                        
                     
                                      
                                     
 

/** Request assembly for a mode: the three payload slots decided in one place. */
function decidePayload(mode        , opts                         )                  {
  const o = opts || {};
  const isWork = normMode(mode) === MODE_WORK;
  const gen                          = {};
  const src = o.genParams || {};
  for (const k of Object.keys(src)) gen[k] = src[k];
  // Work mode adds the stable default only when the user has not set one; an explicit value from the
  // settings card wins.
  if (isWork && gen["temperature"] === undefined) gen["temperature"] = 0.3;
  return {
    promptProfile: isWork ? "assist" : "rp",
    replyStyle: isWork ? "default" : o.replyStyle || "default",
    stateLayer: isWork ? { stateLayer: false } : o.stateLayer || {},
    genParams: gen,
  };
}

                              
                                    
                                      
 

                               
                        
                              
                                                                       
                                                      
                                                                          
                                
                                    
 

function createAppMode(host                          ) {
  const h = host || {};
  const storage = h.storage || {
    getItem: (k        )                => {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    setItem: (k        , v        )       => {
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    },
  };
  const activeConvId = typeof h.activeConvId === "function" ? h.activeConvId : () => "";
  const touchConv = typeof h.touchConv === "function" ? h.touchConv : () => {};
  const loadConvMeta = typeof h.loadConvMeta === "function" ? h.loadConvMeta : () => ({});
  const setIcon = typeof h.setIcon === "function" ? h.setIcon : () => {};
  const emit = typeof h.emit === "function" ? h.emit : () => {};
  const btn                     = typeof h.button === "function" ? h.button() : null;

  function read(k        )                {
    try {
      return storage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function write(k        , v        )       {
    try {
      storage.setItem(k, v);
    } catch (e) {}
  }

  // Default rp: verbatim the pre-mode behaviour, where the main chat always got the full RP layer.
  let current = normMode(read(APP_MODE_LS_KEY));

  function isWork()          {
    return current === MODE_WORK;
  }

  /** Work mode forces the default style (no group-chat bursts, no long-form narration); rp reads the user's setting. */
  function replyStyle()         {
    return isWork() ? "default" : read("cfw_reply_style_v1") || "default";
  }

  /** Request assembly; the caller spreads the result. */
  function payload(extra                         )                  {
    return decidePayload(current, {
      replyStyle: read("cfw_reply_style_v1") || "default",
      stateLayer: (extra && extra.stateLayer) || {},
      genParams: (extra && extra.genParams) || {},
    });
  }

  function paint()       {
    if (!btn) return;
    const w = isWork();
    setIcon(btn, w ? "modeWork" : "modeRp", w ? "工作" : "角色扮演");
    btn.title = w
      ? "工作模式：按交付办事，不吃角色状态层与长段叙事（点击切到角色扮演）"
      : "角色扮演：完整角色层（状态 / 关系 / 氛围）（点击切到工作）";
    // The guards keep stub buttons (vm tests, future hosts without a full element) from throwing.
    if (btn.setAttribute) {
      btn.setAttribute("aria-label", w ? "当前工作模式，点击切到角色扮演" : "当前角色扮演，点击切到工作");
      btn.setAttribute("aria-pressed", w ? "true" : "false");
    }
    if (btn.classList && btn.classList.toggle) btn.classList.toggle("is-work", w);
  }

  /** `silent` keeps the change in memory and the button only — used when applying a conversation. */
  function set(v        , opts                                  )         {
    current = normMode(v);
    write(APP_MODE_LS_KEY, current);
    if (!(opts && opts.silent)) {
      try {
        const id = activeConvId();
        if (id) touchConv(id, { appMode: current });
      } catch (e) {}
    }
    paint();
    emit(current);
    return current;
  }

  function toggle()         {
    return set(isWork() ? MODE_RP : MODE_WORK, undefined);
  }

  /** Switching conversations: a stored per-conversation mode wins, else the global default. */
  function applyConv(convId        )         {
    let meta                          = {};
    try {
      // Copy instead of trusting the port's return: hosts have handed odd shapes here before.
      const loaded = loadConvMeta();
      if (loaded && typeof loaded === "object") {
        for (const k of Object.keys(loaded)) meta[k] = loaded[k];
      }
    } catch (e) {}
    const raw = (convId && meta[convId]) || {};
    const field                          = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of Object.keys(raw)) field[k] = raw[k];
    }
    current = normMode(field[META_FIELD] || read(APP_MODE_LS_KEY));
    paint();
    return current;
  }

  function bind(el                    )       {
    if (el) el.addEventListener("click", toggle);
  }

  paint();
  return {
    get: () => current,
    isWork: isWork,
    set: set,
    toggle: toggle,
    applyConv: applyConv,
    paint: paint,
    bind: bind,
    replyStyle: replyStyle,
    payload: payload,
    LS_MODE: APP_MODE_LS_KEY,
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/conv/app-mode.ts; this file only carries
// the frozen global surface (create plus the two pure helpers the tests and callers import).
(function (global) {
  "use strict";
  if (global.__appMode) return;

  global.__appMode = {
    create: function (host) { return createAppMode(host || {}); },
    decidePayload: decidePayload,
    norm: normMode,
    WORK: MODE_WORK,
    RP: MODE_RP,
    LS_MODE: APP_MODE_LS_KEY,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.APP_MODE_LS_KEY = APP_MODE_LS_KEY;
globalThis.META_FIELD = META_FIELD;
globalThis.MODE_WORK = MODE_WORK;
globalThis.MODE_RP = MODE_RP;
globalThis.normMode = normMode;
globalThis.decidePayload = decidePayload;
globalThis.createAppMode = createAppMode;
})();
