(function () {
/**
 * Tool send mode card row: the settings switch for `cfw_tool_mode_v1` (B2 C-4). Lives as a row
 * inside the existing Agent card (mountAgentToolsCard) rather than a card of its own — it governs
 * how the SAME tool set is sent, not a new capability.
 *
 * The rule here is the honest-display rule: the stored value is what the user chose, but the row
 * always shows the EFFECTIVE mode. The runtime (services/policy/tool-mode.ts) degrades `directory`
 * to `full` when its dependency set is missing, so a row that kept showing "目录" after the policy
 * products failed to load would lie about what is being sent. `directory` is also unselectable
 * until the runtime is present — the switch the design doc asks for ("directory 仅在 tool_search
 * 就位时可选").
 *
 * Only the mode gate, the option table and the row model live here; the DOM and localStorage stay
 * in the wiring, which reads and writes through the ports. The same key is read independently by
 * the request path (app.js getToolsConfig → toolModeRaw) — the source-anchor lock keeps both sides
 * on one key.
 * @module services/ui/tool-mode-card
 */

/** Storage key shared with the request path (app.js getToolsConfig) and the policy runtime. */
const LS_TOOL_MODE = "cfw_tool_mode_v1";

/** The two modes v1 exposes. `adaptive` is compiled but stays behind the switch (B2 design §6). */
                                                

/** Storage port; the wiring wraps localStorage so quota errors stay outside this module. */
                                    
                                      
                                            
 

/** One select option as the wiring renders it. */
                                 
                               
                         
                             
                             
 

/** The row model: selected value (effective), the note line, and the option list in order. */
                                   
                               
                        
                                              
 

/**
 * The read side. Only the exact string "directory" means directory — blank, garbage and wrong
 * types all read as full, which is the runtime's own gate (readToolMode in tool-mode.ts) and the
 * default IS the old behaviour, so the flag doubles as the rollback.
 */
function parseToolMode(raw               )               {
  return raw === "directory" ? "directory" : "full";
}

/**
 * Build the row model. `toolModePresent` means the policy runtime answered (window.toolModeSvc
 * with v === 1, checked by the wiring at render time).
 * @param ports - storage access for the stored choice.
 * @param toolModePresent - whether the tool_search runtime is live this boot.
 */
function buildToolModeRow(ports                   , toolModePresent         )                   {
  const stored = parseToolMode(ports.getItem(LS_TOOL_MODE));
  const value               = toolModePresent ? stored : "full";
  const note = stored === "directory" && !toolModePresent
    ? "目录模式需要工具目录运行时就位（本次启动未加载，刷新页面后再试）；当前仍按全量发送。"
    : value === "directory"
      ? "只发常驻工具和 tool_search；模型需要某个工具的完整定义时自己调 tool_search 取。省 token，但模型要多走一步。"
      : "每轮把全部工具定义发给模型。最稳，模型直接看到每个工具的参数。";
  return {
    value: value,
    note: note,
    options: [
      { value: "full", label: "全量（每轮发全部工具定义）", disabled: false, selected: value === "full" },
      { value: "directory", label: "目录（只发常驻 + tool_search 按需取）", disabled: !toolModePresent, selected: value === "directory" },
    ],
  };
}

/** Public surface; the wiring assigns it to a non-`__` global (no frozen-contract growth). */
                                  
                       
                                                                                               
                                                                                         
                                     
                                                                       
                                                  
 

/**
 * Create the API. A failed storage write is swallowed by the wiring, so this layer may assume the
 * port reports success.
 * @param ports - storage access from the wiring.
 */
function createToolModeCard(ports                   )                  {
  function read()               {
    return parseToolMode(ports.getItem(LS_TOOL_MODE));
  }
  function write(value        )               {
    if (value === "full" || value === "directory") ports.setItem(LS_TOOL_MODE, value);
    return read();
  }
  function row(toolModePresent         )                   {
    return buildToolModeRow(ports, toolModePresent);
  }
  return { read: read, write: write, row: row };
}

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
    try { return !!(window.toolModeSvc && window.toolModeSvc.v === 1); } catch (e) { return false; }
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

globalThis.LS_TOOL_MODE = LS_TOOL_MODE;
globalThis.parseToolMode = parseToolMode;
globalThis.buildToolModeRow = buildToolModeRow;
globalThis.createToolModeCard = createToolModeCard;
})();
