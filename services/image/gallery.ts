/**
 * Workshop gallery: the local record of images a user chose to keep, with the blob cache that makes
 * a thumbnail survive the provider link expiring.
 *
 * The metadata is an append-only list with tombstones, kept in localStorage because it is small and
 * must survive a reload without waiting on a database. A deleted entry stays in the list with
 * `deleted: true` and a fresh timestamp instead of being spliced out — that is what makes a delete
 * reconcilable later, and it is why every read goes through one visibility filter.
 *
 * The cloud gallery routes this used to call are gone; the "uploaded" branch is kept only so older
 * entries that still carry a key keep rendering. Everything new is `local`, cached under a
 * per-item key, and the module says so out loud rather than pretending there is a server.
 * @module services/image/gallery
 */

export const LS_META = "cfw_image_gallery_v1";
export const IDB_NAME = "cfw_image_gallery";
export const IDB_STORE = "blobs";
export const EMPTY_TEXT = "(无提示词)";
export const EMPTY_GRID_TEXT = "画廊还是空的。生成图片后点图片上的「收藏」即可存入,开了云同步还能跨设备。";

export interface GalleryItem {
  id: string;
  key: string;
  url: string;
  src: string;
  kind: string;
  prompt: string;
  ts: number;
  deleted: boolean;
  local: boolean;
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

/** Stored metadata, defensively: a broken value is an empty gallery, never a crash on load. */
export function parseMeta(raw: string | null): GalleryItem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x === "object").map(toItem);
  } catch (e) {
    return [];
  }
}

function toItem(v: unknown): GalleryItem {
  const o = recOf(v);
  return {
    id: str(o.id),
    key: str(o.key),
    url: str(o.url),
    src: str(o.src),
    kind: str(o.kind),
    prompt: str(o.prompt),
    ts: typeof o.ts === "number" ? o.ts : 0,
    deleted: o.deleted === true,
    local: o.local !== false
  };
}

/** Everything the grid may show: tombstones are excluded here and nowhere else. */
export function visible(items: GalleryItem[]): GalleryItem[] {
  return items.filter((it) => it && !it.deleted);
}

/** A new entry for a favourite. Newest first, so it goes on top. */
export function makeItem(o: {
  id: string;
  src: string;
  kind?: string;
  prompt?: string;
  ts: number;
}): GalleryItem {
  return {
    id: o.id,
    key: "",
    url: o.src,
    src: o.src,
    kind: str(o.kind),
    prompt: str(o.prompt),
    ts: o.ts,
    deleted: false,
    local: true
  };
}

export function addItem(items: GalleryItem[], item: GalleryItem): GalleryItem[] {
  return [item].concat(items);
}

/**
 * Mark one entry deleted and bump its timestamp. Returns the same list when the id is unknown, so
 * the caller can skip the write.
 */
export function tombstone(items: GalleryItem[], id: string, ts: number): GalleryItem[] {
  let hit = false;
  const out = items.map((it) => {
    if (it.id !== id) return it;
    hit = true;
    return { id: it.id, key: it.key, url: it.url, src: it.src, kind: it.kind, prompt: it.prompt, ts: ts, deleted: true, local: it.local };
  });
  return hit ? out : items;
}

/** Blob cache key: entries that came with a remote key use it, local ones are namespaced by id. */
export function cacheKeyOf(item: GalleryItem): string {
  return item.key || "local:" + item.id;
}

/** Caption under a tile; the trim keeps an empty kind from leaving a leading space. */
export function metaTextOf(item: GalleryItem): string {
  const t = (str(item.kind) + " " + str(item.prompt)).trim();
  return t || EMPTY_TEXT;
}

/** Where the thumbnail comes from when the cache misses. */
export function fallbackUrlOf(item: GalleryItem): string {
  return item.url || item.src || "";
}

/** Download URL for the cache fill: a keyed entry is already ours, a source URL goes via the proxy. */
export function downloadUrlOf(item: GalleryItem): string {
  return item.key ? item.url : "/img/dl?url=" + encodeURIComponent(item.src);
}
