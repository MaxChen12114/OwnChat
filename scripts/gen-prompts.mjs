// scripts/gen-prompts.mjs — 扫提示词目录，各生成一份注册表
// ─────────────────────────────────────────────────────────────
// 由 wrangler.toml 的 [build] command 在每次 dev / deploy 前自动执行。
// 2026-10-05: 从 gen-bases.mjs 泛化而来 —— 现在管两类 target:
//   「文本型」(kind 缺省)：一个文件/目录 = 一段文本
//   「条目型」(kind: "entries", 2026-10-06 新增)：一个文件 = 一条带元数据的条目
//     src/prompts/presets/   → presets/index.js  (PRESETS + LIBRARY_VERSION) 指令模块库（第一层子目录 = 分组）
//     src/prompts/skills/    → skills/index.js   (SKILLS)                    技能库（平铺，不带分组）
//   条目型支持**可选 front-matter**（文本型没有，它是红线"文件即文本"）：
//     ---
//     name: 显示名          （缺省用文件名）
//     description: 一句话    （技能必填——目录里靠它触发）
//     enabled: false        （默认是否列入；缺省 false：库是库，用哪个由用户勾）
//     source / license: 出处与许可（第三方条目必填；缺省视为本仓库自有）
//     note: 备注（节选说明、适配说明等）
//     ---
//   未写 source 的条目会在生成时打印「未标注出处」提醒（软提醒，不中止）。
//
// 文本型的识别规则（2026-10-05 放开命名）：**目录下任意 .md / .txt 就是一套**，文件名去掉扩展名即 id ——
// 想靠名字分辨效果，就把效果写进文件名。排除按**基名**判（不带扩展名）：readme.* / shared.*。
// 目录（= 一套多文件提示词，「体系化作战」那种）：子目录名即 id，里面 .md/.txt 按文件名排序后用
//   "\n\n---\n\n" 拼成一套文本。条目型的目录含义不同：presets 第一层子目录 = 分组（不再往下扫），
//   skills 只认平铺文件（技能的 references 目录形式是 P1，现在遇到会明确报错）。
// 排序：数字开头按数字升序排在前面（1- / 2- / 10- 不会乱），其余按码元序跟在后面。
//   「默认档」= 排完的第一份；想固定某个当默认就写 <目录>/.default（内容 = 那个 id）。
//
// 为什么生成"内嵌字符串"而不是让 esbuild 直接 import 文件：
//   esbuild 靠 rules 能加载，但纯 node（测试台一类）没有 loader 会直接挂 —— 内嵌成普通 JS 后两边都兼容。
//
// 以下情况**中止生成**（缺东西要响，别静默 —— 静默的后果是"你写了半天却根本没生效"）：
//   ① id 撞车（x.md / x.txt / x/ 并存）  ② 空文件、空目录、目录里只剩被排除的文件
//   ③ 文本型目录里还有子目录（不支持嵌套）  ④ .default 指向不存在的 id
//   ⑤ 条目型：front-matter 没闭合 / 技能没写 description / skills 里出现子目录
// 非 .md/.txt 的文件在目录里会被忽略并打印警告，不中止。
// 例外：target 标了 optional: true 时，目录不存在 / 为空都**不中止**，改生成"空注册表"——
//   公开版的 custom/（使用者自己的基座目录）就是这个形态：目录由使用者自建，而 worker 是静态
//   import，缺 index.js 会直接编译失败，所以必须先有一份空的。
// 注册表走 Object.create(null) + 逐条赋值，而不是对象字面量：文件名叫 __proto__ 的极端情况下，
//   字面量 `{ "__proto__": ... }` 会被 JS 当成设置原型而不是加一个键，白名单就废了。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT_RE = /\.(md|txt)$/i;
const EXCLUDE_BASENAMES = ["readme", "shared"];
const FOLDER_SEP = "\n\n---\n\n";

const TARGETS = [
  // 目录名一律 ASCII（中文路径在构建机/压缩工具/编码假定上都是雷）。
  { dir: "bases", table: "BASES", defaultConst: "DEFAULT_BASE_ID", withShared: true },
  // 2026-10-09: 公开版第二套目录 —— 使用者自己的基座（顶栏按钮切到「自定义」时用它）。
  // optional: 目录不存在 / 为空都生成空注册表（worker 是静态 import，缺 index.js 会直接编译失败）。
  { dir: "custom", table: "CUSTOMS", defaultConst: "DEFAULT_CUSTOM_ID", withShared: false, optional: true },
  { dir: "presets", table: "PRESETS", kind: "entries", groupKey: "group" },
  { dir: "skills", table: "SKILLS", kind: "entries" },
];

const stem = (f) => f.replace(EXT_RE, "");
const isExcluded = (name) => EXCLUDE_BASENAMES.includes(name.toLowerCase());
function sortKey(name) {
  const m = name.match(/^(\d+)/);
  return m ? [0, parseInt(m[1], 10)] : [1, 0];
}
function cmpName(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[0] === 0) return (ka[1] - kb[1]) || (a < b ? -1 : a > b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0; // 码元序（刻意不用 locale 比较器）
}

// 读文件并归一为 LF，剥掉开头 UTF-8 BOM。两者都是「编码标记/换行约定」，不是内容：
//   · 原提示词文本是 JS 模板字符串，规范规定 CRLF 归一为 LF，所以原文就是纯 LF；
//     本仓库 core.autocrlf=true，若不归一，Windows 下检出的 CRLF 会让文本平白多出一堆 \r。
//   · BOM 是编辑器「UTF-8 带 BOM」另存时加的，肉眼不可见，不剥就会成为 prompt 第一个字符。
function readText(p, bomSink, label) {
  let t = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  if (t.charCodeAt(0) === 0xfeff) { t = t.slice(1); bomSink.push(label); }
  return t;
}

/** 生成物里的注册表标题（中性措辞：私有版生成物不进公开树，但公开版生成的同名字段要对得上）。 */
const TABLE_TITLE = { BASES: "基座提示词", CUSTOMS: "自定义基座提示词" };

/** optional target 的空注册表：0 条 + 默认档为空串（调用方必须自己兜底）。 */
function writeEmptyRegistry({ dir, table, defaultConst, withShared }, why) {
  const out = `// src/prompts/${dir}/index.js — ⚠️ 自动生成，勿手改（scripts/gen-prompts.mjs）
// ${why}（该目录是 optional target，允许暂时没有内容）。
// 往目录里放进 .md / .txt（或一整个子目录 = 一套多文件基座）后重新 dev / deploy，这里就会自动多出条目。

/** ${TABLE_TITLE[table] || table}注册表：id = 文件名/目录名。null 原型对象，避免 __proto__ 这类键名作祟。 */
export const ${table} = Object.create(null);

/** 默认档：空注册表没有默认档（空串）—— 调用方必须自己兜底。 */
export const ${defaultConst} = "";
${withShared ? `
/** 共用前缀（shared.md / shared.txt，当前为空占位；不进下拉、不当默认） */
export const sharedText = "";
` : ""}`;
  const target = path.join(ROOT, "src", "prompts", dir, "index.js");
  fs.mkdirSync(path.dirname(target), { recursive: true }); // 目录不存在时也要写得进去（optional 的常态）
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (prev === out) console.log(`[gen-prompts] ${dir}/index.js 无变化（空注册表），跳过写入`);
  else { fs.writeFileSync(target, out, "utf8"); console.log(`[gen-prompts] 已生成 ${dir}/index.js：空注册表（${why}）`); }
  return { ids: [], defaultId: "" };
}

function buildOne({ dir, table, defaultConst, withShared, optional }) {
  const abs = path.join(ROOT, "src", "prompts", dir);
  if (!fs.existsSync(abs)) {
    if (optional) return writeEmptyRegistry({ dir, table, defaultConst, withShared }, "目录不存在");
    return { skipped: true, dir };
  }
  const bom = [], soft = [], hard = [];
  const items = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (!isExcluded(d.name)) items.push({ id: d.name, kind: "dir", name: d.name });
    } else if (EXT_RE.test(d.name) && !isExcluded(stem(d.name))) {
      items.push({ id: stem(d.name), kind: "file", name: d.name });
    }
  }
  if (!items.length) {
    if (optional) return writeEmptyRegistry({ dir, table, defaultConst, withShared }, "目录为空");
    console.error(`[gen-prompts] ✗ ${dir}/ 下没有任何 .md / .txt / 子目录，拒绝生成空注册表`);
    process.exit(1);
  }
  items.sort((a, b) => cmpName(a.id, b.id) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lines = [], ids = [], seen = new Map();
  for (const it of items) {
    const where = it.kind === "dir" ? it.name + "/" : it.name;
    if (seen.has(it.id)) {
      hard.push(`id 撞车：「${seen.get(it.id)}」与「${where}」去掉扩展名后都是 "${it.id}"（改一个名字）`);
      continue;
    }
    seen.set(it.id, where);
    let text = "";
    if (it.kind === "file") {
      text = readText(path.join(abs, it.name), bom, `${dir}/${it.name}`);
      if (!text.trim()) hard.push(`空文件：${dir}/${it.name}（要么写内容，要么改名成 readme.* 排除）`);
    } else {
      const sub = fs.readdirSync(path.join(abs, it.name), { withFileTypes: true });
      const nested = sub.filter((x) => x.isDirectory()).map((x) => x.name);
      if (nested.length) {
        hard.push(`${dir}/${it.name}/ 里还有子目录：${nested.join(", ")} —— 不支持嵌套，请把文件平铺进去`);
        continue;
      }
      const parts = sub
        .filter((x) => x.isFile() && EXT_RE.test(x.name) && !isExcluded(stem(x.name)))
        .map((x) => x.name)
        .sort(cmpName);
      const ignored = sub.filter((x) => x.isFile() && !EXT_RE.test(x.name)).map((x) => x.name);
      if (ignored.length) soft.push(`${dir}/${it.name}/ 里的非文本文件已忽略（只认 .md / .txt）：${ignored.join(", ")}`);
      const kept = parts.map((f) => readText(path.join(abs, it.name, f), bom, `${dir}/${it.name}/${f}`)).filter((b) => b.trim());
      if (!kept.length) { hard.push(`空目录：${dir}/${it.name}/（没有可用的 .md / .txt）`); continue; }
      text = kept.join(FOLDER_SEP);
    }
    if (!text.trim()) continue;
    if (it.id === "__proto__" || it.id === "constructor" || it.id === "prototype") {
      soft.push(`${dir}: id "${it.id}" 是原型键名：赋值写法能安全收录，但仍建议改名`);
    }
    lines.push(`${table}[${JSON.stringify(it.id)}] = ${JSON.stringify(text)};`);
    ids.push(it.id);
  }
  for (const s of soft) console.error(`[gen-prompts] ⚠ ${s}`);
  if (bom.length) {
    console.error(`[gen-prompts] ⚠ 以下文件带 UTF-8 BOM，已在读取时剥掉（想彻底干净就在编辑器里另存为「UTF-8」而不是「UTF-8 带 BOM」）：`);
    for (const f of bom) console.error(`               ${f}`);
  }
  if (hard.length) {
    console.error("[gen-prompts] ✗ 以下问题必须修掉（拒绝生成注册表）：");
    for (const h of hard) console.error(`               · ${h}`);
    process.exit(1);
  }

  // 默认档：.default 指针优先，否则排序第一份
  const ptr = path.join(abs, ".default");
  let pointerId = null;
  if (fs.existsSync(ptr)) {
    const body = readText(ptr, [], `${dir}/.default`).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    pointerId = body[0] || null;
    if (!pointerId) {
      console.error(`[gen-prompts] ✗ ${dir}/.default 是空的：第一行应写一个 id；不想指定就删掉它`);
      process.exit(1);
    }
    if (!ids.includes(pointerId)) {
      console.error(`[gen-prompts] ✗ ${dir}/.default 指向 "${pointerId}"，但注册表里没有它。现有：${ids.join(" / ")}`);
      process.exit(1);
    }
  }
  const defaultId = pointerId || ids[0];

  const sharedText = withShared
    ? (["shared.md", "shared.txt"].map((n) => path.join(abs, n)).find((p) => fs.existsSync(p))
        ? readText(["shared.md", "shared.txt"].map((n) => path.join(abs, n)).find((p) => fs.existsSync(p)), [], `${dir}/shared`)
        : "")
    : "";

  const out = `// src/prompts/${dir}/index.js — ⚠️ 自动生成，勿手改（scripts/gen-prompts.mjs）
// 编辑面是本目录下的 *.md / *.txt 与子目录；wrangler dev / deploy 前会自动重新生成。
// 手动重新生成：node scripts/gen-prompts.mjs

/** ${TABLE_TITLE[table] || table}注册表：id = 文件名/目录名。null 原型对象，避免 __proto__ 这类键名作祟。 */
export const ${table} = Object.create(null);
${lines.join("\n")}

/** 默认档（调用方没指定 id 时用它）：.default 指定的那份，没指定就是排序第一份。 */
export const ${defaultConst} = ${JSON.stringify(defaultId)};
${withShared ? `
/** 共用前缀（shared.md / shared.txt，当前为空占位；不进下拉、不当默认） */
export const sharedText = ${JSON.stringify(sharedText)};
` : ""}`;

  const target = path.join(abs, "index.js");
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  // 内容没变就不落盘 —— 否则每次 [build] 都刷新 mtime，wrangler 的监听会再触发一次 build，
  // 实测形成「build → 写 index.js → 监听触发 → build …」的无限重建循环（dev 下刷了 700+ 次）。
  if (prev === out) console.log(`[gen-prompts] ${dir}/index.js 无变化（${ids.length} 套：${ids.join(" / ")}），跳过写入`);
  else {
    fs.writeFileSync(target, out, "utf8");
    console.log(`[gen-prompts] 已生成 ${dir}/index.js：${ids.length} 套（${ids.join(" / ")}），默认档 = ${defaultId}`);
  }
  return { ids, defaultId };
}

// ── 条目型 target：一个文件 = 一条带元数据的条目（presets / skills）──
// 与文本型的根本差别：正文可以带 front-matter，生成出去的是**对象**（id/name/group/enabled/source/license/text…）。
// presets 允许一层子目录（= 分组）；skills 只认平铺文件（references 目录形式是 P1）。
// group：条目分组名（覆盖"第一层子目录名"作为显示标签 —— 目录是 ASCII，标签要中文时用它）
const FM_KEYS = ["name", "group", "description", "enabled", "lang", "source", "license", "note"];
const FM_BOOL = (v) => /^(true|1|yes|on)$/i.test(String(v || "").trim());
function splitFrontmatter(text, where, hard) {
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text.trim() };
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) { hard.push(`front-matter 没闭合（开头有 --- 但找不到收尾的 ---）：${where}`); return { meta: {}, body: text.trim() }; }
  const meta = {};
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!FM_KEYS.includes(k)) continue; // 未知键忽略（不报错：别的工具的 frontmatter 混进来很常见）
    meta[k] = v;
  }
  return { meta, body: (m[2] || "").trim() };
}
function buildEntries({ dir, table, groupKey }) {
  const abs = path.join(ROOT, "src", "prompts", dir);
  if (!fs.existsSync(abs)) return { skipped: true, dir };
  const soft = [], hard = [], bom = [];
  const items = []; // { id, name, group, file }
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory()) {
      if (isExcluded(d.name)) continue;
      if (!groupKey) { hard.push(`${dir}/${d.name}/ 是子目录，但 ${dir} 只认平铺文件（技能的 references 目录形式是 P1，先删掉或用扁平文件）`); continue; }
      if (d.name.startsWith(".")) continue;
      for (const f of fs.readdirSync(path.join(abs, d.name), { withFileTypes: true })) {
        if (f.isDirectory()) { hard.push(`${dir}/${d.name}/${f.name}/ 又套了一层目录 —— 分组只允许一层`); continue; }
        if (!EXT_RE.test(f.name) || isExcluded(stem(f.name))) continue;
        items.push({ id: stem(f.name), name: f.name, group: d.name, file: path.join(d.name, f.name) });
      }
    } else if (EXT_RE.test(d.name) && !isExcluded(stem(d.name))) {
      items.push({ id: stem(d.name), name: d.name, group: "", file: d.name });
    }
  }
  if (!items.length) {
    console.error(`[gen-prompts] ✗ ${dir}/ 下没有任何 .md / .txt，拒绝生成空注册表`);
    process.exit(1);
  }
  // 分组内先按名字排；再按整条 id（含分组前缀）排一遍 —— 与文本型同款排序语义
  const fullId = (it) => (it.group ? it.group + "-" + it.id : it.id);
  items.sort((a, b) => cmpName(a.id, b.id) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  items.sort((a, b) => cmpName(a.group, b.group) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));

  const seen = new Map(), records = [];
  items.forEach((it, idx) => {
    const where = it.file;
    const id = "lib-" + fullId(it);
    if (seen.has(id)) { hard.push(`id 撞车：「${seen.get(id)}」与「${where}」会生成同一个 id "${id}"（改一个名字）`); return; }
    seen.set(id, where);
    const raw = readText(path.join(abs, it.file), bom, `${dir}/${where}`);
    const { meta, body } = splitFrontmatter(raw, `${dir}/${where}`, hard);
    if (!body.trim()) { hard.push(`空文件（front-matter 之后没有正文）：${dir}/${where}`); return; }
    if (dir === "skills" && !meta.description) hard.push(`技能缺 description：${dir}/${where} —— 目录里靠 description 触发，缺了模型就无从判断何时该加载`);
    if (!meta.source) soft.push(`${dir}/${where} 未标注出处（front-matter 里加 source / license；本仓库自有的写「本仓库」）`);
    records.push({
      id, name: meta.name || it.id, group: meta.group || it.group, order: idx,
      // file = 相对本目录的真实路径（组名/文件名.md）—— 编辑器用它显示"这条例来自哪个仓库文件"
      file: (it.group ? it.group + "/" : "") + it.name,
      enabled: FM_BOOL(meta.enabled), lang: meta.lang || "zh",
      description: meta.description || "", source: meta.source || "", license: meta.license || "", note: meta.note || "",
      text: body,
    });
  });
  for (const s of soft) console.error(`[gen-prompts] ⚠ ${s}`);
  if (bom.length) console.error(`[gen-prompts] ⚠ ${bom.length} 个条目文件带 UTF-8 BOM，已在读取时剥掉（另存为无 BOM 的 UTF-8 即可消除）`);
  if (hard.length) {
    console.error("[gen-prompts] ✗ 以下问题必须修掉（拒绝生成注册表）：");
    for (const h of hard) console.error(`               · ${h}`);
    process.exit(1);
  }

  const lines = records.map((r) =>
    `${table}[${JSON.stringify(r.id)}] = ${JSON.stringify({ id: r.id, name: r.name, group: r.group, order: r.order, enabled: r.enabled, lang: r.lang, description: r.description, source: r.source, license: r.license, note: r.note, file: r.file, text: r.text })};`);
  const hash = crypto.createHash("sha1").update(records.map((r) => r.id + "\u0000" + r.text).join("\u0001")).digest("hex").slice(0, 12);
  const out = `// src/prompts/${dir}/index.js — ⚠️ 自动生成，勿手改（scripts/gen-prompts.mjs）
// 编辑面是本目录下的 *.md / *.txt${groupKey ? "（第一层子目录 = 分组）" : ""}；wrangler dev / deploy 前会自动重新生成。
// 手动重新生成：node scripts/gen-prompts.mjs

/** ${dir === "presets" ? "指令模块库（预设）" : "技能库"}注册表：id 形如 lib-<名字>（带 lib- 前缀，永不与用户自建条目撞）。null 原型对象。 */
export const ${table} = Object.create(null);
${lines.join("\n")}

/** 库内容指纹（id + 正文的 sha1 前 12 位）：客户端据此判断"要不要合并新条目"。改任何库文件都会变。 */
export const LIBRARY_VERSION = ${JSON.stringify(hash)};
`;
  const target = path.join(abs, "index.js");
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (prev === out) console.log(`[gen-prompts] ${dir}/index.js 无变化（${records.length} 条：${records.slice(0, 4).map((r) => r.name).join(" / ")}${records.length > 4 ? " …" : ""}），跳过写入`);
  else {
    fs.writeFileSync(target, out, "utf8");
    console.log(`[gen-prompts] 已生成 ${dir}/index.js：${records.length} 条（${records.map((r) => r.name).join(" / ")}）· 指纹 ${hash}`);
  }
  return { ids: records.map((r) => r.id) };
}

for (const t of TARGETS) (t.kind === "entries" ? buildEntries : buildOne)(t);
