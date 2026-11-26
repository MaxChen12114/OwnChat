// Browser wiring for services/ui/settings-cat-nav.ts: reads the two gate switches, then hands the
// tab list to the pure planner. Non-`__` global on purpose (the frozen surface stays as is).
(function () {
  function gate(key) {
    try {
      return window.localStorage.getItem(key) === "1";
    } catch (e) {
      return false;
    }
  }
  function savedCat() {
    try {
      return window.localStorage.getItem("cfw_settings_cat_v1");
    } catch (e) {
      return null;
    }
  }
  window.settingsCatNav = {
    plan: function (items) {
      const list = [];
      for (let i = 0; i < items.length; i++) list.push({ cat: String(items[i].cat), devOnly: !!items[i].devOnly });
      return planCatNav({
        items: list,
        devOn: gate("cfw_dev_mode_v1"),
        isApp: !!(window.tauriSvc && (window.tauriSvc.has() || window.tauriSvc.presence().internals)),
        hasCloudTts: !!window.cloudTtsSvc,
        saved: savedCat(),
      });
    },
    save: function (cat) {
      try {
        window.localStorage.setItem("cfw_settings_cat_v1", cat);
      } catch (e) {}
    },
  };
})();
