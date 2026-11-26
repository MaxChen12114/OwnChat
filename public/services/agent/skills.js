(function () {
/**
 * Skill store and catalogue — three-level progressive disclosure for agent skills.
 *
 * Level 1 is a one-line-per-skill catalogue that lives in the system prompt, level 2 is the body,
 * fetched on demand by the `load_skill` tool, and level 3 (references) is not injected at all: the
 * browser shell has no host filesystem, so "read the attachment when needed" is not implementable
 * here. Only the catalogue is resident, which is the whole point — the earlier design pasted every
 * enabled skill's body into `extraSystemPrompts` on every round, which made skills a duplicate of the
 * prompt modules and burned tokens per turn.
 *
 * Community skills are untrusted input (they can carry prompt injection), so an import is always
 * created with `enabled: false` and stays out of the catalogue until a human reads it and ticks the
 * box. That default is a security boundary, not a UX preference.
 *
 * Storage and network arrive through {@link SkillsEnv}: `localStorage` in the page, a stub in tests.
 * The settings card itself is not here — it is DOM, so it lives in `tooling/l0/wiring/skills.js` and reaches
 * back through `onChange`.
 *
 * Lock: `tooling/scripts/test-skills-import.mjs` (imports through the real store) and `test/slot-runtime.test.mjs`.
 * @module services/agent/skills
 */

const SKILLS_LS_KEY = "cfw_skills_v1";
const SKILLS_LS_ENABLED_KEY = "cfw_skills_enabled_v1";
/**
 * Body length warning line. The kernel truncates tool results to 8000 chars (head 6000 + tail 1500),
 * so anything past 6000 loses its tail on load — both the import message and the list say so.
 */
const SKILLS_BODY_WARN = 6000;
/** Per-description cap, aligned with the 500-char limit the harness uses. */
const SKILLS_DESC_MAX = 500;
/**
 * Whole-catalogue cap. Deliberate: if the catalogue gets pushed out of the prompt, every skill becomes
 * unreachable at once, so over budget it degrades to bare names and then says how many were dropped.
 */
const SKILLS_CATALOG_MAX = 4000;

/** A stored skill. Everything is optional because the store is user-editable JSON. */
                        
                         
 

                              
               
                      
                       
                  
 

                                
                                      
                                            
 

                            
                         
                                                                                            
                                                                   
                                                                          
                    
 

                                 
              
                 
                          
                           
 

                            
                    
                             
                            
                                             
                  
                             
                                      
                                                  
                                         
                                           
                                                         
                                              
                                          
                                   
                                                                       
                   
 

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function createSkills(env           )            {
  const storage = env.storage;
  const doFetch = typeof env.fetch === "function" ? env.fetch : null;
  const onChange = typeof env.onChange === "function" ? env.onChange : () => undefined;

  function getAll()          {
    try {
      const raw = storage.getItem(SKILLS_LS_KEY);
      if (!raw) return [];
      const arr          = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(arr         )       {
    try {
      storage.setItem(SKILLS_LS_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
    } catch (e) {
      // Quota or a locked-down store: the in-memory list stays usable, persistence is best effort.
    }
  }

  function isGlobalEnabled()          {
    return (storage.getItem(SKILLS_LS_ENABLED_KEY) ?? "1") !== "0";
  }

  function setGlobalEnabled(on         )       {
    try {
      storage.setItem(SKILLS_LS_ENABLED_KEY, on ? "1" : "0");
    } catch (e) {
      // Same as saveAll.
    }
    onChange();
  }

  function uid()         {
    return "sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function sizeHint(skill         )         {
    const n = text(recOf(skill).content).length;
    return (
      "（正文 " +
      n +
      " 字" +
      (n > SKILLS_BODY_WARN ? "，超过 " + SKILLS_BODY_WARN + "：加载时会被工具结果裁剪，建议精简" : "") +
      "）"
    );
  }

  /**
   * Builds the resident catalogue block.
   * @param onlyNames when the active role card names its skills, only those are listed; an empty or
   * non-array value means "every enabled skill", which is the old behaviour.
   * @returns the block to append to the system prompt, or "" when the master switch is off or nothing
   * is enabled — callers must treat "" as "append nothing", not as "append an empty header".
   */
  function buildCatalogPrompt(onlyNames          )         {
    try {
      if (!isGlobalEnabled()) return "";
      const allow =
        Array.isArray(onlyNames) && onlyNames.length
          ? new Set(onlyNames.map((n) => text(n).trim()).filter(Boolean))
          : null;
      const arr = getAll()
        .filter((s) => s && s.enabled && text(s.name).trim())
        .filter((s) => !allow || allow.has(text(s.name).trim()))
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
      if (!arr.length) return "";
      const lines           = [];
      let used = 0;
      let dropped = 0;
      for (const s of arr) {
        const name = text(s.name).trim();
        let desc = text(s.description).replace(/\s+/g, " ").trim();
        if (!desc) desc = "（未写 description —— 不确定是否匹配时先 load_skill 看正文）";
        if (desc.length > SKILLS_DESC_MAX) desc = desc.slice(0, SKILLS_DESC_MAX) + "…";
        let line = "- `" + name + "`: " + desc;
        if (used + line.length > SKILLS_CATALOG_MAX) {
          const bare = "- `" + name + "`";
          if (used + bare.length > SKILLS_CATALOG_MAX) {
            dropped = arr.length - lines.length;
            break;
          }
          line = bare;
        }
        used += line.length;
        lines.push(line);
      }
      if (dropped > 0) lines.push("- （目录过长，其余 " + dropped + " 条未列出：可按名直接试 load_skill）");
      return (
        "\n\n【可用技能目录】每个技能都是「摘要 + 正文」两段式：想用某个技能，先按名调 `load_skill` 取全文再行动，" +
        "不要凭这里的摘要臆测内容。\n" +
        lines.join("\n")
      );
    } catch (e) {
      return "";
    }
  }

  /** Exact name first, then case-insensitive — `load_skill` addresses skills by name, never by id. */
  function getByName(name         )               {
    const want = text(name).trim();
    if (!want) return null;
    const arr = getAll();
    const nm = (s       ) => text(s.name).trim();
    return (
      arr.find((s) => nm(s) === want) || arr.find((s) => nm(s).toLowerCase() === want.toLowerCase()) || null
    );
  }

  function stripQuotes(s         )         {
    const v = text(s).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  }

  /**
   * Parses a `SKILL.md`: optional YAML frontmatter (`name` / `description` / `references`, the latter
   * as a comma list or a `- item` block) followed by the body.
   * @returns the body as `content`; without frontmatter the first `# heading` becomes the name and the
   * whole text becomes the body. A file with neither still gets a name, so it is importable.
   */
  function parseSkillMd(text0         )              {
    const src = text(text0).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let name = "";
    let description = "";
    let references           = [];
    let body = src.trim();
    const fm = src.match(/^\uFEFF?---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fm) {
      const meta = fm[1];
      body = (fm[2] || "").trim();
      let curKey                = null;
      for (const ln of meta.split("\n")) {
        const listM = ln.match(/^\s*-\s+(.*)$/);
        if (listM && curKey === "references") {
          const v = stripQuotes(listM[1].trim());
          if (v) references.push(v);
          continue;
        }
        const kv = ln.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        curKey = key;
        if (key === "name") name = stripQuotes(val);
        else if (key === "description") description = stripQuotes(val);
        else if (key === "references" || key === "resources") {
          if (val) references = val.split(",").map((x) => stripQuotes(x.trim())).filter(Boolean);
        }
      }
    }
    if (!name) {
      const h = body.match(/^#\s+(.+)$/m);
      if (h) name = h[1].trim();
    }
    if (!name) name = "未命名技能";
    return { name: name, description: description, references: references, content: body };
  }

  /**
   * Imports a SKILL.md body.
   * @returns the stored skill. It is created with `enabled: false` on purpose: imported skills are
   * untrusted and must not reach the catalogue until a human ticks them.
   * @throws when the text parses to nothing — a silent no-op would look like a successful import.
   */
  function importFromText(text0         , source          )        {
    const parsed = parseSkillMd(text0);
    if (!parsed.content && !parsed.name) throw new Error("解析为空：不是有效的 SKILL.md");
    const arr = getAll();
    const order = arr.reduce((m, s) => Math.max(m, Number(s.order ?? 0)), 0) + 1;
    const skill        = {
      id: uid(),
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      references: parsed.references || [],
      enabled: false,
      order: order,
      source: source || "import",
      createdAt: Date.now(),
    };
    arr.push(skill);
    saveAll(arr);
    return skill;
  }

  async function importFromUrl(url         )                 {
    const u = text(url).trim();
    if (!u) throw new Error("请填链接");
    if (!/^https?:\/\//i.test(u)) throw new Error("链接需以 http(s):// 开头");
    if (!doFetch) throw new Error("当前环境不支持拉取链接");
    const r = await doFetch(u);
    if (!r.ok) throw new Error("拉取失败: " + r.status);
    const body = await r.text();
    return importFromText(body, u);
  }

  function save(skill         )       {
    const patch = recOf(skill);
    if (!skill || !patch.id) return;
    const arr = getAll();
    const i = arr.findIndex((s) => s && s.id === patch.id);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], patch);
    else arr.push(patch);
    saveAll(arr);
  }

  function remove(id         )       {
    saveAll(getAll().filter((s) => s && s.id !== id));
  }

  function setEnabled(id         , on         )       {
    const arr = getAll();
    const s = arr.find((x) => x && x.id === id);
    if (s) {
      s.enabled = !!on;
      saveAll(arr);
    }
  }

  function list()          {
    return getAll();
  }

  /**
   * Pulls the starter library from `POST /api/presets`, the same unlock-gated endpoint the prompt
   * modules use — the old static JSON was readable by anyone, including locked-out visitors.
   * Deduplicates by **name**: library ids are `lib-*` while imported ids are `sk_*`, so ids never match.
   * @returns how many skills were added.
   * @throws when there is no unlock token, the request fails, or the library is empty.
   */
  async function importStarterLibrary()                  {
    let tok = "";
    try {
      tok = storage.getItem("cfw_unlock_token_v1") || "";
    } catch (e) {
      // Treated as "not unlocked" below.
    }
    if (!tok) throw new Error("需先解锁（技能库与指令模块库同走解锁门禁）");
    if (!doFetch) throw new Error("当前环境不支持拉取技能库");
    const r = await doFetch("/api/presets", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unlockToken: tok }),
    });
    if (!r.ok) throw new Error("拉取技能库失败: " + r.status);
    const data = recOf(await r.json());
    const skills = Array.isArray(data.skills) ? data.skills : [];
    if (!skills.length) throw new Error("技能库为空");
    const existing = new Set(getAll().map((s) => text(s.name).trim()));
    let added = 0;
    for (const item of skills) {
      const it = recOf(item);
      const content = typeof it.content === "string" ? it.content : typeof item === "string" ? item : "";
      if (!content.trim()) continue;
      const nm = text(it.name).trim();
      if (!nm || existing.has(nm)) continue;
      const arr = getAll();
      const order = arr.reduce((m, s) => Math.max(m, Number(s.order || 0)), 0) + 1;
      arr.push({
        id: uid(),
        name: nm,
        description: it.description || "",
        content: content.trim(),
        references: [],
        enabled: false,
        order: order,
        source: it.source || "library",
        license: it.license || "",
        createdAt: Date.now(),
      });
      saveAll(arr);
      existing.add(nm);
      added++;
    }
    return added;
  }

  return {
    getAll: getAll,
    save: save,
    remove: remove,
    setEnabled: setEnabled,
    list: list,
    isGlobalEnabled: isGlobalEnabled,
    setGlobalEnabled: setGlobalEnabled,
    buildCatalogPrompt: buildCatalogPrompt,
    getByName: getByName,
    parseSkillMd: parseSkillMd,
    importFromText: importFromText,
    importFromUrl: importFromUrl,
    importStarterLibrary: importStarterLibrary,
    sizeHint: sizeHint,
    bodyWarn: SKILLS_BODY_WARN,
  };
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name,
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
          if (!window.ZipRead) await loadScriptOnce("/shared/lib/zip-read.js");
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

globalThis.createSkills = createSkills;
})();
