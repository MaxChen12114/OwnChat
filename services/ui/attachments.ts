/**
 * Chat attachment domain rules, minus the browser: the pending-attachment state machine, the
 * message metadata shaping, token estimation, and the request-assembly expansion that turns
 * stored attachment metadata into payload content (fenced file blocks, vision image arrays).
 *
 * Non-obvious choice: document full texts never enter session storage — messages carry only
 * {id,name,chars,truncated}; the full text lives in the unified `attachments` store (via the
 * injected getText/getBlob ports) plus an in-page memo that covers the async write window, and
 * expansion re-fetches it on every send. This keeps the 2MB localStorage session slot from being
 * overflowed by a single paste, which used to evict the oldest messages (= real data loss).
 *
 * The wiring (browser adapter appended by l0/emit.mjs) owns the storage backends, DOM rendering,
 * the lightbox gestures and the frozen attach facade; everything here is pure and vm-testable.
 * @module services/ui/attachments
 */

/** Single-document character cap for request assembly (the only source of truth). */
export const ATT_MAX_CHARS = 100000;

export interface AttFileMeta {
  id?: string;
  name?: string;
  chars?: number;
  truncated?: boolean;
  text?: string;
}

export interface AttImageMeta {
  id?: string;
  name?: string;
  dataUrl?: string;
  w?: number;
  h?: number;
  blob?: Blob | null;
}

/** Input for addText; chars is intentionally unknown because callers pass raw file metadata. */
export interface AttTextItem {
  name?: string;
  chars?: unknown;
  truncated?: boolean;
  text?: unknown;
}

export interface AttImageItem {
  name?: string;
  dataUrl?: string;
  blob?: Blob | null;
  w?: number;
  h?: number;
}

export interface AttMetaLike {
  files?: AttFileMeta[];
  images?: AttImageMeta[];
  _memImages?: AttImageMeta[];
}

/**
 * Browser ports injected by the wiring. putBlob must never throw synchronously (its caller
 * wraps the Blob construction in the same try as before); getBlob resolves null instead of
 * rejecting when a device does not hold the blob. getText is the fast path for text attachments
 * (the SQL store keeps them in a text column); absent or null means "fall back to getBlob".
 */
export interface AttachCoreHost {
  putBlob: (id: string, blob: Blob | null, name?: string) => Promise<boolean> | boolean;
  getBlob: (id: string) => Promise<Blob | null>;
  getText?: (id: string) => Promise<string | null>;
  onPendingChange: () => void;
}

export interface AttPendingText {
  id: string;
  kind: "text";
  name: string;
  chars: number;
  truncated: boolean;
  text?: string;
}

export interface AttPendingImage {
  id: string;
  kind: "image";
  name: string;
  dataUrl: string;
  blob: Blob | null;
  w: number;
  h: number;
}

export type AttPending = AttPendingText | AttPendingImage;

export interface AttTaken {
  files?: Array<{ id: string; name: string; chars: number; truncated: boolean }>;
  images?: Array<{ id: string; name: string; w: number; h: number }>;
  /** dataUrl-bearing images for this render only; never persisted into the session. */
  _memImages: AttPendingImage[];
}

export interface AttachCore {
  list(): AttPending[];
  count(): number;
  countImages(): number;
  clear(): void;
  remove(id: string): void;
  addText(item: AttTextItem): void;
  addImage(item: AttImageItem): AttPendingImage;
  takePending(): AttTaken;
  restage(msg: unknown): number;
  imageDataUrl(meta: AttImageMeta | null | undefined): Promise<string>;
  fileFullText(f: AttFileMeta | null | undefined): Promise<string>;
  fmtChars(n: unknown): string;
  fmtBytes(n: unknown): string;
  attHasAny(att: AttMetaLike | null | undefined): boolean;
  attMeta(att: AttMetaLike | null | undefined): Record<string, unknown>;
  attMaxChars(): number;
  /** Throws when estimate is missing — silent zero would understate request cost. */
  attFileTokens(att: AttMetaLike | null | undefined, estimate?: (text: string) => number): number;
  expandAttachmentMessages(msgs: unknown): Promise<unknown>;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const isRecArray = (v: unknown): v is Rec[] => Array.isArray(v);
const isFileMeta = (v: unknown): v is AttFileMeta => isRec(v);
const isImageMeta = (v: unknown): v is AttImageMeta => isRec(v);

function uid(): string {
  return "att_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function parseIntSafe(n: unknown): number {
  return parseInt(String(n ?? ""), 10) || 0;
}

/** Human character counts; the units are user-visible copy and stay localized. */
export function fmtChars(n: unknown): string {
  const v = parseIntSafe(n);
  if (v >= 10000) return (Math.round(v / 1000) / 10) + " 万字";
  if (v >= 1000) return (Math.round(v / 100) / 10) + " 千字";
  return v + " 字";
}

/** Human byte sizes; thresholds follow the 1024 ladder, rounding mirrors the legacy math. */
export function fmtBytes(n: unknown): string {
  const v = parseIntSafe(n);
  if (v >= 1048576) return (Math.round(v / 104857.6) / 10) + "MB";
  if (v >= 1024) return Math.round(v / 102.4) / 10 + "KB";
  return v + "B";
}

export function extOf(name: unknown): string {
  const m = String(name || "").match(/\.([A-Za-z0-9]{1,6})$/);
  return m ? String(m[1]).toLowerCase() : "";
}

/** File-type chip palette (colored doc icon + filename pill, not one flat gray). */
const TYPE_COLORS: Array<[RegExp, string]> = [
  [/^(pdf)$/, "#e0453a"],
  [/^(docx?|rtf|odt|pages)$/, "#2b6cb0"],
  [/^(pptx?|key)$/, "#d9480f"],
  [/^(xlsx?|csv|tsv|ods|numbers)$/, "#2f9e44"],
  [/^(md|markdown|mdx|rst|txt|text|log)$/, "#6b7280"],
  [/^(json|jsonc|json5|ya?ml|toml|ini|conf|env|xml)$/, "#a16207"],
  [/^(html?|css|scss|less|vue|svelte)$/, "#0891b2"],
  [/^(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|graphql|gql|lua|dart|swift|r|pl)$/, "#587a9d"]
];

export function typeColor(name: unknown): string {
  const e = extOf(name);
  for (const [re, color] of TYPE_COLORS) {
    if (re.test(e)) return color;
  }
  return "#6b7280";
}

const FENCE = "\x60\x60\x60"; // triple backticks (never spelled bare in this source)

export function createAttachmentsCore(host: AttachCoreHost): AttachCore {
  const pending: AttPending[] = [];
  const _textMemo = new Map<string, string>();

  function list(): AttPending[] {
    return pending.slice();
  }
  function count(): number {
    return pending.length;
  }
  // Images only: they have a separate quota (vision request body / token cost) and must not
  // be crowded out by text attachments.
  function countImages(): number {
    let n = 0;
    for (const p of pending) if (p.kind === "image") n++;
    return n;
  }
  function clear(): void {
    pending.length = 0;
    host.onPendingChange();
  }
  function remove(id: string): void {
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].id === id) {
        pending.splice(i, 1);
        break;
      }
    }
    host.onPendingChange();
  }
  function addText(item: AttTextItem): void {
    const id = uid();
    const text = String(item.text == null ? "" : item.text);
    _textMemo.set(id, text);
    try {
      host.putBlob(id, new Blob([text], { type: "text/plain;charset=utf-8" }), item.name || "未命名");
    } catch (_) {
      // Blob construction can fail in non-browser realms; the memo below still covers the send.
    }
    pending.push({
      id: id, kind: "text", name: item.name || "未命名",
      chars: parseIntSafe(item.chars),
      truncated: !!item.truncated
    });
    host.onPendingChange();
  }
  function addImage(item: AttImageItem): AttPendingImage {
    const p: AttPendingImage = {
      id: uid(), kind: "image", name: item.name || "图片",
      dataUrl: item.dataUrl || "", blob: item.blob || null,
      w: item.w || 0, h: item.h || 0
    };
    pending.push(p);
    if (p.blob) host.putBlob(p.id, p.blob, p.name);
    host.onPendingChange();
    return p;
  }

  /**
   * Drain the pending list into the shapes a sent message needs. files/images carry metadata
   * only (the full text lives in the store/memo, fetched back via fileFullText) so the session
   * store is never overflowed by document bodies; _memImages exists for this render only.
   */
  function takePending(): AttTaken {
    const files: Array<{ id: string; name: string; chars: number; truncated: boolean }> = [];
    const images: AttPendingImage[] = [];
    const imagesMeta: Array<{ id: string; name: string; w: number; h: number }> = [];
    for (const p of pending) {
      if (p.kind === "text") {
        files.push({ id: p.id, name: p.name, chars: p.chars, truncated: p.truncated });
      } else {
        images.push(p);
        imagesMeta.push({ id: p.id, name: p.name, w: p.w || 0, h: p.h || 0 });
      }
    }
    pending.length = 0;
    host.onPendingChange();
    return {
      files: files.length ? files : undefined,
      images: imagesMeta.length ? imagesMeta : undefined,
      _memImages: images
    };
  }

  /**
   * Put a sent message's attachments back into the pending list (the retry path). New-format
   * files (with id) reuse the original id — the blob is already stored, no re-ingest; legacy
   * files (with inline text) are restaged as-is and read from f.text during expansion.
   */
  function restage(msg: unknown): number {
    const m = isRec(msg) ? msg : {};
    let n = 0;
    const files = Array.isArray(m.files) ? m.files.filter(isFileMeta) : [];
    for (const f of files) {
      if (f.id) {
        pending.push({
          id: f.id, kind: "text", name: f.name || "未命名",
          chars: parseIntSafe(f.chars), truncated: !!f.truncated
        });
      } else {
        pending.push({
          id: uid(), kind: "text", name: f.name || "未命名",
          chars: parseIntSafe(f.chars), truncated: !!f.truncated,
          text: String(f.text == null ? "" : f.text)
        });
      }
      n++;
    }
    const images = Array.isArray(m.images) ? m.images.filter(isImageMeta) : [];
    for (const im of images) {
      // Reuse the original id: the image blob is already stored and can be fetched
      // back to a dataURL at send time.
      pending.push({ id: im.id || uid(), kind: "image", name: im.name || "图片", dataUrl: "", blob: null, w: im.w || 0, h: im.h || 0 });
      n++;
    }
    if (n) host.onPendingChange();
    return n;
  }

  function blobToDataUrl(blob: Blob | null): Promise<string> {
    return new Promise((res) => {
      if (!blob) {
        res("");
        return;
      }
      try {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ""));
        fr.onerror = () => res("");
        fr.readAsDataURL(blob);
      } catch (_) {
        res("");
      }
    });
  }

  function imageDataUrl(meta: AttImageMeta | null | undefined): Promise<string> {
    if (!meta) return Promise.resolve("");
    if (meta.dataUrl) return Promise.resolve(meta.dataUrl);
    if (meta.id) return host.getBlob(meta.id).then(blobToDataUrl);
    return Promise.resolve("");
  }

  /**
   * Fetch a document's full text: in-page memo first (covers the async store-write race for
   * texts added this page load), then the legacy inline f.text (historical sessions), then the
   * store's text column (getText), then the Blob body. Empty string when nothing is available —
   * never rejects.
   */
  async function fileFullText(f: AttFileMeta | null | undefined): Promise<string> {
    if (!f) return "";
    if (f.id && _textMemo.has(f.id)) return _textMemo.get(f.id) || "";
    if (typeof f.text === "string") return f.text;
    if (f.id) {
      try {
        if (typeof host.getText === "function") {
          const text = await host.getText(f.id);
          if (text != null) return text;
        }
        const b = await host.getBlob(f.id);
        if (b) return await b.text();
      } catch (_) {
        // fall through to empty
      }
    }
    return "";
  }

  function attHasAny(att: AttMetaLike | null | undefined): boolean {
    return !!(att && ((att.files && att.files.length) || (att.images && att.images.length)));
  }

  /** Metadata persisted into the message (no _memImages — that is per-render memory only). */
  function attMeta(att: AttMetaLike | null | undefined): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    if (att && att.files && att.files.length) o.files = att.files;
    if (att && att.images && att.images.length) o.images = att.images;
    return o;
  }

  function attMaxChars(): number {
    return ATT_MAX_CHARS;
  }

  /**
   * Token estimate for attachment texts (images go through the vision chain and are not
   * estimated client-side). New format approximates synchronously as min(chars, cap) — chars
   * counts the original text while a truncated send carries only the cap, so min() is the
   * real occupancy; legacy format (inline f.text) uses the injected estimator, whose
   * implementation lives in chat/context and is deliberately not duplicated here.
   */
  function attFileTokens(att: AttMetaLike | null | undefined, estimate?: (text: string) => number): number {
    if (!att || !att.files || !att.files.length) return 0;
    if (typeof estimate !== "function") throw new Error("attFileTokens 需要注入 estimateTokens");
    let n = 0;
    for (const f of att.files) {
      if (typeof f.chars === "number" && f.chars) n += Math.min(f.chars, attMaxChars());
      else n += estimate("【文件:" + f.name + "】" + (f.text || ""));
    }
    return n;
  }

  /**
   * Request-assembly expansion (memory-only; the session is never rewritten, so retry and
   * refresh cannot lose anything):
   *   · files — only the LATEST message carrying files expands full texts; earlier file
   *     messages keep the first 1000 chars. Before the storage migration every historical file
   *     message resent its full text each turn (cost x turns, blowing the upstream context
   *     in 2-3 turns on large docs).
   *   · images — only the last user message expands, into the vision array.
   */
  async function expandAttachmentMessages(msgs: unknown): Promise<unknown> {
    const arr: Rec[] = isRecArray(msgs) ? msgs : [];
    let lastUser = -1;
    let lastFilesUser = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (m && m.role === "user") {
        if (lastUser < 0) lastUser = i;
        if (lastFilesUser < 0 && Array.isArray(m.files) && m.files.length) lastFilesUser = i;
      }
    }
    if (lastUser < 0) return arr;
    const attLimit = attMaxChars();
    const EXCERPT = 1000;
    let changed = false;
    const out = arr.slice();
    for (let j = 0; j < out.length; j++) {
      const m = out[j];
      if (!m || m.role !== "user") continue;
      const hasFiles = Array.isArray(m.files) && m.files.length > 0;
      const hasImgs = j === lastUser && Array.isArray(m.images) && m.images.length > 0;
      if (!hasFiles && !hasImgs) continue;
      let text = typeof m.content === "string" ? m.content : "";
      if (hasFiles) {
        const isLatest = j === lastFilesUser;
        const blocks: string[] = [];
        const files: AttFileMeta[] = Array.isArray(m.files) ? m.files.filter(isFileMeta) : [];
        for (const f of files) {
          let body = "";
          try {
            body = await fileFullText(f);
          } catch (_) {
            body = typeof f.text === "string" ? f.text : "";
          }
          const note: string[] = [];
          if (f.truncated) note.push("(内容过长,已截断到前 " + attLimit + " 字)");
          if (!isLatest && body.length > EXCERPT) {
            body = body.slice(0, EXCERPT);
            note.push("(较早上传的长文档,正文已省略 —— 完整全文仅在刚上传后的回合提供;需要可重新上传或分批粘贴)");
          }
          blocks.push("【文件:" + f.name + "】\n" + FENCE + "\n" + body + "\n" + FENCE + (note.length ? "\n" + note.join(" ") : ""));
        }
        text = text ? text + "\n\n" + blocks.join("\n\n") : blocks.join("\n\n");
      }
      let content: unknown = text;
      if (hasImgs) {
        const urls: string[] = [];
        const images: AttImageMeta[] = Array.isArray(m.images) ? m.images.filter(isImageMeta) : [];
        for (const im of images) {
          let u = "";
          try {
            u = await imageDataUrl(im);
          } catch (_) {
            // missing blob -> skip this image
          }
          if (u) urls.push(u);
        }
        if (urls.length) {
          const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: text }];
          for (const x of urls) parts.push({ type: "image_url", image_url: { url: x } });
          content = parts;
        }
      }
      // Deliberately keep only role/content: passing files/images back through the payload
      // would duplicate the full text one more time.
      out[j] = { role: m.role, content: content };
      changed = true;
    }
    return changed ? out : arr;
  }

  return {
    list, count, countImages, clear, remove,
    addText, addImage,
    takePending, restage,
    imageDataUrl, fileFullText,
    fmtChars, fmtBytes,
    attHasAny, attMeta, attMaxChars,
    attFileTokens,
    expandAttachmentMessages
  };
}
