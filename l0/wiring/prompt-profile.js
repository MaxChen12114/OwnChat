// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract names
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
      var c = window.__character && window.__character.getActiveCard && window.__character.getActiveCard();
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
