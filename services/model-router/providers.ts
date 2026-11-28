/**
 * Channel registry: server-registered presets and this device's custom direct endpoints in one
 * list, plus active selection, per-model enable switches and model-list fetching.
 *
 * Ports: storage (the two registry keys, the legacy migration keys, the model key and the old
 * candidate pools), auth (resolved per call, for guest detection and the Authorization header),
 * notify (the change event) and onStorage (cross-tab). The service never touches window;
 * tooling/l0/wiring/providers.js is the adapter and keeps the frozen name, including the four startup
 * side effects it orchestrates in order.
 *
 * One rule explains the shape of v3: a custom channel takes over chat only when it was activated.
 * v2 returned the first entry of whatever list it found, so a leftover BYO placeholder hijacked
 * every request — that was a real 403 outage, not a hypothetical. Hence:
 *  - null            → follow the fast/free pill (also the migration default)
 *  - "preset:<pid>"  → pin a preset (server-side key)
 *  - "custom:<id>"   → pin a local endpoint + key
 *
 * cfw_providers_v3 carries the whole registry including apiKey and syncs with the account (one
 * account, one configuration); cfw_providers_public_v3 is the key-stripped copy kept for older
 * clients. The v2/v1 keys are read for migration and left in place afterwards, so a rollback still
 * finds them.
 * @module services/model-router/providers
 */

/** Key-value storage port; the adapter wraps localStorage, tests wrap a Map. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The minimum slice of the auth bridge this registry needs: the access token. */
export interface AuthLike {
  getToken?(): string | null | undefined;
}

/** Environment ports, injected by the adapter. */
export interface ProvidersPorts {
  storage: KvStorage;
  auth(): AuthLike | null;
  /** Fire the change event; the adapter owns the try/catch. */
  notify(detail: { reason: string }): void;
  /** Sink for the deprecated-alias notice; the adapter wires it to console.warn. */
  notifyDeprecated?(message: string): void;
  /** Subscribe to the cross-tab storage event. Only registration is guarded, not each callback. */
  onStorage(cb: (e: { key?: string | null } | null | undefined) => void): void;
}

export interface ModelEntry {
  id: string;
  label: string;
  recommended?: boolean;
  /** Retired alias: the notice is generated once per model id, never on every read. */
  deprecated?: boolean;
  deprecatedOn?: string;
  successor?: string;
}

/**
 * Legacy aliases the retired chat adapter warned about (2026-07-24 15:59 UTC). The mapping lives on
 * the model definition, so the notice needs no third implementation; the registry decides when to
 * emit it and the adapter decides where the text goes.
 */
const DEPRECATED_MODELS: ModelEntry[] = [
  { id: "deepseek-chat", label: "deepseek-chat", deprecated: true, deprecatedOn: "2026-07-24", successor: "deepseek-v4-flash" },
  { id: "deepseek-reasoner", label: "deepseek-reasoner", deprecated: true, deprecatedOn: "2026-07-24", successor: "deepseek-v4-flash" },
];

/** Pure: the notice for a retired alias, or null for every other model. No global, no side effect. */
export function deprecationNotice(model: string): string | null {
  const id = String(model || "").trim();
  for (let i = 0; i < DEPRECATED_MODELS.length; i++) {
    const entry = DEPRECATED_MODELS[i];
    if (entry.id === id && entry.deprecated) {
      return `[providers] 模型「${id}」将于 ${entry.deprecatedOn || "2026-07-24"} 弃用，请迁移到 ${entry.successor || "deepseek-v4-flash"}`;
    }
  }
  return null;
}

export interface CustomProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  supportsThinking: boolean;
  thinkingStyle: string;
  needsReasoningHistory: boolean;
  models: ModelEntry[];
  disabled: { [modelId: string]: unknown };
  updatedAt: number;
  /** Unknown fields survive normalization; later writers append recEra / legacyMigrated / defaultsV. */
  [key: string]: unknown;
}

export interface PresetState {
  models: ModelEntry[];
  disabled: { [modelId: string]: unknown };
  fetchedAt: number;
  [key: string]: unknown;
}

export interface PresetMetaLike {
  id: string;
  label?: string;
  title?: string;
  keyEnv?: string;
  configured?: unknown;
  supportsThinking?: boolean;
  thinkingStyle?: string;
  effortValues?: string[];
  defaultModel?: string;
  [key: string]: unknown;
}

/** Typed shell over the stored JSON; readRaw accepts it only when v === 3 and custom is an array. */
export interface RegistryState {
  v: number;
  activeId: string | null;
  custom: CustomProvider[];
  presets: { [pid: string]: PresetState };
  presetsMeta: { [pid: string]: PresetMetaLike };
  deleted: { [id: string]: number };
  updatedAt: number;
  [key: string]: unknown;
}

export interface FetchResult {
  ok: boolean;
  error?: string;
  count?: number;
  title?: string;
}


export function createProvidersRegistry(ports: ProvidersPorts) {
  const K3 = "cfw_providers_v3";
  const K3PUB = "cfw_providers_public_v3";
  const K2 = "cfw_byo_providers_v2";
  const K1 = "cfw_byo_provider_v1";
  const K1PUB = "cfw_byo_provider_public_v1";
  const LS_MODEL = "cfw_model";

  const MODE_TO_PRESET: { [mode: string]: string } = { fast: "deepseek", free: "nvidia" };
  const PRESET_TO_MODE: { [pid: string]: string } = { deepseek: "fast", nvidia: "free" };
  // Model lists used to be frozen forever: fetchedAt was written and never read, so an upstream
  // that shipped new free models was invisible until the user pressed fetch. Three days is fresh
  // enough while keeping the upstream off the critical path of every page load.
  const MODELS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  // Version of the default-selection policy. Raising it re-checks the recommended family once
  // (server-side recommended:true). Additive only: a model the user unchecked stays unchecked,
  // except the recommended family, which has to be visible out of the box.
  const DEFAULTS_V = 2;
  // Fallback for an old Worker or an offline start; ids stay aligned with the worker's registry.
  const PRESET_FALLBACK: PresetMetaLike[] = [
    { id: "deepseek", label: "deepseek-official", title: "DeepSeek 官方", endpoint: "https://api.deepseek.com/v1/chat/completions", keyEnv: "DEEPSEEK_API_KEY", configured: null, supportsThinking: true, thinkingStyle: "deepseek", defaultModel: "deepseek-flash" },
    { id: "nvidia", label: "nvidia-nim", title: "NVIDIA 免费档", endpoint: "https://integrate.api.nvidia.com/v1/chat/completions", keyEnv: "NVIDIA_API_KEY", configured: null, supportsThinking: true, thinkingStyle: "vllm", defaultModel: "deepseek-ai/deepseek-v4.1-flash" },
    // AMD exposes its shared pool only on the China site and blocks direct browser calls (OPTIONS
    // 405, no ACAO), so the Worker proxies it. The endpoint rejects thinking:{type} with 400 and
    // accepts only reasoning_effort, hence the "effort" dialect below.
    { id: "amd", label: "amd-token-factory", title: "AMD Token Factory（免费共享）", endpoint: "https://developer.amd.com.cn/radeon/api/v1/chat/completions", keyEnv: "AMD_API_KEY", configured: null, supportsThinking: true, thinkingStyle: "effort", effortValues: ["low", "medium"], defaultModel: "Qwen3.8-27B" },
  ];

  function nowMs(): number { return Date.now(); }
  // Deletion tombstones ({id: timestamp}). Under account-level sync a delete has to travel, or a
  // stale copy on another device resurrects the channel.
  function blank(): RegistryState {
    return { v: 3, activeId: null, custom: [], presets: {}, presetsMeta: {}, deleted: {}, updatedAt: 0 };
  }
  function normModelList(list: unknown): ModelEntry[] {
    return (Array.isArray(list) ? list : []).map(function (m) {
      if (!m) return null;
      const rec: Record<string, unknown> = (m && typeof m === "object") ? toRec(m) : {};
      const id = (typeof m === "string") ? m : String(rec.id || "");
      const trimmed = id.trim();
      if (!trimmed) return null;
      const out: ModelEntry = { id: trimmed, label: String(rec.label || trimmed) };
      // recommended comes from the server (the free tier's DeepSeek/Nemotron family). Do not
      // re-derive it here: two copies of the vendor rules drift.
      if (rec.recommended) out.recommended = true;
      return out;
    }).filter(function (m): m is ModelEntry { return !!m; });
  }
  function normalizeCustom(p: unknown): CustomProvider | null {
    if (!p || typeof p !== "object") return null;
    const rec = p as { [k: string]: unknown };
    const id = String(rec.id || "").trim();
    if (!id) return null;
    // Thinking is a shape, not a boolean: none / vllm (on-off only) / deepseek (three levels) /
    // effort (sends reasoning_effort and no thinking, which some endpoints require). Legacy
    // supportsThinking=true without a style stays on "deepseek", so old data behaves as before.
    const thinkStyle = rec.supportsThinking
      ? (rec.thinkingStyle === "vllm" ? "vllm" : (rec.thinkingStyle === "effort" ? "effort" : "deepseek"))
      : "none";
    return {
      id: id,
      name: String(rec.name || "未命名服务商"),
      endpoint: String(rec.endpoint || "").trim(),
      apiKey: typeof rec.apiKey === "string" ? rec.apiKey : "",
      model: String(rec.model || "").trim(),
      supportsThinking: thinkStyle !== "none",
      thinkingStyle: thinkStyle,
      needsReasoningHistory: !!rec.needsReasoningHistory,
      models: normModelList(rec.models),
      disabled: (function () {
        const din = rec.disabled;
        const dis: { [modelId: string]: unknown } = {};
        if (din && typeof din === "object") { for (const [k, v] of Object.entries(din)) dis[k] = v; }
        return dis;
      })(),
      // Decides "who is newer" when merging. Callers stamp it on save; a cloud copy may carry 0.
      updatedAt: Number(rec.updatedAt || 0) || 0,
    };
  }

  // ── read + migrate (idempotent) ──
  function readRaw(): RegistryState | null {
    try {
      const o = JSON.parse(ports.storage.getItem(K3) || "null");
      if (o && o.v === 3 && Array.isArray(o.custom)) return o;
    } catch (e) {}
    return null;
  }
  function migrate(): RegistryState {
    const st = blank();
    try {
      const v2 = JSON.parse(ports.storage.getItem(K2) || "null");
      if (v2 && Array.isArray(v2.providers) && v2.providers.length) {
        st.custom = v2.providers.map(normalizeCustom).filter(function (m): m is CustomProvider { return !!m; });
        // Only honour a v2 activeId; otherwise stay on the preset path, which is what stops the
        // old "anything in the list hijacks chat" behaviour from coming back.
        if (v2.activeId) st.activeId = "custom:" + v2.activeId;
        st.updatedAt = nowMs();
        return st;
      }
      // v1 was a single slot: an endpoint plus a model means the user configured it, so it
      // migrates as the active custom channel.
      const priv = JSON.parse(ports.storage.getItem(K1) || "{}") || {};
      const pub = JSON.parse(ports.storage.getItem(K1PUB) || "{}") || {};
      const o1 = Object.assign({}, pub, priv);
      if (priv && typeof priv.apiKey === "string") o1.apiKey = priv.apiKey;
      if (o1 && o1.endpoint && o1.model) {
        const p1 = normalizeCustom({
          id: "p_" + nowMs().toString(36), name: "自定义直连（迁移）",
          endpoint: o1.endpoint, apiKey: o1.apiKey || "", model: o1.model,
          supportsThinking: !!o1.supportsThinking, needsReasoningHistory: !!o1.needsReasoningHistory,
          models: Array.isArray(o1.models) ? o1.models : [],
        });
        if (p1) { st.custom = [p1]; st.activeId = "custom:" + p1.id; }
      }
    } catch (e) {}
    st.updatedAt = nowMs();
    return st;
  }
  function read(): RegistryState {
    let st = readRaw();
    if (!st) { st = migrate(); write(st); }
    // Older registries predate tombstones.
    if (!st.deleted || typeof st.deleted !== "object") st.deleted = {};
    return st;
  }
  function publicCopy(st: RegistryState): Record<string, unknown> {
    return {
      v: 3, activeId: st.activeId, presetsMeta: st.presetsMeta || {},
      presets: st.presets || {},
      custom: (st.custom || []).map(function (p) { const c = JSON.parse(JSON.stringify(p)); delete c.apiKey; return c; }),
      deleted: st.deleted || {},
      updatedAt: st.updatedAt || 0,
    };
  }
  function write(st: RegistryState): void {
    st.updatedAt = nowMs();
    try { ports.storage.setItem(K3, JSON.stringify(st)); } catch (e) {}
    try { ports.storage.setItem(K3PUB, JSON.stringify(publicCopy(st))); } catch (e) {}
    emit("save");
  }
  // Recompute the public copy only, without bumping updatedAt: the sync layer calls this after it
  // merges the full registry, so the key-stripped copy never lags behind.
  function republish(): void {
    try { ports.storage.setItem(K3PUB, JSON.stringify(publicCopy(read()))); } catch (e) {}
  }
  // Merge the cloud's public copy inwards: match by id, take the non-sensitive fields, keep this
  // device's apiKey (the public copy never carries one).
  function mergePublic(): void {
    try {
      const pub = JSON.parse(ports.storage.getItem(K3PUB) || "null");
      if (!pub || pub.v !== 3) return;
      const st = read();
      if ((pub.updatedAt || 0) > (st.updatedAt || 0)) {
        st.activeId = pub.activeId || null;
        st.presetsMeta = pub.presetsMeta || st.presetsMeta;
        st.presets = pub.presets || st.presets;
        const byId: { [id: string]: CustomProvider } = {};
        (st.custom || []).forEach(function (p) { byId[p.id] = p; });
        st.custom = (pub.custom || []).map(function (pc) {
          const local = pc ? byId[pc.id] : null;
          const merged = normalizeCustom(pc);
          if (merged && local && local.apiKey) merged.apiKey = local.apiKey;
          return merged;
        }).filter(function (m): m is CustomProvider { return !!m; });
        write(st);
        emit("external");
      }
    } catch (e) {}
  }

  // ── events ──
  const subs: Array<(detail: { reason: string }) => void> = [];
  function on(cb: (detail: { reason: string }) => void): void { if (typeof cb === "function") subs.push(cb); }
  function emit(reason: string): void {
    const detail = { reason: reason || "" };
    for (let i = 0; i < subs.length; i++) { try { subs[i](detail); } catch (e) {} }
    ports.notify(detail);
  }
  // Once per model id, mirroring the retired adapter's `warned` map. The text itself is pure; this
  // service only decides "has this been said", the injected port decides where it is said.
  const warnedDeprecated: { [model: string]: number } = {};
  function noticeDeprecated(model: string): void {
    if (!model || warnedDeprecated[model]) return;
    const text = deprecationNotice(model);
    if (!text) return;
    warnedDeprecated[model] = 1;
    try { if (ports.notifyDeprecated) ports.notifyDeprecated(text); } catch (e) {}
  }
  // Cross-tab storage events. Registration belongs to the adapter; the decision belongs here,
  // because these two keys are this module's own.
  function handleStorageEvent(e: { key?: string | null } | null | undefined): void {
    if (!e || e.key === K3PUB || e.key === K3) { if (e && e.key === K3PUB) mergePublic(); else emit("external"); }
  }

  // ── preset metadata (GET /api/providers, built-in fallback) ──
  function presetMeta(pid: string): PresetMetaLike {
    const st = read();
    const m = st.presetsMeta ? st.presetsMeta[pid] : undefined;
    if (m && m.id) return m;
    for (let i = 0; i < PRESET_FALLBACK.length; i++) if (PRESET_FALLBACK[i].id === pid) return PRESET_FALLBACK[i];
    return { id: pid, label: pid, title: pid, keyEnv: "", configured: null, supportsThinking: true, thinkingStyle: "deepseek", defaultModel: "" };
  }
  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h = Object.assign({}, extra || {});
    try {
      const au = ports.auth();
      const tk = (au && typeof au.getToken === "function") ? au.getToken() : null;
      if (tk && !h.Authorization) h.Authorization = "Bearer " + tk;
    } catch (e) {}
    return h;
  }
  async function refreshPresets(): Promise<boolean> {
    try {
      const r = await fetch("/api/providers", { headers: authHeaders() });
      const d = await r.json().catch(function () { return null; });
      if (d && d.ok && Array.isArray(d.presets) && d.presets.length) {
        const st = read();
        const meta: { [pid: string]: PresetMetaLike } = {};
        d.presets.forEach(function (p: PresetMetaLike) { if (p && p.id) meta[p.id] = p; });
        st.presetsMeta = meta;
        write(st);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ── channel keys ──
  function presetKey(pid: unknown): string { return "preset:" + String(pid || "").trim(); }
  function customKey(id: unknown): string { return "custom:" + String(id || "").trim(); }
  function parseKey(key: unknown): { kind: string; id: string } | null {
    const s = String(key || "");
    if (s.indexOf("preset:") === 0) return { kind: "preset", id: s.slice(7) };
    if (s.indexOf("custom:") === 0) return { kind: "custom", id: s.slice(7) };
    return null;
  }
  function presetIdForMode(mode: string): string { return MODE_TO_PRESET[mode === "fast" ? "fast" : "free"]; }
  function modeForPreset(pid: string): string | null { return PRESET_TO_MODE[pid] || null; }
  function getCustom(st: RegistryState, id: string): CustomProvider | null {
    for (let i = 0; i < st.custom.length; i++) if (st.custom[i].id === id) return st.custom[i];
    return null;
  }
  // A guest is a visitor without a local access code. Guests may only use their own custom
  // channels: the presets are billed to the site owner's key, so they are closed outright.
  function guest(): boolean {
    try {
      const au = ports.auth();
      return !!(au && typeof au.getToken === "function" && !au.getToken());
    } catch (e) { return false; }
  }
  // An explicit selection wins; with none, follow the fast/free pill.
  function effectiveKey(mode: string): string | null {
    const st = read();
    if (guest()) {
      return (st.activeId && String(st.activeId).indexOf("custom:") === 0) ? st.activeId : null;
    }
    if (st.activeId) return st.activeId;
    return presetKey(presetIdForMode(mode));
  }
  function activePresetId(): string | null {
    if (guest()) return null;
    const k = parseKey(read().activeId);
    return (k && k.kind === "preset") ? k.id : null;
  }
  function modeForActive(): string | null {
    if (guest()) return null;
    const k = parseKey(read().activeId);
    return (k && k.kind === "preset") ? modeForPreset(k.id) : null;
  }
  // Legacy contract: a snapshot of the active custom channel, or null when a preset is active or
  // nothing is selected, which sends the caller down its built-in path.
  function byoSnapshot(): Record<string, unknown> | null {
    const st = read();
    const k = parseKey(st.activeId);
    if (!k || k.kind !== "custom") return null;
    const p = getCustom(st, k.id);
    if (!p || !p.endpoint || !p.model) return null;
    const out: Record<string, unknown> = { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, supportsThinking: !!p.supportsThinking, thinkingStyle: p.thinkingStyle || "deepseek", needsReasoningHistory: !!p.needsReasoningHistory, models: Array.isArray(p.models) ? p.models : [] };
    if (typeof p.apiKey === "string" && p.apiKey) out.apiKey = p.apiKey;
    return out;
  }

  // ── channel list (the left rail) ──
  function channels(): object[] {
    const st = read();
    const out: object[] = [];
    if (!guest()) {
      const pids = Object.keys(st.presetsMeta || {});
      PRESET_FALLBACK.forEach(function (f) { if (pids.indexOf(f.id) < 0) pids.push(f.id); });
      pids.forEach(function (pid) {
        const m = presetMeta(pid);
        const psRaw = st.presets[pid];
        const psModels = (psRaw && psRaw.models) ? psRaw.models : [];
        out.push({ key: presetKey(pid), kind: "preset", id: pid, name: m.title || m.label || pid, sub: m.label || "", detail: m, models: psModels });
      });
    }
    (st.custom || []).forEach(function (p) {
      out.push({ key: customKey(p.id), kind: "custom", id: p.id, name: p.name || p.id, sub: p.endpoint || "未填端点", detail: p, models: p.models || [] });
    });
    return out;
  }

  // ── model list and per-model switches ──
  function channelState(st: RegistryState, key: string): PresetState | CustomProvider | null {
    const k = parseKey(key);
    if (!k) return null;
    if (k.kind === "preset") {
      if (!st.presets[k.id]) st.presets[k.id] = { models: [], disabled: {}, fetchedAt: 0 };
      const ps = st.presets[k.id];
      if (!ps.disabled || typeof ps.disabled !== "object") ps.disabled = {};
      return ps;
    }
    // A custom channel keeps models/disabled on the provider object itself.
    return getCustom(st, k.id);
  }
  function modelsAll(key: string): object[] {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return [];
    const dis = (cs.disabled && typeof cs.disabled === "object") ? cs.disabled : {};
    return normModelList(cs.models).map(function (m) {
      const out: Record<string, unknown> = { id: m.id, label: m.label, enabled: !dis[m.id] };
      if (m.recommended) out.recommended = true;
      return out;
    });
  }
  function enabledModels(key: string): object[] {
    return modelsAll(key).filter(function (m) { return toRec(m).enabled; });
  }
  function toggleModel(key: string, modelId: string, enabled: unknown): void {
    const st = read();
    const cs = channelState(st, key);
    if (!cs || !modelId) return;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    if (enabled) delete cs.disabled[modelId];
    else cs.disabled[modelId] = 1;
    // Unchecking the currently selected model has to move the selection, or the channel points at
    if (enabled === false && cs.model === modelId) {
      const next = enabledModels(key)[0];
      cs.model = next ? String(toRec(next).id) : "";
    }
    write(st);
  }
  function setSelectedModel(key: string, modelId: unknown): void {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return;
    cs.model = String(modelId || "").trim();
    write(st);
  }
  // One entry point for select-all / clear / restore-recommended: a single write and a single
  // event. Calling toggleModel per row re-renders the list once per model, which is a slideshow at
  // fifty models. With enabled=true, onlyRecommended means "recommended family only".
  function setAllModels(key: string, enabled: unknown, opts?: { onlyRecommended?: boolean }): number {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return 0;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    const onlyRec = !!(opts && opts.onlyRecommended);
    const all = normModelList(cs.models);
    let n = 0;
    all.forEach(function (m) {
      if (onlyRec && !m.recommended) { cs.disabled[m.id] = 1; return; }
      if (enabled) delete cs.disabled[m.id]; else cs.disabled[m.id] = 1;
      n++;
    });
    // The preset's current model lives in the model key, not here; a custom channel's moves only
    // inside toggleModel.
    write(st);
    return n;
  }
  // Legacy candidate pools (cfw_models_free_v1 / _fast_v1) held the user's own selection before
  // the registry existed, so on the first fetch their picks are re-checked. Additive only: an
  // earlier version cleared the switches and then disabled everything outside the pool, which left
  // upgraded users with nothing but the old handful of models.
  function migrateLegacyPool(cs: PresetState | CustomProvider, pid: string): void {
    const mode = modeForPreset(pid);
    if (!mode) return;
    let leg: unknown[] = [];
    try { leg = JSON.parse(ports.storage.getItem("cfw_models_" + mode + "_v1") || "[]") || []; } catch (e) {}
    if (!Array.isArray(leg) || !leg.length) return;
    if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
    // A pool covering ≥80% of the current list is a snapshot somebody's fetch produced, not a
    // hand-picked set. Migrating it would check fifty models at once the moment a guest signs in.
    if (leg.length >= (cs.models || []).length * 0.8) return;
    const have: { [id: string]: number } = {};
    (cs.models || []).forEach(function (m) { have[m.id] = 1; });
    leg.forEach(function (m) {
      // Accepts both shapes the old pool stored: an object takes its id, a string is the id.
      const id = String(((m && typeof m === "object") ? toRec(m).id : m) || m || "").trim();
      if (id && have[id]) delete cs.disabled[id];
    });
  }
  // Default selection for models that just appeared: check the recommended ones, leave the rest
  // off. When the channel carries no recommendation at all (two-model official preset, old
  // Worker), disable nothing: no policy means everything stays visible, never an empty dropdown.
  function seedDefaultSelection(cs: PresetState | CustomProvider, fresh: ModelEntry[]): void {
    if (!fresh.length) return;
    const hasRec = (cs.models || []).some(function (m) { return m.recommended; });
    if (!hasRec) return;
    fresh.forEach(function (m) {
      if (m.recommended) delete cs.disabled[m.id];
      else cs.disabled[m.id] = 1;
    });
  }
  // Store a fetched model list: keep existing switches, default the new models, and only add
  // from the legacy pool.
  function setChannelModels(key: string, models: unknown): void {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return;
    const norm = normModelList(models);
    // An empty answer must not overwrite what is stored: one flaky upstream response would wipe
    // the user's switches.
    if (!norm.length) return;
    const k = parseKey(key);
    if (k && k.kind === "preset") {
      if (!cs.disabled || typeof cs.disabled !== "object") cs.disabled = {};
      const prev: { [id: string]: number } = {};
      (cs.models || []).forEach(function (m) { prev[m.id] = 1; });
      cs.models = norm;
      cs.fetchedAt = nowMs();
      cs.recEra = 1; // 这份清单来自"会下发 recommended 标记"的服务端（旧清单没有这个标记）
      // 1. New models: recommended on, the rest off. Known models keep the user's switches.
      seedDefaultSelection(cs, norm.filter(function (m) { return !prev[m.id]; }));
      // 2. Legacy pool: check what it held, uncheck nothing.
      if (!cs.legacyMigrated) { migrateLegacyPool(cs, k.id); cs.legacyMigrated = true; }
      // 3. Policy upgrade, idempotent: re-check the recommended family for existing users.
      if (Number(cs.defaultsV || 1) < DEFAULTS_V) {
        norm.forEach(function (m) { if (m.recommended) delete cs.disabled[m.id]; });
        cs.defaultsV = DEFAULTS_V;
      }
      // 4. Drop switches for models the upstream retired, so the switch map cannot grow without bound.
      const alive: { [id: string]: number } = {};
      norm.forEach(function (m) { alive[m.id] = 1; });
      Object.keys(cs.disabled).forEach(function (id) { if (!alive[id]) delete cs.disabled[id]; });
    } else {
      cs.models = norm;
    }
    write(st);
  }
  // Whether a list is stale. Only presets are refetched automatically; a custom endpoint and its
  // billing belong to the user, so nothing calls it on their behalf.
  function modelsStale(key: string): boolean {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return false;
    const k = parseKey(key);
    if (!k || k.kind !== "preset") return false;
    if (!cs.models || !cs.models.length) return true;
    // A list without recEra predates the recommendation flag, so it is stale by definition; one
    // refetch sets recEra and from then on only age decides.
    if (!cs.recEra) return true;
    return (nowMs() - Number(cs.fetchedAt || 0)) > MODELS_TTL_MS;
  }
  function selectedModel(key: string): string {
    const st = read();
    const cs = channelState(st, key);
    if (!cs) return "";
    let picked = "";
    if (String(key).indexOf("custom:") === 0) picked = String(cs.model || "");
    else { try { picked = ports.storage.getItem(LS_MODEL) || ""; } catch (e) { picked = ""; } }
    noticeDeprecated(picked);
    return picked;
  }

  // ── fetching model lists (presets via /api/models?provider=, custom via the worker proxy) ──
  // Preset fetches are de-duplicated per key: the silent startup refresh and the settings page's
  // first paint fire in the same second, and the free tiers rate-limit.
  const _fetching: { [key: string]: Promise<FetchResult> } = {};
  function fetchModels(key: string, opts?: { endpoint?: string; apiKey?: string }): Promise<FetchResult> {
    const k0 = String(key || "");
    const kk0 = parseKey(k0);
    if (!kk0 || kk0.kind !== "preset") return fetchModelsInner(key, opts);
    if (_fetching[k0]) return _fetching[k0];
    const p = fetchModelsInner(key, opts).then(
      function (v) { delete _fetching[k0]; return v; },
      function (e) { delete _fetching[k0]; throw e; }
    );
    _fetching[k0] = p;
    return p;
  }
  async function fetchModelsInner(key: string, opts?: { endpoint?: string; apiKey?: string }): Promise<FetchResult> {
    const st = read();
    const k = parseKey(key);
    if (!k) return { ok: false, error: "未知渠道" };
    try {
      if (k.kind === "preset") {
        const r = await fetch("/api/models?provider=" + encodeURIComponent(k.id), { headers: authHeaders() });
        const d = await r.json().catch(function () { return null; });
        if ((!d || !d.ok) && r.status === 404) return { ok: false, error: "服务端未升级（/api/models 无 provider 参数）" };
        const models = normModelList(d && d.models);
        if (d && d.ok && models.length) { setChannelModels(key, models); return { ok: true, count: models.length, title: d.sourceTitle || "" }; }
        return { ok: false, error: (d && d.error) || ("HTTP " + r.status) };
      }
      const cs = channelState(st, k.id);
      const endpoint = (opts && opts.endpoint) || (cs && cs.endpoint) || "";
      const apiKey = (opts && opts.apiKey != null) ? opts.apiKey : ((cs && cs.apiKey) || "");
      if (!endpoint) return { ok: false, error: "先填 Endpoint" };
      const r2 = await fetch("/api/custom-endpoint/models", {
        method: "POST", headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ endpoint: endpoint, apiKey: apiKey }),
      });
      const d2 = await r2.json().catch(function () { return null; });
      const models2 = normModelList(d2 && d2.models);
      if (d2 && d2.ok && models2.length) { setChannelModels(key, models2); return { ok: true, count: models2.length }; }
      return { ok: false, error: (d2 && d2.error) || ("HTTP " + r2.status) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ── custom channel CRUD ──
  function newCustom(patch?: Partial<CustomProvider> | null): string {
    const st = read();
    const base = Object.assign({ id: "p_" + nowMs().toString(36) + "_" + Math.random().toString(36).slice(2, 6), name: "新服务商", updatedAt: nowMs() }, patch || {});
    const p = normalizeCustom(base);
    // Unreachable: base always carries an id.
    if (!p) return "";
    p.updatedAt = nowMs();
    st.custom.push(p);
    write(st);
    return p.id;
  }
  function saveCustom(id: string, fields?: Partial<CustomProvider> | null): boolean {
    const st = read();
    const p = getCustom(st, id);
    if (!p) return false;
    const merged = normalizeCustom(Object.assign({}, p, fields || {}, { id: p.id }));
    if (merged) Object.assign(p, merged);
    p.updatedAt = nowMs();
    write(st);
    return true;
  }
  function deleteCustom(id: string): void {
    const st = read();
    st.custom = st.custom.filter(function (p) { return p.id !== id; });
    // Tombstone: the delete has to travel, or another device pushes its stale copy back.
    if (!st.deleted || typeof st.deleted !== "object") st.deleted = {};
    st.deleted[id] = nowMs();
    if (st.activeId === customKey(id)) st.activeId = null;
    write(st);
  }

  // ── active selection ──
  function setActive(key: string | null): void {
    const st = read();
    let next = key || null;
    // Validate existence, so a deleted channel cannot leave a dangling active selection behind.
    if (next) {
      const k = parseKey(next);
      if (!k) next = null;
      else if (k.kind === "custom" && !getCustom(st, k.id)) next = null;
    }
    // No change, no event: listeners write back and would otherwise loop.
    if (st.activeId === next) return;
    st.activeId = next;
    write(st);
    // Switching to a preset with no list, a stale list or a legacy list fetches once.
    try {
      const kk = parseKey(next);
      if (kk && kk.kind === "preset" && next && modelsStale(next)) { fetchModels(next); }
    } catch (e) {}
  }

  // Startup reconciliation, once per page: a registry that already holds model lists but was never
  // aligned with the legacy pool gets migrated here. Hanging the migration off "fetch" alone would
  // never fire for a user who fetched under the previous version.
  let _legacyReconciled = false;
  function reconcileLegacyOnce(): void {
    if (_legacyReconciled) return;
    _legacyReconciled = true;
    try {
      const st = read();
      let changed = false;
      Object.keys(st.presets || {}).forEach(function (pid) {
        const cs = st.presets[pid];
        if (cs && cs.models && cs.models.length && !cs.legacyMigrated) {
          migrateLegacyPool(cs, pid);
          cs.legacyMigrated = true;
          changed = true;
        }
      });
      if (changed) write(st);
    } catch (e) {}
  }

  // Silent refresh, once per page: re-check every cached preset list against its TTL. Without it a
  // new upstream model waits for somebody to press fetch. Only channels that already have a list
  // are visited — a first fetch is a user action.
  let _staleRefreshed = false;
  function refreshStalePresetsOnce(): void {
    if (_staleRefreshed) return;
    _staleRefreshed = true;
    try {
      const st = read();
      Object.keys(st.presets || {}).forEach(function (pid) {
        const key = presetKey(pid);
        // Silent on failure: the previous list keeps working.
        if (modelsStale(key)) fetchModels(key);
      });
    } catch (e) {}
  }

  function toRec(o: object): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = v;
    return out;
  }

  return {
    read, save: write, mergePublic, republish,
    refreshPresets, presetMeta, channels,
    effectiveKey, activePresetId, modeForActive,
    parseKey,
    byoSnapshot, setActive,
    modelsAll, enabledModels, toggleModel, setAllModels,
    setChannelModels, selectedModel, setSelectedModel,
    fetchModels, modelsStale,
    newCustom, saveCustom, deleteCustom,
    on,
    // Adapter-only: not part of the frozen member list.
    handleStorageEvent, reconcileLegacyOnce, refreshStalePresetsOnce, noticeDeprecated,
    keys: { K3: K3, K3PUB: K3PUB, PRESET_TO_MODE: PRESET_TO_MODE, MODE_TO_PRESET: MODE_TO_PRESET },
  };
}
