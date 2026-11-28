/**
 * Merge algorithms of the sync engine: the cost ledger's day×device max merge, the chat slot
 * three-way merge with its baseline and tombstone resolution, and the character-card merge shell
 * that delegates to the char-sync-merge module.
 *
 * This fragment is decision-only — it reads local state through the context and returns merged
 * structures; landing them on local storage belongs to the channel fragments. The chat merge's
 * decision tree is kept as one function on purpose: tombstone check, empty-slot rule, one-sided
 * slots and the hash-baseline comparison form a single ordered judgment, and the clock guard
 * (a local slot untouched since the last sync may fast-forward only when the remote meta is
 * genuinely newer) lives in its `base === lHash` branch.
 * @module services/data/sync-merge
 */
import type { ChatConflict, Json, MergedChat, MergedChars } from "./sync";
import { arrOf, recOf } from "./sync";
import { isRec, keysOf, numOf, strOf } from "./sync-context";
import type { SyncContext } from "./sync-context";

/** Public surface of the merge engine; the host facade and the channel fragments call these. */
export interface MergeEngine {
  mergeCostLogs(a: Json, b: Json): Json;
  mergeChatSessions(remote: unknown): MergedChat;
  chatSessionsSig(sessions: Json): string;
  readLocalChars(): Promise<{ chars: unknown[]; affections: unknown[] }>;
  mergeChars(remote: unknown): Promise<MergedChars>;
}

export function createMergeEngine(ctx: SyncContext): MergeEngine {
  const ports = ctx.ports;

  // ── cost: pure merges over the day×device ledger ──

  /**
   * Normalise one day. Days used to be flat `{cost, requests, prompt, completion}`; they are now
   * bucketed per device, and the flat shape is treated as the "legacy" bucket so old logs still
   * merge instead of being dropped.
   */
  function normCostDay(entry: unknown): Json {
    if (!isRec(entry)) return {};
    const rec = recOf(entry);
    if (
      typeof rec["cost"] === "number" ||
      typeof rec["requests"] === "number" ||
      typeof rec["prompt"] === "number" ||
      typeof rec["completion"] === "number"
    ) {
      return { legacy: entry };
    }
    return rec;
  }

  function mergeCostModels(a: Json, b: Json): Json {
    const out: Json = {};
    const names = new Set<string>();
    keysOf(a).forEach((n) => names.add(n));
    keysOf(b).forEach((n) => names.add(n));
    names.forEach((name) => {
      const x = recOf(a[name]);
      const y = recOf(b[name]);
      out[name] = {
        cost: Math.max(numOf(x["cost"]), numOf(y["cost"])),
        prompt: Math.max(numOf(x["prompt"]), numOf(y["prompt"])),
        completion: Math.max(numOf(x["completion"]), numOf(y["completion"])),
        requests: Math.max(numOf(x["requests"]), numOf(y["requests"])),
        estimated: Math.max(numOf(x["estimated"]), numOf(y["estimated"])),
      };
    });
    return out;
  }

  /**
   * Merge by day × device, taking the max of every counter. Max rather than sum is what makes the
   * operation idempotent: a device that pushes the same day twice must not double its own usage,
   * while two devices contributing different buckets still add up.
   */
  function mergeCostLogs(a: Json, b: Json): Json {
    const out: Json = {};
    const days = new Set<string>();
    keysOf(a).forEach((d) => days.add(d));
    keysOf(b).forEach((d) => days.add(d));
    days.forEach((day) => {
      const da = normCostDay(a[day]);
      const db = normCostDay(b[day]);
      const devs = new Set<string>();
      keysOf(da).forEach((d) => devs.add(d));
      keysOf(db).forEach((d) => devs.add(d));
      const merged: Json = {};
      devs.forEach((dev) => {
        const ea = recOf(da[dev]);
        const eb = recOf(db[dev]);
        merged[dev] = {
          cost: Math.max(numOf(ea["cost"]), numOf(eb["cost"])),
          prompt: Math.max(numOf(ea["prompt"]), numOf(eb["prompt"])),
          completion: Math.max(numOf(ea["completion"]), numOf(eb["completion"])),
          requests: Math.max(numOf(ea["requests"]), numOf(eb["requests"])),
          estimated: Math.max(numOf(ea["estimated"]), numOf(eb["estimated"])),
          models: mergeCostModels(recOf(ea["models"]), recOf(eb["models"])),
        };
      });
      out[day] = merged;
    });
    return out;
  }

  // ── chat: per-slot three-way merge ──

  function slotMetaOf(meta: Json, updatedAt: number): Json {
    return {
      updatedAt: typeof updatedAt === "number" && updatedAt >= 0 ? updatedAt : ctx.now(),
      deviceId: strOf(meta["deviceId"]) || ctx.chatDeviceId(),
    };
  }

  /**
   * Per-slot merge with a three-way baseline. Each slot carries updatedAt + deviceId, and
   * `cfw_chat_synced_v1` holds the hash each slot had at the last successful sync:
   *  - local hash still equals the base → the remote moved → fast-forward to remote;
   *  - remote hash equals the base → the local moved → keep local;
   *  - neither matches → a real conflict, handed to the panel for the user to judge.
   * Deletion is a tombstone, resolved by deletedAt against updatedAt, so an edit after a delete
   * resurrects the conversation.
   */
  function mergeChatSessions(remote: unknown): MergedChat {
    const localSessions = ctx.getChatSessions();
    const localMeta = ctx.getChatSlotMeta();
    const localTomb = ctx.getChatTomb();
    const localConv = ctx.getConvMetaMap();
    const synced = ctx.getChatSynced();
    const r = recOf(remote);
    const rSlots = recOf(r["slots"]);
    const rMsgs = recOf(r["msgs"]);
    const rTomb = recOf(r["tombstones"]);
    const rConv = recOf(r["convMeta"]);

    const outTomb: Json = {};
    const tombKeys = new Set<string>();
    keysOf(localTomb).forEach((k) => tombKeys.add(k));
    keysOf(rTomb).forEach((k) => tombKeys.add(k));
    tombKeys.forEach((k) => {
      const la = numOf(recOf(localTomb[k])["deletedAt"]) || -1;
      const ra = numOf(recOf(rTomb[k])["deletedAt"]) || -1;
      outTomb[k] = ra >= la ? rTomb[k] : localTomb[k];
    });

    const outSessions: Json = {};
    const outMeta: Json = {};
    const conflicts: ChatConflict[] = [];
    // An excluded slot neither merges nor uploads: "clear the cloud, keep this device" depends on
    // both halves.
    const excluded = new Set<string>(ctx.getExcluded().sessions);
    const slotKeys = new Set<string>();
    keysOf(localSessions).forEach((k) => slotKeys.add(k));
    keysOf(rSlots).forEach((k) => slotKeys.add(k));

    slotKeys.forEach((k) => {
      if (excluded.has(k)) return;
      const localArr = Array.isArray(localSessions[k]) ? arrOf(localSessions[k]) : null;
      const remoteArr = Array.isArray(rMsgs[k]) ? arrOf(rMsgs[k]) : null;
      const lMeta = recOf(localMeta[k]);
      const rMeta = recOf(rSlots[k]);
      const lUpd = typeof lMeta["updatedAt"] === "number" ? numOf(lMeta["updatedAt"]) : localArr ? 0 : -1;
      const rUpd = typeof rMeta["updatedAt"] === "number" ? numOf(rMeta["updatedAt"]) : remoteArr ? 0 : -1;
      const baseRaw = recOf(synced[k])["hash"];
      const base = typeof baseRaw === "string" ? baseRaw : null;
      const lHash = localArr ? ctx.hashStr(JSON.stringify(localArr)) : null;
      const rHash = remoteArr ? ctx.hashStr(JSON.stringify(remoteArr)) : strOf(rMeta["hash"]) || null;

      const tomb = outTomb[k];
      if (isRec(tomb)) {
        const deletedAt = numOf(recOf(tomb)["deletedAt"]);
        if (typeof recOf(tomb)["deletedAt"] === "number" && deletedAt >= lUpd && deletedAt >= rUpd) return;
        if (lUpd > deletedAt || rUpd > deletedAt) delete outTomb[k];
      }

      // An empty array is not a delete signal: whichever side still has messages wins. Only a
      // tombstone removes a conversation.
      const lEmpty = localArr !== null && localArr.length === 0;
      const rEmpty = remoteArr !== null && remoteArr.length === 0;
      if (lEmpty && remoteArr && !rEmpty) {
        outSessions[k] = remoteArr;
        outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : ctx.now(), deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (rEmpty && localArr && !lEmpty) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (localArr && !remoteArr) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (!localArr && remoteArr) {
        outSessions[k] = remoteArr;
        outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : ctx.now(), deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (!localArr || !remoteArr) return;

      if (lHash === rHash) {
        outSessions[k] = localArr;
        outMeta[k] = lUpd >= rUpd ? slotMetaOf(lMeta, lUpd) : { updatedAt: rUpd, deviceId: strOf(rMeta["deviceId"]) };
        return;
      }
      if (base && lHash === base) {
        // updatedAt comes from each device's own clock, and the server's LWW trusts it. A local
        // slot untouched since the last sync may fast-forward only when the remote meta is
        // genuinely newer: otherwise a device with a skewed clock can park stale content in the
        // cloud and have it silently poured back here, losing messages.
        if (rUpd > lUpd) {
          outSessions[k] = remoteArr;
          outMeta[k] = { updatedAt: rUpd >= 0 ? rUpd : ctx.now(), deviceId: strOf(rMeta["deviceId"]) };
          return;
        }
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      if (base && rHash === base) {
        outSessions[k] = localArr;
        outMeta[k] = slotMetaOf(lMeta, lUpd);
        return;
      }
      conflicts.push({
        slotKey: k,
        localMsgs: localArr,
        remoteMsgs: remoteArr,
        localUpdatedAt: lUpd,
        remoteUpdatedAt: rUpd,
        localCount: localArr.length,
        remoteCount: remoteArr.length,
      });
      outSessions[k] = localArr;
      outMeta[k] = slotMetaOf(lMeta, lUpd);
    });

    const outConv: Json = {};
    const convBases = new Set<string>();
    keysOf(rConv).forEach((b) => convBases.add(b));
    keysOf(localConv).forEach((b) => convBases.add(b));
    convBases.forEach((b) => {
      outConv[b] = Object.assign({}, recOf(rConv[b]), recOf(localConv[b]));
    });
    return { sessions: outSessions, slotMeta: outMeta, tomb: outTomb, convMeta: outConv, conflicts: conflicts };
  }

  /** Order-independent fingerprint of the whole slot set; detects "did the merge change anything". */
  function chatSessionsSig(sessions: Json): string {
    const keys = keysOf(sessions).sort();
    return keys.map((k) => k + ":" + ctx.hashStr(JSON.stringify(sessions[k]))).join("|");
  }

  // ── chars: local read and the merge shell over the char-sync-merge module ──

  async function readLocalChars(): Promise<{ chars: unknown[]; affections: unknown[] }> {
    const dumped = await ports.idb.dump(ctx.CHARS_DB);
    const data = recOf(dumped);
    return { chars: arrOf(data["chars"]), affections: arrOf(data["affections"]) };
  }

  async function mergeChars(remote: unknown): Promise<MergedChars> {
    const local = await readLocalChars();
    const charMerge = ports.charMerge();
    if (!charMerge || typeof charMerge.mergeCharsState !== "function") throw new Error("角色卡合并模块未加载");
    const merged = recOf(
      charMerge.mergeCharsState({
        localCards: local.chars,
        localAffections: local.affections,
        localMeta: ctx.getCharsMeta(),
        localTomb: ctx.getCharsTomb(),
        remote: remote,
        synced: ctx.getCharsSynced(),
        excluded: new Set<string>(ctx.getExcluded().roles),
        deviceId: ctx.chatDeviceId(),
        hashFn: ctx.hashStr,
        now: ctx.now(),
      }),
    );
    return {
      cards: recOf(merged["cards"]),
      meta: recOf(merged["meta"]),
      affections: recOf(merged["affections"]),
      tomb: recOf(merged["tomb"]),
      synced: recOf(merged["synced"]),
      conflicts: arrOf(merged["conflicts"]),
    };
  }

  return {
    mergeCostLogs: mergeCostLogs,
    mergeChatSessions: mergeChatSessions,
    chatSessionsSig: chatSessionsSig,
    readLocalChars: readLocalChars,
    mergeChars: mergeChars,
  };
}
