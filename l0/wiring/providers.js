// Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name.
// The implementation lives in services/model-router/providers.ts; this file owns three things:/n//   1) the four window ports (storage / auth / notify / onStorage), each with the same try/catch
//      shape as the old inline code;
//   2) the member list, verbatim: twenty-eight members plus `keys`, in the original order;
//   3) the four startup side effects from the old IIFE tail (the storage listener, mergePublic,
//      the legacy reconcile, and two setTimeouts).
(function () {
  if (window.__providers) return;
  var ports = {
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    auth: function () { return window.__auth || null; },
    notify: function (detail) {
      try { window.dispatchEvent(new CustomEvent("cfw:providers-changed", { detail: detail })); } catch (e) {}
    },
    // Deprecated-alias notice: the service owns the "once per model" decision and the pure text;
    // only the console sink lives here, so services/** stays free of globals.
    notifyDeprecated: function (message) {
      try { console.warn(message); } catch (e) {}
    },
    onStorage: function (cb) {
      try { window.addEventListener("storage", cb); } catch (e) {}
    },
  };
  var reg = createProvidersRegistry(ports);
  window.__providers = {
    // State
    read: reg.read, save: reg.save, mergePublic: reg.mergePublic, republish: reg.republish,
    // Metadata
    refreshPresets: reg.refreshPresets, presetMeta: reg.presetMeta, channels: reg.channels,
    // Active selection
    effectiveKey: reg.effectiveKey, activePresetId: reg.activePresetId, modeForActive: reg.modeForActive,
    parseKey: reg.parseKey,
    byoSnapshot: reg.byoSnapshot, setActive: reg.setActive,
    // Model list
    modelsAll: reg.modelsAll, enabledModels: reg.enabledModels, toggleModel: reg.toggleModel, setAllModels: reg.setAllModels,
    setChannelModels: reg.setChannelModels, selectedModel: reg.selectedModel, setSelectedModel: reg.setSelectedModel,
    fetchModels: reg.fetchModels, modelsStale: reg.modelsStale,
    // Custom preset CRUD
    newCustom: reg.newCustom, saveCustom: reg.saveCustom, deleteCustom: reg.deleteCustom,
    // Events
    on: reg.on,
    keys: reg.keys,
  };

  // Startup side effects, one for one from the old IIFE tail.
  // Cross-tab storage sync: a change to the public copy goes through mergePublic, while a direct
  // write to a local key only emits the external event.
  ports.onStorage(function (e) { reg.handleStorageEvent(e); });
  // On startup: merge the cloud public copy, reconcile the legacy pool, pull the server registry
  // once, and silently refresh stale lists. Any of these failing must not block boot.
  try { reg.mergePublic(); } catch (e) {}
  try { reg.reconcileLegacyOnce(); } catch (e) {}
  setTimeout(function () { reg.refreshPresets(); }, 0);
  // Deferred by 1.2s: let the first paint finish instead of racing the chat list for bandwidth.
  setTimeout(function () { try { reg.refreshStalePresetsOnce(); } catch (e) {} }, 1200);
})();
