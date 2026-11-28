/**
 * Merge of the channel table (`cfw_providers_v3`): this device ∩ the cloud copy.
 *
 * Account-level config merges per entity, never per key. A whole-key overwrite is what once wiped a
 * machine's channels and their keys when a phone pushed an empty table up — every rule below exists
 * to keep "deleted on one device" and "configured on the other" from cancelling each other.
 *
 * Pure functions, no DOM and no localStorage; the frozen global lives in
 * tooling/l0/wiring/provider-merge.js. Merge order is always local-then-remote, so ties keep the local copy.
 *
 * Type discipline: no `as`, no `any`. Channel entries are dynamic JSON, so every read goes through
 * a typeof guard plus {@link toRec}; outputs keep the original object identity (toRec is read-side
 * only, the entries stored in byId/out are the inputs themselves).
 * @module services/model-router/provider-merge
 */

/** object → Record, with no assertion: the Object.entries bridge. Read-side only; never returned. */
function toRec(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

/** Input state: every field is `unknown`; merge semantics come from score/pickNewer, not narrowing. */
export interface ProvidersState {
  [key: string]: unknown;
  v?: number;
  activeId?: unknown;
  custom?: unknown;
  presets?: unknown;
  presetsMeta?: unknown;
  deleted?: unknown;
  updatedAt?: unknown;
}

// ── helpers ──

function clone(x: unknown): unknown {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}

/**
 * Completeness of one entry, used only when both sides lack `updatedAt` (data written before the
 * field existed). Both field families count: chat channels use endpoint/apiKey, image channels
 * baseUrl/key. Key outweighs everything — an empty-key copy must never win, otherwise the merge
 * overwrites a working key with "", which is exactly the shape of the 2026-11-13 incident.
 */
function score(p: unknown): number {
  let s = 0;
  if (!p || typeof p !== "object") return s;
  const q = toRec(p);
  if (String(q.endpoint || q.baseUrl || "").trim()) s += 4;
  if (String(q.apiKey || q.key || "").trim()) s += 8;
  if (String(q.model || "").trim()) s += 2;
  if (String(q.name || "").trim() && q.name !== "新服务商") s += 1;
  return s;
}

// `a` is whichever side was inserted first; both merges insert local first, so a tie keeps local.
function pickNewer(a: object, b: object): object {
  const ta = Number(toRec(a).updatedAt || 0);
  const tb = Number(toRec(b).updatedAt || 0);
  if (ta !== tb) return ta > tb ? a : b;
  const sa = score(a);
  const sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  return a; // tie keeps local: that is the copy the user is looking at
}

/**
 * Union of delete tombstones `{id: timestamp}`, keeping the largest timestamp per id; a tombstone
 * at or after an entry's `updatedAt` hides that entry. This is what lets a delete propagate to
 * other devices without an older copy on one of them resurrecting the entry.
 */

function mergeDeleted(a: unknown, b: unknown): { [id: string]: number } {
  const out: { [id: string]: number } = {};
  [a, b].forEach(function (m) {
    if (!m || typeof m !== "object") return;
    const mm = toRec(m);
    Object.keys(mm).forEach(function (k) {
      const v = Number(mm[k] || 0);
      if (!out[k] || v > out[k]) out[k] = v;
    });
  });
  return out;
}

function mergeCustom(localArr: unknown, remoteArr: unknown, deleted: { [id: string]: number }): object[] {
  const byId: { [id: string]: object } = {};
  const order: string[] = [];
  function put(p: unknown): void {
    if (!p || typeof p !== "object") return;
    const rec = toRec(p);
    const idRaw = rec.id;
    if (!idRaw) return;
    const id = String(idRaw);
    if (!byId[id]) { byId[id] = p; order.push(id); return; }
    byId[id] = pickNewer(byId[id], p);
  }
  // Local first: pickNewer returns `a` (local) on a tie, and remote entries can only append.
  const la = Array.isArray(localArr) ? localArr : [];
  const ra = Array.isArray(remoteArr) ? remoteArr : [];
  la.forEach(put);
  ra.forEach(put);
  const out: object[] = [];
  order.forEach(function (id) {
    const p = byId[id];
    const tomb = Number(deleted[id] || 0);
    const born = Number(toRec(p).updatedAt || 0);
    // Tombstone at or after the entry's own timestamp means deleted; an entry edited after the
    // delete (newer updatedAt) survives.
    if (tomb && (!born || tomb >= born)) return;
    out.push(p);
  });
  return out;
}

/**
 * Per-channel model lists: `models` unioned by id, `disabled` unioned with "disabled wins",
 * `fetchedAt` maxed. Returns a fresh object; the local copy is deep-cloned first so the caller's
 * localStorage object is never mutated.
 */
function mergePresets(localP: unknown, remoteP: unknown): { [id: string]: unknown } {
  const cloned = clone(localP) || {};
  const out: { [id: string]: unknown } = (cloned && typeof cloned === "object") ? toRec(cloned) : {};
  const remote = (remoteP && typeof remoteP === "object") ? toRec(remoteP) : {};
  Object.keys(remote).forEach(function (id) {
    const rvRaw = remote[id];
    const rv = rvRaw || {}; // a missing remote entry becomes an empty object, never null
    const r = (rv && typeof rv === "object") ? toRec(rv) : {};
    const lv = out[id];
    if (!lv) { out[id] = clone(rv); return; }
    const l = (lv && typeof lv === "object") ? toRec(lv) : {};
    const seen: { [mid: string]: number } = {};
    const models: unknown[] = [];
    // models is always an array (normModelList output); normalize before concatenating so a
    // hand-edited value cannot throw.
    const lModels = Array.isArray(l.models) ? l.models : [];
    const rModels = Array.isArray(r.models) ? r.models : [];
    lModels.concat(rModels).forEach(function (m) {
      const mid = typeof m === "string" ? m : ((m && typeof m === "object") ? toRec(m).id : undefined);
      if (mid == null || mid === "" || seen[String(mid)]) return;
      seen[String(mid)] = 1;
      models.push(m);
    });
    const dis: { [k: string]: unknown } = {};
    const rDis = (r.disabled && typeof r.disabled === "object") ? toRec(r.disabled) : {};
    const lDis = (l.disabled && typeof l.disabled === "object") ? toRec(l.disabled) : {};
    Object.keys(rDis).forEach(function (k) { dis[k] = rDis[k]; });
    Object.keys(lDis).forEach(function (k) { dis[k] = lDis[k]; });
    out[id] = {
      models: models,
      disabled: dis,
      fetchedAt: Math.max(Number(l.fetchedAt || 0), Number(r.fetchedAt || 0)),
    };
  });
  return out;
}

export function mergeProviders(local: ProvidersState | null, remote: ProvidersState | null): ProvidersState | null {
  if (!local && !remote) return null;
  // One side absent: deep-copy the other and bridge the top level. No reference identity is needed
  // here, and the caller's object must not be handed back for later mutation.
  if (!local) {
    const rc = clone(remote);
    return (rc && typeof rc === "object") ? toRec(rc) : null;
  }
  if (!remote) {
    const lc = clone(local);
    return (lc && typeof lc === "object") ? toRec(lc) : null;
  }
  // The local active selection wins over the remote one; presetsMeta overlays remote then local, so
  // a locally known channel keeps its metadata.
  const deleted = mergeDeleted(local.deleted, remote.deleted);
  return {
    v: 3,
    activeId: local.activeId || remote.activeId || null,
    custom: mergeCustom(local.custom, remote.custom, deleted),
    presets: mergePresets(local.presets, remote.presets),
    presetsMeta: (function () {
      const rm = (remote.presetsMeta && typeof remote.presetsMeta === "object") ? toRec(remote.presetsMeta) : {};
      const lm = (local.presetsMeta && typeof local.presetsMeta === "object") ? toRec(local.presetsMeta) : {};
      const merged: { [id: string]: unknown } = {};
      Object.keys(rm).forEach(function (k) { merged[k] = rm[k]; });
      Object.keys(lm).forEach(function (k) { merged[k] = lm[k]; });
      return merged;
    })(),
    deleted: deleted,
    updatedAt: Math.max(Number(local.updatedAt || 0), Number(remote.updatedAt || 0)),
  };
}

/** Image channels are a plain array (`[{id,...}]`) and follow the same rules, minus tombstones. */
export function mergeImageChannels(localArr: unknown, remoteArr: unknown): object[] {
  const byId: { [id: string]: object } = {};
  const order: string[] = [];
  function put(p: unknown): void {
    if (!p || typeof p !== "object") return;
    const rec = toRec(p);
    const idRaw = rec.id;
    if (!idRaw) return;
    const id = String(idRaw);
    if (!byId[id]) { byId[id] = p; order.push(id); return; }
    byId[id] = pickNewer(byId[id], p);
  }
  // Same as above: local inserted first, ties keep local.
  const la2 = Array.isArray(localArr) ? localArr : [];
  const ra2 = Array.isArray(remoteArr) ? remoteArr : [];
  la2.forEach(put);
  ra2.forEach(put);
  return order.map(function (id) { return byId[id]; });
}

/** Exposed for unit tests; nothing in the app calls the scoring helpers directly. */
export const _score = score;
export const _pickNewer = pickNewer;
