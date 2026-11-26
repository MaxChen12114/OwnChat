/**
 * Text extraction for chat attachments: DOCX, XLSX, CSV/TSV and plain text, reduced to the text an
 * agent can quote.
 *
 * Parsing only: the original file is never uploaded, the attachment list is never mutated, and
 * there is no OCR. The ZIP reader is a port because zip-read.js is a classic script that must be
 * loaded before this module and is shared with skills-import; wiring it here would create a second
 * loader. PDF is refused outright — a text-layer reader needs pdf.js, which the repo does not
 * vendor.
 *
 * Everything is bounded: 20MB in, 50k chars out, 200 rows / 50 columns per sheet, 5 sheets.
 * @module services/chat/doc-extract
 */

/** Byte input accepted from `File.arrayBuffer()`, a test fixture, or a typed-array slice. */
export type ByteInput = ArrayBuffer | Uint8Array;

/** One member of the archive, as returned by zip-read.js. */
export interface ZipEntry {
  name: string;
  data?: ByteInput;
}

/** Result of decrypting an archive; `warnings` are passed through to the caller untouched. */
export interface ZipReadResult {
  entries: ZipEntry[];
  warnings?: string[];
}

/**
 * Ports. `readZip` returns `null` when zip-read.js was not loaded, which the service reports as
 * `ZIP_READER_MISSING` instead of throwing — a missing script must not look like a corrupt file.
 */
export interface DocExtractPorts {
  readZip(bytes: Uint8Array): ZipReadResult | null | Promise<ZipReadResult | null>;
}

/** Counters reported alongside the text; which fields appear depends on the format. */
export interface ExtractMeta {
  chars?: number;
  paragraphs?: number;
  tables?: number;
  rows?: number;
  cells?: number;
  sheets?: number;
  formulas?: number;
  truncated?: boolean;
}

/** Extraction success. `text` is already clipped to {@link LIMITS}. */
export interface ExtractOk {
  ok: true;
  kind: string;
  text: string;
  meta: ExtractMeta;
  warnings: string[];
}

/** Extraction failure. `code` is the discriminator callers switch on; `message` is user-facing. */
export interface ExtractFail {
  ok: false;
  code: string;
  message: string;
  warnings: string[];
}

export type ExtractResult = ExtractOk | ExtractFail;

/** Hard bounds. `maxBytes` is overridable per call; the text bounds are not. */
export const LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxChars: 50000,
  maxRows: 200,
  maxCols: 50,
  maxSheets: 5,
};

/** Read one property without assuming the value came from this realm. */
function readProp(obj: object, key: string): unknown {
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) return v;
  }
  return undefined;
}

function fail(code: string, message: string): ExtractFail {
  return { ok: false, code, message, warnings: [] };
}

/**
 * Realm-agnostic tag check: fixtures and `File.arrayBuffer()` results may come from another
 * context, where `instanceof ArrayBuffer` is false even though the buffer is usable.
 */
function isBareArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/** Views keep their window, so a sliced `Uint8Array` is not copied again. */
function toBytes(input: unknown): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (isBareArrayBuffer(input)) return new Uint8Array(input);
  throw new Error("extractBytes 需要 ArrayBuffer 或 Uint8Array");
}

function decodeText(bytes: ByteInput): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Named and numeric XML entities. `&amp;` is last so `&amp;lt;` decodes to `&lt;`, not `<`. */
function decodeXmlEntities(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch (e) {
        return "";
      }
    })
    .replace(/&#(\d+);/g, function (_, d) {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch (e) {
        return "";
      }
    })
    .replace(/&amp;/g, "&");
}

/** Value of one XML attribute on a raw tag string; "" when absent. Matches both quote styles. */
function attr(tag: unknown, name: string): string {
  const re = new RegExp("(?:^|\\s)" + name.replace(/[:.]/g, "\\$&") + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i");
  const m = String(tag || "").match(re);
  if (!m) return "";
  return m[2] != null ? m[2] : m[3] != null ? m[3] : "";
}

function clip(text: unknown): { text: string; truncated: boolean } {
  const s = String(text == null ? "" : text);
  if (s.length <= LIMITS.maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, LIMITS.maxChars), truncated: true };
}

/** Body of one DOCX block: runs are concatenated, `<w:tab>`/`<w:br>` become real whitespace. */
function textFromDocxFragment(fragment: unknown): string {
  let s = String(fragment || "");
  s = s.replace(/<w:tab\b[^>]*\/>/g, "\t");
  s = s.replace(/<w:br\b[^>]*\/>/g, "\n");
  const out: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  const text = out.length ? out.join("") : s.replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Walk `word/document.xml` once, one line per paragraph and per table row.
 *
 * Tables are matched before paragraphs: a table row is full of `<w:p>` runs, and walking
 * paragraphs first would count every cell as a body paragraph and lose the column layout.
 */
function xmlDocxToText(xml: string): { text: string; meta: ExtractMeta } {
  const meta: ExtractMeta = { paragraphs: 0, tables: 0, rows: 0, cells: 0 };
  const lines: string[] = [];
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[0];
    if (/^<w:tbl\b/.test(block)) {
      meta.tables = (meta.tables || 0) + 1;
      const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rm: RegExpExecArray | null;
      while ((rm = rowRe.exec(block))) {
        meta.rows = (meta.rows || 0) + 1;
        const cells: string[] = [];
        const cellRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cm: RegExpExecArray | null;
        while ((cm = cellRe.exec(rm[0]))) {
          meta.cells = (meta.cells || 0) + 1;
          cells.push(textFromDocxFragment(cm[0]));
        }
        if (cells.length) lines.push(cells.join("\t"));
      }
    } else {
      meta.paragraphs = (meta.paragraphs || 0) + 1;
      lines.push(textFromDocxFragment(block));
    }
  }
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), meta };
}

function findEntry(entries: ZipEntry[], name: string): ZipEntry | null {
  for (const e of entries) {
    if (e.name === name) return e;
  }
  return null;
}

/** Shared-string pool of an XLSX workbook: `<si>` entries keep their own run order. */
function xlsxText(fragment: unknown): string {
  const out: string[] = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(fragment || "")))) out.push(m[1]);
  return decodeXmlEntities(out.join(""));
}

function parseWorkbook(xml: string): { name: string; rid: string }[] {
  const sheets: { name: string; rid: string }[] = [];
  const re = /<(?:[A-Za-z0-9_]+:)?sheet\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    sheets.push({ name: attr(tag, "name") || "Sheet" + (sheets.length + 1), rid: attr(tag, "r:id") });
  }
  return sheets;
}

function parseRels(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<(?:[A-Za-z0-9_]+:)?Relationship\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) map[id] = target;
  }
  return map;
}

/** Normalize a relationship target into an archive path; anything outside `xl/` is rebased there. */
function resolveXlsxPath(target: unknown): string {
  let t = String(target || "").replace(/\\/g, "/");
  if (t.charAt(0) === "/") t = t.slice(1);
  const stack: string[] = [];
  for (const p of t.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(p);
  }
  let out = stack.join("/");
  if (out.indexOf("xl/") !== 0) out = "xl/" + out;
  return out;
}

/** 0-based column index of an A1-style reference; -1 when the reference has no letters. */
function colIndex(ref: unknown): number {
  const m = String(ref || "").match(/^([A-Za-z]+)/);
  if (!m) return -1;
  const s = m[1].toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * Rows of one sheet as tab-separated lines. Cells are placed by their `r` attribute, so sparse
 * rows keep their columns; a row that runs past `maxRows` stops the whole sheet, not just the row.
 */
function parseSheet(xml: string, shared: string[], meta: ExtractMeta): string[] {
  const lines: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    if ((meta.rows || 0) >= LIMITS.maxRows) {
      meta.truncated = true;
      break;
    }
    meta.rows = (meta.rows || 0) + 1;
    const row: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) {
      if (row.length >= LIMITS.maxCols) {
        meta.truncated = true;
        break;
      }
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      let idx = colIndex(attr(attrs, "r"));
      if (idx < 0) idx = row.length;
      if (idx >= LIMITS.maxCols) {
        meta.truncated = true;
        continue;
      }
      const t = attr(attrs, "t");
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      let val = "";
      if (t === "s") {
        const si = vm ? parseInt(vm[1], 10) : -1;
        val = si >= 0 && si < shared.length ? shared[si] : "";
      } else if (t === "inlineStr") {
        val = xlsxText(inner);
      } else if (t === "b") {
        val = vm && String(vm[1]).trim() === "1" ? "TRUE" : "FALSE";
      } else {
        val = vm ? decodeXmlEntities(vm[1]) : "";
      }
      row[idx] = val;
      meta.cells = (meta.cells || 0) + 1;
    }
    const line = row.map((v) => (v == null ? "" : v)).join("\t").replace(/\t+$/, "");
    lines.push(line);
  }
  return lines;
}

/** Error code/message of a thrown value; values without those fields fall back to the catch site. */
function errorParts(e: unknown, fallbackCode: string): { code: string; message: string } {
  const obj = e && typeof e === "object" ? e : {};
  const code = readProp(obj, "code");
  const message = readProp(obj, "message");
  return {
    code: typeof code === "string" && code ? code : fallbackCode,
    message: typeof message === "string" && message ? message : String(e),
  };
}

export interface DocExtract {
  extractBytes(input: unknown, name?: string, opts?: { maxBytes?: number }): Promise<ExtractResult>;
  extractFile(file: unknown): Promise<ExtractResult>;
  extractDocx(bytes: ByteInput): Promise<ExtractResult>;
  extractXlsx(bytes: ByteInput): Promise<ExtractResult>;
  extractCsv(text: unknown, name?: string): ExtractResult;
  limits: typeof LIMITS;
}

/**
 * Build the extractor. `readZip` is called once per DOCX/XLSX input and may return `null` to mean
 * "reader not loaded"; nothing else is captured.
 */
export function createDocExtract(ports: DocExtractPorts): DocExtract {
  async function extractDocx(bytes: ByteInput): Promise<ExtractResult> {
    const zr = await ports.readZip(toBytes(bytes));
    if (!zr) return fail("ZIP_READER_MISSING", "需要先加载 zip-read.js");
    const doc = findEntry(zr.entries, "word/document.xml");
    if (!doc || !doc.data) return fail("NOT_DOCX", "DOCX 缺少 word/document.xml");
    const parsed = xmlDocxToText(decodeText(doc.data));
    const clipped = clip(parsed.text);
    return {
      ok: true,
      kind: "docx",
      text: clipped.text,
      meta: {
        chars: clipped.text.length,
        paragraphs: parsed.meta.paragraphs,
        tables: parsed.meta.tables,
        rows: parsed.meta.rows,
        cells: parsed.meta.cells,
        truncated: clipped.truncated,
      },
      warnings: zr.warnings || [],
    };
  }

  async function extractXlsx(bytes: ByteInput): Promise<ExtractResult> {
    const zr = await ports.readZip(toBytes(bytes));
    if (!zr) return fail("ZIP_READER_MISSING", "需要先加载 zip-read.js");
    const map = new Map<string, ZipEntry>();
    for (const e of zr.entries) map.set(e.name, e);

    const wb = map.get("xl/workbook.xml");
    if (!wb || !wb.data) return fail("NOT_XLSX", "XLSX 缺少 xl/workbook.xml");
    const sheets = parseWorkbook(decodeText(wb.data));
    if (!sheets.length) return fail("NOT_XLSX", "工作簿里没有工作表");

    const rels = map.get("xl/_rels/workbook.xml.rels");
    const relMap = rels && rels.data ? parseRels(decodeText(rels.data)) : {};

    const shared: string[] = [];
    const ss = map.get("xl/sharedStrings.xml");
    if (ss && ss.data) {
      const ssxml = decodeText(ss.data);
      const siRe = /<si\b[^>]*>[\s\S]*?<\/si>/g;
      let sm: RegExpExecArray | null;
      while ((sm = siRe.exec(ssxml))) shared.push(xlsxText(sm[0]));
    }

    let out: string[] = [];
    const meta: ExtractMeta = { sheets: 0, rows: 0, cells: 0, formulas: 0, truncated: false };
    for (let i = 0; i < sheets.length && i < LIMITS.maxSheets; i++) {
      const sh = sheets[i];
      const target = sh.rid && relMap[sh.rid] ? relMap[sh.rid] : "worksheets/sheet" + (i + 1) + ".xml";
      let entry = map.get(resolveXlsxPath(target));
      if (!entry && map.has("xl/worksheets/sheet" + (i + 1) + ".xml")) {
        entry = map.get("xl/worksheets/sheet" + (i + 1) + ".xml");
      }
      if (!entry || !entry.data) continue;
      meta.sheets = (meta.sheets || 0) + 1;
      const sheetXml = decodeText(entry.data);
      meta.formulas = (meta.formulas || 0) + (sheetXml.match(/<f\b/g) || []).length;
      out.push("# Sheet: " + sh.name);
      out = out.concat(parseSheet(sheetXml, shared, meta));
    }
    if (!meta.sheets) return fail("NOT_XLSX", "找不到任何工作表 XML");

    const clipped = clip(out.join("\n"));
    meta.chars = clipped.text.length;
    meta.truncated = meta.truncated || clipped.truncated;
    return { ok: true, kind: "xlsx", text: clipped.text, meta, warnings: zr.warnings || [] };
  }

  function extractCsv(text: unknown, name?: string): ExtractResult {
    let s = String(text == null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const clipped = clip(s);
    return {
      ok: true,
      kind: /\.tsv$/i.test(String(name || "")) ? "tsv" : "csv",
      text: clipped.text,
      meta: { chars: clipped.text.length, truncated: clipped.truncated },
      warnings: [],
    };
  }

  function extractText(bytes: ByteInput, ext: string): ExtractResult {
    let s = decodeText(bytes);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const clipped = clip(s);
    return {
      ok: true,
      kind: ext || "text",
      text: clipped.text,
      meta: { chars: clipped.text.length, truncated: clipped.truncated },
      warnings: [],
    };
  }

  /**
   * Dispatch by extension. Never throws: a bad file comes back as `{ok:false}` so the caller can
   * attach the code to its own UI without a try/catch.
   */
  async function extractBytes(
    input: unknown,
    name?: string,
    opts?: { maxBytes?: number },
  ): Promise<ExtractResult> {
    try {
      const bytes = toBytes(input);
      const asked = opts && opts.maxBytes ? Number(opts.maxBytes) : 0;
      const maxBytes = asked > 0 ? asked : LIMITS.maxBytes;
      if (bytes.length > maxBytes) {
        return fail("FILE_TOO_LARGE", "文件超过 " + Math.round(maxBytes / 1024 / 1024) + "MB");
      }
      const n = String(name || "").toLowerCase();
      const dot = n.lastIndexOf(".");
      const ext = dot >= 0 ? n.slice(dot + 1) : "";
      if (ext === "docx") return await extractDocx(bytes);
      if (ext === "xlsx" || ext === "xlsm") return await extractXlsx(bytes);
      if (ext === "csv" || ext === "tsv" || ext === "txt" || ext === "md") return extractText(bytes, ext);
      if (ext === "pdf") {
        return fail("PDF_UNSUPPORTED", "PDF 文本层解析需要 pdf.js；v1 未内置第三方库（待拍板）。");
      }
      return fail("UNSUPPORTED_TYPE", "暂不支持的文件类型: " + (ext || "未知"));
    } catch (e) {
      const parts = errorParts(e, "PARSE_ERROR");
      return fail(parts.code, parts.message);
    }
  }

  /** Read a File/Blob: size is checked before the buffer is materialized. */
  async function extractFile(file: unknown): Promise<ExtractResult> {
    if (!file || typeof file !== "object") return fail("BAD_FILE", "没有文件");
    const size = readProp(file, "size");
    if (typeof size === "number" && size > LIMITS.maxBytes) return fail("FILE_TOO_LARGE", "文件超过 20MB");
    try {
      const toBuf = readProp(file, "arrayBuffer");
      if (typeof toBuf !== "function") return fail("BAD_FILE", "当前环境不支持 File.arrayBuffer()");
      const buf = await toBuf.call(file);
      const name = readProp(file, "name");
      return await extractBytes(buf, typeof name === "string" ? name : "");
    } catch (e) {
      const parts = errorParts(e, "READ_ERROR");
      return fail(parts.code, parts.message);
    }
  }

  return { extractBytes, extractFile, extractDocx, extractXlsx, extractCsv, limits: LIMITS };
}
