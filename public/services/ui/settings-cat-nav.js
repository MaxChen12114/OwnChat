(function () {
/**
 * Settings category navigation: which tabs are visible and which one opens.
 *
 * Two gates hide tabs (developer mode, and the voice tab which only exists inside a shell) and a
 * remembered category may point at a tab that is hidden on this device — in that case the first
 * visible tab wins, and `account` is the last resort. Keeping the decision here means the DOM
 * wiring only applies a plan, so a hidden saved tab can no longer leave the panel on an empty
 * category.
 * @module services/ui/settings-cat-nav
 */

/** One tab as the DOM reports it: its category id and whether it is developer-only. */
                          
                       
                            
 

/** Everything the plan depends on. */
                              
                                     
                                                   
                          
                                                                                         
                          
                                                                                                    
                                
                                                         
                                
 

/** The plan: hidden tabs and the tab to activate. */
                             
                                     
                          
 

/** Category used when nothing else is visible (the panel always has an account tab). */
const FALLBACK_CATEGORY = "account";

/**
 * Decide visibility and the active tab.
 * @param input - items plus the two gates and the remembered category.
 * @returns Hidden category ids and the active one; an empty item list still yields the fallback.
 */
function planCatNav(input             )             {
  const hidden           = [];
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (item.devOnly && !input.devOn) hidden.push(item.cat);
    // The voice tab used to be shell-only because local GPT-SoVITS needs native audio. Cloud speech
    // (2026-11-25) runs through the Worker and works in the browser, so the tab is visible whenever
    // either engine is available — otherwise the only speech setting in a web guest session would
    // be buried in the model-API category.
    else if (item.cat === "voice" && !input.isApp && !input.hasCloudTts) hidden.push(item.cat);
  }
  const visible = (cat        )          => hidden.indexOf(cat) < 0;
  // 旧实现用 `items.find(cat === saved && 可见)`：保存的分类必须**当前存在于列表里**才算数，
  // 否则回落首个可见页（例如换了版本后某分类被移除）。只判 visible 会让空表也接受任意 saved。
  const exists = (cat        )          => {
    for (let i = 0; i < input.items.length; i++) if (input.items[i].cat === cat) return true;
    return false;
  };
  if (input.saved !== null && input.saved !== "" && exists(input.saved) && visible(input.saved)) {
    return { hidden: hidden, active: input.saved };
  }
  for (let i = 0; i < input.items.length; i++) {
    if (visible(input.items[i].cat)) return { hidden: hidden, active: input.items[i].cat };
  }
  return { hidden: hidden, active: FALLBACK_CATEGORY };
}

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

globalThis.FALLBACK_CATEGORY = FALLBACK_CATEGORY;
globalThis.planCatNav = planCatNav;
})();
