(function () {
/**
 * Thinking policy: what the toggle offers and what the request carries, minus the DOM.
 *
 * The level table belongs to `services/model-router/model-think.ts`; this module only compiles it
 * into a UI capability (available / off-allowed / must-on plus the label list) and into the request
 * fields. The table arrives as a validated {@link ThinkTable} because the wiring reads the emitted
 * `__modelThink` global, which may be absent in sandboxed hosts — a missing table degrades per
 * dialect instead of throwing.
 *
 * Dialect styles pass through unchanged. Defaulting an unknown style to `deepseek` puts
 * `thinking:{type}` on endpoints that reject it with a 400, so {@link thinkStyleFromMeta} spells out
 * the `none` / `effort` cases instead of relying on a catch-all.
 * @module services/ui/think-control
 */

                                
            
                
 

/** The level table after validation. `labelOf` / `levelsFor` are null when the table script is absent. */
                             
                          
                   
                                          
                                                                                           
 

/** A model's thinking capability as the UI sees it. `levels` is empty for plain on/off models. */
                           
                     
                
                          
                      
                  
                
 

/** Wire fields. `reasoning_effort` appears only when the model exposes strengths. */
                               
                   
                            
 

/** Everything the toggle button renders, so the wiring only assigns. */
                                  
               
                   
                    
                  
                
 

/** One popup row. `__off__` / `__on__` are sentinels: "on, no strength" is not a level. */
                                  
            
                
                  
 

                                
              
                 
               
 

const THINK_LEVEL_KEY = "cfw_think_level_v1";
const THINK_DEFAULT_LEVEL = "medium";

const THINK_LEVELS_FALLBACK                  = [
  { v: "minimal", label: "极低" },
  { v: "low", label: "低" },
  { v: "medium", label: "中" },
  { v: "high", label: "高" },
  { v: "xhigh", label: "更高" },
  { v: "max", label: "最高" },
];

/** Shallow field copy of an unknown JSON object; `null` becomes `{}` so callers stay total. */
function tkRec(v         )                          {
  const out                          = {};
  if (v === null || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v)) out[k] = val;
  return out;
}

function tkStrings(v         )           {
  const out           = [];
  if (!Array.isArray(v)) return out;
  for (const item of v) if (typeof item === "string") out.push(item);
  return out;
}

/**
 * Validate the emitted table global. Any missing or malformed field falls back, so a half-loaded
 * script yields the generic six-level ladder rather than an empty picker.
 * @param raw value of `__modelThink` (may be undefined)
 */
function thinkTableFrom(raw         )             {
  const rec = tkRec(raw);
  const levels                  = [];
  if (Array.isArray(rec.levels)) {
    for (const item of rec.levels) {
      const row = tkRec(item);
      const v = typeof row.v === "string" ? row.v : "";
      if (!v) continue;
      levels.push({ v, label: typeof row.label === "string" && row.label ? row.label : v });
    }
  }
  const declared = tkStrings(rec.values);
  const values = declared.length ? declared : (levels.length ? levels : THINK_LEVELS_FALLBACK).map((row) => row.v);
  const labelFn = typeof rec.label === "function" ? rec.label : null;
  const levelsFn = typeof rec.levelsFor === "function" ? rec.levelsFor : null;
  return {
    levels: levels.length ? levels : THINK_LEVELS_FALLBACK,
    values,
    labelOf: labelFn
      ? (v        )         => {
          const got = labelFn(v);
          return typeof got === "string" ? got : v;
        }
      : null,
    levelsFor: levelsFn
      ? (model        , style        , allowed                 )           => tkStrings(levelsFn(model, style, allowed))
      : null,
  };
}

/** Levels the model supports, per the table when present. Values only — UI meaning is derived later. */
function thinkLevelsFor(table            , model        , style        , allowed                 )           {
  if (table.levelsFor) return table.levelsFor(model, style, allowed);
  return style === "vllm" ? ["disabled", "enabled"] : ["disabled", "low", "medium", "high", "max"];
}

function thinkLevelLabel(table            , v        )         {
  if (table.labelOf) return table.labelOf(v);
  for (const row of table.levels) if (row.v === v) return row.label;
  return "中";
}

/**
 * Compile the table into the three UI states: unavailable, on/off only, on/off plus strengths.
 * A model whose only "on" value is `enabled` gets an empty `levels` list and `mustOn` when the
 * channel offers no off switch.
 */
function buildThinkCap(
  table            ,
  supports         ,
  style        ,
  model        ,
  allowed                 ,
)           {
  const named = model || "";
  if (!supports || style === "none") {
    return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: named };
  }
  const values = thinkLevelsFor(table, named, style, allowed);
  const offAllowed = values.indexOf("disabled") >= 0 || values.indexOf("none") >= 0;
  const ons = values.filter((v) => v !== "disabled" && v !== "none");
  if (!ons.length) {
    return { available: false, style: "none", levels: [], offAllowed: false, mustOn: false, model: named };
  }
  if (ons.length === 1 && ons[0] === "enabled") {
    return { available: true, style, levels: [], offAllowed, mustOn: !offAllowed, model: named };
  }
  const levels                  = ons.map((v) => ({ v, label: thinkLevelLabel(table, v) }));
  return { available: true, style, levels, offAllowed, mustOn: !offAllowed, model: named };
}

/**
 * Stored level if this model accepts it, otherwise its highest strength. Falling back to the top
 * level (not the middle) matches the reference client: a silently weakened level is harder to
 * notice than an over-eager one.
 */
function resolveThinkLevel(stored        , cap          )         {
  if (!cap || !cap.levels || !cap.levels.length) return "";
  if (cap.levels.some((row) => row.v === stored)) return stored;
  return cap.levels[cap.levels.length - 1].v;
}

/** Stored level filtered against the table's vocabulary; anything else reads as `medium`. */
function thinkLevelOrDefault(stored         , table            )         {
  const v = typeof stored === "string" ? stored : "";
  return table.values.indexOf(v) >= 0 ? v : THINK_DEFAULT_LEVEL;
}

/** Channel metadata to dialect style. `none` / `effort` must survive: those endpoints 400 on `thinking`. */
function thinkStyleFromMeta(thinkingStyle         , presetId         )         {
  if (thinkingStyle === "none" || thinkingStyle === "effort") return thinkingStyle;
  if (thinkingStyle === "vllm" || presetId === "nvidia") return "vllm";
  return "deepseek";
}

/** Free-form style string from a provider record; only the three known dialects are honoured. */
function thinkStyleOf(v         )         {
  if (v === "vllm") return "vllm";
  if (v === "effort") return "effort";
  if (v === "none") return "none";
  return "deepseek";
}

/**
 * Wire fields for one request. A model that cannot switch thinking off forces `enabled` even when
 * the user toggled it off, so the request matches what the channel will do anyway.
 */
function thinkRequestPayload(cap          , thinkingOn         , stored        )               {
  const on = cap.available && (cap.mustOn || thinkingOn);
  if (!on) return { thinking: "disabled" };
  const out               = { thinking: "enabled" };
  if (cap.levels.length) out.reasoning_effort = resolveThinkLevel(stored, cap);
  return out;
}

/** Button label, aria state and tooltip. Every string here is user-visible and stays Chinese. */
function thinkToggleView(table            , cap          , thinkingOn         , stored        )                  {
  const on = cap.available && (cap.mustOn || thinkingOn);
  const level = resolveThinkLevel(stored, cap);
  const text = !cap.available
    ? "思考不可用"
    : (on ? (cap.levels.length ? "思考:" + thinkLevelLabel(table, level) : "思考开") : "思考关");
  const tail = cap.mustOn
    ? (cap.levels.length ? "；该模型固定开启思考，点击可改强度" : "；该模型固定开启思考")
    : ("；点击可改开关" + (cap.levels.length ? "/强度" : ""));
  const title = !cap.available
    ? "所选模型不支持思考（可在 设置 → 模型 API 的渠道里改「思考形态」）"
    : (on
      ? "思考模式：开启" + (cap.levels.length ? "（强度：" + thinkLevelLabel(table, level) + "）" : "") + "。更准，但更慢、费用较高、输出含思考过程" + tail
      : "思考模式：关闭（快、便宜）。点击选择开关" + (cap.levels.length ? "与强度" : ""));
  return { text, pressed: on, disabled: !cap.available, opacity: cap.available ? "1" : ".45", title };
}

/**
 * Popup rows in render order: the off row (only when the channel allows it), then one row per
 * strength, or a single on row. `active` marks the current choice.
 */
function thinkMenuOptions(table            , cap          , thinkingOn         , stored        )                    {
  const rows                    = [];
  if (cap.offAllowed) rows.push({ v: "__off__", label: "关闭", active: false });
  if (cap.levels.length) {
    for (const level of cap.levels) rows.push({ v: level.v, label: "开启（" + level.label + "）", active: false });
  } else {
    rows.push({ v: "__on__", label: "开启", active: false });
  }
  const onNow = thinkingOn || cap.mustOn;
  const current = resolveThinkLevel(stored, cap);
  return rows.map((row) => {
    const active = (row.v === "__off__" && !onNow)
      || (row.v === "__on__" && onNow && !cap.levels.length)
      || (row.v !== "__off__" && row.v !== "__on__" && onNow && current === row.v);
    return { v: row.v, label: row.label, active };
  });
}

/**
 * Fixed-position menu placement above the toggle, flipped below when it would clip the top edge and
 * clamped 8px inside the viewport. Missing measurements fall back to the menu's own baseline size.
 */
function thinkMenuPosition(
  anchor               ,
  size                                   ,
  viewportWidth        ,
)                                {
  const height = size.height || 170;
  const width = size.width || 140;
  let top = anchor.top - height - 6;
  if (top < 8) top = anchor.bottom + 6;
  const left = Math.max(8, Math.min(anchor.left, viewportWidth - width - 8));
  return { top, left };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/think-control.ts; this file owns the
// toggle button, the popup menu and every localStorage / provider read.
//
// The DOM contract is narrow on purpose: `#thinkToggle`, an optional `.think-label` inside it, and a
// fixed-position menu appended to <body>. app.js creates the instance once at load and forwards
// thinkRequestPayload / updateThinkToggleUI, so create() must work even when the toggle is absent
// (sandboxed hosts and tests build the instance without one).
//
// Active-channel detection stays here because it reads two optional globals (`__byoProvider`,
// `__providers`) whose shapes differ; the engine receives a plain {supports, style, model, allowed}.
(function (global) {
  "use strict";
  if (global.__thinkControl) return;

  var THEME_KEY = "my-theme";

  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, v) {
    try { global.localStorage.setItem(key, String(v)); } catch (e) {}
  }

  /** Active channel as capability input, or null when neither registry answers. */
  function readChannel(host) {
    try {
      var byo = global.__byoProvider && global.__byoProvider.get ? global.__byoProvider.get() : null;
      if (byo) {
        return {
          supports: byo.supportsThinking,
          style: thinkStyleOf(byo.thinkingStyle),
          model: byo.model,
          allowed: byo.effortValues,
        };
      }
      var P = global.__providers;
      if (P && P.read) {
        var key = P.effectiveKey ? P.effectiveKey(host.getMode()) : null;
        var parsed = key && P.parseKey ? P.parseKey(key) : null;
        if (parsed && parsed.kind === "preset") {
          var meta = (P.presetMeta ? P.presetMeta(parsed.id) : null) || {};
          return {
            supports: meta.supportsThinking !== false,
            style: thinkStyleFromMeta(meta.thinkingStyle, parsed.id),
            model: host.getModel(),
            allowed: meta.effortValues,
          };
        }
      }
    } catch (e) {}
    return null;
  }

  global.__thinkControl = {
    create(host) {
      var h = host || {};
      var table = thinkTableFrom(global.__modelThink || null);
      var doc = global.document;
      var toggleEl = doc ? doc.getElementById("thinkToggle") : null;
      var menuEl = null;

      function getThinkLevel() {
        return thinkLevelOrDefault(lsGet(THINK_LEVEL_KEY), table);
      }

      function capsNow() {
        var channel = readChannel(h);
        if (!channel) return buildThinkCap(table, true, "deepseek", h.getModel(), null);
        return buildThinkCap(table, channel.supports, channel.style, channel.model, channel.allowed);
      }

      function updateThinkToggleUI() {
        if (!toggleEl) return;
        var view = thinkToggleView(table, capsNow(), !!h.isThinkingOn(), getThinkLevel());
        var label = toggleEl.querySelector ? toggleEl.querySelector(".think-label") : null;
        if (label) label.textContent = view.text;
        else toggleEl.textContent = view.text;
        toggleEl.setAttribute("aria-pressed", view.pressed ? "true" : "false");
        if (toggleEl.classList && toggleEl.classList.toggle) toggleEl.classList.toggle("active", view.pressed);
        toggleEl.disabled = view.disabled;
        toggleEl.style.opacity = view.opacity;
        toggleEl.title = view.title;
      }

      function closeThinkMenu() {
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
        doc.removeEventListener("click", onDocClick);
      }

      function onDocClick(e) {
        var insideToggle = toggleEl && toggleEl.contains && toggleEl.contains(e.target);
        if (menuEl && !menuEl.contains(e.target) && e.target !== toggleEl && !insideToggle) closeThinkMenu();
      }

      function openThinkMenu() {
        closeThinkMenu();
        if (!toggleEl) return;
        var cap = capsNow();
        if (!cap.available) return; // Disabled button: offering dead levels would only confuse.
        var isLight = (global.__theme && typeof global.__theme.is === "function")
          ? global.__theme.is("light")
          : (lsGet(THEME_KEY) === "light");
        var menu = doc.createElement("div");
        menu.id = "thinkLevelMenu";
        menu.style.cssText = "position:fixed;z-index:9999;min-width:140px;border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.35);";
        menu.style.background = isLight ? "#ffffff" : "#1c1c22";
        menu.style.border = "1px solid " + (isLight ? "#ddd" : "#3a3a44");
        menu.style.color = isLight ? "#222" : "#eee";

        var options = thinkMenuOptions(table, cap, !!h.isThinkingOn(), getThinkLevel());
        options.forEach(function (opt) {
          var it = doc.createElement("div");
          it.style.cssText = "padding:7px 10px;border-radius:7px;cursor:pointer;font-size:13px;white-space:nowrap;"
            + (opt.active ? ("background:" + (isLight ? "#eaeaea" : "#33333d") + ";font-weight:600;") : "");
          it.textContent = opt.label;
          it.addEventListener("mouseenter", function () { it.style.background = isLight ? "#f0f0f0" : "#2a2a32"; });
          it.addEventListener("mouseleave", function () {
            it.style.background = opt.active ? (isLight ? "#eaeaea" : "#33333d") : "transparent";
          });
          it.addEventListener("click", function (e) {
            e.stopPropagation();
            if (opt.v === "__off__") {
              if (!cap.offAllowed) return;
              h.setThinkingOn(false);
              lsSet(h.lsThinkingKey, "0");
            } else if (opt.v === "__on__") {
              h.setThinkingOn(true);
              lsSet(h.lsThinkingKey, "1");
            } else {
              h.setThinkingOn(true);
              lsSet(h.lsThinkingKey, "1");
              lsSet(THINK_LEVEL_KEY, opt.v);
            }
            updateThinkToggleUI();
            closeThinkMenu();
          });
          menu.appendChild(it);
        });

        doc.body.appendChild(menu);
        var pos = thinkMenuPosition(
          toggleEl.getBoundingClientRect(),
          { height: menu.offsetHeight, width: menu.offsetWidth },
          global.innerWidth || 0,
        );
        menu.style.top = pos.top + "px";
        menu.style.left = pos.left + "px";
        menuEl = menu;
        // The click that opened the menu is still propagating: defer the outside-click listener.
        global.setTimeout(function () { doc.addEventListener("click", onDocClick); }, 0);
      }

      function bind() {
        if (!toggleEl) return;
        toggleEl.addEventListener("click", function (e) {
          e.stopPropagation();
          if (menuEl) { closeThinkMenu(); return; }
          openThinkMenu();
        });
      }

      return {
        getThinkLevel: getThinkLevel,
        thinkLevelLabel: function (v) { return thinkLevelLabel(table, v); },
        thinkLevelsFor: function (model, style, allowed) { return thinkLevelsFor(table, model, style, allowed); },
        buildThinkCap: function (supports, style, model, allowed) {
          return buildThinkCap(table, supports, style, model, allowed);
        },
        resolveThinkLevel: function (cap) { return resolveThinkLevel(getThinkLevel(), cap); },
        getActiveThinkCaps: capsNow,
        thinkRequestPayload: function () {
          return thinkRequestPayload(capsNow(), !!h.isThinkingOn(), getThinkLevel());
        },
        updateThinkToggleUI: updateThinkToggleUI,
        openThinkMenu: openThinkMenu,
        closeThinkMenu: closeThinkMenu,
        bind: bind,
        _thinkToggle: toggleEl,
      };
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

globalThis.THINK_LEVEL_KEY = THINK_LEVEL_KEY;
globalThis.THINK_DEFAULT_LEVEL = THINK_DEFAULT_LEVEL;
globalThis.thinkTableFrom = thinkTableFrom;
globalThis.thinkLevelsFor = thinkLevelsFor;
globalThis.thinkLevelLabel = thinkLevelLabel;
globalThis.buildThinkCap = buildThinkCap;
globalThis.resolveThinkLevel = resolveThinkLevel;
globalThis.thinkLevelOrDefault = thinkLevelOrDefault;
globalThis.thinkStyleFromMeta = thinkStyleFromMeta;
globalThis.thinkStyleOf = thinkStyleOf;
globalThis.thinkRequestPayload = thinkRequestPayload;
globalThis.thinkToggleView = thinkToggleView;
globalThis.thinkMenuOptions = thinkMenuOptions;
globalThis.thinkMenuPosition = thinkMenuPosition;
})();
