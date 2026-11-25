/**
 * Conversation registry: id shape, the flat `{ convId: meta }` table, which conversation is
 * current, the per-device main conversation and its dedupe, restoring a conversation's remembered
 * character, and assembling the rows the sidebar list needs.
 *
 * Message persistence is explicitly not here — that belongs to the session store. Neither is any
 * UI orchestration: switching, creating, renaming and deleting are the app's business, and this
 * module only keeps the registry consistent underneath them.
 *
 * Storage keys are unchanged on purpose. To `/sync/chat` they are opaque strings, so keeping them
 * means the sync contract does not move when this module does.
 * @module services/conv/store
 */

export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A registry entry; its fields are the caller's business, not this module's. */
export type MetaEntry = { [k: string]: unknown };
export type Msg = Record<string, unknown>;
export type MsgArr = Msg[];
export type Card = Record<string, unknown>;

export interface ConvStoreHost {
  getDeviceId?(): string;
  getAllSessions?(): Record<string, MsgArr>;
  saveAllSessions?(all: Record<string, MsgArr>): void;
  getMemSlots?(): Record<string, MsgArr>;
  writeChatTombstone?(slotKey: string): void;
  getActiveCard?(): Card | null;
  setActiveCardId?(id: unknown): void;
  toast?(msg: string, ms?: number): void;
  recordMeta?(convId: string, patch: Record<string, unknown>, kind?: string): void;
}

export interface ConvStorePorts {
  storage: KvStorage;
}

export interface ConvListItem {
  convId: string;
  name: string;
  charId: string;
  charName: string;
  charIcon: string;
  charAvatar: string;
  preview: string;
  count: number;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  running: boolean;
}

export interface ConvStore {
  LS_CONV_ACTIVE: string;
  LS_CONV_META: string;
  newConvId(): string;
  isConvId(id: string): boolean;
  loadActiveConvRaw(): string;
  setActiveConvId(id: string): void;
  loadConvMeta(): Record<string, MetaEntry>;
  saveConvMeta(m: Record<string, MetaEntry>): void;
  touchConv(convId: string, patch?: Record<string, unknown>): void;
  convCharId(convId: string): unknown;
  setConvCharId(convId: string, charId: unknown): void;
  getMainConvId(): string;
  ensureDefaultConv(): string;
  dedupeDefaultConvs(): void;
  activeConvId(): string;
  reconcileDuplicateMains(): void;
  currentSlotKey(): string;
  applyConvChar(convId: string): void;
  activeCardId(): unknown;
  buildConversationList(o?: {
    all?: Record<string, MsgArr>;
    meta?: Record<string, MetaEntry>;
    cur?: string;
    session?: MsgArr;
    memSlots?: Record<string, MsgArr>;
    cards?: Card[];
    isRunning?(id: string): boolean;
  }): ConvListItem[];
}

/** object to Record, bridged through Object.entries; entries carry no reference identity. */
function toRecord(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

/** One level deeper: a non-object entry reads as an empty one, as it always has. */
function toMeta(o: object): Record<string, MetaEntry> {
  const out: Record<string, MetaEntry> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = (typeof v === "object" && v !== null && !Array.isArray(v)) ? toRecord(v) : {};
  }
  return out;
}

export function createConvStore(ports: ConvStorePorts, host?: ConvStoreHost): ConvStore {
  const h = host || {};
  const storage = ports.storage;
  const LS_CONV_ACTIVE = "cfw_conv_active_v1"; // device-local, never synced (protected in sync)
  const LS_CONV_META = "cfw_conv_meta_v1";     // flat { [convId]: { name, createdAt, updatedAt, charId } }

  const getDeviceId = typeof h.getDeviceId === "function" ? h.getDeviceId : function () { return "dev_unknown"; };
  const getAllSessions = typeof h.getAllSessions === "function" ? h.getAllSessions : function () { return {}; };
  const saveAllSessions = typeof h.saveAllSessions === "function" ? h.saveAllSessions : function () {};
  const getMemSlots = typeof h.getMemSlots === "function" ? h.getMemSlots : function () { return {}; };
  const writeChatTombstone = typeof h.writeChatTombstone === "function" ? h.writeChatTombstone : function () {};
  const getActiveCard = typeof h.getActiveCard === "function" ? h.getActiveCard : function () { return null; };
  const setActiveCardId = typeof h.setActiveCardId === "function" ? h.setActiveCardId : function () {};
  const toast = typeof h.toast === "function" ? h.toast : function () {};
  const recordMeta = typeof h.recordMeta === "function" ? h.recordMeta : function () {};

  const CONV_PREFIX = "c_";
  const MAIN_CONV_PREFIX = "c_main_";

  function newConvId(): string { return CONV_PREFIX + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6); }
  function isConvId(id: string): boolean { return typeof id === "string" && id.indexOf(CONV_PREFIX) === 0; }
  function loadActiveConvRaw(): string { try { return storage.getItem(LS_CONV_ACTIVE) || ""; } catch { return ""; } }
  function setActiveConvId(id: string): void { try { if (id) storage.setItem(LS_CONV_ACTIVE, id); else storage.removeItem(LS_CONV_ACTIVE); } catch {} }

  function loadConvMeta(): Record<string, MetaEntry> {
    try {
      const m: unknown = JSON.parse(storage.getItem(LS_CONV_META) || "{}");
      return (typeof m === "object" && m !== null && !Array.isArray(m)) ? toMeta(m) : {};
    } catch { return {}; }
  }
  function saveConvMeta(m: Record<string, MetaEntry>): void { try { storage.setItem(LS_CONV_META, JSON.stringify(m)); } catch {} }

  function activeCardId(): unknown {
    try {
      const c = getActiveCard();
      return c && c.id ? c.id : "";
    } catch { return ""; }
  }

  // Write or update one registry entry; the timestamps are maintained here and nowhere else.
  function touchConv(convId: string, patch?: Record<string, unknown>): void {
    if (!isConvId(convId)) return;
    const meta = loadConvMeta();
    const prev = meta[convId] || {};
    meta[convId] = Object.assign({ name: "新对话", createdAt: Date.now() }, prev, patch || {}, { updatedAt: Date.now() });
    saveConvMeta(meta);
  }
  function convCharId(convId: string): unknown {
    const m = loadConvMeta();
    const e = m[convId];
    return (e && e.charId) || "";
  }
  function setConvCharId(convId: string, charId: unknown): void {
    if (!isConvId(convId)) return;
    const before = convCharId(convId);
    const next = charId || "";
    touchConv(convId, { charId: next });
    if (before === next) return; // switching conversations re-records the same value: no event
    recordMeta(convId, { charId: next }, "meta");
  }

  // The per-device main conversation has a derived id. A random one would let two tabs each create
  // their own "main" conversation on first run.
  function getMainConvId(): string { return MAIN_CONV_PREFIX + getDeviceId(); }

  // The current conversation, created when missing: first run, deletion, or a broken registry.
  function ensureDefaultConv(): string {
    const raw = loadActiveConvRaw();
    if (isConvId(raw)) {
      const meta = loadConvMeta();
      if (meta[raw]) return raw;
      const sess = getAllSessions()[raw];
      if (Array.isArray(sess)) { touchConv(raw, { name: "主对话" }); return raw; } // messages but no entry: register, do not drop
    }
    const id = getMainConvId();
    if (!loadConvMeta()[id]) touchConv(id, { name: "主对话", charId: activeCardId() });
    setActiveConvId(id);
    return id;
  }

  // One-shot dedupe for the era of random main ids: keep the current empty main and drop the rest.
  // Only conversations that are empty everywhere are touched.
  function dedupeDefaultConvs(): void {
    try {
      if (storage.getItem("cfw_conv_dedup_v1") === "1") return;
      const cur = loadActiveConvRaw();
      const all = getAllSessions();
      const meta = loadConvMeta();
      const memSlots = getMemSlots();
      let n = 0;
      Object.keys(meta).forEach(function (k) {
        if (!isConvId(k) || k === cur) return;
        const e = meta[k] || {};
        if (e.name !== "主对话") return;
        if (Array.isArray(all[k]) && all[k].length) return; // 有消息的不动
        delete meta[k];
        delete all[k];
        delete memSlots[k];
        n++;
      });
      if (n) {
        saveConvMeta(meta);
        if (Object.keys(all).length) saveAllSessions(all);
        console.log("[conv] 已合并重复的空默认会话:", n, "条");
      }
      storage.setItem("cfw_conv_dedup_v1", "1");
    } catch {}
  }

  function activeConvId(): string { ensureDefaultConv(); reconcileDuplicateMains(); return loadActiveConvRaw() || ensureDefaultConv(); }

  // Merge duplicate empty main conversations, checked on every touch. The "more than one" guard is
  // what keeps the last remaining main from being deleted. Kept in this order: the current one,
  // then the canonical id, then the oldest.
  function reconcileDuplicateMains(): void {
    try {
      const meta = loadConvMeta();
      const all = getAllSessions();
      const memSlots = getMemSlots();
      const cur = loadActiveConvRaw();
      const isEmptyMain = function (k: string): boolean {
        const e = meta[k] || {};
        const lsArr = all[k];
        const memArr = memSlots[k];
        return isConvId(k) && e.name === "主对话" &&
          (!Array.isArray(lsArr) || lsArr.length === 0) &&
          (!Array.isArray(memArr) || memArr.length === 0);
      };
      const mains = Object.keys(meta).filter(isEmptyMain);
      if (mains.length <= 1) return; // a single one is not a duplicate
      const mainId = getMainConvId();
      const keep = mains.indexOf(cur) >= 0 ? cur
        : (mains.indexOf(mainId) >= 0 ? mainId
          : mains.slice().sort(function (a, b) {
            const ea = meta[a] || {};
            const eb = meta[b] || {};
            return (numOf(ea.createdAt) || 0) - (numOf(eb.createdAt) || 0);
          })[0]);
      const dups = mains.filter(function (k) { return k !== keep; });
      dups.forEach(function (k) { delete meta[k]; delete all[k]; delete memSlots[k]; writeChatTombstone(k); });
      saveConvMeta(meta);
      saveAllSessions(all);
      console.log("[conv] 已合并重复的空主对话:", dups.length, "条(保留", keep, ")");
    } catch {}
  }

  function numOf(v: unknown): number { return typeof v === "number" ? v : 0; }

  function currentSlotKey(): string { return activeConvId(); }

  // Apply the conversation's remembered character as the active one.
  function applyConvChar(convId: string): void {
    try {
      const want = convCharId(convId);
      const cur = activeCardId();
      if (want && want !== cur) {
        setActiveCardId(want);
        // Say so once when a remembered character comes back; the field itself travels with sync,
        // so the switch can arrive from another device.
        try {
          const c = getActiveCard() || null;
          if (c && c.name) toast("已按「会话记住的角色」切到 " + c.name + "（不是刚选的；左栏角色面板可换）", 4200);
        } catch {}
      } else if (!want && cur) {
        // Switching to a conversation with no character must unset the current one, or the card
        // leaks across conversations.
        setActiveCardId("");
      }
    } catch {}
  }

  // Sidebar rows: pure assembly and ordering. No UI in this module.
  function buildConversationList(o?: {
    all?: Record<string, MsgArr>;
    meta?: Record<string, MetaEntry>;
    cur?: string;
    session?: MsgArr;
    memSlots?: Record<string, MsgArr>;
    cards?: Card[];
    isRunning?(id: string): boolean;
  }): ConvListItem[] {
    const a = o || {};
    const all = a.all || {};
    const meta = a.meta || {};
    const cur = a.cur || "";
    const sessionArr: MsgArr = Array.isArray(a.session) ? a.session : [];
    const memSlots = a.memSlots || {};
    const cards: Card[] = Array.isArray(a.cards) ? a.cards : [];
    const cardOf = function (id: unknown): Card | null {
      for (const c of cards) { if (c && c.id === id) return c; }
      return null;
    };
    const ids = new Set(Object.keys(meta).filter(isConvId));
    for (const k of Object.keys(all)) if (isConvId(k)) ids.add(k);
    for (const k of Object.keys(memSlots)) if (isConvId(k)) ids.add(k); // 还没落盘的运行期会话也要列出来
    const out: ConvListItem[] = [];
    ids.forEach(function (id) {
      const cached = (id === cur) ? sessionArr : (Array.isArray(memSlots[id]) ? memSlots[id] : null);
      const arr: MsgArr = cached || (Array.isArray(all[id]) ? all[id] : []);
      const m = meta[id] || {};
      let preview = "";
      for (let i = arr.length - 1; i >= 0; i--) {
        const row = arr[i];
        if (row && row.content) { preview = String(row.content).replace(/\s+/g, " ").slice(0, 60); break; }
      }
      const card = m.charId ? cardOf(m.charId) : null;
      out.push({
        convId: id,
        name: typeof m.name === "string" && m.name ? m.name : "新对话",
        charId: m.charId ? String(m.charId) : "",
        charName: card ? (typeof card.name === "string" ? card.name : "") : (m.charId ? "(角色已删除)" : ""),
        charIcon: card ? (typeof card.icon === "string" ? card.icon : "") : "",
        charAvatar: card ? (typeof card.avatar === "string" ? card.avatar : "") : "",
        preview: preview,
        count: arr.length,
        createdAt: numOf(m.createdAt) || 0,
        updatedAt: numOf(m.updatedAt) || numOf(m.createdAt) || 0,
        active: id === cur,
        running: typeof a.isRunning === "function" ? !!a.isRunning(id) : false,
      });
    });
    out.sort(function (x, y) {
      if (x.active !== y.active) return x.active ? -1 : 1;
      const xu = x.count ? x.updatedAt : 0, yu = y.count ? y.updatedAt : 0;
      if (xu !== yu) return yu - xu;
      return (y.createdAt || 0) - (x.createdAt || 0);
    });
    return out;
  }

  return {
    LS_CONV_ACTIVE, LS_CONV_META,
    newConvId, isConvId, loadActiveConvRaw, setActiveConvId,
    loadConvMeta, saveConvMeta, touchConv, convCharId, setConvCharId,
    getMainConvId, ensureDefaultConv, dedupeDefaultConvs, activeConvId,
    reconcileDuplicateMains, currentSlotKey, applyConvChar, activeCardId,
    buildConversationList,
  };
}
