/**
 * Main-blob channel of the sync engine: the localStorage allow-list, whole-blob dump and restore,
 * the exclusion filter on the outbound blob, the debounced push loop, the startup pull and the
 * local backup file (export/import).
 *
 * The allow-list tables are the load-bearing part. `LS_EXPLICIT` is the *entire* list of keys the
 * main blob carries — there is no fallback sweep — and `PROTECTED` doubles as the restore guard,
 * so a device-local key such as the auth token or the hand-picked theme survives every pull. The
 * registry keys ride the strongly authenticated blob on purpose: one account, one set of keys.
 *
 * Restore semantics worth keeping in mind: cards and chat left the blob when their channels landed,
 * so a restore skips both rather than letting a stale whole-blob copy overwrite the merged per-id
 * result, and the deleted props database is never resurrected by old blobs.
 * @module services/data/sync-upload
 */
import type { IdbEntry, Json, SyncPorts } from "./sync";
import { arrOf, recOf } from "./sync";
import { isRec, keysOf, numOf, strOf } from "./sync-context";
import type { ChannelLoop, SyncContext } from "./sync-context";

/** Public surface of the main-blob channel; the host facade forwards to these. */
export interface UploadChannel {
  markDirty(): void;
  pushNow(): Promise<void>;
  pullFromKV(): Promise<Json | null>;
  pullOnStartup(): Promise<void>;
  dumpAll(opts?: { includeChars?: boolean }): Promise<Json>;
  restoreAll(blob: unknown, opts?: { allowChars?: boolean }): Promise<boolean>;
  exportJSON(): Promise<Json>;
  importJSONText(text: string): Promise<Json>;
  isListedKey(key: string): boolean;
  isProtected(key: string): boolean;
  cancelTimer(): void;
}

export function createUploadChannel(ctx: SyncContext): UploadChannel {
  const storage = ctx.storage;
  const timers = ctx.timers;
  const ports: SyncPorts = ctx.ports;

  /**
   * Exact keys carried by the main blob. This list is the whole allow-list: {@link collectLS}
   * takes "listed here" plus "matching a prefix", with no fallback sweep, so a key added nowhere is
   * never synced and nothing reports it.
   */
  const LS_EXPLICIT: string[] = [
    "cfw_thinking",
    "cfw_prior_summary_by_conv_v1", "cfw_summary_enabled", "cfw_summary_trigger", "cfw_summary_keep",
    "tavern_active_scene_v1", "tavern_aff_pending_v1",
    "cfw_prompt_presets_v1", "cfw_skills_v1", "cfw_skills_enabled_v1", "tavern_multi_agent_mode_v1",
    "tavern_lorebook_v1",
    "cfw_mode", "cfw_model", "cfw_use_builtin", "cfw_history_enabled",
    "cfw_prompt_enabled", "cfw_custom_prompt_v1",
    "cfw_byo_provider_public_v1", "cfw_custom_pricing_v1",
    "cfw_providers_public_v3",
    // Channel registries are account-scoped since 2026-11-13: one account, one set of keys. They
    // ride the strongly authenticated main blob, so a key only ever lands in the user's own KV.
    "cfw_providers_v3",
    // Image channels follow the same rule. A channel pointing at a local ComfyUI simply fails to
    // connect on other devices; it does not affect the rest of the list.
    "cfw_image_channels_v1",
    "cfw_char_caps_v1",
    "cfw_ma_delegate_v1", "cfw_ma_meeting_v1", "cfw_ma_invite_v1",
    "cfw_ma_meeting_max_v1", "cfw_ma_meeting_rounds_v1", "cfw_ma_ctx_msgs_v1",
  ];

  /** Prefix families (multi-instance keys), matched after the exact list. */
  const LS_PREFIXES: string[] = ["tavern_aff_triggered_", "cfw_summary_"];

  /**
   * Keys that must never ride the blob. Only the prefix loop and the restore guard consult this at
   * runtime, but the list is also the written record of intent: adding a device-local key here is
   * how you say "this belongs to one machine" before someone adds it to the allow-list above.
   */
  const PROTECTED: string[] = [
    "cfw_auth_token_v1",
    // Appearance is per-device. Listing it here also protects it during restore: older blobs still
    // carry these keys, and removing them from the allow-list alone would not stop a restore from
    // overwriting a hand-picked theme.
    "cfw_theme_v1", "cfw_theme_accent_v1", "cfw_ui_overrides_v1",
    "cfw_chat_protect_v1",
    "cfw_byo_provider_v1",
    "cfw_byo_providers_v2",
    "cfw_app_fx_rich_v1",
    "cfw_mem_idle_release_v1",
    ctx.SYNC_ENABLED_KEY, ctx.LAST_PUSH_KEY, ctx.LAST_PULL_KEY,
    ctx.INCLUDE_CHAT_KEY, ctx.PAUSE_KEY, ctx.PUSH_COUNT_KEY, ctx.PUSH_COUNT_DAY_KEY,
    "cfw_cost_log_v1",
    "cfw_sync_last_cost_push_v1",
    "cfw_sync_last_cost_pull_v1",
    // The device id is the metering bucket. Sharing one across devices under-counts every total.
    "cfw_device_id_v1",
    ctx.EXCLUDE_KEY,
    ctx.LAST_EXCLUDE_PUSH_KEY, ctx.LAST_EXCLUDE_PULL_KEY,
    "cfw_dev_mode_v1", "cfw_dev_hud_v1", "cfw_dev_notes_v1", "cfw_dev_overrides_v1",
    "cfw_dev_debug_v1", "cfw_dev_force_comply_v1", "cfw_dev_stream_probe_v1", "cfw_dev_io_record_v1",
    ctx.LAST_CHAT_PUSH_KEY, ctx.LAST_CHAT_PULL_KEY,
    "cfw_ui_assets_v1",
    "cfw_chat_session_v1",
    "cfw_chat_slot_meta_v1",
    "cfw_chat_tomb_v1",
    "cfw_conv_meta_v1",
    "cfw_chat_synced_v1",
    "cfw_chat_conflicts_v1",
    "cfw_conv_active_v1",
    ctx.CHARS_META_KEY, ctx.CHARS_TOMB_KEY,
    ctx.LAST_CHARS_PUSH_KEY, ctx.LAST_CHARS_PULL_KEY,
    ctx.CHAT_EVENTS_SEQ_KEY, ctx.CHAT_EVENTS_QUEUE_KEY, "cfw_chat_events_pending_v1", ctx.CHAT_REALTIME_KEY, ctx.CHARS_SYNCED_KEY,
  ];

  /**
   * Databases carried by the main blob. Empty on purpose: cards moved to their own channel and the
   * props database no longer exists. The loops below stay because that is where a future database
   * gets added.
   */
  const IDB_NAMES: string[] = [];

  // ── main blob: localStorage ──

  function collectLS(): Json {
    const out: Json = {};
    const seen = new Set<string>();
    for (let i = 0; i < LS_EXPLICIT.length; i++) {
      const k = LS_EXPLICIT[i];
      const v = storage.getItem(k);
      if (v !== null) {
        out[k] = v;
        seen.add(k);
      }
    }
    const total = storage.length;
    for (let i = 0; i < total; i++) {
      const k = storage.key(i);
      if (!k || seen.has(k) || PROTECTED.indexOf(k) >= 0) continue;
      let matched = false;
      for (let j = 0; j < LS_PREFIXES.length; j++) {
        if (k.indexOf(LS_PREFIXES[j]) === 0) matched = true;
      }
      if (matched) out[k] = storage.getItem(k);
    }
    return out;
  }

  function restoreLS(ls: Json): void {
    // The loop below overwrites whole keys, so the two channel registries have to be saved first
    // and merged by id afterwards. Without this a device holding an empty registry (a fresh phone)
    // wipes the other device's channels, keys included — it happened.
    let localProviders: string | null = null;
    let localImageChannels: string | null = null;
    try {
      localProviders = storage.getItem("cfw_providers_v3");
      localImageChannels = storage.getItem("cfw_image_channels_v1");
    } catch (e) {
      /* storage unavailable: nothing to preserve */
    }
    const toRemove: string[] = [];
    const total = storage.length;
    for (let i = 0; i < total; i++) {
      const k = storage.key(i);
      if (!k || PROTECTED.indexOf(k) >= 0) continue;
      let matched = LS_EXPLICIT.indexOf(k) >= 0;
      if (!matched) {
        for (let j = 0; j < LS_PREFIXES.length; j++) {
          if (k.indexOf(LS_PREFIXES[j]) === 0) matched = true;
        }
      }
      if (matched) toRemove.push(k);
    }
    for (let i = 0; i < toRemove.length; i++) storage.removeItem(toRemove[i]);
    const incoming = keysOf(ls);
    for (let i = 0; i < incoming.length; i++) {
      const k = incoming[i];
      if (PROTECTED.indexOf(k) >= 0) continue;
      if (k === "tavern_active_props_v1") continue;
      const v = ls[k];
      if (typeof v === "string") storage.setItem(k, v);
    }

    const merge = ports.providerMerge();
    const parse = (raw: string | null): unknown => {
      try {
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    };
    try {
      const cloudProviders = ls["cfw_providers_v3"];
      if (cloudProviders != null) {
        if (merge) {
          const merged = merge.mergeProviders(parse(localProviders), parse(strOf(cloudProviders)));
          if (isRec(merged)) storage.setItem("cfw_providers_v3", JSON.stringify(merged));
        }
      } else if (localProviders) {
        // The cloud copy predates the key: keep ours rather than dropping the registry.
        storage.setItem("cfw_providers_v3", localProviders);
      }
      const registry = ports.providers();
      if (registry && typeof registry.republish === "function") registry.republish();
      const cloudImage = ls["cfw_image_channels_v1"];
      if (cloudImage != null) {
        if (merge) {
          const mergedImage = merge.mergeImageChannels(parse(localImageChannels), parse(strOf(cloudImage)));
          if (Array.isArray(mergedImage)) storage.setItem("cfw_image_channels_v1", JSON.stringify(mergedImage));
        }
      } else if (localImageChannels) {
        storage.setItem("cfw_image_channels_v1", localImageChannels);
      }
    } catch (e) {
      /* merge is best-effort: a broken cloud registry must not abort the restore */
    }

    // setItem does not fire the storage event in the same tab, and the registries just changed
    // underneath the UI — repaint explicitly.
    try {
      const registry = ports.providers();
      if (registry && typeof registry.mergePublic === "function") registry.mergePublic();
    } catch (e) {
      /* UI refresh is optional */
    }
  }

  // ── main blob: dump / restore ──

  async function dumpAll(opts?: { includeChars?: boolean }): Promise<Json> {
    const ls = collectLS();
    const idb: Json = {};
    for (let i = 0; i < IDB_NAMES.length; i++) idb[IDB_NAMES[i]] = await ports.idb.dump(IDB_NAMES[i]);
    // Cards stay out of the blob by default; a local backup must not lose them, hence the opt-in.
    if (opts && opts.includeChars) idb[ctx.CHARS_DB] = await ports.idb.dump(ctx.CHARS_DB);
    return applyExclusionsToBlob({ version: 1, savedAt: ctx.now(), localStorage: ls, indexedDB: idb });
  }

  async function restoreAll(blob: unknown, opts?: { allowChars?: boolean }): Promise<boolean> {
    if (!isRec(blob)) return false;
    const data = recOf(blob);
    // Cards and chat left the blob when their channels landed. An older cloud blob still carries
    // them, so restoring must skip both: otherwise the stale whole-blob copy overwrites the merged
    // per-id result.
    const allowChars = !!(opts && opts.allowChars);
    const ex = ctx.getExcluded();
    let keepRoles: IdbEntry[] = [];
    const keepSlots: Json = {};
    const keepAffLS: Json = {};
    if (ex.roles.length) {
      try {
        keepRoles = await ports.idb.readByIds(ctx.CHARS_DB, ex.roles);
      } catch (e) {
        /* nothing to preserve */
      }
      for (let i = 0; i < ex.roles.length; i++) {
        const k = "tavern_aff_triggered_" + ex.roles[i];
        const v = storage.getItem(k);
        if (v !== null) keepAffLS[k] = v;
      }
    }
    const slotKeys = Array.from(new Set<string>(ex.sessions.concat(ex.roles)));
    if (slotKeys.length) {
      try {
        const sessions = ctx.readJSONObj("cfw_chat_session_v1", {});
        for (let i = 0; i < slotKeys.length; i++) {
          const k = slotKeys[i];
          if (Object.prototype.hasOwnProperty.call(sessions, k)) keepSlots[k] = sessions[k];
        }
      } catch (e) {
        /* nothing to preserve */
      }
    }
    const ls = data["localStorage"];
    if (isRec(ls)) restoreLS(recOf(ls));
    const idb = data["indexedDB"];
    if (isRec(idb)) {
      const cloudIdb = recOf(idb);
      const names = keysOf(cloudIdb);
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (n === ctx.CHARS_DB && !allowChars) continue;
        // The props database was deleted from the product. Old blobs still contain it, and
        // restoring would recreate it — deleted data coming back to life.
        if (n === "tavern_props_v1") continue;
        await ports.idb.restore(n, recOf(cloudIdb[n]));
      }
    }
    if (keepRoles.length) {
      try {
        await ports.idb.putItems(ctx.CHARS_DB, keepRoles);
      } catch (e) {
        /* best-effort: an excluded card that cannot be re-put is still excluded from the cloud */
      }
    }
    const keptSlotKeys = keysOf(keepSlots);
    if (keptSlotKeys.length) {
      try {
        const sessions = ctx.readJSONObj("cfw_chat_session_v1", {});
        for (let i = 0; i < keptSlotKeys.length; i++) sessions[keptSlotKeys[i]] = keepSlots[keptSlotKeys[i]];
        storage.setItem("cfw_chat_session_v1", JSON.stringify(sessions));
      } catch (e) {
        /* best-effort */
      }
    }
    const affKeys = keysOf(keepAffLS);
    for (let i = 0; i < affKeys.length; i++) {
      try {
        storage.setItem(affKeys[i], strOf(keepAffLS[affKeys[i]]));
      } catch (e) {
        /* best-effort */
      }
    }
    return true;
  }

  /**
   * Strip excluded entities from an outbound blob. Exclusion means "clear the cloud, keep this
   * device", so the filter runs on the push side only; the local copy is untouched.
   */
  function applyExclusionsToBlob(blob: Json): Json {
    const ex = ctx.getExcluded();
    if (!ex.roles.length && !ex.sessions.length) return blob;
    // recOf returns a copy, so every mutation below is written back onto the blob. Mutating the
    // copy and dropping it silently uploads the excluded entity — the filter is the only thing
    // standing between "clear the cloud" and "nothing happened".
    const idbRaw = blob["indexedDB"];
    if (ex.roles.length && isRec(idbRaw)) {
      const idbOut = recOf(idbRaw);
      const dbObj = recOf(idbOut[ctx.CHARS_DB]);
      const stores = keysOf(dbObj);
      for (let i = 0; i < stores.length; i++) {
        const sn = stores[i];
        const items = arrOf(dbObj[sn]);
        // The chars store is keyed by id, the affections store by cardId; both belong to the role,
        // so both are cleared from the cloud.
        dbObj[sn] = items.filter((it) => {
          const rec = recOf(it);
          return !(ex.roles.indexOf(strOf(rec["id"])) >= 0 || ex.roles.indexOf(strOf(rec["cardId"])) >= 0);
        });
      }
      idbOut[ctx.CHARS_DB] = dbObj;
      blob["indexedDB"] = idbOut;
    }
    const lsRaw = blob["localStorage"];
    if (isRec(lsRaw)) {
      const lsOut = recOf(lsRaw);
      for (let i = 0; i < ex.roles.length; i++) delete lsOut["tavern_aff_triggered_" + ex.roles[i]];
      const slotKeys = Array.from(new Set<string>(ex.sessions.concat(ex.roles)));
      const raw = lsOut["cfw_chat_session_v1"];
      if (slotKeys.length && typeof raw === "string") {
        try {
          const sessions = recOf(JSON.parse(raw));
          let changed = false;
          for (let i = 0; i < slotKeys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(sessions, slotKeys[i])) {
              delete sessions[slotKeys[i]];
              changed = true;
            }
          }
          if (changed) lsOut["cfw_chat_session_v1"] = JSON.stringify(sessions);
        } catch (e) {
          /* a malformed local value is left as-is */
        }
      }
      blob["localStorage"] = lsOut;
    }
    return blob;
  }

  // ── main blob KV wrappers ──

  function pullFromKV(): Promise<Json | null> {
    return ctx.getChannel(ctx.MAIN_BLOB_PATH, "");
  }

  function pushToKV(blob: Json): Promise<Json> {
    return ctx.putChannel(ctx.MAIN_BLOB_PATH, blob, "");
  }

  // ── main blob: debounced push ──

  const loop: ChannelLoop = ctx.makeChannelLoop({ debounceMs: 30000, job: runPush });

  async function runPush(): Promise<void> {
    ctx.emit("syncing");
    try {
      const blob = await dumpAll();
      const res = await pushToKV(blob);
      const savedAt = numOf(res["savedAt"]) || ctx.now();
      storage.setItem(ctx.LAST_PUSH_KEY, String(savedAt));
      // Advance the pull stamp too, or the next startup drags back what was just pushed.
      storage.setItem(ctx.LAST_PULL_KEY, String(savedAt));
      const pushN = ctx.incrPushCount();
      ctx.emit("synced", Object.assign({}, res, { pushCount: pushN }));
    } catch (e) {
      ctx.emit("error", e);
    }
  }

  function markDirty(): void {
    if (!ctx.syncEnabled() || !ctx.token()) return;
    if (ctx.isPaused()) return;
    // 30s, not 3s: the whole blob is one KV write and the free tier allows 1000/day.
    loop.markDirty();
  }

  async function pushNow(): Promise<void> {
    loop.cancelTimer();
    await loop.run(runPush);
  }

  // ── startup ──

  async function pullOnStartup(): Promise<void> {
    if (!ctx.syncEnabled() || !ctx.token()) return;
    ctx.emit("syncing");
    try {
      const remote = await pullFromKV();
      if (!remote) {
        // Empty cloud means first enablement: seed it from this device rather than starting blank.
        ctx.emit("synced", { firstPush: true });
        await pushNow();
        return;
      }
      const lastPull = parseInt(storage.getItem(ctx.LAST_PULL_KEY) || "0", 10) || 0;
      const remoteAt = numOf(remote["savedAt"]);
      if (remoteAt > lastPull) {
        await restoreAll(remote);
        storage.setItem(ctx.LAST_PULL_KEY, String(remoteAt));
        ctx.emit("restored", { savedAt: remoteAt });
        // A reload is the only reliable way to make the app re-read state it already loaded.
        timers.set(() => {
          ports.reloadPage();
        }, 600);
      } else {
        ctx.emit("synced");
      }
    } catch (e) {
      ctx.emit("error", e);
    }
  }

  // ── local file backup ──

  async function exportJSON(): Promise<Json> {
    const blob = await dumpAll({ includeChars: true });
    const text = JSON.stringify(blob, null, 2);
    const name = "tavern-backup-" + new Date(ctx.now()).toISOString().slice(0, 10) + ".json";
    const result = await ports.saveText(text, name);
    if (!result["ok"]) ports.toast(strOf(result["error"]) || "未写盘");
    return result;
  }

  /** Resolves with the parsed blob; restores cards too, because a local import is a full backup. */
  async function importJSONText(text: string): Promise<Json> {
    const blob = JSON.parse(text);
    await restoreAll(blob, { allowChars: true });
    return recOf(blob);
  }

  // ── dirty classification (the storage router calls this per same-tab write) ──

  function isListedKey(key: string): boolean {
    if (PROTECTED.indexOf(key) >= 0) return false;
    if (LS_EXPLICIT.indexOf(key) >= 0) return true;
    for (let i = 0; i < LS_PREFIXES.length; i++) {
      if (key.indexOf(LS_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /** Cross-tab storage events route on this: any non-protected key re-marks the main blob. */
  function isProtected(key: string): boolean {
    return PROTECTED.indexOf(key) >= 0;
  }

  return {
    markDirty: markDirty,
    pushNow: pushNow,
    pullFromKV: pullFromKV,
    pullOnStartup: pullOnStartup,
    dumpAll: dumpAll,
    restoreAll: restoreAll,
    exportJSON: exportJSON,
    importJSONText: importJSONText,
    isListedKey: isListedKey,
    isProtected: isProtected,
    cancelTimer: loop.cancelTimer,
  };
}
