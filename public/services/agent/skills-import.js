(function () {
/**
 * Skill-package import: a `SKILL.md` bundle with an optional `skill.json` sidecar, from a ZIP or a
 * dropped folder, reduced to the record the skill store already owns.
 *
 * The store and the ZIP reader are ports resolved at call time. Both are classic scripts that load
 * late (the ZIP reader is lazy), so capturing either at module load would freeze a null and make a
 * later, successful load look like a corrupt package. A missing port is reported as a result code,
 * never thrown — a lazy script that failed to load is not a bad archive.
 *
 * Packages are never executed. Paths stay inside the archive, executable extensions and symlinks
 * are refused, and size/compression caps are applied before any byte is decoded. Assets are kept
 * as a name+size manifest; their bytes never reach localStorage.
 * @module services/agent/skills-import
 */

/** Hard bounds over the decoded package; byte caps are on uncompressed bytes. */
const LIMITS = {
  maxFiles: 200,
  maxTotal: 20 * 1024 * 1024,
  maxSingle: 5 * 1024 * 1024,
  maxRatio: 1000,
  maxAssetsBytes: 2 * 1024 * 1024,
};

/** Executable extensions are refused in skill packs; the bundle gate wants the opposite set. */
const BAD_EXT = /\.(js|mjs|cjs|exe|dll|bat|cmd|ps1|sh|jar|msi|com|scr|vbs|wsf|hta|apk|dmg|pkg|deb|rpm)$/i;

                            
                     
                   
                    
                   
 

                             
                    
 

/** The skill-store surface the importer needs. Both write methods are load-bearing. */
                             
                                                 
                                   
                     
                                       
 

                                   
                                                                           
                             
                                                                                                
                                                                                            
                
                   
 

                        
               
                  
                
 

                             
               
               
 

                       
               
                      
                       
                  
 

                                            
                       
                 
 

                      
              
                       
                  
                    
 

                                
                                               
                                              
                  
                    
 

                        
               
               
                         
                         
                 
 

                        
               
                        
                 
 

                                 
                                                                         
                                                                          
                                                                 
                                            
                         
 

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function num(value         )         {
  return Number(value) || 0;
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

function prop(value         , key        )          {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function errParts(error         , fallback        )                                    {
  const code = prop(error, "code");
  const message = prop(error, "message");
  return {
    code: typeof code === "string" && code ? code : fallback,
    message: typeof message === "string" && message ? message : text(error),
  };
}

function fail(code        , message        , path         )                {
  const issue        = path ? { code, message, path } : { code, message };
  return { imported: [], skipped: [], errors: [issue], warnings: [] };
}

function toBytes(value         )             {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

function decodeText(bytes         )         {
  return new TextDecoder("utf-8").decode(toBytes(bytes));
}

/** Reject drive letters, absolute paths, NUL and any parent segment, in either slash flavour. */
function safePath(path         )          {
  const n = text(path).replace(/\\/g, "/");
  if (!n) return false;
  if (n.indexOf("\0") >= 0) return false;
  if (n.charAt(0) === "/") return false;
  if (/^[A-Za-z]:/.test(n)) return false;
  for (const part of n.split("/")) if (part === "..") return false;
  return true;
}

function isExecutable(path         )          {
  return BAD_EXT.test(text(path));
}

/** Unix mode bits in the high half of externalAttrs; 0xa000 marks a symlink. */
function isSymlink(attrs         )          {
  const a = num(attrs);
  return ((a >>> 16) & 0xf000) === 0xa000;
}

function entryOf(value         )               {
  const r = recOf(value);
  return {
    path: text(r.path),
    size: num(r.size),
    compressedSize: num(r.compressedSize),
    externalAttrs: r.externalAttrs,
    bytes: r.bytes,
  };
}

function storeOf(ports                  )                    {
  return typeof ports.store === "function" ? ports.store() : null;
}

/** Frontmatter parser for hosts that have not loaded the skill store yet. */
function fallbackParse(input         )              {
  const src = text(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let name = "";
  let description = "";
  let references           = [];
  let body = src.trim();
  const fm = src.match(/^\uFEFF?---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = text(fm[2]).trim();
    for (const line of text(fm[1]).split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name") name = val;
      else if (key === "description") description = val;
      else if (key === "references") references = val.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  if (!name) {
    const heading = body.match(/^#\s+(.+)$/m);
    if (heading) name = heading[1].trim();
  }
  if (!name) name = "未命名技能";
  return { name, description, references, content: body };
}

function parsedOf(value         )              {
  const r = recOf(value);
  return {
    name: text(r.name),
    description: text(r.description),
    references: arrOf(r.references).map((x) => text(x)).filter(Boolean),
    content: text(r.content),
  };
}

function parseSkillMd(input         , ports                  )              {
  const store = storeOf(ports);
  if (store && typeof store.parseSkillMd === "function") return parsedOf(store.parseSkillMd(text(input)));
  return fallbackParse(input);
}

/** One flat `SKILL.md` marks a package root; every entry under that prefix belongs to it. */
function groupPackages(entries           )                 {
  const packages                 = [];
  const seen                          = {};
  for (const raw of entries) {
    const e = recOf(raw);
    if (e.isDir) continue;
    const m = text(e.path).match(/^(.*\/)?SKILL\.md$/i);
    if (!m) continue;
    const root = m[1] || "";
    if (seen[root]) continue;
    seen[root] = true;
    const files                 = [];
    for (const other of entries) {
      const x = recOf(other);
      if (x.isDir) continue;
      if (root ? text(x.path).indexOf(root) === 0 : true) files.push(entryOf(other));
    }
    packages.push({ root, files, source: "" });
  }
  return packages;
}

function validatePackage(input         , ports                  )             {
  const pkg = recOf(input);
  const root = text(pkg.root);
  const files = arrOf(pkg.files).map(entryOf);
  const errors          = [];
  const warnings          = [];
  let total = 0;
  let skillMd                      = null;
  let skillJson                      = null;

  if (files.length > LIMITS.maxFiles) {
    errors.push({ code: "TOO_MANY_FILES", message: "技能包文件数超过 " + LIMITS.maxFiles });
  }
  for (const f of files) {
    const p = f.path;
    if (!safePath(p)) { errors.push({ code: "BAD_PATH", path: p, message: "非法路径" }); continue; }
    if (isExecutable(p)) { errors.push({ code: "EXECUTABLE", path: p, message: "技能包不允许可执行文件" }); continue; }
    if (isSymlink(f.externalAttrs)) { errors.push({ code: "SYMLINK", path: p, message: "技能包不允许符号链接" }); continue; }
    if (f.size > LIMITS.maxSingle) { errors.push({ code: "FILE_TOO_LARGE", path: p, message: "单文件超过 5MB" }); continue; }
    total += f.size;
    if (f.compressedSize > 0 && f.size > f.compressedSize * LIMITS.maxRatio) {
      errors.push({ code: "ZIP_RATIO", path: p, message: "压缩比异常" });
      continue;
    }
    const lower = p.toLowerCase();
    if (lower === (root + "skill.md").toLowerCase()) skillMd = f;
    else if (lower === (root + "skill.json").toLowerCase()) skillJson = f;
  }
  if (total > LIMITS.maxTotal) errors.push({ code: "TOTAL_TOO_LARGE", message: "解压后总量超过 20MB" });
  if (!skillMd) errors.push({ code: "NO_SKILL_MD", message: "技能包缺少 SKILL.md" });
  if (errors.length || !skillMd) return { ok: false, errors, warnings };

  let metaValue          = {};
  if (skillJson) {
    try {
      metaValue = JSON.parse(decodeText(skillJson.bytes) || "{}");
      if (!metaValue || typeof metaValue !== "object" || Array.isArray(metaValue)) throw new Error("skill.json 必须是对象");
    } catch (e) {
      const parts = errParts(e, "BAD_SKILL_JSON");
      return { ok: false, errors: [{ code: "BAD_SKILL_JSON", path: skillJson.path, message: "skill.json 解析失败: " + parts.message }], warnings };
    }
  }
  const meta = recOf(metaValue);
  if (meta.name != null && typeof meta.name !== "string") {
    return { ok: false, errors: [{ code: "BAD_SKILL_JSON", path: skillJson ? skillJson.path : "", message: "skill.json 的 name 必须是字符串" }], warnings };
  }

  const parsed = parseSkillMd(decodeText(skillMd.bytes), ports);
  const name = text(meta.name || parsed.name || "").trim();
  if (!name) {
    return { ok: false, errors: [{ code: "NO_NAME", message: "技能没有可用名称（skill.json 或 SKILL.md frontmatter）" }], warnings };
  }

  const assets               = [];
  let assetsBytes = 0;
  for (const a of files) {
    if (a === skillMd || a === skillJson) continue;
    assets.push({ path: a.path, size: a.size });
    assetsBytes += a.size;
  }
  if (assetsBytes > LIMITS.maxAssetsBytes) {
    warnings.push({ code: "ASSETS_LARGE", message: "assets 超过 2MB，仅记录清单不保存字节" });
  }
  return {
    ok: true,
    skill: {
      name,
      description: text(meta.description != null ? meta.description : parsed.description),
      content: text(parsed.content),
      references: Array.isArray(parsed.references) ? parsed.references : [],
      assets,
      source: text(pkg.source) || "zip",
    },
    errors,
    warnings,
  };
}

function nextOrder(ports                  )         {
  const store = storeOf(ports);
  const raw = store && typeof store.getAll === "function" ? store.getAll() : [];
  let max = 0;
  for (const item of arrOf(raw)) max = Math.max(max, num(recOf(item).order));
  return max + 1;
}

function uniqueName(base        , ports                  )         {
  const store = storeOf(ports);
  let n = 2;
  let candidate = base + " (" + n + ")";
  while (store && typeof store.getByName === "function" && store.getByName(candidate)) {
    n++;
    candidate = base + " (" + n + ")";
  }
  return candidate;
}

function uid(ports                  )         {
  return "sk_" + num(ports.now()).toString(36) + num(ports.random()).toString(36).slice(2, 7);
}

function importEntries(entries         , opts         , ports                  )                {
  const store = storeOf(ports);
  if (!store || typeof store.save !== "function" || typeof store.getByName !== "function") {
    return fail("SKILLS_NOT_READY", "技能系统未就绪 (skill store)");
  }
  const list = arrOf(entries).filter((e) => {
    const r = recOf(e);
    return !r.isDir && !!r.path;
  });
  if (list.length > LIMITS.maxFiles) return fail("TOO_MANY_FILES", "文件数超过 " + LIMITS.maxFiles);
  let total = 0;
  for (const e of list) total += num(recOf(e).size);
  if (total > LIMITS.maxTotal) return fail("TOTAL_TOO_LARGE", "解压后总量超过 20MB");

  const packages = groupPackages(list);
  if (!packages.length) return fail("NO_SKILL_MD", "压缩包/文件夹里没有 SKILL.md");

  const imported                            = [];
  const skipped                           = [];
  const errors          = [];
  const warnings          = [];
  const options = recOf(opts);
  const strategy = text(options.onConflict) || "skip";
  let order = nextOrder(ports);

  for (const pkg of packages) {
    pkg.source = text(options.source) || "zip";
    const verdict = validatePackage(pkg, ports);
    if (!verdict.ok || !verdict.skill) {
      for (const e of verdict.errors) errors.push(e);
      for (const w of verdict.warnings) warnings.push(w);
      continue;
    }
    const skill = verdict.skill;
    let name = skill.name;
    const existing = store.getByName(name);
    if (existing) {
      if (strategy === "skip") {
        skipped.push({ name, reason: "同名技能已存在" });
        continue;
      }
      if (strategy === "overwrite") {
        store.save(Object.assign({}, recOf(existing), {
          name,
          description: skill.description,
          content: skill.content,
          references: skill.references,
          assets: skill.assets,
          source: skill.source,
          updatedAt: ports.now(),
        }));
        imported.push({ name, action: "overwrite" });
        continue;
      }
      if (strategy === "rename") name = uniqueName(name, ports);
    }
    store.save({
      id: uid(ports),
      name,
      description: skill.description,
      content: skill.content,
      references: skill.references,
      assets: skill.assets,
      enabled: false,
      order: order++,
      source: skill.source,
      createdAt: ports.now(),
    });
    imported.push({ name, action: existing ? "rename" : "new" });
  }
  return { imported, skipped, errors, warnings };
}

async function importZipBytes(bytes         , opts         , ports                  )                         {
  if (typeof ports.zip !== "function") return fail("ZIP_READER_MISSING", "需要先加载 zip-read.js");
  let zr                    = null;
  try {
    zr = await ports.zip(toBytes(bytes), {
      maxEntries: LIMITS.maxFiles + 100,
      maxTotal: LIMITS.maxTotal,
      maxSingle: LIMITS.maxSingle,
      maxRatio: LIMITS.maxRatio,
    });
  } catch (e) {
    const parts = errParts(e, "ZIP_ERROR");
    return fail(parts.code, parts.message);
  }
  if (!zr) return fail("ZIP_READER_MISSING", "需要先加载 zip-read.js");
  const entries = arrOf(recOf(zr).entries)
    .filter((e) => !recOf(e).isDir)
    .map((e) => {
      const r = recOf(e);
      return { path: r.name, size: r.size, compressedSize: r.compressedSize, externalAttrs: r.externalAttrs, bytes: r.data };
    });
  return importEntries(entries, Object.assign({ source: "zip" }, recOf(opts)), ports);
}

async function importFolder(fileList         , opts         , ports                  )                         {
  const files            = Array.prototype.slice.call(fileList || []);
  if (files.length > LIMITS.maxFiles) return fail("TOO_MANY_FILES", "文件数超过 " + LIMITS.maxFiles);
  const entries                            = [];
  let total = 0;
  for (const item of files) {
    const f = recOf(item);
    const path = text(f.webkitRelativePath || f.name || "");
    if (!path) continue;
    const size = num(f.size);
    if (size > LIMITS.maxSingle) return fail("FILE_TOO_LARGE", "单文件超过 5MB", path);
    total += size;
    if (total > LIMITS.maxTotal) return fail("TOTAL_TOO_LARGE", "总量超过 20MB");
    const toBuffer = f.arrayBuffer;
    if (typeof toBuffer !== "function") continue;
    const buf          = await Reflect.apply(toBuffer, f, []);
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(0);
    entries.push({
      path,
      size: size || bytes.byteLength,
      compressedSize: size || bytes.byteLength,
      bytes,
    });
  }
  return importEntries(entries, Object.assign({ source: "folder" }, recOf(opts)), ports);
}

/**
 * Build the importer. All IO arrives through `ports`; the caller keeps the frozen API name and the
 * load-order decisions in the classic wiring.
 */
function createSkillImport(ports                  )                 {
  return {
    importZipBytes: (bytes, opts) => importZipBytes(bytes, opts, ports),
    importFolder: (fileList, opts) => importFolder(fileList, opts, ports),
    importEntries: (entries, opts) => importEntries(entries, opts, ports),
    validatePackage: (pkg) => validatePackage(pkg, ports),
    _limits: LIMITS,
  };
}

// Classic binding for services/agent/skills-import.ts. The importer facade keeps its frozen name;
// both IO ports resolve on every call so a lazily loaded reader is visible to an importer that was
// already installed at boot. All package decisions live in the service, none in this file.
(function () {
  window.__skillsImport = createSkillImport({
    store: function () { return window.skillsSvc || null; },
    zip: function (bytes, limits) {
      var reader = window.ZipRead;
      if (!reader || typeof reader.readZip !== "function") return null;
      return reader.readZip(bytes, limits);
    },
    now: function () { return Date.now(); },
    random: function () { return Math.random(); },
  });
})();

globalThis.createSkillImport = createSkillImport;
})();
