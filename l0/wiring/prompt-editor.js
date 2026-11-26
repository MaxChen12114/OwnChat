// Browser adapter, appended by l0/emit.mjs. Engine: services/ui/prompt-editor.ts; this file owns the
// editor's DOM: the modal shell, the three tab panes, the inline editors, file inputs and drag-and-drop.
// Every decision lives in the engine — row order, library merge, JSON validation, card mapping, PNG
// chunks, the import report. Preset localStorage lives in services/data/presets.ts instead: this
// adapter reads/writes through window.presetStore (the library version key is still local here).
//
// Interface with the rest of the app (frozen globals, all best-effort):
//   window.characterSvc  getAllCards() / saveCard(card) / deleteCard(id) / setActiveId(id)
//   window.lorebookSvc    getAll() / getEntry(id) / saveEntry(e) / deleteEntry(id) /
//                        exportAll() / importAll(rows, {merge}) / parseSillyTavernBook(data, name)
//   window.syncSvc       markDirty() / pushNow()   driven by presets.js on every preset save
//   window.saveFileSvc   isTauri() / saveTextFile(json, name)   Android shell cannot use <a download>
// Opened from the left sidebar 🛠 button (#promptEditorBtn); the entry point is the frozen
// window.__promptEditor facade at the bottom.
(function () {
  "use strict";

  if (window.__promptEditor) return;

  const MASK_ID = "promptEditorMask";
  // Preset storage is owned by services/data/presets.ts; this adapter reaches it through
  // window.presetStore (mounted before this script). The library version key stays here.
  const LIB_VERSION_KEY = "cfw_prompt_lib_v1";

  // 4.59 linear icons: the editor title and every tab use the site-wide currentColor SVG set
  // (replacing emoji, dropping the v0 skeleton corner badge).
  function ueSvg(d, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;flex:none;">' +
      d + "</svg>"
    );
  }

  const UE_ICON = {
    wrench: ueSvg('<path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="17" r="2"/>', 17),
    preset: ueSvg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>'),
    character: ueSvg('<circle cx="12" cy="8.5" r="3.3"/><path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/>'),
    world: ueSvg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>'),
  };

  // 4.60 de-emoji: toolbar buttons, section titles and placeholders all use linear currentColor SVG.
  const UE_A = {
    plus: ueSvg('<path d="M12 5v14M5 12h14"/>', 15),
    reload: ueSvg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>', 15),
    code: ueSvg('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>', 15),
    folder: ueSvg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 15),
    imp: ueSvg('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 15),
    exp: ueSvg('<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', 15),
    pencil: ueSvg('<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>', 14),
    close: ueSvg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
    grip: ueSvg('<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>', 14),
    chevron: ueSvg('<path d="M9 6l6 6-6 6"/>', 14),
    file: ueSvg('<path d="M7 3.5h7L18.5 8v12.5H7z"/><path d="M14 3.5V8h4.5"/>', 14),
  };

  const TABS = [
    {
      id: "preset",
      icon: UE_ICON.preset,
      label: "指令模块",
      desc: "编辑每轮注入 system 的附加指令（解限底座之后的语调/任务约束层）。带仓库文件名的条目来自 src/prompts/presets/（库），你可以改名、改内容、停用或新建；点「从库重载」把库里新增的条目拉进来（同名会被库原文覆盖）。",
    },
    {
      id: "character",
      icon: UE_ICON.character,
      label: "角色",
      desc: "编辑角色卡的完整字段（身份/背景、场景、性格、说话方式、行为铁则、示例对话），支持导入 SillyTavern V2 卡与 PNG 卡。与左栏「角色卡」是同一份数据（都存本机 IndexedDB）：左栏负责快速切换，这里负责集中管理与导入导出。",
    },
    {
      id: "world",
      icon: UE_ICON.world,
      label: "设定集",
      // The pane keeps its own inline description; duplicating it here would drift.
      desc: "",
    },
  ];

  let currentTab = "preset";
  let mask = null;

  // The normalization (pePresetsFrom's rule) now lives in the shared store, so both writers read
  // the same shape. presets.js is a boot prerequisite; the guards keep a missing facade harmless.
  function loadPresets() {
    try {
      return window.presetStore ? window.presetStore.load() : [];
    } catch (e) {
      return [];
    }
  }

  function presetUid() {
    try {
      return window.presetStore ? window.presetStore.uid() : "";
    } catch (e) {
      return "";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function findTab(id) {
    for (const t of TABS) if (t.id === id) return t;
    return null;
  }

  /* ── Modal shell ─────────────────────────────────────────────────────────────────────────── */

  function buildDom() {
    if (document.getElementById(MASK_ID)) return;
    mask = document.createElement("div");
    mask.id = MASK_ID;
    mask.innerHTML = [
      '<div id="promptEditor" role="dialog" aria-label="提示词编辑器" aria-modal="true">',
      '<div class="ue-header">',
      '<div class="ue-title">' + UE_ICON.wrench + " 提示词编辑器</div>",
      '<button class="ue-close" id="ueCloseBtn" aria-label="关闭" title="关闭(ESC)">' + UE_A.close + "</button>",
      "</div>",
      '<div class="ue-tabs" id="ueTabs" role="tablist">',
      TABS.map((t) =>
        '<button class="ue-tab" role="tab" data-tab="' + t.id + '" title="' + escapeAttr(t.label) +
        '"><span class="ue-tab-icon">' + t.icon + '</span><span class="ue-tab-label">' + escapeHtml(t.label) + "</span></button>"
      ).join(""),
      "</div>",
      '<div class="ue-body" id="ueBody" role="tabpanel"></div>',
      '<div class="ue-footer">',
      '<span class="ue-footer-hint">这里改的是本机数据（与左栏面板共用同一份），不会触发聊天。Esc 退出。</span>',
      '<button class="ue-btn-ghost" id="ueFooterClose">关闭</button>',
      "</div>",
      "</div>",
    ].join("");
    document.body.appendChild(mask);

    // Clicking the backdrop closes; clicks inside the dialog do not reach here.
    mask.addEventListener("click", (e) => {
      if (e.target === mask) close();
    });
    document.getElementById("ueCloseBtn").addEventListener("click", close);
    document.getElementById("ueFooterClose").addEventListener("click", close);
    document.getElementById("ueTabs").addEventListener("click", (e) => {
      const btn = e.target.closest && e.target.closest(".ue-tab");
      if (!btn) return;
      switchTab(btn.getAttribute("data-tab"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mask && mask.classList.contains("open")) close();
    });
  }

  function renderBody() {
    if (currentTab === "preset") return renderPresetTab();
    if (currentTab === "character") return renderCharacterTab();
    if (currentTab === "world") return renderWorldTab();
  }

  function refreshTabs() {
    document.querySelectorAll("#ueTabs .ue-tab").forEach((b) => {
      const on = b.getAttribute("data-tab") === currentTab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function open(tabId) {
    buildDom();
    if (tabId && findTab(tabId)) currentTab = tabId;
    refreshTabs();
    renderBody();
    mask.classList.add("open");
    document.body.classList.add("ue-open");
  }

  function close() {
    if (!mask) return;
    mask.classList.remove("open");
    document.body.classList.remove("ue-open");
  }

  function switchTab(tabId) {
    if (!findTab(tabId)) return;
    currentTab = tabId;
    refreshTabs();
    renderBody();
  }

  function bindEntry() {
    const btn = document.getElementById("promptEditorBtn");
    if (btn && !btn.__ueBound) {
      btn.__ueBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        open();
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindEntry);
  else bindEntry();

  // Card added/edited from the sidebar while the 角色 tab is open and idle: keep the list in step.
  window.addEventListener("character:changed", () => {
    if (!(mask && mask.classList.contains("open") && currentTab === "character")) return;
    const slot = document.getElementById("ueCharEditor");
    if (slot && slot.children.length) return;
    renderCharacterTab();
  });

  // Same for the world book, on the 设定集 tab.
  window.addEventListener("lorebook:changed", () => {
    if (!(mask && mask.classList.contains("open") && currentTab === "world")) return;
    const slot = document.getElementById("ueWorldEditor");
    if (slot && slot.children.length) return;
    renderWorldTab();
  });

  /* ── Storage + sync nudge ───────────────────────────────────────────────────────────────── */
  // Both live in services/data/presets.ts now: save writes the key AND calls onSave, which the
  // presets wiring implements as markDirty + 1.2s pushNow. The editor and the agent tool therefore
  // can no longer drift (the old tool-side save had no sync nudge at all).

  function savePresets(arr) {
    try {
      if (window.presetStore) window.presetStore.save(arr);
    } catch (e) {}
  }

  /* ── Export helpers ─────────────────────────────────────────────────────────────────────── */

  function showExportBox(filename, json, msg) {
    const slot = document.getElementById("uePresetEditor") || document.getElementById("ueCharEditor") || document.getElementById("ueWorldEditor");
    if (!slot) {
      try {
        prompt("复制 JSON：", json);
      } catch (e) {
        alert("导出失败：当前环境不允许下载或显示复制框");
      }
      return;
    }
    slot.innerHTML = [
      '<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + escapeHtml(msg || "JSON 已生成") + "</div>",
      '<p class="ue-panel-desc">如果浏览器/手机 App 没有弹出保存窗口，请复制下面内容，手动保存为 <b>' + escapeHtml(filename) + "</b>。</p>",
      '<textarea class="ue-textarea ue-mono" id="ueExportJsonText" rows="14">' + escapeHtml(json) + "</textarea>",
      '<div class="ue-editor-foot">',
      '<button class="ue-btn ue-btn-primary" id="ueExportCopy">复制 JSON</button>',
      '<button class="ue-btn" id="ueExportRetry">重新下载</button>',
      '<button class="ue-btn" id="ueExportClose">关闭</button>',
      "</div>",
      "</div>",
    ].join("");
    try {
      slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {}
    const ta = document.getElementById("ueExportJsonText");
    const copyBtn = document.getElementById("ueExportCopy");
    const retryBtn = document.getElementById("ueExportRetry");
    const closeBtn = document.getElementById("ueExportClose");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const text = ta ? ta.value : json;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => alert("已复制 JSON"),
            () => {
              if (ta) {
                ta.focus();
                ta.select();
              }
            }
          );
        } else if (ta) {
          ta.focus();
          ta.select();
        }
      });
    }
    if (retryBtn) retryBtn.addEventListener("click", () => downloadJson(filename, json, msg, true));
    if (closeBtn) closeBtn.addEventListener("click", () => {
      slot.innerHTML = "";
    });
  }

  function downloadJson(filename, json, copiedMsg, silent) {
    const msg = copiedMsg || "JSON 已导出";
    // The Tauri shell writes through its own native call: Android WebView ignores <a download>, so the
    // old button did nothing there. save-file.js is the single exit; the copyable box still shows up so
    // the write path (or the cancel reason) stays visible.
    if (window.saveFileSvc && window.saveFileSvc.isTauri()) {
      window.saveFileSvc.saveTextFile(json, filename).then((r) => {
        if (silent) return;
        if (r.ok) showExportBox(filename, json, msg + "；已写盘 " + (r.path || ""));
        else showExportBox(filename, json, msg + "；" + (r.error || "未写盘"));
      });
      return;
    }
    let ok = false;
    try {
      const file = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      a.target = "_blank";
      a.style.position = "fixed";
      a.style.left = "-9999px";
      a.style.top = "-9999px";
      document.body.appendChild(a);
      // Must stay inside the click's synchronous stack; do not wait on a clipboard promise here.
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      ok = true;
      setTimeout(() => {
        try {
          if (a && a.parentNode) a.parentNode.removeChild(a);
        } catch (e) {}
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      }, 4000);
    } catch (e) {
      ok = false;
    }
    // A blocked download usually throws nothing, so the copyable box always appears: "button does
    // nothing" on desktop and "no file dialog" on Android both end with a visible result.
    if (!silent) {
      showExportBox(filename, json, msg + (ok ? "；已尝试下载文件" : "；当前环境未允许直接下载"));
      try {
        const ta = document.getElementById("ueExportJsonText");
        if (ta) {
          ta.focus();
          ta.select();
        }
      } catch (e) {}
    }
  }

  /* ── Library ────────────────────────────────────────────────────────────────────────────── */

  // The library is no longer a static file under public/presets/: that was GET-able by anyone and the
  // locked visitor still got seeded with it. It is POST /api/presets now — a locked session gets 403
  // and not one character back. The text itself is generated by scripts/gen-prompts.mjs.
  let libraryVersion = "";

  async function fetchLibrary() {
    try {
      var tok = '';
      try { tok = localStorage.getItem('cfw_unlock_token_v1') || ''; } catch (e) {}
      if (!tok) return null; // locked: no request at all (the server would answer 403 anyway)
      const resp = await fetch("/api/presets", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unlockToken: tok }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const arr = data && Array.isArray(data.presets) ? data.presets : null;
      if (!arr || !arr.length) return null;
      if (data.version && data.version.presets) libraryVersion = data.version.presets;
      return arr;
    } catch (e) {
      return null;
    }
  }

  function syncLibraryIfNeeded(silent) {
    return fetchLibrary().then((pack) => {
      if (!pack) return null; // locked or offline: nothing to do, and not an error
      const result = peMergeLibrary(loadPresets(), pack);
      const changed = result.purged || result.added || result.orphanPurged || result.metaRefreshed;
      if (changed) {
        savePresets(result.list);
        try {
          if (libraryVersion) localStorage.setItem(LIB_VERSION_KEY, libraryVersion);
        } catch (e) {}
      } else {
        try {
          if (libraryVersion && localStorage.getItem(LIB_VERSION_KEY) !== libraryVersion) {
            localStorage.setItem(LIB_VERSION_KEY, libraryVersion);
          }
        } catch (e) {}
      }
      if (!silent) {
        try {
          const line = peMergeLog(result);
          if (line) console.log(line);
        } catch (e) {}
      }
      return result;
    });
  }

  // Align once on open. Reaching this point means unlocked: the entry button itself is data-nsfw.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => syncLibraryIfNeeded(true));
  else syncLibraryIfNeeded(true);

  /* ── Preset pane ────────────────────────────────────────────────────────────────────────── */

  const collapsedGroups = {};
  let dragId = null;

  function presetRowHtml(p) {
    const preview = pePresetPreview(p.content);
    const fileTag = p.file
      ? '<span class="ue-preset-file" title="仓库文件：src/prompts/presets/' + escapeAttr(p.file) + '">' + escapeHtml(p.file) + "</span>"
      : "";
    return [
      '<div class="ue-preset-row ue-has-drag' + (p.enabled ? " enabled" : "") + '" data-id="' + escapeAttr(p.id) + '" draggable="true">',
      '<span class="ue-preset-drag" title="拖拽排序 —— 决定注入顺序（越靠上越先注入）" draggable="false">' + UE_A.grip + "</span>",
      '<label class="ue-preset-tog" title="' + (p.enabled ? "已启用 · 点击禁用" : "已禁用 · 点击启用") + '">',
      '<input type="checkbox" class="ue-preset-chk"' + (p.enabled ? " checked" : "") + ">",
      "</label>",
      '<span class="ue-preset-name">' + escapeHtml(p.name || "(未命名)") + fileTag + "</span>",
      '<div class="ue-preset-preview">' + (escapeHtml(preview.text) || "<em>（空内容）</em>") + "</div>",
      '<div class="ue-preset-ops">',
      '<button class="ue-mini ue-preset-edit" title="编辑">' + UE_A.pencil + "</button>",
      '<button class="ue-mini danger ue-preset-del" title="删除">' + UE_A.close + "</button>",
      "</div>",
      "</div>",
    ].join("");
  }

  function presetListHtml(list) {
    if (!list.length) {
      return '<div class="ue-empty">还没有指令模块。点上方「新建」，或「上传」导入 JSON（兼容 SillyTavern 预设）；也可以「从库重载」把 src/prompts/presets/ 里的条目拉下来。</div>';
    }
    const buckets = peGroupBuckets(list);
    if (buckets.length === 1 && buckets[0].group === "") return buckets[0].items.map(presetRowHtml).join("");
    let html = "";
    for (const b of buckets) {
      if (b.group === "") {
        html += b.items.map(presetRowHtml).join("");
        continue;
      }
      const collapsed = !!collapsedGroups[b.group];
      html +=
        '<div class="ue-pgroup-head" data-group="' + escapeAttr(b.group) + '">' +
        '<span class="ue-pgroup-arrow' + (collapsed ? " folded" : "") + '">' + UE_A.chevron + "</span>" +
        '<span class="ue-pgroup-name">' + escapeHtml(b.group) + "</span>" +
        '<span class="ue-pgroup-count">' + b.items.length + "</span>" +
        '<button class="ue-mini danger ue-pgroup-del" data-group="' + escapeAttr(b.group) + '" title="删除整组">' + UE_A.close + "</button></div>";
      if (!collapsed) html += '<div class="ue-pgroup-body">' + b.items.map(presetRowHtml).join("") + "</div>";
    }
    return html;
  }

  function renderPresetTab() {
    const t = findTab("preset");
    const body = document.getElementById("ueBody");
    if (!body) return;
    const list = peSortByOrder(loadPresets());
    body.innerHTML = [
      '<div class="ue-panel">',
      '<div class="ue-panel-head">',
      '<span class="ue-panel-icon">' + t.icon + "</span>",
      '<span class="ue-panel-name">' + escapeHtml(t.label) + "</span>",
      "</div>",
      '<p class="ue-panel-desc">' + escapeHtml(t.desc) + "</p>",
      '<div class="ue-toolbar">',
      '<button class="ue-btn ue-btn-primary" id="uePresetNew">' + UE_A.plus + " 新建</button>",
      '<button class="ue-btn" id="uePresetReloadStarter" title="从库（src/prompts/presets）重新拉取：同名覆盖、新条目追加；你自建的条目不动">' + UE_A.reload + " 从库重载</button>",
      '<button class="ue-btn" id="uePresetJsonMode">' + UE_A.code + " JSON 源码</button>",
      '<button class="ue-btn" id="uePresetUpload" title="上传 .json（追加；兼容 SillyTavern 预设）">' + UE_A.folder + " 上传</button>",
      '<input type="file" id="uePresetFile" accept=".json,application/json" style="display:none">',
      '<button class="ue-btn" id="uePresetExport">' + UE_A.exp + " 导出</button>",
      '<span class="ue-toolbar-spacer"></span>',
      '<span class="ue-count">共 ' + list.length + " 条</span>",
      "</div>",
      '<div class="ue-preset-list" id="uePresetList">',
      presetListHtml(list),
      "</div>",
      '<div class="ue-editor-slot" id="uePresetEditor"></div>',
      "</div>",
    ].join("");

    document.getElementById("uePresetNew").addEventListener("click", () => {
      const made = pePresetCreate(loadPresets(), presetUid(), "新预设");
      savePresets(made.list);
      renderPresetTab();
      editPreset(made.created.id);
    });

    document.getElementById("uePresetReloadStarter").addEventListener("click", async () => {
      const pack = await fetchLibrary();
      if (!pack) {
        alert("从库加载失败：未解锁、未部署或网络异常。\n（库走 POST /api/presets，需要已解锁）");
        return;
      }
      const cur = loadPresets();
      const touched = peLibraryOwnedCount(cur, pack);
      if (!confirm("从库重载 " + pack.length + " 条：\n· 同名条目将被库里的原文覆盖（" + touched + " 条会受影响，你的编辑会丢）\n· 库里新增的条目追加进来（默认关）\n· 你自建的条目完全不动\n\n继续？")) return;
      const r = peReloadFromLibrary(cur, pack);
      savePresets(r.list);
      try {
        localStorage.setItem(LIB_VERSION_KEY, libraryVersion);
      } catch (e) {}
      renderPresetTab();
      alert("已从库重载：覆盖 " + r.overwritten + " 条，追加 " + r.added + " 条。");
    });

    document.getElementById("uePresetJsonMode").addEventListener("click", presetJsonEditor);
    document.getElementById("uePresetExport").addEventListener("click", () => {
      const cur = loadPresets();
      downloadJson(peExportName("presets", new Date().toISOString()), JSON.stringify(cur, null, 2), "已导出 " + cur.length + " 个 preset");
    });

    const fileEl = document.getElementById("uePresetFile");
    const upBtn = document.getElementById("uePresetUpload");
    if (upBtn) {
      upBtn.addEventListener("click", () => {
        if (fileEl) {
          fileEl.value = "";
          fileEl.click();
        }
      });
    }
    if (fileEl) {
      fileEl.addEventListener("change", () => {
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => importPresetFile(String(rd.result || ""), f.name);
        rd.readAsText(f);
      });
    }

    const listEl = document.getElementById("uePresetList");
    listEl.addEventListener("click", (e) => {
      const head = e.target.closest && e.target.closest(".ue-pgroup-head");
      if (head) {
        // The buttons hold SVG icons, so a click lands on <path>: test the closest button, not target.
        const gDel = e.target.closest && e.target.closest(".ue-pgroup-del");
        if (gDel) {
          deleteGroup(gDel.getAttribute("data-group"));
          return;
        }
        const g = head.getAttribute("data-group");
        collapsedGroups[g] = !collapsedGroups[g];
        renderPresetTab();
        return;
      }
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (!row) return;
      const pid = row.getAttribute("data-id");
      // Same icon caveat: resolve the action from the button, then dispatch.
      const act = e.target.closest && e.target.closest(".ue-preset-edit,.ue-preset-del,.ue-preset-up,.ue-preset-down");
      if (!act) return;
      if (act.classList.contains("ue-preset-edit")) editPreset(pid);
      else if (act.classList.contains("ue-preset-del")) deletePreset(pid);
      else if (act.classList.contains("ue-preset-up")) movePreset(pid, -1);
      else if (act.classList.contains("ue-preset-down")) movePreset(pid, +1);
    });
    listEl.addEventListener("dragstart", (e) => {
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (!row) return;
      dragId = row.getAttribute("data-id");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", dragId);
      } catch (x) {}
      row.classList.add("dragging");
    });
    listEl.addEventListener("dragend", (e) => {
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (row) row.classList.remove("dragging");
      listEl.querySelectorAll(".dragover").forEach((r) => r.classList.remove("dragover"));
      dragId = null;
    });
    listEl.addEventListener("dragover", (e) => {
      if (!dragId) return;
      e.preventDefault();
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      listEl.querySelectorAll(".dragover").forEach((r) => {
        if (r !== row) r.classList.remove("dragover");
      });
      if (row && row.getAttribute("data-id") !== dragId) row.classList.add("dragover");
    });
    listEl.addEventListener("drop", (e) => {
      e.preventDefault();
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (!row || !dragId) return;
      const targetId = row.getAttribute("data-id");
      if (targetId !== dragId) dropPreset(dragId, targetId);
    });
    listEl.addEventListener("change", (e) => {
      if (!e.target.classList.contains("ue-preset-chk")) return;
      const row = e.target.closest(".ue-preset-row");
      const pid = row.getAttribute("data-id");
      const next = pePresetToggle(loadPresets(), pid, !!e.target.checked);
      savePresets(next);
      const p = next.find((x) => x.id === pid);
      if (p) row.classList.toggle("enabled", p.enabled);
    });
  }

  function editPreset(pid) {
    const list = loadPresets();
    const p = list.find((x) => x.id === pid);
    if (!p) return;
    const slot = document.getElementById("uePresetEditor");
    if (!slot) return;
    slot.innerHTML = [
      '<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + UE_A.pencil + " 编辑：" + escapeHtml(p.name || "(未命名)") + "</div>",
      '<label class="ue-field"><span>名称</span><input class="ue-input" id="uePEName" value="' + escapeAttr(p.name || "") + '"></label>',
      '<label class="ue-field"><span>内容（追加到 system prompt 末层）</span><textarea class="ue-textarea" id="uePEContent" rows="10">' + escapeHtml(p.content || "") + "</textarea></label>",
      '<div class="ue-editor-foot">',
      '<button class="ue-btn ue-btn-primary" id="uePESave">保存修改</button>',
      '<button class="ue-btn" id="uePECancel">取消</button>',
      "</div>",
      "</div>",
    ].join("");
    slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.getElementById("uePESave").addEventListener("click", () => {
      const nm = (document.getElementById("uePEName").value || "").trim();
      if (!nm) {
        alert("名称不能为空");
        return;
      }
      const ct = document.getElementById("uePEContent").value || "";
      const r = pePresetEdit(loadPresets(), pid, nm, ct);
      if (!r.ok) return;
      savePresets(r.list);
      renderPresetTab();
    });
    document.getElementById("uePECancel").addEventListener("click", () => {
      slot.innerHTML = "";
    });
  }

  function deletePreset(pid) {
    const list = loadPresets();
    const p = list.find((x) => x.id === pid);
    if (!p) return;
    if (!confirm("删除 preset「" + p.name + "」？")) return;
    savePresets(pePresetRemove(list, pid));
    renderPresetTab();
  }

  function movePreset(pid, dir) {
    const next = pePresetMove(loadPresets(), pid, dir);
    if (!next) return;
    savePresets(next);
    renderPresetTab();
  }

  function dropPreset(fromId, targetId) {
    savePresets(pePresetDrop(loadPresets(), fromId, targetId));
    renderPresetTab();
  }

  function deleteGroup(group) {
    const list = loadPresets();
    const n = peGroupCount(list, group);
    if (!confirm("删除分组「" + group + "」下的全部 " + n + " 个 preset？")) return;
    savePresets(peGroupRemove(list, group));
    renderPresetTab();
  }

  function presetJsonEditor() {
    const slot = document.getElementById("uePresetEditor");
    if (!slot) return;
    slot.innerHTML = [
      '<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + UE_A.code + " JSON 源码模式（保存会覆盖全部 preset）</div>",
      '<textarea class="ue-textarea ue-mono" id="uePresetJsonText" rows="16">' + escapeHtml(JSON.stringify(loadPresets(), null, 2)) + "</textarea>",
      '<div class="ue-editor-foot">',
      '<button class="ue-btn ue-btn-primary" id="uePJSave">保存 JSON</button>',
      '<button class="ue-btn" id="uePJCancel">取消</button>',
      "</div>",
      "</div>",
    ].join("");
    slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.getElementById("uePJSave").addEventListener("click", () => {
      const s = document.getElementById("uePresetJsonText").value || "";
      const r = peNormalizeJsonSource(s, (i) => "preset-" + Date.now() + "-" + i);
      if (!r.ok) {
        alert(r.code === "parse" ? "JSON 解析失败：" + r.message : r.message);
        return;
      }
      if (!confirm("将用 " + r.value.length + " 个 preset 覆盖当前 " + loadPresets().length + " 个。继续？")) return;
      savePresets(r.value);
      renderPresetTab();
    });
    document.getElementById("uePJCancel").addEventListener("click", () => {
      slot.innerHTML = "";
    });
  }

  function importPresetFile(text, fname) {
    const r = peParsePresetImport(text, fname);
    if (!r.ok) {
      alert(r.code === "parse" ? "JSON 解析失败：" + r.message : r.message);
      return;
    }
    const next = peAppendImported(loadPresets(), r.value, (i) => presetUid() + "-" + i);
    savePresets(next);
    const group = r.value[0] && r.value[0].group ? r.value[0].group : "";
    if (group) collapsedGroups[group] = false;
    renderPresetTab();
    alert("已追加 " + r.value.length + " 个 preset" + (group ? "（分组「" + group + "」）" : ""));
  }

  /* ── Character pane ─────────────────────────────────────────────────────────────────────── */

  const GENDER_PH = "女 / 男 / 双性 / 无性别 / 自定义";

  function charApi() {
    return window.characterSvc && typeof window.characterSvc.getAllCards === "function" ? window.characterSvc : null;
  }

  function charListHtml(cards, activeId) {
    if (!cards.length) {
      return '<div class="ue-empty">还没有角色卡。点上方「新建角色卡」创建；也可以「导入」网上找的 SillyTavern V2 卡或 PNG 卡。</div>';
    }
    return cards
      .map((c) => {
        const on = c.id === activeId;
        const sub = peCharSummary(c);
        return [
          '<div class="ue-preset-row' + (on ? " enabled" : "") + '" data-id="' + escapeAttr(c.id) + '">',
          '<label class="ue-preset-tog" title="' + (on ? "当前使用 · 点击卸下（改为非角色模式）" : "点击设为当前角色") + '">',
          '<input type="checkbox" class="ue-preset-chk ue-char-chk"' + (on ? " checked" : "") + ">",
          "</label>",
          '<span class="ue-preset-name"><span class="ue-char-line"><span class="ue-char-ava">' + escapeHtml(c.icon || "🙂") + "</span>" + escapeHtml(c.name || "(未命名)") + (on ? ' <span class="ue-char-cur">当前</span>' : "") + "</span></span>",
          '<div class="ue-preset-preview">' + (escapeHtml(sub) || "<em>（无描述）</em>") + "</div>",
          '<div class="ue-preset-ops"><button class="ue-mini ue-char-edit" title="编辑">' + UE_A.pencil + '</button><button class="ue-mini danger ue-char-del" title="删除">' + UE_A.close + "</button></div>",
          "</div>",
        ].join("");
      })
      .join("");
  }

  async function renderCharacterTab() {
    const t = findTab("character");
    const body = document.getElementById("ueBody");
    if (!body) return;
    const api = charApi();
    if (!api) {
      body.innerHTML =
        '<div class="ue-panel"><div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) +
        '</span></div><div class="ue-empty">角色卡模块尚未就绪（character.js 未加载）,请刷新页面后重试。</div></div>';
      return;
    }
    let cards = [];
    try {
      cards = await api.getAllCards();
    } catch (e) {
      cards = [];
    }
    let activeId = "";
    try {
      activeId = localStorage.getItem("tavern_active_char_id") || "";
    } catch (e) {}
    body.innerHTML = [
      '<div class="ue-panel">',
      '<div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + "</span></div>",
      '<p class="ue-panel-desc">' + escapeHtml(t.desc) + "</p>",
      '<div class="ue-toolbar"><button class="ue-btn ue-btn-primary" id="ueCharNew">' + UE_A.plus + ' 新建角色卡</button><button class="ue-btn" id="ueCharImport" title="导入角色卡：SillyTavern V1/V2 JSON、PNG 卡（内嵌 tEXt）、本应用导出数组；内嵌世界书一并导入">' + UE_A.imp + ' 导入</button><input type="file" id="ueCharFile" accept=".json,application/json,.png,image/png" style="display:none"><button class="ue-btn" id="ueCharExport" title="导出为 SillyTavern Card V2（可被 ST 等工具直接读取；内部扩展挂 data.extensions.ownchat(并双写旧键 omnigent 兼容老导出)；卡内 V3 assets 一并带回）">' + UE_A.exp + ' 导出 V2</button><button class="ue-btn" id="ueCharExportRaw" title="本应用内部格式（含好感度阈值等本平台专有字段，仅供本应用回导/备份）">' + UE_A.file + ' 内部 JSON</button><span class="ue-toolbar-spacer"></span><span class="ue-count">共 ' + cards.length + " 条</span></div>",
      '<div class="ue-preset-list" id="ueCharList">' + charListHtml(cards, activeId) + "</div>",
      '<div class="ue-editor-slot" id="ueCharEditor"></div>',
      "</div>",
    ].join("");

    document.getElementById("ueCharNew").addEventListener("click", () => editChar(null));
    document.getElementById("ueCharExport").addEventListener("click", () => {
      const lore = window.lorebookSvc && typeof window.lorebookSvc.getAll === "function" ? window.lorebookSvc.getAll() || [] : [];
      const v2 = cards.map((c) =>
        peCardToV2(c, lore.filter((e) => e && e.scope === "perCard" && e.boundCardId === c.id))
      );
      downloadJson(
        peExportName("chars-v2", new Date().toISOString()),
        JSON.stringify(v2.length === 1 ? v2[0] : v2, null, 2),
        "已导出 " + v2.length + " 张（V2 标准格式，含内嵌世界书）"
      );
    });
    document.getElementById("ueCharExportRaw").addEventListener("click", () => {
      downloadJson(peExportName("chars-internal", new Date().toISOString()), JSON.stringify(cards, null, 2), "已导出 " + cards.length + " 张（本应用内部格式）");
    });

    const fileEl = document.getElementById("ueCharFile");
    const impBtn = document.getElementById("ueCharImport");
    if (impBtn) {
      impBtn.addEventListener("click", () => {
        if (fileEl) {
          fileEl.value = "";
          fileEl.click();
        }
      });
    }
    if (fileEl) {
      fileEl.addEventListener("change", () => {
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        const rd = new FileReader();
        const isPng = /\.png$/i.test(f.name) || f.type === "image/png";
        // PNG cards carry base64 JSON in a tEXt chunk and must be read as bytes: a text read destroys
        // the chunk layout, which is why the old version reported "JSON 解析失败" on every PNG.
        rd.onload = () => {
          if (isPng) {
            const buf = rd.result;
            try {
              importCharFile(pePngCardToJson(new Uint8Array(buf), pngPorts()), f.name, true);
            } catch (e) {
              alert("PNG 角色卡解析失败：" + (e && e.message ? e.message : e));
            }
          } else {
            importCharFile(String(rd.result || ""), f.name);
          }
        };
        if (isPng) rd.readAsArrayBuffer(f);
        else rd.readAsText(f);
      });
    }

    const listEl = document.getElementById("ueCharList");
    listEl.addEventListener("click", (e) => {
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (!row) return;
      const id = row.getAttribute("data-id");
      const act = e.target.closest && e.target.closest(".ue-char-edit,.ue-char-del");
      if (!act) return;
      if (act.classList.contains("ue-char-edit")) editCharById(id);
      else if (act.classList.contains("ue-char-del")) deleteChar(id);
    });
    listEl.addEventListener("change", (e) => {
      if (!e.target.classList.contains("ue-char-chk")) return;
      const row = e.target.closest(".ue-preset-row");
      if (!row) return;
      const apiNow = charApi();
      if (!apiNow) return;
      // '' detaches the card: checked means "in use", and this single-select column can be cleared.
      try {
        apiNow.setActiveId(e.target.checked ? row.getAttribute("data-id") : "");
      } catch (x) {}
      renderCharacterTab();
    });
  }

  function pngPorts() {
    return {
      fromBase64(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      },
      decodeBytes(bytes) {
        return new TextDecoder().decode(bytes);
      },
    };
  }

  function editCharById(id) {
    const api = charApi();
    if (!api) return;
    api.getAllCards().then((cards) => {
      const c = cards.find((x) => x.id === id);
      editChar(c || null);
    });
  }

  function deleteChar(id) {
    const api = charApi();
    if (!api) return;
    api.getAllCards().then((cards) => {
      const c = cards.find((x) => x.id === id);
      if (!confirm("删除角色卡「" + ((c && c.name) || id) + "」？此操作不可撤销。")) return;
      api.deleteCard(id).then(() => renderCharacterTab());
    });
  }

  function editChar(card) {
    const slot = document.getElementById("ueCharEditor");
    if (!slot) return;
    const isNew = !card || !card.id;
    const c = card || {};
    const rules = Array.isArray(c.rules) ? c.rules.slice() : [];
    while (rules.length < 3) rules.push("");
    const qa = Array.isArray(c.exampleQA) ? c.exampleQA.slice() : [];
    while (qa.length < 2) qa.push({ user: "", character: "" });
    const F = (lb, k, v, ph) =>
      '<label class="ue-field"><span>' + escapeHtml(lb) + '</span><input class="ue-input" data-cf="' + k + '" value="' + escapeAttr(v || "") + '" placeholder="' + escapeAttr(ph || "") + '"></label>';
    const I = (k, v, ph, mb) =>
      '<input class="ue-input" data-cf="' + k + '" value="' + escapeAttr(v || "") + '" placeholder="' + escapeAttr(ph || "") + '"' + (mb ? ' style="margin-bottom:6px;"' : "") + ">";
    slot.innerHTML = [
      '<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + (isNew ? UE_A.plus + " 新建角色卡" : UE_A.pencil + " 编辑：" + escapeHtml(c.name || "")) + "</div>",
      F("角色名 *", "name", c.name, "角色名称"),
      '<div class="ue-char-grid2">' + F("性别", "gender", c.gender, GENDER_PH) + F("年龄", "age", c.age, "如：18 / 二十出头（影响立绘）") + "</div>",
      F("身份/背景", "identity", c.identity, "如：高中生 / 修仙者（可空）"),
      F("场景", "scenario", c.scenario, "如：雨夜的旧书店（对应 ST 的 scenario；可空）"),
      F("头像 emoji", "icon", c.icon, "🙂"),
      F("性格关键词", "personality", c.personality, "如：包容、耐心"),
      F("说话方式", "speakingStyle", c.speakingStyle, "如：轻声细语"),
      '<label class="ue-field"><span>行为铁则（最多 3 条）</span>' + I("r0", rules[0], "铁则 1", 1) + I("r1", rules[1], "铁则 2", 1) + I("r2", rules[2], "铁则 3") + "</label>",
      F("开场白", "opening", c.openingLine, "第一句话"),
      '<label class="ue-field"><span>示例对话 1</span>' + I("q0u", qa[0].user, "用户说", 1) + I("q0c", qa[0].character, "角色回") + "</label>",
      '<label class="ue-field"><span>示例对话 2</span>' + I("q1u", qa[1].user, "用户说", 1) + I("q1c", qa[1].character, "角色回") + "</label>",
      '<div class="ue-editor-foot"><button class="ue-btn ue-btn-primary" id="ueCharSave">' + (isNew ? "新建" : "保存修改") + '</button><button class="ue-btn" id="ueCharCancel">取消</button></div>',
      "</div>",
    ].join("");
    slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.getElementById("ueCharCancel").addEventListener("click", () => {
      slot.innerHTML = "";
    });
    document.getElementById("ueCharSave").addEventListener("click", async () => {
      const api = charApi();
      if (!api) return;
      const read = (k) => {
        const el = slot.querySelector('[data-cf="' + k + '"]');
        return el ? el.value.trim() : "";
      };
      const keys = ["name", "gender", "age", "identity", "scenario", "icon", "personality", "speakingStyle", "r0", "r1", "r2", "opening", "q0u", "q0c", "q1u", "q1c"];
      const fields = {};
      for (const k of keys) fields[k] = read(k);
      const merged = peCharSaveFields(card || null, fields);
      if (!merged.ok) {
        alert("角色名不能为空");
        return;
      }
      try {
        await api.saveCard(merged.card);
        renderCharacterTab();
      } catch (e) {
        alert("保存失败：" + (e && e.message ? e.message : e));
      }
    });
  }

  /**
   * Import a card file. Cards are saved one after another so a single failure does not abort the
   * batch, and the report is built from what actually landed — including the asset count read back
   * from the stored card, which the data layer's quota may have trimmed.
   */
  function importCharFile(text, fname, isBinaryPng) {
    const api = charApi();
    if (!api) {
      alert("角色卡模块未就绪（character.js 未加载），请刷新页面后重试。");
      return;
    }
    let data;
    if (isBinaryPng) data = text; // the caller already decoded the PNG
    else {
      try {
        data = JSON.parse(text);
      } catch (e) {
        alert("JSON 解析失败：" + e.message);
        return;
      }
    }
    const pack = peCardsFromAny(data);
    if (!pack.cards.length) {
      alert("未识别到角色卡（支持 SillyTavern V1/V2/V3 单卡或多卡数组、PNG 卡、本应用导出）" + (pack.rejected ? "；被拒 " + pack.rejected + " 个" : ""));
      return;
    }
    let saved = 0;
    let chain = Promise.resolve();
    // `savedSpecs` stays index-aligned with `reports`: a failed save pushes null so the two lists can
    // still be read in parallel.
    const savedSpecs = [];
    for (const c of pack.cards) {
      chain = chain.then(() => api.saveCard(c));
      chain = chain.then(
        (sc) => {
          saved++;
          savedSpecs.push(sc && sc.spec ? sc.spec : null);
        },
        () => {
          savedSpecs.push(null);
        }
      );
    }
    // An embedded world book is only merged for a single card: with a pack there is no way to tell
    // which book belongs to which card, so the count is reported instead of guessed.
    let loreImported = 0;
    let loreSkipped = 0;
    if (!pack.isArray && window.lorebookSvc && window.lorebookSvc.parseSillyTavernBook) {
      const book = window.lorebookSvc.parseSillyTavernBook(data, (pack.cards[0] && pack.cards[0].name) || "import");
      if (book && book.length) loreImported = window.lorebookSvc.importAll(book, { merge: true });
    } else if (pack.isArray) {
      loreSkipped = peCardsWithBook(data);
    }
    chain.then(() => {
      renderCharacterTab();
      const lines = peImportReportLines({
        saved,
        reports: pack.reports,
        savedSpecs,
        loreImported,
        loreSkipped,
        rejected: pack.rejected,
      });
      alert(lines.join("\n"));
    });
  }

  /* ── World book pane ───────────────────────────────────────────────────────────────────── */

  function worldApi() {
    return window.lorebookSvc && typeof window.lorebookSvc.getAll === "function" ? window.lorebookSvc : null;
  }

  function worldListHtml(entries) {
    if (!entries.length) {
      return '<div class="ue-empty">还没有设定集条目。点上方「新建条目」创建；也可以「导入」SillyTavern 的 world info（世界书）。</div>';
    }
    return entries
      .map((e) => {
        const sub = peWorldSummary(e);
        return [
          '<div class="ue-preset-row' + (e.enabled !== false ? " enabled" : "") + '" data-id="' + escapeAttr(e.id) + '">',
          '<label class="ue-preset-tog"><input type="checkbox" class="ue-world-chk"' + (e.enabled !== false ? " checked" : "") + '><span class="ue-preset-name">' + escapeHtml(e.name || "(未命名条目)") + "</span></label>",
          '<div class="ue-preset-preview">' + (escapeHtml(sub) || "<em>（空）</em>") + "</div>",
          '<div class="ue-preset-ops"><button class="ue-mini ue-world-edit" title="编辑">✎</button><button class="ue-mini danger ue-world-del" title="删除">✕</button></div>',
          "</div>",
        ].join("");
      })
      .join("");
  }

  function renderWorldTab() {
    const t = findTab("world");
    const body = document.getElementById("ueBody");
    if (!body) return;
    const api = worldApi();
    if (!api) {
      body.innerHTML =
        '<div class="ue-panel"><div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) +
        '</span></div><div class="ue-empty">设定集模块尚未就绪（lorebook.js 未加载），请刷新页面后重试。</div></div>';
      return;
    }
    const entries = peWorldSorted(api.getAll());
    body.innerHTML = [
      '<div class="ue-panel">',
      '<div class="ue-panel-head"><span class="ue-panel-icon">' + t.icon + '</span><span class="ue-panel-name">' + escapeHtml(t.label) + "</span></div>",
      '<p class="ue-panel-desc">设定集条目（世界书 / Lorebook）：常驻或命中关键词时注入 system。与角色、剧情无关的通用设定也放这里；随云同步跨设备。</p>',
      '<div class="ue-toolbar">',
      '<button class="ue-btn ue-btn-primary" id="ueWorldNew">' + UE_A.plus + " 新建条目</button>",
      '<button class="ue-btn" id="ueWorldImport" title="导入 SillyTavern 世界书 / 角色卡内嵌 character_book / 本应用导出的 JSON">' + UE_A.imp + " 导入</button>",
      '<input type="file" id="ueWorldFile" accept=".json,application/json" style="display:none">',
      '<button class="ue-btn" id="ueWorldExport" title="导出全部设定集 JSON（下载文件）">' + UE_A.exp + " 导出</button>",
      '<span class="ue-toolbar-spacer"></span>',
      '<span class="ue-count">共 ' + entries.length + " 条</span>",
      "</div>",
      '<div class="ue-preset-list" id="ueWorldList">' + worldListHtml(entries) + "</div>",
      '<div class="ue-editor-slot" id="ueWorldEditor"></div>',
      "</div>",
    ].join("");

    document.getElementById("ueWorldNew").addEventListener("click", () => editWorld(null));
    document.getElementById("ueWorldExport").addEventListener("click", () => {
      const json = JSON.stringify(api.exportAll(), null, 2);
      downloadJson(peExportName("lorebook", new Date().toISOString()), json, "已导出 " + entries.length + " 条世界书");
    });
    const fileEl = document.getElementById("ueWorldFile");
    const impBtn = document.getElementById("ueWorldImport");
    if (impBtn) {
      impBtn.addEventListener("click", () => {
        if (fileEl) {
          fileEl.value = "";
          fileEl.click();
        }
      });
    }
    if (fileEl) {
      fileEl.addEventListener("change", () => {
        const f = fileEl.files && fileEl.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => importWorldFile(String(rd.result || ""), f.name);
        rd.readAsText(f);
      });
    }
    const listEl = document.getElementById("ueWorldList");
    listEl.addEventListener("click", (e) => {
      const row = e.target.closest && e.target.closest(".ue-preset-row");
      if (!row) return;
      const id = row.getAttribute("data-id");
      const act = e.target.closest && e.target.closest(".ue-world-edit,.ue-world-del");
      if (!act) return;
      if (act.classList.contains("ue-world-edit")) editWorldById(id);
      else if (act.classList.contains("ue-world-del")) deleteWorld(id);
    });
    listEl.addEventListener("change", (e) => {
      if (!e.target.classList.contains("ue-world-chk")) return;
      const row = e.target.closest(".ue-preset-row");
      const id = row.getAttribute("data-id");
      const entry = api.getEntry(id);
      if (!entry) return;
      entry.enabled = !!e.target.checked;
      api.saveEntry(entry);
      row.classList.toggle("enabled", entry.enabled);
    });
  }

  function editWorldById(id) {
    const api = worldApi();
    if (!api) return;
    editWorld(api.getEntry(id));
  }

  function deleteWorld(id) {
    const api = worldApi();
    if (!api) return;
    const e = api.getEntry(id);
    if (!confirm("删除世界书条目「" + ((e && e.name) || id) + "」？")) return;
    api.deleteEntry(id);
    renderWorldTab();
  }

  function importWorldFile(text, fname) {
    const api = worldApi();
    if (!api) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      alert("JSON 解析失败：" + e.message);
      return;
    }
    // Our own export is a plain array; anything else goes through the ST book parser, which also
    // understands a card's embedded character_book.
    const add = Array.isArray(data) ? data : api.parseSillyTavernBook(data, String(fname || "").replace(/\.json$/i, "") || "import");
    if (!add || !add.length) {
      alert("未识别到可导入的世界书条目（支持本应用数组 / SillyTavern world info / 角色卡内嵌 character_book）");
      return;
    }
    const n = api.importAll(add, { merge: true });
    renderWorldTab();
    alert("已追加导入 " + n + " 条世界书");
  }

  function editWorld(entry) {
    const slot = document.getElementById("ueWorldEditor");
    if (!slot) return;
    const isNew = !entry || !entry.id;
    const e = entry || {};
    const kw = Array.isArray(e.keywords) ? e.keywords.join(", ") : e.keywords || "";
    slot.innerHTML = [
      '<div class="ue-editor-card">',
      '<div class="ue-editor-head">' + (isNew ? UE_A.plus + " 新建设定集条目" : UE_A.pencil + " 编辑：" + escapeHtml(e.name || "")) + "</div>",
      '<label class="ue-field"><span>条目名 *</span><input class="ue-input" data-wf="name" value="' + escapeAttr(e.name || "") + '" placeholder="如：王国设定 / 主角的过去"></label>',
      '<label class="ue-field"><span>触发关键词（逗号分隔；勾选常驻则忽略）</span><input class="ue-input" data-wf="keywords" value="' + escapeAttr(kw) + '" placeholder="如：王国, 首都, 国王"></label>',
      '<label class="ue-field"><span>内容（注入到【世界设定】的正文）</span><textarea class="ue-textarea" data-wf="content" rows="6">' + escapeHtml(e.content || "") + "</textarea></label>",
      '<div class="ue-char-grid2">',
      '<label class="ue-field"><span>优先级（越大越靠前）</span><input class="ue-input" data-wf="priority" type="number" value="' + escapeAttr(e.priority != null ? String(e.priority) : "0") + '"></label>',
      '<label class="ue-field"><span>生效范围</span><select class="ue-input" data-wf="scope" id="ueWorldScope"><option value="global"' + (e.scope !== "perCard" ? " selected" : "") + '>全局</option><option value="perCard"' + (e.scope === "perCard" ? " selected" : "") + ">仅绑定角色卡</option></select></label>",
      "</div>",
      '<label class="ue-field" id="ueWorldBindWrap" style="' + (e.scope === "perCard" ? "" : "display:none;") + '"><span>绑定角色卡</span><select class="ue-input" data-wf="boundCardId" id="ueWorldBind"><option value="">（加载中…）</option></select></label>',
      '<label class="ue-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" data-wf="alwaysOn"' + (e.alwaysOn ? " checked" : "") + "><span>常驻注入（无视关键词，每轮都注入）</span></label>",
      '<div class="ue-editor-foot"><button class="ue-btn ue-btn-primary" id="ueWorldSave">' + (isNew ? "新建" : "保存修改") + '</button><button class="ue-btn" id="ueWorldCancel">取消</button></div>',
      "</div>",
    ].join("");
    slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const bindSel = document.getElementById("ueWorldBind");
    if (bindSel && window.characterSvc && window.characterSvc.getAllCards) {
      window.characterSvc.getAllCards().then(
        (cards) => {
          bindSel.innerHTML =
            '<option value="">（选择角色卡）</option>' +
            (cards || [])
              .map((c) => '<option value="' + escapeAttr(c.id) + '"' + (c.id === e.boundCardId ? " selected" : "") + ">" + escapeHtml((c.icon ? c.icon + " " : "") + (c.name || c.id)) + "</option>")
              .join("");
        },
        () => {
          bindSel.innerHTML = '<option value="">（无法加载角色卡）</option>';
        }
      );
    }
    const scopeSel = document.getElementById("ueWorldScope");
    const bindWrap = document.getElementById("ueWorldBindWrap");
    if (scopeSel) {
      scopeSel.addEventListener("change", () => {
        if (bindWrap) bindWrap.style.display = scopeSel.value === "perCard" ? "" : "none";
      });
    }
    document.getElementById("ueWorldCancel").addEventListener("click", () => {
      slot.innerHTML = "";
    });
    document.getElementById("ueWorldSave").addEventListener("click", () => {
      const api = worldApi();
      if (!api) return;
      const read = (k) => {
        const el = slot.querySelector('[data-wf="' + k + '"]');
        return el ? el.value : "";
      };
      const chk = slot.querySelector('[data-wf="alwaysOn"]');
      const fields = {
        name: read("name"),
        keywords: read("keywords"),
        content: read("content"),
        priority: read("priority"),
        scope: read("scope"),
        boundCardId: read("boundCardId"),
        alwaysOn: chk && chk.checked ? "1" : "",
      };
      const merged = peWorldSaveFields(entry || null, fields);
      if (!merged.ok) {
        alert("条目名和内容不能都为空");
        return;
      }
      try {
        api.saveEntry(merged.entry);
        renderWorldTab();
      } catch (x) {
        alert("保存失败：" + (x && x.message ? x.message : x));
      }
    });
  }

  window.__promptEditor = {
    open: open,
    close: close,
    switchTab: switchTab,
    // Force a redraw of the current pane (settings.js calls this after writing LS).
    refresh: function () {
      if (mask && mask.classList.contains("open")) renderBody();
    },
  };
})();
