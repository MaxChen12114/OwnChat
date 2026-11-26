/**
 * Local album: every image this browser produced, kept as blobs so a provider link that expires
 * tomorrow still works. It fills itself by watching successful image responses, which is why no
 * caller has to remember to archive anything.
 *
 * Two response shapes are captured, and only those: a synchronous generation (its `data[]` entries)
 * and a task poll that finally carries a file URL. The async submit endpoint is skipped on purpose —
 * it answers with a job handle, not an image.
 *
 * Dedupe is by URL hash, and the album is capped: past the cap the oldest entries go. `_seen` is a
 * session-level shortcut so a repeated poll of the same URL does not hit the database at all, while
 * the database itself is the durable dedupe.
 *
 * The database, the download, the fetch wrapper and the modal all live in the wiring; this module is
 * the policy — what to capture, what to drop, in which order.
 * @module services/image/album
 */

export const DB_NAME = "cfw_image_album";
export const STORE = "items";
export const MAX_ITEMS = 60;
export const PROMPT_LIMIT = 200;

export type CaptureKind = "generation" | "task";

export interface AlbumAdd {
  url: string;
  prompt: string;
}

export interface AlbumItem {
  id: string;
  url: string;
  prompt: string;
  ts: number;
  blob: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

/** djb2-xor over UTF-16 code units, backwards; the same scheme the image cache uses. */
export function hashId(url: string): string {
  let h = 5381;
  let i = url.length;
  while (i) {
    h = (h * 33) ^ url.charCodeAt(--i);
  }
  return "a" + (h >>> 0).toString(36);
}

/**
 * Which capture rule applies to this request, if any. The async submit is excluded because its
 * response is a job handle; the poll that follows is what actually sees an image.
 */
export function captureKind(url: string, method: string): CaptureKind | null {
  const u = str(url);
  const m = str(method || "GET").toUpperCase();
  if (m === "POST" && u.indexOf("images/generations") !== -1 && u.indexOf("async/") === -1) return "generation";
  if (m === "GET" && u.indexOf("/img/v1/task/") !== -1) return "task";
  return null;
}

/** Every image URL in a generation response, in order; a b64 payload becomes a data URL. */
export function generationItems(json: unknown, prompt: unknown): AlbumAdd[] {
  const data = recOf(json).data;
  const list = Array.isArray(data) ? data : [];
  const p = str(prompt).slice(0, PROMPT_LIMIT);
  const out: AlbumAdd[] = [];
  for (const d of list) {
    const rec = recOf(d);
    const url = str(rec.url) || (str(rec.b64_json) ? "data:image/png;base64," + str(rec.b64_json) : "");
    if (url) out.push({ url: url, prompt: p });
  }
  return out;
}

/** The file URL of a finished task, if this poll carries one. */
export function taskItem(json: unknown): AlbumAdd | null {
  const j = recOf(json);
  const direct = recOf(j.output);
  const nested = recOf(recOf(j.raw).output);
  const url = str(direct.file_url) || str(nested.file_url);
  return url ? { url: url, prompt: "edit" } : null;
}

/** Prompt from a request body, capped; a malformed body simply has no prompt. */
export function promptOf(body: unknown): string {
  if (typeof body !== "string" || !body) return "";
  try {
    return str(recOf(JSON.parse(body)).prompt).slice(0, PROMPT_LIMIT);
  } catch (e) {
    return "";
  }
}

/**
 * Ids that must go to stay within the cap: the oldest first. Returns an empty list when the album
 * is already small enough, so the caller can skip the deletes entirely.
 */
export function evictIds(items: AlbumItem[], max: number): string[] {
  const limit = max > 0 ? max : MAX_ITEMS;
  if (items.length <= limit) return [];
  const ordered = items.slice().sort((a, b) => a.ts - b.ts);
  return ordered.slice(0, items.length - limit).map((it) => it.id);
}

/** Newest first — the order the grid renders in. */
export function newestFirst(items: AlbumItem[]): AlbumItem[] {
  return items.slice().sort((a, b) => b.ts - a.ts);
}
