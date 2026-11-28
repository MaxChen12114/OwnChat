(function () {
/**
 * Character-sync merge policy: per-card last-write-wins on top of a tombstone layer, plus the one
 * rule plain LWW cannot express — with a sync baseline present and both sides edited the same card
 * to different content, the remote copy stays canonical and the local one is cloned into a
 * "conflict copy" rather than overwritten silently.
 *
 * Pure by construction: no storage, no clock, no module-level state. `now`, `deviceId` and `hashFn`
 * arrive from the caller, so replaying one input yields one output. The single exception is the
 * conflict-copy id, which carries `Math.random` to stay unique when two merges land in one
 * millisecond; nothing downstream may depend on that id being reproducible.
 *
 * A first sync (no baseline) still takes the newer side. Inventing a conflict on day one would only
 * teach users to dismiss the banner.
 * @module services/sync/char-sync-merge
 */

                                    

/** One local card that lost to the remote copy; `copyId` is the id of the clone kept locally. */
                                    
             
                 
                    
                     
 

/** Merged state, shaped exactly like the blobs the sync engine stores. */
                                       
              
             
                   
             
               
                                 
 

/** Every field is `unknown`: the caller hands over parsed localStorage / remote JSON unchecked. */
                                      
                       
                            
                      
                      
                   
                   
                     
                     
                
                   
                        
 

function recOf(value         )       {
  const out       = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

function cardsOf(value         )            {
  const out            = [];
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function strOf(value         )         {
  return value == null ? "" : String(value);
}

function isRec(value         )          {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** FNV-1a, base36. Same digest the sync engine uses for its baseline fingerprints. */
function charSyncHash32(input         )         {
  const text = String(input == null ? "" : input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Callers may pass their own digest (tests do, to keep fixtures readable). Anything that is not a
 * function falls back to the built-in one instead of throwing: a broken hash must not block a sync
 * that the user asked for.
 */
function pickHashFn(value         )                           {
  if (typeof value !== "function") return charSyncHash32;
  return function (text        )         {
    return String(value(text));
  };
}

function updatedAtOf(meta      , card         , missing        )         {
  return typeof meta.updatedAt === "number" ? meta.updatedAt : card ? 0 : missing;
}

/**
 * Merge one device's character state with the remote blob.
 *
 * @param input Local cards / affections / meta / tombstones, the remote blob, the last-synced
 *   baseline, and the excluded id set. All optional; missing pieces merge as empty.
 * @returns The merged blobs plus `conflicts`, one entry per card that produced a local clone.
 *   Tombstones already dominated by a newer edit are dropped from the result, and a card deleted
 *   on both sides leaves no trace in `cards` / `meta` / `synced`.
 */
function mergeCharsState(input                      )                       {
  const opts                      = input || {};

  const localCards = cardsOf(opts.localCards);
  const localAffs = cardsOf(opts.localAffections);
  const localMeta = recOf(opts.localMeta);
  const localTomb = recOf(opts.localTomb);
  const remote = isRec(opts.remote) ? recOf(opts.remote) : {};
  const rCards = recOf(remote.cards);
  const rMeta = recOf(remote.meta);
  const rAff = recOf(remote.affections);
  const rTomb = recOf(remote.tombstones);
  const synced = recOf(opts.synced);
  const excluded = opts.excluded instanceof Set
    ? opts.excluded
    : new Set         (Array.isArray(opts.excluded) ? opts.excluded : []);
  const deviceId = String(opts.deviceId || "dev");
  const now = Number(opts.now) || Date.now();
  const hashFn = pickHashFn(opts.hashFn);
  const label = String(opts.deviceLabel || ("设备 " + deviceId.slice(-4)));

  const localCardMap       = {};
  const localAffMap       = {};
  for (let i = 0; i < localCards.length; i++) {
    const card = recOf(localCards[i]);
    const id = strOf(card.id);
    if (id) localCardMap[id] = card;
  }
  for (let j = 0; j < localAffs.length; j++) {
    const aff = recOf(localAffs[j]);
    const cardId = strOf(aff.cardId);
    if (cardId) localAffMap[cardId] = aff;
  }

  const outTomb       = {};
  const tombKeys = Object.keys(localTomb).concat(Object.keys(rTomb));
  for (let t = 0; t < tombKeys.length; t++) {
    const key = tombKeys[t];
    if (outTomb[key]) continue;
    const localOne = localTomb[key];
    const remoteOne = rTomb[key];
    const localDeleted = isRec(localOne) && typeof recOf(localOne).deletedAt === "number" ? recOf(localOne).deletedAt : -1;
    const remoteDeleted = isRec(remoteOne) && typeof recOf(remoteOne).deletedAt === "number" ? recOf(remoteOne).deletedAt : -1;
    outTomb[key] = Number(remoteDeleted) >= Number(localDeleted) ? remoteOne : localOne;
  }

  const outCards       = {};
  const outMeta       = {};
  const outSynced       = {};
  const outAffs       = {};
  const conflicts                      = [];

  const ids       = {};
  for (const id of Object.keys(localCardMap)) ids[id] = 1;
  for (const id of Object.keys(rCards)) ids[id] = 1;

  for (const id of Object.keys(ids)) {
    const lCard = isRec(localCardMap[id]) ? recOf(localCardMap[id]) : null;
    const rCard = isRec(rCards[id]) ? recOf(rCards[id]) : null;
    const lm = recOf(localMeta[id]);
    const rm = recOf(rMeta[id]);
    const lUpd = updatedAtOf(lm, lCard, -1);
    const rUpd = updatedAtOf(rm, rCard, -1);

    if (excluded.has(id)) {
      if (lCard) {
        outCards[id] = lCard;
        outMeta[id] = { updatedAt: Math.max(lUpd, 0), deviceId: lm.deviceId || deviceId };
        outSynced[id] = { hash: hashFn(JSON.stringify(lCard)), syncedAt: now };
      }
      continue;
    }

    const tomb = recOf(outTomb[id]);
    const tombAt = typeof tomb.deletedAt === "number" ? tomb.deletedAt : null;
    if (tombAt !== null && tombAt >= lUpd && tombAt >= rUpd) {
      delete outTomb[id];
      delete outSynced[id];
      continue;
    }
    if (tombAt !== null && (lUpd > tombAt || rUpd > tombAt)) delete outTomb[id];

    if (lCard && !rCard) {
      outCards[id] = lCard;
      outMeta[id] = { updatedAt: Math.max(lUpd, 0), deviceId: lm.deviceId || deviceId };
      outSynced[id] = { hash: hashFn(JSON.stringify(lCard)), syncedAt: now };
      continue;
    }
    if (!lCard && rCard) {
      outCards[id] = rCard;
      outMeta[id] = { updatedAt: Math.max(rUpd, 0), deviceId: rm.deviceId || "" };
      outSynced[id] = { hash: rm.hash || hashFn(JSON.stringify(rCard)), syncedAt: now };
      continue;
    }
    if (!lCard || !rCard) continue;

    const lHash = hashFn(JSON.stringify(lCard));
    const rHash = strOf(rm.hash) || hashFn(JSON.stringify(rCard));
    const base = synced[id] === undefined ? "" : strOf(recOf(synced[id]).hash);

    if (base && lHash !== base && rHash !== base && lHash !== rHash) {
      outCards[id] = rCard;
      outMeta[id] = { updatedAt: Math.max(rUpd, 0), deviceId: rm.deviceId || "" };
      outSynced[id] = { hash: rHash, syncedAt: now };

      const copy       = {};
      for (const key of Object.keys(lCard)) copy[key] = lCard[key];
      const copyId = id + "_conflict_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 6);
      copy.id = copyId;
      copy.name = strOf(lCard.name) || "角色";
      copy.name = String(copy.name) + "（冲突副本 " + label + " " + new Date(now).toLocaleString() + "）";
      if (String(copy.name).length > 240) copy.name = String(copy.name).slice(0, 240);
      const copyHash = hashFn(JSON.stringify(copy));
      outCards[copyId] = copy;
      outMeta[copyId] = { updatedAt: now, deviceId: deviceId, hash: copyHash, conflictOf: id };
      outSynced[copyId] = { hash: copyHash, syncedAt: now };
      if (localAffMap[id]) {
        const aff = recOf(localAffMap[id]);
        outAffs[copyId] = { cardId: copyId, value: aff.value, updatedAt: now };
      }
      conflicts.push({
        id: id,
        copyId: copyId,
        localName: strOf(lCard.name),
        remoteName: strOf(rCard.name),
      });
      continue;
    }

    if (rUpd > lUpd) {
      outCards[id] = rCard;
      outMeta[id] = { updatedAt: rUpd, deviceId: rm.deviceId || "" };
      outSynced[id] = { hash: rHash, syncedAt: now };
    } else {
      outCards[id] = lCard;
      outMeta[id] = { updatedAt: Math.max(lUpd, 0), deviceId: lm.deviceId || deviceId };
      outSynced[id] = { hash: lHash, syncedAt: now };
    }
  }

  const affIds       = {};
  for (const id of Object.keys(localAffMap)) affIds[id] = 1;
  for (const id of Object.keys(rAff)) affIds[id] = 1;
  for (const id of Object.keys(affIds)) {
    if (!outCards[id]) continue;
    const localOne = recOf(localAffMap[id]);
    const remoteOne = recOf(rAff[id]);
    const localAff = localAffMap[id] ? { value: localOne.value, updatedAt: localOne.updatedAt || 0 } : null;
    const remoteAff = rAff[id] ? { value: remoteOne.value, updatedAt: remoteOne.updatedAt || 0 } : null;
    if (localAff && remoteAff) {
      outAffs[id] = Number(remoteAff.updatedAt) >= Number(localAff.updatedAt) ? remoteAff : localAff;
    } else {
      outAffs[id] = localAff || remoteAff;
    }
  }

  return {
    cards: outCards,
    meta: outMeta,
    affections: outAffs,
    tomb: outTomb,
    synced: outSynced,
    conflicts: conflicts,
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/sync/char-sync-merge.ts.
//
// The merge is pure and storage-free; this file publishes it under a non-frozen bridge that the
// cloud-sync engine reads through its `charMerge` port. The port is looked up lazily on every merge,
// so load order against services/data/sync.js does not matter — only that this artifact ran once.
(function () {
  "use strict";

  window.charSyncMerge = { mergeCharsState: mergeCharsState, hash32: charSyncHash32 };
})();

globalThis.mergeCharsState = mergeCharsState;
})();
