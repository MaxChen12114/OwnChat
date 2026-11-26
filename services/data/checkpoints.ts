/**
 * Checkpoints: one append-only record per saved state, with content-addressed payloads.
 *
 * The `scope` is the only behaviour switch:
 *   - `roleplay`: a conversation's messages + character/affection/scene state;
 *   - `work`: a manifest of agent-workspace file versions (`{path, version}`), no copied text;
 *   - `sandbox`: a deterministic simulation snapshot (tick/entities/RNG), owned by sim-kernel.
 *
 * The store itself never interprets a payload. `kind` is a label (`manual`, `auto`,
 * `pre-restore`, …), not a behaviour; pruning, restore and UI grouping key off `scope`.
 *
 * No DOM, no storage globals: every platform piece arrives as a port, so the tests drive it with
 * maps and a fixed digest. `captureRoleplay` / `applyRoleplay` are the roleplay adapter; `work` and
 * `sandbox` adapters land separately.
 * @module services/data/checkpoints
 */

export type CheckpointScope = "roleplay" | "work" | "sandbox";

/** The three scopes the product exposes; a new one needs a restore adapter before it may be added. */
export const CHECKPOINT_SCOPES: CheckpointScope[] = ["roleplay", "work", "sandbox"];

/** Per-scope retention defaults. A checkpoint is small; the payload may not be. */
export const CHECKPOINT_CAPS: Record<CheckpointScope, number> = {
  roleplay: 30,
  work: 100,
  sandbox: 20,
};

/** Same shape as the agent workspace's FileStore; classic artifacts cannot share imports. */
export interface FileStore {
  all(): Promise<Record<string, unknown>[]>;
  get(id: string): Promise<Record<string, unknown> | null>;
  put(row: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
  removeWhere(match: (row: Record<string, unknown>) => boolean): Promise<number>;
  clear(): Promise<void>;
}

export interface CheckpointStorePorts {
  store: FileStore;
  blobs: FileStore;
  /** Content hash of the serialized payload; rejects when the platform has no digest. */
  digest: (text: string) => Promise<string>;
  now: () => number;
  /** Injectable id source for tests. */
  newId?: () => string;
  caps?: Partial<Record<CheckpointScope, number>>;
}

export interface CheckpointOptions {
  subject?: unknown;
  kind?: unknown;
  parentId?: unknown;
  meta?: unknown;
}

export interface CheckpointRow {
  id: string;
  scope: CheckpointScope;
  scopeId: string;
  subject: string;
  kind: string;
  ts: number;
  parentId: string | null;
  hash: string;
  bytes: number;
  meta: Record<string, unknown>;
}

export interface CheckpointStore {
  put(scope: unknown, scopeId: unknown, payload: unknown, opts?: CheckpointOptions): Promise<unknown>;
  list(scope: unknown, scopeId: unknown, limit?: unknown): Promise<unknown>;
  get(id: unknown): Promise<unknown>;
  remove(id: unknown): Promise<unknown>;
  removeScope(scope: unknown, scopeId: unknown): Promise<unknown>;
  clear(): Promise<unknown>;
}

function strOf(value: unknown): string {
  return value == null ? "" : String(value);
}

function numOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function isScope(value: unknown): value is CheckpointScope {
  return value === "roleplay" || value === "work" || value === "sandbox";
}

function rowOf(value: unknown): CheckpointRow | null {
  const r = recOf(value);
  const scope = r["scope"];
  if (!isScope(scope)) return null;
  const id = strOf(r["id"]);
  const scopeId = strOf(r["scopeId"]);
  if (!id || !scopeId) return null;
  return {
    id,
    scope,
    scopeId,
    subject: strOf(r["subject"]),
    kind: strOf(r["kind"]) || "manual",
    ts: numOf(r["ts"]),
    parentId: r["parentId"] == null ? null : strOf(r["parentId"]),
    hash: strOf(r["hash"]),
    bytes: numOf(r["bytes"]),
    meta: recOf(r["meta"]),
  };
}

function blobId(scope: CheckpointScope, scopeId: string, hash: string): string {
  return scope + "::" + scopeId + "::" + hash;
}

function defaultId(ts: number): string {
  return "ck_" + ts.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

/**
 * Build the generic checkpoint store. Every call returns a result object; a storage or digest
 * failure is reported, never thrown at the caller.
 */
export function createCheckpointStore(ports: CheckpointStorePorts): CheckpointStore {
  const caps: Record<CheckpointScope, number> = {
    roleplay: CHECKPOINT_CAPS.roleplay,
    work: CHECKPOINT_CAPS.work,
    sandbox: CHECKPOINT_CAPS.sandbox,
  };
  for (const scope of CHECKPOINT_SCOPES) {
    const raw = ports.caps && ports.caps[scope];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) caps[scope] = Math.floor(raw);
  }

  function rows(): Promise<CheckpointRow[]> {
    return ports.store.all()
      .then((list) => list.map(rowOf).filter((r): r is CheckpointRow => r !== null))
      .catch(() => []);
  }

  function forScope(list: CheckpointRow[], scope: CheckpointScope, scopeId: string): CheckpointRow[] {
    return list
      .filter((r) => r.scope === scope && r.scopeId === scopeId)
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  }

  async function gc(scope: CheckpointScope, scopeId: string): Promise<void> {
    try {
      const remaining = forScope(await rows(), scope, scopeId);
      const used = new Set(remaining.map((r) => r.hash));
      const blobs = await ports.blobs.all().catch(() => []);
      for (const raw of blobs) {
        const b = recOf(raw);
        if (strOf(b["scope"]) !== scope || strOf(b["scopeId"]) !== scopeId) continue;
        const hash = strOf(b["hash"]);
        if (hash && !used.has(hash)) {
          try { await ports.blobs.remove(strOf(b["id"])); } catch (_e) { /* best effort */ }
        }
      }
    } catch (_e) { /* best effort */ }
  }

  async function prune(scope: CheckpointScope, scopeId: string): Promise<void> {
    const list = forScope(await rows(), scope, scopeId);
    const keep = caps[scope];
    for (let i = keep; i < list.length; i++) {
      try { await ports.store.remove(list[i].id); } catch (_e) { /* best effort */ }
    }
    await gc(scope, scopeId);
  }

  async function put(scope: unknown, scopeId: unknown, payload: unknown, opts?: CheckpointOptions): Promise<unknown> {
    if (!isScope(scope)) return { ok: false, error: "未知 scope（只允许 roleplay/work/sandbox）" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    let text: string;
    try {
      const json = JSON.stringify(payload);
      if (typeof json !== "string") return { ok: false, error: "payload 不可序列化" };
      text = json;
    } catch (_e) {
      return { ok: false, error: "payload 不可序列化" };
    }
    let hash: string;
    try {
      hash = strOf(await ports.digest(text));
      if (!hash) return { ok: false, error: "digest 返回空" };
    } catch (_e) {
      return { ok: false, error: "内容哈希不可用" };
    }
    const o = opts || {};
    const ts = numOf(ports.now()) || Date.now();
    const id = typeof ports.newId === "function" ? strOf(ports.newId()) : defaultId(ts);
    if (!id) return { ok: false, error: "checkpoint id 为空" };
    const row: CheckpointRow = {
      id,
      scope,
      scopeId: sid,
      subject: strOf(o.subject),
      kind: strOf(o.kind) || "manual",
      ts,
      parentId: o.parentId == null ? null : strOf(o.parentId),
      hash,
      bytes: text.length,
      meta: recOf(o.meta),
    };
    try {
      const bid = blobId(scope, sid, hash);
      const existing = await ports.blobs.get(bid).catch(() => null);
      if (!existing) {
        await ports.blobs.put({ id: bid, scope, scopeId: sid, hash, content: text, bytes: text.length });
      }
      await ports.store.put({ ...row });
    } catch (_e) {
      return { ok: false, error: "checkpoint 写入失败" };
    }
    await prune(scope, sid);
    return { ok: true, id, hash, scope, scopeId: sid, ts, bytes: text.length };
  }

  async function list(scope: unknown, scopeId: unknown, limit?: unknown): Promise<unknown> {
    if (!isScope(scope)) return { ok: false, error: "未知 scope" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    const max = Math.max(1, Math.min(100, numOf(limit) || 20));
    const all = forScope(await rows(), scope, sid);
    return {
      ok: true,
      scope,
      scopeId: sid,
      total: all.length,
      checkpoints: all.slice(0, max).map((r) => ({
        id: r.id,
        subject: r.subject,
        kind: r.kind,
        ts: r.ts,
        parentId: r.parentId,
        bytes: r.bytes,
        meta: r.meta,
      })),
    };
  }

  async function get(id: unknown): Promise<unknown> {
    const cid = strOf(id);
    if (!cid) return { ok: false, error: "checkpoint id 不能为空" };
    const raw = await ports.store.get(cid).catch(() => null);
    const row = raw ? rowOf(raw) : null;
    if (!row) return { ok: false, error: "checkpoint 不存在" };
    const blob = await ports.blobs.get(blobId(row.scope, row.scopeId, row.hash)).catch(() => null);
    if (!blob) return { ok: false, error: "checkpoint 正文已清理" };
    const text = strOf(recOf(blob)["content"]);
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch (_e) { return { ok: false, error: "checkpoint 正文损坏" }; }
    return { ok: true, checkpoint: { ...row }, payload };
  }

  async function remove(id: unknown): Promise<unknown> {
    const cid = strOf(id);
    if (!cid) return { ok: false, error: "checkpoint id 不能为空" };
    const raw = await ports.store.get(cid).catch(() => null);
    const row = raw ? rowOf(raw) : null;
    if (!row) return { ok: false, error: "checkpoint 不存在" };
    try { await ports.store.remove(cid); } catch (_e) { return { ok: false, error: "checkpoint 删除失败" }; }
    await gc(row.scope, row.scopeId);
    return { ok: true, id: cid };
  }

  async function removeScope(scope: unknown, scopeId: unknown): Promise<unknown> {
    if (!isScope(scope)) return { ok: false, error: "未知 scope" };
    const sid = strOf(scopeId);
    if (!sid) return { ok: false, error: "scopeId 不能为空" };
    let removed = 0;
    try {
      removed = await ports.store.removeWhere((row) => {
        const r = recOf(row);
        return strOf(r["scope"]) === scope && strOf(r["scopeId"]) === sid;
      });
    } catch (_e) { return { ok: false, error: "checkpoint 清理失败" }; }
    try {
      await ports.blobs.removeWhere((row) => {
        const r = recOf(row);
        return strOf(r["scope"]) === scope && strOf(r["scopeId"]) === sid;
      });
    } catch (_e) { /* blob cleanup is best effort */ }
    return { ok: true, removed };
  }

  async function clear(): Promise<unknown> {
    try {
      await ports.store.clear();
      await ports.blobs.clear();
      return { ok: true };
    } catch (_e) {
      return { ok: false, error: "checkpoint 全清失败" };
    }
  }

  return { put, list, get, remove, removeScope, clear };
}

export interface RoleplayHost {
  getMessages(): unknown[];
  /** Return false when the host refuses (a live turn owns the array). */
  setMessages(messages: unknown[]): void | boolean | Promise<void | boolean>;
  getActiveCharId(): string;
  /** May resolve after a card refresh; affection must not be written before it settles. */
  setActiveCharId(id: string): void | Promise<void>;
  getRelation(): string;
  setRelation(value: string): void;
  getEmotion(): string;
  setEmotion(value: string): void;
  getAffection(): number | null;
  setAffection(value: number | null): void | Promise<void>;
  getSceneIds(): string[];
  setSceneIds(ids: string[]): void;
  getPriorSummary(): string;
  setPriorSummary(text: string): void;
}

/** The roleplay payload: messages + the four state-layer sources the user asked for. */
export function captureRoleplay(host: RoleplayHost): Record<string, unknown> {
  const messages = Array.isArray(host.getMessages()) ? host.getMessages().slice() : [];
  const sceneIds = Array.isArray(host.getSceneIds()) ? host.getSceneIds().filter((id) => typeof id === "string" && id) : [];
  const affection = host.getAffection();
  return {
    messages,
    activeCharId: strOf(host.getActiveCharId()),
    relation: strOf(host.getRelation()),
    emotion: strOf(host.getEmotion()),
    affection: typeof affection === "number" && Number.isFinite(affection) ? affection : null,
    sceneIds,
    priorSummary: strOf(host.getPriorSummary()),
  };
}

/**
 * Apply a roleplay payload. Order is deliberate: the active card first (relation/emotion/affection
 * act on it), then the scene in one write, then the summary chip. Returns false on any refusal.
 */
export async function applyRoleplay(payload: unknown, host: RoleplayHost): Promise<boolean> {
  const p = recOf(payload);
  const messages = Array.isArray(p["messages"]) ? p["messages"] : [];
  try {
    const ok = await host.setMessages(messages);
    if (ok === false) return false;
    // `setActiveId` refreshes the card asynchronously; affection would hit the old card if we
    // wrote it before the refresh settled.
    await host.setActiveCharId(strOf(p["activeCharId"]));
    host.setRelation(strOf(p["relation"]));
    host.setEmotion(strOf(p["emotion"]));
    const rawAffection = p["affection"];
    await host.setAffection(rawAffection == null || rawAffection === "" ? null : numOf(rawAffection));
    const sceneIds = Array.isArray(p["sceneIds"])
      ? p["sceneIds"].filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    host.setSceneIds(sceneIds);
    host.setPriorSummary(strOf(p["priorSummary"]));
    return true;
  } catch (_e) {
    return false;
  }
}
