/**
 * The prompt editor's rules, minus the DOM: preset ordering and grouping, library reconciliation,
 * JSON-source validation, SillyTavern preset import, character-card mapping in both directions,
 * PNG-card text chunks, world-book row summaries and the import report.
 *
 * Why this is its own module: the editor is the only place that rewrites the user's prompt assets,
 * and every one of those rewrites used to be a side effect of a click handler. The two that matter
 * are the library merge and the card import. The merge is a three-rule contract — add what the
 * library gained, drop only `rphub-*` legacy and orphaned `lib-*` rows, and never touch anything the
 * user edited — and it must be idempotent, because it runs on every open. The import must never
 * silently lose fields: whatever V2 maps onto our card is reported as "mapped", whatever is kept
 * verbatim in `spec` is reported as "stored, returned on export", and whatever is dropped is named.
 *
 * Cards are opaque records on the way in and out. Callers hand over whatever the store returned and
 * get back a plain object; this module owns no storage, no `window`, no `document`.
 * @module services/ui/prompt-editor
 */

/** Any loose JSON object, as read from localStorage or a file. */
type Rec = Record<string, unknown>;

function recOf(v: unknown): Rec {
  const out: Rec = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** String coercion that keeps non-strings out: only real strings pass, everything else is "". */
function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** First key whose value is a non-blank string, trimmed. SillyTavern V1/V2 field aliases ride here. */
function firstStr(rec: Rec, keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/* ── Presets ────────────────────────────────────────────────────────────────────────────────── */

/** One instruction module. `order` is the injection order (0 first); `group` is the display bucket. */
export interface PresetEntry {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  order: number;
  group: string;
  lang: string;
  description: string;
  source: string;
  license: string;
  note: string;
  file: string;
  fromLibrary: boolean;
}

/** The library's copy of one entry, as POST /api/presets returns it. */
export type LibraryPack = unknown[];

/**
 * Coerce one stored row into a PresetEntry. Rows without a name are dropped by the caller: an
 * unnamed row cannot be addressed by any control in the editor.
 */
function presetOf(raw: unknown, index: number): PresetEntry | null {
  const r = recOf(raw);
  const name = strOf(r["name"]);
  if (!name) return null;
  const id = strOf(r["id"]) || "preset-" + String(index);
  return {
    id,
    name,
    content: strOf(r["content"]),
    enabled: r["enabled"] === true,
    order: typeof r["order"] === "number" ? r["order"] : index,
    group: strOf(r["group"]),
    lang: strOf(r["lang"]),
    description: strOf(r["description"]),
    source: strOf(r["source"]),
    license: strOf(r["license"]),
    note: strOf(r["note"]),
    file: strOf(r["file"]),
    fromLibrary: r["fromLibrary"] === true,
  };
}

/** Normalize a whole stored array. Missing/non-array input reads as "no presets", never as an error. */
export function pePresetsFrom(raw: unknown): PresetEntry[] {
  const out: PresetEntry[] = [];
  arrOf(raw).forEach((row, i) => {
    const p = presetOf(row, i);
    if (p) out.push(p);
  });
  return out;
}

/** Injection order, ascending. Copies: callers keep their own array intact. */
export function peSortByOrder(list: PresetEntry[]): PresetEntry[] {
  const out = list.slice();
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

/** Display buckets in first-seen order. The empty group is a bucket too — it renders without a header. */
export interface PresetBucket {
  group: string;
  items: PresetEntry[];
}

export function peGroupBuckets(list: PresetEntry[]): PresetBucket[] {
  const order: string[] = [];
  const map: Record<string, PresetEntry[]> = {};
  for (const p of list) {
    const g = p.group || "";
    if (!(g in map)) {
      map[g] = [];
      order.push(g);
    }
    map[g].push(p);
  }
  return order.map((g) => ({ group: g, items: map[g] }));
}

/** Row preview: an 80-character slice with newlines squeezed, ellipsis when cut. */
export interface PresetPreview {
  text: string;
  truncated: boolean;
}

export function pePresetPreview(content: string): PresetPreview {
  const src = content || "";
  const cut = src.length > 80;
  return { text: cut ? src.slice(0, 80).replace(/\n/g, " ") + "…" : src.replace(/\n/g, " "), truncated: cut };
}

/** Next free order value. */
export function peNextOrder(list: PresetEntry[]): number {
  return list.reduce((m, x) => Math.max(m, x.order || 0), -1) + 1;
}

/** Append a fresh, disabled preset at the end. The caller opens its editor straight away. */
export function pePresetCreate(list: PresetEntry[], id: string, name: string): { list: PresetEntry[]; created: PresetEntry } {
  const created: PresetEntry = {
    id,
    name,
    content: "",
    enabled: false,
    order: peNextOrder(list),
    group: "",
    lang: "",
    description: "",
    source: "",
    license: "",
    note: "",
    file: "",
    fromLibrary: false,
  };
  return { list: list.concat([created]), created };
}

/** Save an edit. A blank name is refused — the row would become unaddressable. */
export function pePresetEdit(list: PresetEntry[], id: string, name: string, content: string): { ok: boolean; list: PresetEntry[] } {
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, list };
  return { ok: true, list: list.map((p) => (p.id === id ? { ...p, name: trimmed, content } : p)) };
}

export function pePresetToggle(list: PresetEntry[], id: string, enabled: boolean): PresetEntry[] {
  return list.map((p) => (p.id === id ? { ...p, enabled } : p));
}

export function pePresetRemove(list: PresetEntry[], id: string): PresetEntry[] {
  return list.filter((p) => p.id !== id);
}

/**
 * Move one row up (-1) or down (+1) by swapping `order` values. Returns null when there is nowhere
 * to go: the wiring then skips the save, so an arrow click at the top of the list writes nothing.
 */
export function pePresetMove(list: PresetEntry[], id: string, dir: number): PresetEntry[] | null {
  const sorted = peSortByOrder(list);
  const i = sorted.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= sorted.length) return null;
  const a = sorted[i];
  const b = sorted[j];
  sorted[i] = { ...a, order: b.order };
  sorted[j] = { ...b, order: a.order };
  return sorted;
}

/**
 * Drop one row onto another: the dragged row lands at the target's index, takes the target's group,
 * and every row is renumbered 0..n-1 (the list is now the order). An unknown target appends.
 */
export function pePresetDrop(list: PresetEntry[], dragId: string, targetId: string): PresetEntry[] {
  const sorted = peSortByOrder(list);
  const di = sorted.findIndex((x) => x.id === dragId);
  if (di < 0) return sorted;
  const moved = sorted.splice(di, 1)[0];
  const ti = sorted.findIndex((x) => x.id === targetId);
  if (ti < 0) sorted.push(moved);
  else sorted.splice(ti, 0, { ...moved, group: sorted[ti].group || "" });
  return sorted.map((x, i) => ({ ...x, order: i }));
}

/** Delete a whole display bucket. The wiring asks for confirmation with the count first. */
export function peGroupRemove(list: PresetEntry[], group: string): PresetEntry[] {
  return list.filter((p) => (p.group || "") !== group);
}

/** How many rows a bucket holds (the confirmation prompt needs it). */
export function peGroupCount(list: PresetEntry[], group: string): number {
  return list.filter((p) => (p.group || "") === group).length;
}

/** What one library reconciliation changed. All zero means "library unchanged, nothing written". */
export interface LibraryMergeResult {
  list: PresetEntry[];
  purged: number;
  orphanPurged: number;
  added: number;
  metaRefreshed: number;
  total: number;
}

const LIB_PREFIX = "lib-";
const RP_HUB_IDS = /^rphub-/;

/**
 * Reconcile the local list with the library pack.
 *
 * Rules, all three needed: ① the library's new ids are appended disabled, so an update never changes
 * what gets injected; ② rows the library no longer has are dropped only when they are library-owned
 * (`lib-*`) — the RP-Hub starter set (`rphub-*`) is purged unconditionally because its files no
 * longer exist, while user rows keep their own ids and are never touched; ③ for ids present on both
 * sides only the provenance metadata is refreshed, so an edited row keeps its text and still learns
 * which repo file it came from.
 */
export function peMergeLibrary(list: PresetEntry[], pack: LibraryPack): LibraryMergeResult {
  const seen: Record<string, boolean> = {};
  for (const p of list) if (p.id) seen[p.id] = true;

  let cur = list.filter((p) => !RP_HUB_IDS.test(p.id));
  const purged = list.length - cur.length;

  const packIds: Record<string, boolean> = {};
  const packById: Record<string, Rec> = {};
  for (const e of pack) {
    const r = recOf(e);
    const id = strOf(r["id"]);
    if (!id) continue;
    packIds[id] = true;
    packById[id] = r;
  }

  const beforeOrphan = cur.length;
  cur = cur.filter((p) => !(p.id.indexOf(LIB_PREFIX) === 0 && !packIds[p.id]));
  const orphanPurged = beforeOrphan - cur.length;

  let metaRefreshed = 0;
  cur = cur.map((p) => {
    const e = packById[p.id];
    if (!e) return p;
    const next: PresetEntry = { ...p };
    const file = strOf(e["file"]);
    if (file && next.file !== file) {
      next.file = file;
      metaRefreshed++;
    }
    const source = strOf(e["source"]);
    if (source && next.source !== source) {
      next.source = source;
      metaRefreshed++;
    }
    const license = strOf(e["license"]);
    if (license && next.license !== license) {
      next.license = license;
      metaRefreshed++;
    }
    const note = strOf(e["note"]);
    if (note && next.note !== note) {
      next.note = note;
      metaRefreshed++;
    }
    const lang = strOf(e["lang"]);
    if (lang && next.lang !== lang) {
      next.lang = lang;
      metaRefreshed++;
    }
    const description = strOf(e["description"]);
    if (description && next.description !== description) {
      next.description = description;
      metaRefreshed++;
    }
    return next;
  });

  let added = 0;
  let maxOrder = cur.reduce((m, x) => Math.max(m, x.order || 0), -1);
  for (const e of pack) {
    const r = recOf(e);
    const id = strOf(r["id"]);
    if (!id || seen[id]) continue;
    cur.push({
      id,
      name: strOf(r["name"]) || id,
      content: strOf(r["content"]),
      enabled: r["enabled"] === true,
      order: typeof r["order"] === "number" ? r["order"] : ++maxOrder,
      group: strOf(r["group"]),
      lang: strOf(r["lang"]),
      description: strOf(r["description"]),
      source: strOf(r["source"]),
      license: strOf(r["license"]),
      note: strOf(r["note"]),
      file: strOf(r["file"]),
      fromLibrary: true,
    });
    seen[id] = true;
    added++;
  }

  return { list: cur, purged, orphanPurged, added, metaRefreshed, total: cur.length };
}

/**
 * "Reload from library" — the explicit, confirmed overwrite. Differs from the merge on rule ②: rows
 * the library still has are replaced with the file text, user rows are still kept untouched.
 */
export function peReloadFromLibrary(list: PresetEntry[], pack: LibraryPack): { list: PresetEntry[]; overwritten: number; added: number } {
  const byId: Record<string, Rec> = {};
  for (const e of pack) {
    const r = recOf(e);
    const id = strOf(r["id"]);
    if (id) byId[id] = r;
  }
  let overwritten = 0;
  const next = list.map((p) => {
    const e = byId[p.id];
    if (!e) return p;
    overwritten++;
    return {
      ...p,
      name: strOf(e["name"]) || p.name,
      content: strOf(e["content"]) || p.content,
      group: strOf(e["group"]),
      description: strOf(e["description"]),
      source: strOf(e["source"]),
      license: strOf(e["license"]),
      note: strOf(e["note"]),
      lang: strOf(e["lang"]),
      file: strOf(e["file"]),
      fromLibrary: true,
    };
  });
  const have: Record<string, boolean> = {};
  for (const p of next) if (p.id) have[p.id] = true;
  let maxOrder = next.reduce((m, x) => Math.max(m, x.order || 0), -1);
  let added = 0;
  for (const e of pack) {
    const r = recOf(e);
    const id = strOf(r["id"]);
    if (!id || have[id]) continue;
    next.push({
      id,
      name: strOf(r["name"]) || id,
      content: strOf(r["content"]),
      enabled: r["enabled"] === true,
      order: typeof r["order"] === "number" ? r["order"] : ++maxOrder,
      group: strOf(r["group"]),
      lang: strOf(r["lang"]),
      description: strOf(r["description"]),
      source: strOf(r["source"]),
      license: strOf(r["license"]),
      note: strOf(r["note"]),
      file: strOf(r["file"]),
      fromLibrary: true,
    });
    have[id] = true;
    added++;
  }
  return { list: next, overwritten, added };
}

/** How many rows the library owns in this list — the reload confirmation quotes it. */
export function peLibraryOwnedCount(list: PresetEntry[], pack: LibraryPack): number {
  const ids: Record<string, boolean> = {};
  for (const e of pack) {
    const id = strOf(recOf(e)["id"]);
    if (id) ids[id] = true;
  }
  return list.filter((p) => ids[p.id]).length;
}

/* ── Preset import ─────────────────────────────────────────────────────────────────────────── */

/** A row as parsed from a file, before it gets an id and a position. */
export interface ImportedPreset {
  name: string;
  content: string;
  enabled: boolean;
  group: string;
  lang: string;
  description: string;
  source: string;
  license: string;
  note: string;
}

function importedOf(raw: unknown): ImportedPreset | null {
  const r = recOf(raw);
  if (typeof r["name"] !== "string" || typeof r["content"] !== "string") return null;
  return {
    name: r["name"],
    content: r["content"],
    enabled: r["enabled"] === true,
    group: strOf(r["group"]),
    lang: strOf(r["lang"]),
    description: strOf(r["description"]),
    source: strOf(r["source"]),
    license: strOf(r["license"]),
    note: strOf(r["note"]),
  };
}

/**
 * SillyTavern preset → rows. Prompt entries flagged as markers are structural dividers, not content;
 * blank content is skipped. Enabled state comes from the last `prompt_order` group, which is the one
 * the ST UI writes; an identifier missing from it imports disabled.
 */
export function peParseSillyTavernPreset(data: unknown, groupName: string): ImportedPreset[] {
  const d = recOf(data);
  const enabledMap: Record<string, boolean> = {};
  const promptOrder = arrOf(d["prompt_order"]);
  if (promptOrder.length) {
    const last = recOf(promptOrder[promptOrder.length - 1]);
    for (const o of arrOf(last["order"])) {
      const row = recOf(o);
      const ident = strOf(row["identifier"]);
      if (ident) enabledMap[ident] = row["enabled"] !== false;
    }
  }
  const out: ImportedPreset[] = [];
  for (const pr of arrOf(d["prompts"])) {
    const r = recOf(pr);
    if (r["marker"] === true) continue;
    const content = strOf(r["content"]);
    if (!content.trim()) continue;
    const name = strOf(r["name"]) || strOf(r["identifier"]) || "(未命名)";
    const ident = strOf(r["identifier"]);
    const enabled = ident && ident in enabledMap ? enabledMap[ident] : false;
    out.push({ name, content, enabled, group: groupName, lang: "", description: "", source: "", license: "", note: "" });
  }
  return out;
}

/** Parse outcome shared by the two file-text entry points. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: "parse" | "format" | "empty"; message: string };

/** Accepts three shapes: our own exported array, a SillyTavern preset, a single {name, content}. */
export function peParsePresetImport(text: string, fname: string): ParseResult<ImportedPreset[]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: "parse", message: e instanceof Error ? e.message : String(e) };
  }
  const groupName = String(fname || "").replace(/\.json$/i, "") || "导入";
  let entries: ImportedPreset[] = [];
  if (Array.isArray(data)) {
    for (const x of data) {
      const row = importedOf(x);
      if (row) entries.push(row);
    }
  } else {
    const d = recOf(data);
    if (Array.isArray(d["prompts"])) {
      entries = peParseSillyTavernPreset(data, groupName);
    } else if (typeof d["name"] === "string" && typeof d["content"] === "string") {
      entries = [{ name: d["name"], content: d["content"], enabled: d["enabled"] === true, group: "", lang: "", description: "", source: "", license: "", note: "" }];
    } else {
      return { ok: false, code: "format", message: "无法识别的预设格式（支持本应用数组 / SillyTavern 预设 / 单条 {name,content}）" };
    }
  }
  if (!entries.length) return { ok: false, code: "empty", message: "文件里没有可导入的有效条目" };
  return { ok: true, value: entries };
}

/** Append imported rows after the current tail; ids come from the caller, which owns the clock. */
export function peAppendImported(list: PresetEntry[], entries: ImportedPreset[], makeId: (i: number) => string): PresetEntry[] {
  const base = peNextOrder(list);
  const out = list.slice();
  entries.forEach((p, i) => {
    out.push({
      id: makeId(i),
      name: p.name,
      content: p.content,
      enabled: p.enabled,
      order: base + i,
      group: p.group || "",
      lang: p.lang || "",
      description: p.description || "",
      source: p.source || "",
      license: p.license || "",
      note: p.note || "",
      file: "",
      fromLibrary: false,
    });
  });
  return out;
}

/**
 * JSON source mode: the textarea is authoritative. Rows need a string name and a string content;
 * everything else gets a default, and an id-less row gets one from `makeId` so the list stays
 * addressable. Metadata (source/license/note/lang/file) survives on purpose — a round trip through
 * this mode used to wipe provenance.
 */
export function peNormalizeJsonSource(text: string, makeId: (i: number) => string): ParseResult<PresetEntry[]> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: "parse", message: e instanceof Error ? e.message : String(e) };
  }
  if (!Array.isArray(data)) return { ok: false, code: "format", message: "JSON 顶层必须是数组" };
  const out: PresetEntry[] = [];
  data.forEach((x: unknown, i: number) => {
    const r = recOf(x);
    if (typeof r["name"] !== "string" || typeof r["content"] !== "string") return;
    out.push({
      id: strOf(r["id"]) || makeId(i),
      name: r["name"],
      content: r["content"],
      enabled: r["enabled"] === true,
      order: typeof r["order"] === "number" ? r["order"] : i,
      group: strOf(r["group"]),
      lang: strOf(r["lang"]),
      description: strOf(r["description"]),
      source: strOf(r["source"]),
      license: strOf(r["license"]),
      note: strOf(r["note"]),
      file: strOf(r["file"]),
      fromLibrary: r["fromLibrary"] === true,
    });
  });
  if (!out.length) return { ok: false, code: "empty", message: "没有有效 preset（需 name + content 字段）" };
  return { ok: true, value: out };
}

/* ── Character cards ──────────────────────────────────────────────────────────────────────── */

/** One example exchange. A half-parsed block keeps the side it found. */
export interface ExamplePair {
  user: string;
  character: string;
}

/** Example-dialogue parse outcome. `failed` counts blocks with neither side — reported, not hidden. */
export interface ExampleParse {
  qa: ExamplePair[];
  failed: number;
  empty: boolean;
}

/**
 * Parse `mes_example`. Three spellings are in the wild: `<START>` blocks with `{{user}}:` /
 * `{{char}}:` prefixes (the standard), blocks prefixed with the card name (old cards), and plain
 * prose. Only two exchanges are kept — the card editor shows two fields.
 */
export function peParseExamples(mex: unknown, cardName: string): ExampleParse {
  const out: ExamplePair[] = [];
  let failed = 0;
  if (!mex || typeof mex !== "string") return { qa: out, failed, empty: !mex };
  const blocks = mex
    .split(/<START>/i)
    .map((x) => x.trim())
    .filter(Boolean);
  const nameRe = cardName ? new RegExp("^" + cardName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:：]", "i") : null;
  for (const blk of blocks) {
    if (out.length >= 2) break;
    let u = "";
    let c = "";
    const um = blk.match(/\{\{user\}\}\s*[:：]\s*([\s\S]*?)(?=\{\{char\}\}|$)/i);
    const cm = blk.match(/\{\{char\}\}\s*[:：]\s*([\s\S]*?)(?=\{\{user\}\}|$)/i);
    if (um || cm) {
      u = um ? um[1].trim() : "";
      c = cm ? cm[1].trim() : "";
    } else if (nameRe) {
      // "Luna: …\nMe: …" old spelling. Text before the first speaker line is context and is lost,
      // exactly as before: an untagged header must not leak into the user turn.
      let cur = "";
      for (const ln of blk.split("\n")) {
        if (nameRe.test(ln)) {
          if (cur === "user") u += (u ? "\n" : "") + ln.replace(nameRe, "").trim();
          else if (cur === "char") c += (c ? "\n" : "") + ln.replace(nameRe, "").trim();
          cur = "char";
        } else if (/^\s*(你|我|user|User|USER)\s*[:：]/.test(ln)) {
          if (cur === "user") u += (u ? "\n" : "") + ln.replace(/^\s*(你|我|user|User|USER)\s*[:：]/, "").trim();
          cur = "user";
        } else if (cur === "user") u += (u ? "\n" : "") + ln;
        else if (cur === "char") c += (c ? "\n" : "") + ln;
      }
    }
    if (u || c) out.push({ user: u, character: c });
    else failed++;
  }
  return { qa: out.slice(0, 2), failed, empty: false };
}

/** SillyTavern fields kept verbatim so an export can hand them back unchanged. */
export interface CardSpec {
  specVersion: string;
  creator: string;
  creatorNotes: string;
  characterVersion: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: unknown[];
  tags: unknown[];
  extensions: Rec;
  assets: unknown[];
}

/** The card we store. `spec` is the V2/V3 residue; the id is assigned by the data layer on save. */
export interface ImportedCard {
  id?: string;
  name: string;
  identity: string;
  scenario: string;
  personality: string;
  speakingStyle: string;
  openingLine: string;
  exampleQA: ExamplePair[];
  icon: string;
  avatar: string;
  gender: string;
  spec: CardSpec;
}

/** What the import dialog tells the user. Three buckets, no silent losses. */
export interface ImportReport {
  ok: boolean;
  reason?: string;
  used: string[];
  stored: string[];
  dropped: string[];
  failedExamples: number;
  assetsRaw: number;
}

function emptyReport(reason: string): ImportReport {
  return { ok: false, reason, used: [], stored: [], dropped: [], failedExamples: 0, assetsRaw: 0 };
}

/**
 * SillyTavern V1/V2/V3 card → our card plus the report above. V2/V3 live under `data`, V1 is flat;
 * V1's old field names are read as aliases. `description` and `scenario` stay separate on purpose —
 * the old code glued them into one "identity" and every imported card lost its situation.
 */
export function peCardFromSillyTavern(raw: unknown): { card: ImportedCard | null; report: ImportReport } {
  const outer = recOf(raw);
  const inner = outer["data"];
  const d = inner && typeof inner === "object" && !Array.isArray(inner) ? recOf(inner) : outer;
  if (!Object.keys(d).length) return { card: null, report: emptyReport("不是角色卡对象") };
  const name = firstStr(d, ["name", "char_name"]);
  const desc = firstStr(d, ["description", "char_persona"]);
  const scenario = firstStr(d, ["scenario", "world_scenario"]);
  const opening = firstStr(d, ["first_mes", "char_greeting"]);
  const mex = firstStr(d, ["mes_example", "example_dialogue"]);
  if (!name && !opening && !desc) return { card: null, report: emptyReport("没有 name/description/first_mes（且不是数组）") };

  const ex = peParseExamples(mex, name);
  const spec: CardSpec = {
    specVersion: firstStr(outer, ["spec_version", "spec"]),
    creator: firstStr(d, ["creator"]),
    creatorNotes: firstStr(d, ["creator_notes"]),
    characterVersion: firstStr(d, ["character_version"]),
    systemPrompt: firstStr(d, ["system_prompt"]),
    postHistoryInstructions: firstStr(d, ["post_history_instructions"]),
    alternateGreetings: arrOf(d["alternate_greetings"]),
    tags: arrOf(d["tags"]),
    extensions: recOf(d["extensions"]),
    assets: arrOf(d["assets"]),
  };
  const card: ImportedCard = {
    name: name || "导入角色",
    identity: desc,
    scenario,
    personality: strOf(d["personality"]),
    speakingStyle: "",
    openingLine: opening,
    exampleQA: ex.qa,
    icon: "🙂",
    avatar: "",
    // Network cards rarely carry a gender; leaving it blank keeps the gender line out of the prompt.
    // The old code hard-wrote female, which also mislabelled every male card.
    gender: "",
    spec,
  };
  const used: string[] = [];
  const stored: string[] = [];
  const dropped: string[] = [];
  const pairs: string[][] = [["name", name], ["description", desc], ["scenario", scenario], ["personality", card.personality], ["first_mes", opening]];
  for (const kv of pairs) {
    if (kv[1]) used.push(kv[0]);
  }
  if (ex.qa.length) used.push("mes_example(" + ex.qa.length + " 组)");
  else if (mex) dropped.push("mes_example(解析不出成对示例)");
  else if (ex.failed) dropped.push("mes_example");
  if (spec.systemPrompt) stored.push("system_prompt");
  if (spec.postHistoryInstructions) stored.push("post_history_instructions");
  if (spec.alternateGreetings.length) stored.push("alternate_greetings(" + spec.alternateGreetings.length + ")");
  if (spec.creatorNotes) stored.push("creator_notes");
  if (spec.tags.length) stored.push("tags(" + spec.tags.length + ")");
  if (Object.keys(spec.extensions).length) stored.push("extensions");
  if (d["character_book"]) stored.push("character_book(→世界书)");
  for (const k of ["nickname", "group_only_greetings", "source", "creation_date", "modification_date", "creator_notes_multilingual"]) {
    if (d[k] !== undefined) dropped.push(k + "(V3 专有，未存)");
  }
  return { card, report: { ok: true, used, stored, dropped, failedExamples: ex.failed, assetsRaw: spec.assets.length } };
}

/** One world-book row as the export needs it (already filtered down to this card). */
export interface BoundLoreRow {
  keywords?: unknown;
  content?: unknown;
  enabled?: unknown;
  priority?: unknown;
  name?: unknown;
  secondaryKeywords?: unknown;
  selective?: unknown;
  position?: unknown;
  depth?: unknown;
  probability?: unknown;
  useProbability?: unknown;
  selectiveLogic?: unknown;
}

/**
 * Our card → SillyTavern Card V2. Fields the other side does not know (rules, affection thresholds,
 * id) ride under `data.extensions.ownchat` and are written twice under the pre-rename key
 * `omnigent`, because exports made before the rename may be read through it by other tools.
 * `assets` and `character_book` are only written when non-empty: an old card must not gain empty keys.
 */
export function peCardToV2(card: Rec, bound: BoundLoreRow[]): Rec {
  const sp = recOf(card["spec"]);
  const own = {
    gender: strOf(card["gender"]),
    age: strOf(card["age"]),
    speakingStyle: strOf(card["speakingStyle"]),
    rules: arrOf(card["rules"]).filter(Boolean),
    enableAffection: card["enableAffection"] !== false,
    affectionThresholds: arrOf(card["affectionThresholds"]),
    id: strOf(card["id"]),
  };
  const qa = arrOf(card["exampleQA"]).map((q) => recOf(q)).filter((q) => q["user"] || q["character"]);
  const data: Rec = {
    name: strOf(card["name"]),
    description: strOf(card["identity"]),
    personality: strOf(card["personality"]),
    scenario: strOf(card["scenario"]),
    first_mes: strOf(card["openingLine"]),
    mes_example: qa.map((q) => "<START>\n{{user}}: " + strOf(q["user"]) + "\n{{char}}: " + strOf(q["character"])).join("\n"),
    creator_notes: strOf(sp["creatorNotes"]),
    system_prompt: strOf(sp["systemPrompt"]),
    post_history_instructions: strOf(sp["postHistoryInstructions"]),
    alternate_greetings: arrOf(sp["alternateGreetings"]),
    tags: arrOf(sp["tags"]),
    creator: strOf(sp["creator"]) || "OwnChat",
    character_version: strOf(sp["characterVersion"]),
    extensions: { ...recOf(sp["extensions"]), ownchat: own, omnigent: own },
  };
  const assets = arrOf(sp["assets"]);
  if (assets.length) data["assets"] = assets;
  if (bound.length) {
    data["character_book"] = {
      name: strOf(card["name"]) + " 的世界书",
      extensions: {},
      entries: bound.map((e) => {
        const row: Rec = {
          keys: arrOf(e.keywords),
          content: strOf(e.content),
          enabled: e.enabled !== false,
          insertion_order: typeof e.priority === "number" ? e.priority : 0,
          extensions: {},
          name: strOf(e.name),
        };
        const secondary = arrOf(e.secondaryKeywords);
        if (secondary.length) {
          row["secondary_keys"] = secondary;
          row["selective"] = e.selective !== false;
        }
        if (e.position) row["position"] = e.position;
        const ex: Rec = {};
        if (typeof e.depth === "number") ex["depth"] = e.depth;
        if (typeof e.probability === "number") {
          ex["probability"] = e.probability;
          ex["useProbability"] = e.useProbability !== false;
        }
        if (e.selectiveLogic !== undefined && e.selectiveLogic !== null) ex["selectiveLogic"] = e.selectiveLogic;
        if (Object.keys(ex).length) row["extensions"] = ex;
        return row;
      }),
    };
  }
  return { spec: "chara_card_v2", spec_version: "2.0", data };
}

/** One pack of cards: singular or array, V1 flat or V2/V3 wrapped. Rejects are counted, not thrown. */
export interface CardPack {
  cards: ImportedCard[];
  reports: ImportReport[];
  rejected: number;
  isArray: boolean;
}

export function peCardsFromAny(data: unknown): CardPack {
  const list = Array.isArray(data) ? data : [data];
  const cards: ImportedCard[] = [];
  const reports: ImportReport[] = [];
  let rejected = 0;
  for (const one of list) {
    const r = peCardFromSillyTavern(one);
    if (r.card) {
      cards.push(r.card);
      reports.push(r.report);
    } else rejected++;
  }
  return { cards, reports, rejected, isArray: Array.isArray(data) };
}

/** Row subtitle for the card list. */
export function peCharSummary(card: Rec): string {
  const src = strOf(card["identity"]) || strOf(card["personality"]);
  return src.slice(0, 60).replace(/\n/g, " ");
}

/** How many cards in a pack carry an embedded world book (multi-card import skips binding them). */
export function peCardsWithBook(data: unknown): number {
  const list = Array.isArray(data) ? data : [];
  return list.filter((x) => {
    const r = recOf(x);
    return r["character_book"] || recOf(r["data"])["character_book"];
  }).length;
}

/**
 * Build the save payload from the editor's field map. Fields come back as trimmed strings; rules and
 * example pairs drop empty rows, and fields the editor does not show (avatar, spec, affection) ride
 * along from the base card so a save never erases them.
 */
export function peCharSaveFields(base: Rec | null, fields: Record<string, string>): { ok: boolean; card: Rec } {
  const name = (fields["name"] || "").trim();
  if (!name) return { ok: false, card: {} };
  const g = (k: string) => (fields[k] === undefined ? "" : fields[k]);
  const rules = [g("r0"), g("r1"), g("r2")].filter((r) => r);
  const qa = [
    { user: g("q0u"), character: g("q0c") },
    { user: g("q1u"), character: g("q1c") },
  ].filter((q) => q.user || q.character);
  const b = base || {};
  return {
    ok: true,
    card: {
      id: strOf(b["id"]),
      name,
      gender: g("gender"),
      age: g("age"),
      identity: g("identity"),
      scenario: g("scenario"),
      icon: g("icon") || "🙂",
      personality: g("personality"),
      speakingStyle: g("speakingStyle"),
      rules,
      openingLine: g("opening"),
      exampleQA: qa,
      enableAffection: base ? b["enableAffection"] : undefined,
      affectionThresholds: base && Array.isArray(b["affectionThresholds"]) ? b["affectionThresholds"] : [],
      avatar: base ? strOf(b["avatar"]) : "",
      spec: base && b["spec"] ? b["spec"] : null,
    },
  };
}

/* ── PNG character cards ──────────────────────────────────────────────────────────────────── */

/** Bytes → text, and base64 → bytes. Injected so this module stays free of `atob`/`TextDecoder`. */
export interface PngPorts {
  fromBase64(b64: string): Uint8Array;
  decodeBytes(bytes: Uint8Array): string;
}

const PNG_SIGNATURE = 0x89504e47;

/**
 * Walk the PNG chunk list and return the `chara` / `ccv3` tEXt payloads.
 *
 * Cards from chub / characterhub are PNGs whose JSON sits in a tEXt chunk (keyword \0 text), so this
 * must be a byte-level walk: reading the file as text destroys the chunk structure. Written here
 * from the PNG spec rather than ported — SillyTavern's implementation is AGPL.
 */
export function pePngTextChunks(bytes: Uint8Array): Record<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint32(0) !== PNG_SIGNATURE) throw new Error("不是 PNG（签名不符）");
  const found: Record<string, string> = {};
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    let type = "";
    for (let k = 0; k < 4; k++) type += String.fromCharCode(bytes[off + 4 + k]);
    const dataStart = off + 8;
    if (dataStart + len > bytes.length) break;
    if (type === "tEXt") {
      let nul = -1;
      for (let q = dataStart; q < dataStart + len; q++) {
        if (bytes[q] === 0) {
          nul = q;
          break;
        }
      }
      if (nul > 0) {
        let key = "";
        for (let a = dataStart; a < nul; a++) key += String.fromCharCode(bytes[a]);
        let txt = "";
        for (let b = nul + 1; b < dataStart + len; b++) txt += String.fromCharCode(bytes[b]);
        if (key === "chara" || key === "ccv3") found[key] = txt;
      }
    }
    off = dataStart + len + 4;
    if (type === "IEND") break;
  }
  if (!found["ccv3"] && !found["chara"]) {
    throw new Error("PNG 里没有 chara / ccv3 文本块（不是角色卡，或用了不支持的编码）");
  }
  return found;
}

/**
 * PNG card → parsed JSON. `ccv3` wins over `chara`. Some exports wrap the JSON in yet another PNG,
 * so a parse failure retries the decoded bytes as a PNG before giving up.
 */
export function pePngCardToJson(bytes: Uint8Array, ports: PngPorts): unknown {
  const chunks = pePngTextChunks(bytes);
  const pick = chunks["ccv3"] || chunks["chara"];
  const inner = ports.fromBase64(pick.trim());
  const json = ports.decodeBytes(inner);
  try {
    return JSON.parse(json);
  } catch {
    return pePngCardToJson(inner, ports);
  }
}

/* ── World book rows ─────────────────────────────────────────────────────────────────────── */

/** Row subtitle: trigger mode, binding scope, then a slice of the text. */
export function peWorldSummary(entry: Rec): string {
  const tags: string[] = [];
  if (entry["alwaysOn"]) tags.push("常驻");
  else {
    const kw = arrOf(entry["keywords"]);
    tags.push(kw.length ? "关键词:" + kw.slice(0, 4).join("/") : "无触发词");
  }
  if (entry["scope"] === "perCard") tags.push("绑卡");
  const body = strOf(entry["content"]).slice(0, 50).replace(/\n/g, " ");
  return tags.join(" · ") + " · " + body;
}

/** Entries highest-priority-first for display; the injection order itself is the data layer's. */
export function peWorldSorted(entries: Rec[]): Rec[] {
  const out = entries.slice();
  out.sort((a, b) => {
    const pa = typeof a["priority"] === "number" ? a["priority"] : 0;
    const pb = typeof b["priority"] === "number" ? b["priority"] : 0;
    return pb - pa;
  });
  return out;
}

/**
 * Build the entry payload from the editor's field map. A blank name *and* a blank body is refused;
 * either alone is allowed, because renaming happens before the text is written. `enabled` only ever
 * turns off: a new entry is enabled, and an explicitly disabled one stays disabled through edits.
 */
export function peWorldSaveFields(base: Rec | null, fields: Record<string, string>): { ok: boolean; entry: Rec } {
  const name = (fields["name"] || "").trim();
  const content = fields["content"] || "";
  if (!name && !content.trim()) return { ok: false, entry: {} };
  const scope = fields["scope"] === "perCard" ? "perCard" : "global";
  const b = base || {};
  const priority = parseInt(fields["priority"] || "", 10);
  return {
    ok: true,
    entry: {
      id: strOf(b["id"]),
      name,
      keywords: fields["keywords"] || "",
      content,
      alwaysOn: fields["alwaysOn"] === "1",
      priority: Number.isFinite(priority) ? priority : 0,
      scope,
      boundCardId: scope === "perCard" ? fields["boundCardId"] || "" : "",
      enabled: base && b["enabled"] === false ? false : true,
      source: base ? b["source"] : "",
    },
  };
}

/* ── Import report ───────────────────────────────────────────────────────────────────────── */

/** Everything the report needs, gathered by the wiring after the saves settle. */
export interface ImportSummaryInput {
  saved: number;
  reports: ImportReport[];
  /** Saved card specs, index-aligned with `reports`; null where the save failed. */
  savedSpecs: (Rec | null)[];
  loreImported: number;
  loreSkipped: number;
  rejected: number;
}

/**
 * The import dialog's lines. The asset count is read back from the stored card because the data
 * layer's quota may have trimmed the list — reporting the raw count would claim more than was kept.
 */
export function peImportReportLines(input: ImportSummaryInput): string[] {
  const lore = input.loreImported ? "，及内嵌世界书 " + input.loreImported + " 条" : "";
  const lines: string[] = ["已导入 " + input.saved + " 张角色卡" + lore + "。"];
  if (input.rejected) lines.push("· 被拒 " + input.rejected + " 个（缺 name/description/first_mes）");
  const first = input.reports[0];
  if (first) {
    const stored = first.stored.slice();
    const dropped = first.dropped.slice();
    const spec = input.savedSpecs[0];
    if (first.assetsRaw && spec) {
      const kept = arrOf(spec["assets"]).length;
      stored.push("assets(" + kept + "/" + first.assetsRaw + ")");
      if (kept < first.assetsRaw) dropped.push("assets(" + (first.assetsRaw - kept) + " 条无效或超配额)");
    }
    if (first.used.length) lines.push("· 映射进卡：" + first.used.join(", "));
    if (stored.length) lines.push("· 原样存着（导出 V2 会还回去，本应用暂不使用）：" + stored.join(", "));
    if (dropped.length) lines.push("· 丢弃：" + dropped.join(", "));
    if (first.failedExamples) {
      lines.push("· 有 " + first.failedExamples + " 段示例对话没解析成对（可用 {{user}}: / {{char}}: 分隔，或手动补）");
    }
  }
  if (input.loreSkipped) {
    lines.push("· 有 " + input.loreSkipped + " 张卡自带世界书：多卡导入时不自动并（哪张绑哪本没法定），请单卡导入一次");
  }
  return lines;
}

/** Export filenames. `isoNow` is the caller's clock; the date part is what distinguishes two exports. */
export function peExportName(kind: "presets" | "chars-v2" | "chars-internal" | "lorebook", isoNow: string): string {
  const day = isoNow.slice(0, 10);
  if (kind === "presets") return "ownchat-presets-" + day + ".json";
  if (kind === "chars-v2") return "ownchat-characters-v2-" + day + ".json";
  if (kind === "chars-internal") return "ownchat-characters-internal-" + day + ".json";
  return "ownchat-lorebook-" + day + ".json";
}

/** One-shot library-alignment log line, or "" when the merge changed nothing worth printing. */
export function peMergeLog(result: LibraryMergeResult): string {
  if (!result.purged && !result.added) return "";
  return "[prompt-editor] 库已对齐：新增 " + result.added + " 条，清理旧 starter " + result.purged + " 条，清理孤儿 lib-* " + result.orphanPurged + " 条";
}
