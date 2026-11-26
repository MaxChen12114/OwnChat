// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/mobile-tabs.ts; this file owns the
// DOM: the two querySelectorAll passes, the click listeners, and writing the plan back. Nothing
// outside this file calls the engine, so it publishes no global — the strip's only contract is the
// DOM it already owns.
(function () {
  "use strict";
  var tabs = document.querySelectorAll(".mobile-tab-btn");
  var panels = document.querySelectorAll(".mobile-tab-panel");
  if (!tabs.length) return;

  var tabNames = [];
  var panelNames = [];
  for (var i = 0; i < tabs.length; i++) tabNames.push(tabs[i].getAttribute("data-tab"));
  for (var j = 0; j < panels.length; j++) panelNames.push(panels[j].getAttribute("data-tab"));

  function apply(btn) {
    var view = mtTabPlan(tabNames, panelNames, btn.getAttribute("data-tab"), btn.classList.contains("active"));
    for (var t = 0; t < tabs.length; t++) tabs[t].classList.toggle("active", view.tabs[tabNames[t]] === true);
    for (var p = 0; p < panels.length; p++) panels[p].classList.toggle("active", view.panels[panelNames[p]] === true);
    document.body.classList.toggle("fishbowl-shown", view.fishbowlShown);
  }

  function bind(btn) {
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      apply(btn);
    });
  }
  for (var k = 0; k < tabs.length; k++) bind(tabs[k]);
})();
