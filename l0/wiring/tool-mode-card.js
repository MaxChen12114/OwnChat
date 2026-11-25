// Browser wiring for services/ui/tool-mode-card.ts: localStorage side plus the non-`__` global
// the settings card calls. Kept off the frozen `window.__*` surface on purpose. The row DOM is
// injected into the existing Agent card (mountAgentToolsCard calls attach(card)); the row always
// shows the EFFECTIVE mode — the runtime's full-on-missing-deps gate is mirrored here so the
// switch never advertises a mode that is not actually in effect.
(function () {
  var api = createToolModeCard({
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
  });
  window.settingsToolMode = api;

  // Row style mirrors the card's own rowline selects (settings.js mountAgentToolsCard).
  var SEL_STYLE = "flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;";

  function runtimePresent() {
    try { return !!(window.__toolMode && window.__toolMode.v === 1); } catch (e) { return false; }
  }

  function render(sel, note) {
    var m = api.row(runtimePresent());
    var html = "";
    for (var i = 0; i < m.options.length; i++) {
      var o = m.options[i];
      html += '<option value="' + o.value + '"' + (o.disabled ? " disabled" : "") + (o.selected ? " selected" : "") + ">" + o.label + "</option>";
    }
    sel.innerHTML = html;
    note.textContent = m.note;
  }

  /** Inject the mode row into the Agent card. Idempotent: the row id is the guard. */
  api.attach = function (card) {
    if (!card || document.getElementById("agentToolModeRow")) return;
    var row = document.createElement("div");
    row.className = "rowline";
    row.id = "agentToolModeRow";
    row.style.cssText = "align-items:center;gap:10px;margin-top:12px;";
    row.innerHTML = '<label style="font-size:12px;color:var(--muted);min-width:42px;">目录</label>'
      + '<select id="agentToolModeSel" style="' + SEL_STYLE + '"></select>';
    var note = document.createElement("div");
    note.style.cssText = "font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;";
    // Before the card's tip block when present (the tip closes the card), else appended.
    var tip = card.querySelector(".settings-tip");
    if (tip && tip.parentNode === card) {
      card.insertBefore(row, tip);
      card.insertBefore(note, tip);
    } else {
      card.appendChild(row);
      card.appendChild(note);
    }
    var sel = row.querySelector("#agentToolModeSel");
    if (!sel) return;
    render(sel, note);
    sel.addEventListener("change", function () {
      api.write(sel.value);
      render(sel, note); // the note follows the stored mode; presence is re-checked on purpose
    });
  };
})();
