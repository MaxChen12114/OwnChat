// tooling/l0/tool-pages.mjs — 工具页外挂：目录即入口的清单扫描与目录块渲染
//
// 一个工具页存在的唯一凭据是它目录里有 `tool.json`；index.html 里只有容器，没有手写入口。
// 扫描放在构建期（无运行时 fetch），清单块注入到 boot 行之前，渲染器同步读取。
// 缺字段/坏 JSON/id 与目录不一致/order 重复/新字段类型错误一律失败退出——静默丢一个入口
// 等于用户看不见这一页，静默放过一个坏字段等于右栏挂出一个空标签。
//
// 同一份扫描结果同时喂左栏（sidebar）与右栏标签宿（page/embed/singleton/keepAlive/chrome/
// requires）；两边都不许再手写清单。
//
// 用法（只经 tooling/l0/build.mjs 调用）：scanToolPages(ROOT, fail) / renderCatalog(pages) / catalogSpan(html)
import fs from "node:fs";
import path from "node:path";

/** The catalog block id both renderers read (`public/js/text/boot/tools-pages.js` / panel-host). */
export const CATALOG_ID = "toolsPageCatalog";

function boolField(m, name, fallback, where, fail) {
  if (m[name] === undefined) return fallback;
  if (typeof m[name] !== "boolean") throw fail(`${where} 的 ${name} 必须是布尔值`);
  return m[name];
}

function stringField(m, name, fallback, where, fail) {
  if (m[name] === undefined) return fallback;
  if (typeof m[name] !== "string") throw fail(`${where} 的 ${name} 必须是字符串`);
  return m[name];
}

function stringArrField(m, name, where, fail) {
  if (m[name] === undefined) return [];
  if (!Array.isArray(m[name]) || m[name].some((x) => typeof x !== "string")) {
    throw fail(`${where} 的 ${name} 必须是字符串数组`);
  }
  return m[name].slice();
}

/**
 * Scan public/tools/<id>/tool.json.
 * @param root repository root (fixtures pass a synthetic tree).
 * @param fail called with a message before throwing; lets the caller print and exit with its style.
 * @returns Normalized pages sorted by order then id.
 */
export function scanToolPages(root, fail) {
  const dir = path.join(root, "public", "tools");
  const pages = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    return pages;
  }
  for (const name of names.sort()) {
    const file = path.join(dir, name, "tool.json");
    if (!fs.existsSync(file)) continue;
    let m;
    try {
      m = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw fail(`public/tools/${name}/tool.json 不是合法 JSON：${e.message}`);
    }
    const where = `public/tools/${name}/tool.json`;
    if (m.id !== name) throw fail(`${where} 的 id「${m.id}」与目录名不一致`);
    if (typeof m.label !== "string" || m.label.trim() === "" || typeof m.href !== "string" || m.href.charAt(0) !== "/") {
      throw fail(`${where} 缺 label 或 href（href 须以 / 开头）`);
    }
    if (typeof m.order !== "number" || !isFinite(m.order)) throw fail(`${where} 缺数字 order`);
    // Same-origin tool pages embed by default; an absolute URL is treated as external and is not
    // put in a tab unless the directory explicitly opts in.
    const page = boolField(m, "page", true, where, fail);
    const sidebar = boolField(m, "sidebar", true, where, fail);
    const embed = boolField(m, "embed", m.href.charAt(0) === "/", where, fail);
    const chrome = stringField(m, "chrome", "", where, fail);
    const singleton = boolField(m, "singleton", true, where, fail);
    const keepAlive = boolField(m, "keepAlive", false, where, fail);
    const requires = stringArrField(m, "requires", where, fail);
    const capabilities = stringArrField(m, "capabilities", where, fail);
    if (!page && !sidebar) throw fail(`${where} 的 page 与 sidebar 不能同时为 false（这一页永远没有入口）`);
    pages.push({
      id: m.id,
      label: m.label,
      href: m.href,
      order: m.order,
      icon: typeof m.icon === "string" ? m.icon : "",
      desc: typeof m.desc === "string" ? m.desc : "",
      page: page,
      sidebar: sidebar,
      embed: embed,
      chrome: chrome,
      singleton: singleton,
      keepAlive: keepAlive,
      requires: requires,
      capabilities: capabilities,
    });
  }
  pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const seen = new Set();
  for (const p of pages) {
    if (seen.has(p.order)) throw fail(`tool.json 的 order 重复：${p.order}（${p.id}）`);
    seen.add(p.order);
  }
  return pages;
}

/** Byte-stable catalog block (idempotence comes from re-rendering the same payload). */
export function renderCatalog(pages) {
  return `<script type="application/json" id="${CATALOG_ID}">${JSON.stringify({ version: 1, pages: pages })}</script>`;
}

/** Current catalog span in the html, or `null` when absent. */
export function catalogSpan(html) {
  const open = `<script type="application/json" id="${CATALOG_ID}">`;
  const at = html.indexOf(open);
  if (at < 0) return null;
  const end = html.indexOf("</script>", at);
  if (end < 0) return null;
  return [at, end + "</script>".length];
}

/** Insert or replace the catalog block so it sits immediately before the boot line. */
export function placeCatalog(html, freshCatalog, span, bootStart) {
  if (span === null) return html.slice(0, bootStart) + freshCatalog + String.fromCharCode(10) + html.slice(bootStart);
  return html.slice(0, span[0]) + freshCatalog + html.slice(span[1]);
}

/**
 * One read of "what the catalog should be" vs "what the html has". Fixtures without pages and
 * without a block count as not applicable rather than stale.
 */
export function catalogState(html, pages) {
  const fresh = renderCatalog(pages);
  const span = catalogSpan(html);
  const current = span === null ? null : html.slice(span[0], span[1]);
  const applicable = pages.length > 0 || span !== null;
  return { fresh: fresh, span: span, drift: applicable && current !== fresh };
}
