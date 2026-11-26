// ── Browser wiring (injected by l0/emit.mjs): binds the service to the frozen window contract name,
// and owns everything that is DOM — the settings card, its event wiring and the lazy script loader.
// The store, the catalogue and the SKILL.md parser moved to services/agent/skills.ts; the card calls
// back into it and re-renders through onChange().
(function () {
  if (window.skillsSvc) return;

  const api = createSkills({
    storage: {
      getItem: function (key) { return window.localStorage.getItem(key); },
      setItem: function (key, value) { window.localStorage.setItem(key, value); },
    },
    fetch: function (url, init) { return window.fetch(url, init); },
    onChange: function () { renderList(); },
  });

  window.skillsSvc = {
    buildCatalogPrompt: api.buildCatalogPrompt,
    getByName: api.getByName,
    list: api.list,
    getAll: api.getAll,
    save: api.save,
    remove: api.remove,
    setEnabled: api.setEnabled,
    setGlobalEnabled: api.setGlobalEnabled,
    isGlobalEnabled: api.isGlobalEnabled,
    importFromText: api.importFromText,
    importFromUrl: api.importFromUrl,
    parseSkillMd: api.parseSkillMd,
  };

  const esc = window.escapeSvc.esc;

  // Scripts loaded on demand for the ZIP import chain (zip-read.js → skills-import.js). They are not
  // in the boot list on purpose: reading a ZIP is only needed when someone clicks "import a pack".
  const lazyScripts = {};
  function loadScriptOnce(src) {
    if (lazyScripts[src]) return lazyScripts[src];
    lazyScripts[src] = new Promise(function (resolve, reject) {
      const el = document.createElement("script");
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { delete lazyScripts[src]; reject(new Error("加载失败：" + src)); };
      document.head.appendChild(el);
    });
    return lazyScripts[src];
  }

  function renderList() {
    const box = document.getElementById("skillList");
    if (!box) return;
    const arr = api.getAll().slice().sort(function (a, b) { return Number(a.order ?? 0) - Number(b.order ?? 0); }).filter(Boolean);
    if (!arr.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--muted);">暂无技能。可从下方导入 SKILL.md 或技能包。</div>';
      return;
    }
    // Master switch off dims the whole column but keeps the checkboxes: what is off is the catalogue,
    // not the individual selections.
    const off = !api.isGlobalEnabled();
    const out = [];
    for (const s of arr) {
      const id = esc(String(s.id || ""));
      const name = esc(String(s.name || "未命名技能").trim() || "未命名技能");
      let desc = String(s.description || "").replace(/\s+/g, " ").trim();
      desc = desc ? esc(desc) : "（未写描述）";
      const src = esc(String(s.source || "import"));
      const len = String(s.content || "").length;
      out.push(
        '<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border,#2a2a2a);'
        + (off ? "opacity:.55;" : "") + '">'
        + '<input type="checkbox" data-act="toggle" data-id="' + id + '"' + (s.enabled ? " checked" : "")
        + ' title="列入 agent 技能目录" style="margin-top:2px;flex:0 0 auto;">'
        + '<div style="flex:1;min-width:0;">'
        + '<div style="font-size:13px;word-break:break-word;">' + name + '</div>'
        + '<div style="font-size:11px;color:var(--muted);word-break:break-word;">' + desc + '</div>'
        + '<div style="font-size:10px;color:var(--muted);">来源 ' + src + ' · 正文 ' + len + ' 字'
        + (len > api.bodyWarn ? " · 超过 " + api.bodyWarn + "：加载时会被工具结果裁剪，建议精简" : "") + '</div>'
        + '</div>'
        + '<button class="smallbtn" data-act="del" data-id="' + id + '" style="flex:0 0 auto;">删除</button>'
        + '</div>'
      );
    }
    box.innerHTML = out.join("");
  }

  /** ZIP import result → one readable line; errors with nothing imported read as a failure. */
  function zipResultText(r) {
    if (!r) return "导入失败：无返回";
    const n = (r.imported || []).length, s = (r.skipped || []).length, e = (r.errors || []).length;
    const first = (e && r.errors[0] && (r.errors[0].message || r.errors[0].code)) || "";
    if (!n && e) return "导入失败：" + (first || "无法识别技能包");
    let t = "已导入 " + n + " 条，跳过 " + s + " 条" + (e ? "，错误 " + e + " 条" : "");
    if (e && first) t += "（" + first + "）";
    if (n) t += "。导入的技能默认未列入目录，请在上方勾选。";
    return t;
  }

  function wireCard(card) {
    const status = card.querySelector("#skillImportStatus");
    function setMsg(t) { if (status) status.textContent = t || ""; }

    const gt = card.querySelector("#skillGlobalToggle");
    if (gt) { gt.checked = api.isGlobalEnabled(); gt.addEventListener("change", function () { api.setGlobalEnabled(gt.checked); }); }

    const listEl = card.querySelector("#skillList");
    if (listEl) {
      listEl.addEventListener("change", function (e) { const t = e.target.closest('input[data-act="toggle"]'); if (!t) return; api.setEnabled(t.getAttribute("data-id"), t.checked); });
      listEl.addEventListener("click", async function (e) { const b = e.target.closest('button[data-act="del"]'); if (!b) return; const ok = (window.feedbackSvc && window.feedbackSvc.confirm) ? await window.feedbackSvc.confirm({ title: "删除技能", message: "删除这条技能？", okText: "删除", danger: true }) : confirm("删除这条技能？"); if (!ok) return; api.remove(b.getAttribute("data-id")); renderList(); });
    }

    const pasteBtn = card.querySelector("#skillPasteBtn"), pasteText = card.querySelector("#skillPasteText");
    if (pasteBtn && pasteText) pasteBtn.addEventListener("click", function () {
      try { const s = api.importFromText(pasteText.value, "paste"); pasteText.value = ""; renderList(); setMsg("已导入「" + s.name + "」" + api.sizeHint(s) + "（默认未列入目录，请在上方勾选）"); }
      catch (e) { setMsg("导入失败：" + (e && e.message || e)); }
    });

    const fileBtn = card.querySelector("#skillFileBtn"), fileInput = card.querySelector("#skillFileInput");
    if (fileBtn && fileInput) {
      fileBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function (e) {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = function () { try { const s = api.importFromText(String(reader.result), f.name); renderList(); setMsg("已从文件导入「" + s.name + "」" + api.sizeHint(s)); } catch (err) { setMsg("导入失败：" + (err && err.message || err)); } };
        reader.onerror = function () { setMsg("读取文件失败"); };
        reader.readAsText(f); fileInput.value = "";
      });
    }

    const urlBtn = card.querySelector("#skillUrlBtn"), urlInput = card.querySelector("#skillUrlInput");
    if (urlBtn && urlInput) urlBtn.addEventListener("click", async function () {
      urlBtn.disabled = true; setMsg("拉取中…");
      try { const s = await api.importFromUrl(urlInput.value); urlInput.value = ""; renderList(); setMsg("已从链接导入「" + s.name + "」" + api.sizeHint(s) + "（外部内容：建议先读一遍再列入目录）"); }
      catch (e) { setMsg("拉取失败：" + (e && e.message || e)); }
      urlBtn.disabled = false;
    });

    const sampleBtn = card.querySelector("#skillSampleBtn");
    if (sampleBtn) sampleBtn.addEventListener("click", async function () {
      sampleBtn.disabled = true; setMsg("拉取起始技能库…");
      try { const n = await api.importStarterLibrary(); renderList(); setMsg(n ? ("已导入起始技能库 " + n + " 条（默认未列入目录，逐条阅读后再勾）。") : "起始技能库已全部导入过，无新增。"); }
      catch (e) { setMsg("导入失败：" + (e && e.message || e)); }
      sampleBtn.disabled = false;
    });

    const zipBtn = card.querySelector("#skillZipBtn"), zipInput = card.querySelector("#skillZipInput");
    if (zipBtn && zipInput) {
      zipBtn.addEventListener("click", function () { zipInput.click(); });
      zipInput.addEventListener("change", async function (e) {
        const f = e.target.files && e.target.files[0];
        if (!f) { zipInput.value = ""; return; }
        zipBtn.disabled = true; setMsg("读取技能包…");
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          if (!window.ZipRead) await loadScriptOnce("/services/core/zip-read.js");
          if (!window.__skillsImport) await loadScriptOnce("/services/agent/skills-import.js");
          if (!window.__skillsImport || typeof window.__skillsImport.importZipBytes !== "function") throw new Error("技能包模块未就绪");
          const r = await window.__skillsImport.importZipBytes(buf, { onConflict: "skip" });
          renderList();
          setMsg(zipResultText(r));
        } catch (err) { setMsg("导入失败：" + (err && err.message || err)); }
        zipBtn.disabled = false;
        zipInput.value = "";
      });
    }
  }

  function mountCard() {
    const slot = window.slotRegistry.pick("setSkillSlot");
    if (slot) window.slotRegistry.claim({ cardId: "skillSystemCard", slotId: "setSkillSlot" });
    if (!slot || document.getElementById("skillSystemCard")) return;
    const IN = 'width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    const card = document.createElement("div");
    card.className = "card";
    card.id = "skillSystemCard";
    card.innerHTML =
      '<h4>Skill 系统</h4>'
      + '<p>导入 <b>SKILL.md</b>（纯 Markdown + YAML frontmatter）。技能走<b>三级渐进披露</b>：只有「名称 + 描述」这一行目录挂在 <b>agent 模式</b>的系统提示里，正文由 agent 需要时自己调 <code>load_skill</code> 取 —— 这是 Anthropic Agent Skills / DeepSeek Harness / ZCode 的通行做法（摘要常驻、正文按需）。<b>普通对话不挂技能。</b>随云同步、跨设备可用。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="skillGlobalToggle"><label for="skillGlobalToggle">启用技能目录（总开关）</label></div></div>'
      + '<div id="skillList" style="display:flex;flex-direction:column;gap:6px;margin-top:8px;"></div>'
      + '<div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">导入技能</div>'
      + '<textarea id="skillPasteText" rows="4" placeholder="粘贴 SKILL.md 内容…" style="' + IN + 'resize:vertical;"></textarea>'
      + '<div class="rowline" style="margin-top:8px;"><div></div><div class="btns">'
      + '<button class="smallbtn" id="skillPasteBtn">从文本导入</button>'
      + '<button class="smallbtn" id="skillFileBtn">从文件导入</button>'
      + '<input type="file" id="skillFileInput" accept=".md,.markdown,.txt" style="display:none">'
      + '<button class="smallbtn" id="skillZipBtn">导入技能包（ZIP）</button>'
      + '<input type="file" id="skillZipInput" accept=".zip,application/zip" style="display:none">'
      + '<button class="smallbtn" id="skillSampleBtn">导入起始技能库</button>'
      + '</div></div>'
      + '<div class="rowline" style="margin-top:6px;align-items:center;gap:8px;"><input type="text" id="skillUrlInput" placeholder="GitHub raw 链接（raw.githubusercontent.com/…/SKILL.md）" style="flex:1;' + IN + '"><button class="smallbtn" id="skillUrlBtn">拉取</button></div>'
      + '<div id="skillImportStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div></div>'
      + '<div class="settings-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>第三方 / 社区技能可能含提示词注入，<b>导入后默认不进目录</b>；请先阅读正文再手动列入。正文超过 6000 字会在加载时被工具结果裁剪；含 reference 的技能当前不加载附件（P1：等 agent 工作区成熟再做按需读）。</span></div>';
    slot.appendChild(card);
    wireCard(card);
    renderList();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountCard);
  else mountCard();
})();
