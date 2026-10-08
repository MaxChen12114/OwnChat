// src/worker.js
import {
  MODELS_FREE,
  MODELS_FAST,
  DEFAULT_MODEL_FREE,
  DEFAULT_MODEL_FAST,
  DEEPSEEK_PRICING,
  DEEPSEEK_PRICING_DEFAULT,
  CTX_EXACT,
  CTX_HINTS,
} from "./model/data.js";
import {
  PROVIDERS,
  providerForMode,
  isAllowedModelId,
  resolveRequestedModel,
  normalizeByoProvider,
  fetchUpstreamModels,
} from "./model/providers.js";
import { isPrivateHost } from "./net-guard.js";
import { assembleSystemPrompt } from "./prompts/layers/assemble.js";
import { resolveBaseId, baseTextForId, baseIds, presetEntries, skillEntries, libraryVersions } from "./prompts/registry.js";
import { buildCharacterBasePrompt, buildLayer2, isValidCard } from "./prompts/layers/rp.js";
import { buildLorebookInstruction, buildReplyStyleInstruction, buildSummarizeSysPrompt, buildTurnNudge } from "./prompts/layers/chat.js";
import { handleImageRequest } from "./image-routes.js";

// 上游端点注册表 / providerForMode / 模型 id 网关 已搬到 src/model/providers.js

// ────────────────────────────
// 提示词资产(2026-10-04 模块化)→ src/prompts/layers/
//   · rp.js       角色层: 角色卡基座 + 状态聚合(关系情绪/好感度/场景/召唤/阈值)
//   · chat.js     通用聊天层: 回复风格/世界书/先前摘要/摘要任务/鱼缸催发言
//   · assemble.js 唯一装配入口: 层顺序 + 分隔符拼接

// ────────────────────────────
// 鉴权 + 云同步
// ────────────────────────────
// checkAuth: 校验 Authorization: Bearer <password> header
//   返回 null  = 没带 header（"软"模式：调用方决定是否放行）
//   返回 false = 带了 header 但密码不对（一律 401）
//   返回 true  = 校验通过
// /api/chat 和 /api/summarize：null/true 放行，false → 401（聊天密码可选）
// /sync GET/PUT：必须 true，其余一律 401（同步强制密码保护）
function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  const provided = m ? m[1].trim() : "";
  if (!provided) return null;
  const expected = (env.CHAT_PASSWORD || "").trim(); // 2026-06-04: 两边都 trim,避免 secret 末尾换行/空格导致永远不匹配
  if (!expected) return false;
  return provided === expected;
}

// 未设 CHAT_PASSWORD 时一律视为锁定(安全默认,避免裸站泄露)。


// 访问控制只剩一层：设置了 CHAT_PASSWORD 时 /api/* 与 /sync 一律要求 Authorization: Bearer <密码>
// （前端有登录弹窗，见 public/js/text/core/auth.js）；未设置密码则不校验 —— 那等于把模型额度开放给
// 任何拿到地址的人，部署时请务必 `wrangler secret put CHAT_PASSWORD`（README 有说明）。
function requireAuth(request, env) {
  const v = checkAuth(request, env);
  if (v === null && !(env.CHAT_PASSWORD || "").trim()) return true;
  return v === true;
}

// 云同步：单 key 存全部用户数据 blob
// GET /sync  → 返回 KV 里的 JSON blob（空时返回 "null"）
// PUT /sync  → 把 body 整段写入 KV（body 是前端 dump 出的 JSON 字符串）
// 2026-10-06: 两库下发。只回 {version, presets, skills}；库文本本身就是提示词，

// 所以库文本只回给通过密码校验的请求（未登录 403，一个字符都不给）。

async function handlePresetLibrary(request, env) {
  let payload = null;
  try { payload = await request.json(); } catch { payload = null; }
  // 公开版：库文本不下发给未登录访客（只发通过密码校验的本人）
  if (!requireAuth(request, env)) {
    return resp(JSON.stringify({ error: "Unauthorized" }), "application/json; charset=utf-8", 403);
  }
  const versions = libraryVersions();
  return resp(JSON.stringify({
    version: versions,
    presets: presetEntries().map((e) => ({ id: e.id, name: e.name, group: e.group, order: e.order, enabled: e.enabled, lang: e.lang, description: e.description, source: e.source, license: e.license, note: e.note, file: e.file, content: e.text })),
    skills: skillEntries().map((e) => ({ id: e.id, name: e.name, order: e.order, enabled: e.enabled, lang: e.lang, description: e.description, source: e.source, license: e.license, note: e.note, file: e.file, content: e.text })),
  }), "application/json; charset=utf-8", 200, { "Cache-Control": "no-store" });
}

async function handleSync(request, env) {
  if (checkAuth(request, env) !== true) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.TAVERN_SYNC) {
    return resp("KV namespace 'TAVERN_SYNC' not bound. Add binding in wrangler.toml.", "text/plain; charset=utf-8", 500);
  }
  const KEY = "user:default";
  if (request.method === "GET") {
    const raw = await env.TAVERN_SYNC.get(KEY);
    return resp(raw || "null", "application/json; charset=utf-8");
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (!body) {
      return resp("Empty body", "text/plain; charset=utf-8", 400);
    }
    if (body.length > 5 * 1024 * 1024) {
      return resp("Body too large (>5MB)", "text/plain; charset=utf-8", 413);
    }
    await env.TAVERN_SYNC.put(KEY, body);
    return resp(
      JSON.stringify({ ok: true, savedAt: Date.now(), size: body.length }),
      "application/json; charset=utf-8"
    );
  }
  // 4.21 P2 删云端: DELETE /sync → 删除 main blob KV key (全局清空云端的一半)
  if (request.method === "DELETE") {
    await env.TAVERN_SYNC.delete(KEY);
    return resp(
      JSON.stringify({ ok: true, deleted: true, savedAt: Date.now() }),
      "application/json; charset=utf-8"
    );
  }
  return resp("Method not allowed", "text/plain; charset=utf-8", 405);
}

// 4.20: 费用独立同步 (/sync/cost) - 防止 main blob last-write-wins 跨设备覆盖 cost
// 4.50 起: 服务端做 per-day × per-device 分桶 max merge,即使两台设备并发 PUT 也不会丢数据,响应返回 merged 全量供客户端二次落地
async function handleSyncCost(request, env) {
  if (checkAuth(request, env) !== true) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.TAVERN_SYNC) {
    return resp("KV namespace 'TAVERN_SYNC' not bound.", "text/plain; charset=utf-8", 500);
  }
  const KEY = "user:default:cost";
  if (request.method === "GET") {
    const raw = await env.TAVERN_SYNC.get(KEY);
    return resp(raw || "null", "application/json; charset=utf-8");
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (!body) return resp("Empty body", "text/plain; charset=utf-8", 400);
    if (body.length > 512 * 1024) return resp("Body too large (>512KB)", "text/plain; charset=utf-8", 413);
    let incoming;
    try { incoming = JSON.parse(body); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return resp("Body must be object", "text/plain; charset=utf-8", 400);
    }
    const existing = await env.TAVERN_SYNC.get(KEY);
    let prev = {};
    if (existing) {
      try {
        prev = JSON.parse(existing);
        if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
      } catch { prev = {}; }
    }
    // 4.50: 客户端改按设备分桶 { day: { deviceId: {cost,...} } };按 day×device 取 max,跨设备并集
    // 归一:旧扁平 {cost,...} → {legacy:{...}},兼容老客户端/历史数据
    const normDay = (e) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return {};
      if (typeof e.cost === "number" || typeof e.requests === "number" ||
          typeof e.prompt === "number" || typeof e.completion === "number") return { legacy: e };
      return e;
    };
    const merged = {};
    const days = new Set([...Object.keys(prev), ...Object.keys(incoming)]);
    for (const day of days) {
      const da = normDay(prev[day]);
      const db = normDay(incoming[day]);
      const devs = new Set([...Object.keys(da), ...Object.keys(db)]);
      const m = {};
      for (const dev of devs) {
        const a = da[dev] || {};
        const b = db[dev] || {};
        m[dev] = {
          cost: Math.max(a.cost || 0, b.cost || 0),
          prompt: Math.max(a.prompt || 0, b.prompt || 0),
          completion: Math.max(a.completion || 0, b.completion || 0),
          requests: Math.max(a.requests || 0, b.requests || 0),
        };
      }
      merged[day] = m;
    }
    const mergedJson = JSON.stringify(merged);
    await env.TAVERN_SYNC.put(KEY, mergedJson);
    return resp(
      JSON.stringify({ ok: true, savedAt: Date.now(), days: Object.keys(merged).length, size: mergedJson.length, merged }),
      "application/json; charset=utf-8"
    );
  }
  // 4.21 P2 删云端: DELETE /sync/cost → 删除 cost KV key (全局清空云端的另一半)
  if (request.method === "DELETE") {
    await env.TAVERN_SYNC.delete(KEY);
    return resp(
      JSON.stringify({ ok: true, deleted: true, savedAt: Date.now() }),
      "application/json; charset=utf-8"
    );
  }
  return resp("Method not allowed", "text/plain; charset=utf-8", 405);
}

// 4.21-F: 排除清单独立同步通道 (/sync/exclude) - 让「只清云端/恢复」跨设备生效
// registry = { entries: { "<kind>:<key>": {kind,key,state:"excluded"|"restored",ts} } }
// 服务端按条目 ts 做 LWW 合并(谁后操作谁生效),响应返回 merged 全量供客户端二次落地
async function handleSyncExclude(request, env) {
  if (checkAuth(request, env) !== true) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.TAVERN_SYNC) {
    return resp("KV namespace 'TAVERN_SYNC' not bound.", "text/plain; charset=utf-8", 500);
  }
  const KEY = "user:default:exclude";
  if (request.method === "GET") {
    const raw = await env.TAVERN_SYNC.get(KEY);
    return resp(raw || "null", "application/json; charset=utf-8");
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (!body) return resp("Empty body", "text/plain; charset=utf-8", 400);
    if (body.length > 256 * 1024) return resp("Body too large (>256KB)", "text/plain; charset=utf-8", 413);
    let incoming;
    try { incoming = JSON.parse(body); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
    const inEntries = (incoming && typeof incoming === "object" && incoming.entries && typeof incoming.entries === "object") ? incoming.entries : {};
    const existing = await env.TAVERN_SYNC.get(KEY);
    let prevEntries = {};
    if (existing) {
      try { const p = JSON.parse(existing); if (p && p.entries && typeof p.entries === "object") prevEntries = p.entries; } catch {}
    }
    const merged = {};
    const ids = new Set([...Object.keys(prevEntries), ...Object.keys(inEntries)]);
    for (const id of ids) {
      const a = prevEntries[id], b = inEntries[id];
      const aok = a && typeof a.ts === "number";
      const bok = b && typeof b.ts === "number";
      if (aok && bok) merged[id] = b.ts >= a.ts ? b : a;
      else merged[id] = aok ? a : b;
    }
    const out = { entries: merged };
    const outJson = JSON.stringify(out);
    await env.TAVERN_SYNC.put(KEY, outJson);
    return resp(
      JSON.stringify({ ok: true, savedAt: Date.now(), count: Object.keys(merged).length, merged: out }),
      "application/json; charset=utf-8"
    );
  }
  if (request.method === "DELETE") {
    await env.TAVERN_SYNC.delete(KEY);
    return resp(JSON.stringify({ ok: true, deleted: true, savedAt: Date.now() }), "application/json; charset=utf-8");
  }
  return resp("Method not allowed", "text/plain; charset=utf-8", 405);
}

// 4.76: 聊天会话独立同步通道 (/sync/chat) —— 把 cfw_chat_session_v1 移出 main blob,改 slot 级合并
// 避免 main blob 整段 LWW 跨设备互相覆盖聊天(同 4.20 cost 把费用拆出 main 的思路)。blob 结构:
//   { slots:{ [slotKey]:{ updatedAt, deviceId, hash } }, msgs:{ [slotKey]: messages[] },
//     tombstones:{ [slotKey]:{ deletedAt, deviceId } }, convMeta:{ [base]:{ [convId]:{name,createdAt} } } }
// 服务端只做「防御性」合并(slot 按 updatedAt max、tombstone 按 deletedAt max、二者按时间裁决生死),
// 返回 merged 全量供客户端二次落地;真正的「两端都改」冲突检测在客户端用 syncedHash 做。
async function handleSyncChat(request, env) {
  if (checkAuth(request, env) !== true) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.TAVERN_SYNC) {
    return resp("KV namespace 'TAVERN_SYNC' not bound.", "text/plain; charset=utf-8", 500);
  }
  const KEY = "user:default:chat";
  if (request.method === "GET") {
    const raw = await env.TAVERN_SYNC.get(KEY);
    return resp(raw || "null", "application/json; charset=utf-8");
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (!body) return resp("Empty body", "text/plain; charset=utf-8", 400);
    if (body.length > 5 * 1024 * 1024) return resp("Body too large (>5MB)", "text/plain; charset=utf-8", 413);
    let incoming;
    try { incoming = JSON.parse(body); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return resp("Body must be object", "text/plain; charset=utf-8", 400);
    }
    const existing = await env.TAVERN_SYNC.get(KEY);
    let prev = {};
    if (existing) { try { const p = JSON.parse(existing); if (p && typeof p === "object" && !Array.isArray(p)) prev = p; } catch {} }
    const merged = mergeChatBlobsServer(prev, incoming);
    const mergedJson = JSON.stringify(merged);
    await env.TAVERN_SYNC.put(KEY, mergedJson);
    return resp(
      JSON.stringify({ ok: true, savedAt: Date.now(), slots: Object.keys(merged.slots || {}).length, size: mergedJson.length, merged }),
      "application/json; charset=utf-8"
    );
  }
  if (request.method === "DELETE") {
    await env.TAVERN_SYNC.delete(KEY);
    return resp(JSON.stringify({ ok: true, deleted: true, savedAt: Date.now() }), "application/json; charset=utf-8");
  }
  return resp("Method not allowed", "text/plain; charset=utf-8", 405);
}

// 服务端 chat blob 防御性合并(并发 PUT 不丢):slot 按 updatedAt max、tombstone 按 deletedAt max,
// 再用时间戳裁决 slot 与同名 tombstone 的生死(slot 比删除新 → 复活并删 tombstone;否则删 slot);convMeta 浅合并。
function mergeChatBlobsServer(a, b) {
  a = (a && typeof a === "object") ? a : {};
  b = (b && typeof b === "object") ? b : {};
  const aSlots = (a.slots && typeof a.slots === "object") ? a.slots : {};
  const bSlots = (b.slots && typeof b.slots === "object") ? b.slots : {};
  const aMsgs = (a.msgs && typeof a.msgs === "object") ? a.msgs : {};
  const bMsgs = (b.msgs && typeof b.msgs === "object") ? b.msgs : {};
  const aTomb = (a.tombstones && typeof a.tombstones === "object") ? a.tombstones : {};
  const bTomb = (b.tombstones && typeof b.tombstones === "object") ? b.tombstones : {};
  const slots = {}, msgs = {};
  for (const k of new Set([...Object.keys(aSlots), ...Object.keys(bSlots)])) {
    const sa = aSlots[k], sb = bSlots[k];
    const ta = (sa && typeof sa.updatedAt === "number") ? sa.updatedAt : -1;
    const tb = (sb && typeof sb.updatedAt === "number") ? sb.updatedAt : -1;
    if (tb >= ta) { slots[k] = sb || sa; msgs[k] = (k in bMsgs) ? bMsgs[k] : aMsgs[k]; }
    else { slots[k] = sa; msgs[k] = (k in aMsgs) ? aMsgs[k] : bMsgs[k]; }
  }
  const tombstones = {};
  for (const k of new Set([...Object.keys(aTomb), ...Object.keys(bTomb)])) {
    const da = (aTomb[k] && typeof aTomb[k].deletedAt === "number") ? aTomb[k].deletedAt : -1;
    const db = (bTomb[k] && typeof bTomb[k].deletedAt === "number") ? bTomb[k].deletedAt : -1;
    tombstones[k] = db >= da ? bTomb[k] : aTomb[k];
  }
  for (const k of Object.keys(tombstones)) {
    const del = (tombstones[k] && tombstones[k].deletedAt) || 0;
    const upd = (slots[k] && slots[k].updatedAt) || 0;
    if (upd > del) { delete tombstones[k]; }
    else { delete slots[k]; delete msgs[k]; }
  }
  const convMeta = {};
  const am = (a.convMeta && typeof a.convMeta === "object") ? a.convMeta : {};
  const bm = (b.convMeta && typeof b.convMeta === "object") ? b.convMeta : {};
  for (const base of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    convMeta[base] = Object.assign({}, am[base] || {}, bm[base] || {});
  }
  return { slots, msgs, tombstones, convMeta };
}

// 4.78: 角色卡独立同步通道 (/sync/chars) —— 把 tavern_chars_v2(角色卡 + 好感度)移出 main blob,
// 改按卡 id LWW 合并 + tombstone,避免 main blob 整段 LWW 跨设备互相覆盖角色卡(同 4.20 cost / 4.76 chat 思路)。blob 结构:
//   { cards:{ [id]:cardObj }, meta:{ [id]:{updatedAt,deviceId,hash} },
//     affections:{ [cardId]:{value,updatedAt} }, tombstones:{ [id]:{deletedAt,deviceId} } }
// 服务端按 meta.updatedAt / affections.updatedAt / tombstones.deletedAt 取较新者合并,并用时间戳裁决卡与同名 tombstone 的生死。
async function handleSyncChars(request, env) {
  if (checkAuth(request, env) !== true) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.TAVERN_SYNC) {
    return resp("KV namespace 'TAVERN_SYNC' not bound.", "text/plain; charset=utf-8", 500);
  }
  const KEY = "user:default:chars";
  if (request.method === "GET") {
    const raw = await env.TAVERN_SYNC.get(KEY);
    return resp(raw || "null", "application/json; charset=utf-8");
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (!body) return resp("Empty body", "text/plain; charset=utf-8", 400);
    if (body.length > 5 * 1024 * 1024) return resp("Body too large (>5MB)", "text/plain; charset=utf-8", 413);
    let incoming;
    try { incoming = JSON.parse(body); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return resp("Body must be object", "text/plain; charset=utf-8", 400);
    }
    const existing = await env.TAVERN_SYNC.get(KEY);
    let prev = {};
    if (existing) { try { const p = JSON.parse(existing); if (p && typeof p === "object" && !Array.isArray(p)) prev = p; } catch {} }
    const merged = mergeCharsBlobsServer(prev, incoming);
    const mergedJson = JSON.stringify(merged);
    await env.TAVERN_SYNC.put(KEY, mergedJson);
    return resp(
      JSON.stringify({ ok: true, savedAt: Date.now(), cards: Object.keys(merged.cards || {}).length, size: mergedJson.length, merged }),
      "application/json; charset=utf-8"
    );
  }
  if (request.method === "DELETE") {
    await env.TAVERN_SYNC.delete(KEY);
    return resp(JSON.stringify({ ok: true, deleted: true, savedAt: Date.now() }), "application/json; charset=utf-8");
  }
  return resp("Method not allowed", "text/plain; charset=utf-8", 405);
}

// 服务端角色卡 blob 防御性合并(并发 PUT 不丢):卡按 meta.updatedAt max、好感度按 updatedAt max、
// tombstone 按 deletedAt max,再用时间戳裁决卡与同名 tombstone 的生死(卡比删除新 → 复活并删 tombstone;否则删卡)。
function mergeCharsBlobsServer(a, b) {
  a = (a && typeof a === "object") ? a : {};
  b = (b && typeof b === "object") ? b : {};
  const aCards = (a.cards && typeof a.cards === "object") ? a.cards : {};
  const bCards = (b.cards && typeof b.cards === "object") ? b.cards : {};
  const aMeta = (a.meta && typeof a.meta === "object") ? a.meta : {};
  const bMeta = (b.meta && typeof b.meta === "object") ? b.meta : {};
  const aAff = (a.affections && typeof a.affections === "object") ? a.affections : {};
  const bAff = (b.affections && typeof b.affections === "object") ? b.affections : {};
  const aTomb = (a.tombstones && typeof a.tombstones === "object") ? a.tombstones : {};
  const bTomb = (b.tombstones && typeof b.tombstones === "object") ? b.tombstones : {};
  const cards = {}, meta = {};
  for (const k of new Set([...Object.keys(aCards), ...Object.keys(bCards)])) {
    const ma = aMeta[k], mb = bMeta[k];
    const ta = (ma && typeof ma.updatedAt === "number") ? ma.updatedAt : -1;
    const tb = (mb && typeof mb.updatedAt === "number") ? mb.updatedAt : -1;
    if (tb >= ta) { cards[k] = (k in bCards) ? bCards[k] : aCards[k]; meta[k] = mb || ma || { updatedAt: tb }; }
    else { cards[k] = (k in aCards) ? aCards[k] : bCards[k]; meta[k] = ma || mb || { updatedAt: ta }; }
  }
  const affections = {};
  for (const k of new Set([...Object.keys(aAff), ...Object.keys(bAff)])) {
    const ea = aAff[k], eb = bAff[k];
    const ta = (ea && typeof ea.updatedAt === "number") ? ea.updatedAt : -1;
    const tb = (eb && typeof eb.updatedAt === "number") ? eb.updatedAt : -1;
    affections[k] = tb >= ta ? (eb || ea) : (ea || eb);
  }
  const tombstones = {};
  for (const k of new Set([...Object.keys(aTomb), ...Object.keys(bTomb)])) {
    const da = (aTomb[k] && typeof aTomb[k].deletedAt === "number") ? aTomb[k].deletedAt : -1;
    const db = (bTomb[k] && typeof bTomb[k].deletedAt === "number") ? bTomb[k].deletedAt : -1;
    tombstones[k] = db >= da ? bTomb[k] : aTomb[k];
  }
  for (const k of Object.keys(tombstones)) {
    const del = (tombstones[k] && tombstones[k].deletedAt) || 0;
    const upd = (meta[k] && meta[k].updatedAt) || 0;
    if (upd > del) { delete tombstones[k]; }
    else { delete cards[k]; delete meta[k]; delete affections[k]; }
  }
  return { cards, meta, affections, tombstones };
}

function resp(body, contentType = "text/plain; charset=utf-8", status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...extraHeaders },
  });
}

// 2026-09-10 (方案 C): 下发给前端的「候选池覆盖」小脑袋。随 /config.js 一起在最早期执行(早于 app.js 建下拉),
// 把本机勾选的模型(LS cfw_models_free_v1 / cfw_models_fast_v1)盖到 APP_MODELS_*上。
// 没勾任何模型 → 保持内置兜底表(即厂商默认模型),不会出现空下拉。
// 注: 这段用数组 + join("\n") 拼,不用多行模板字符串 —— 避免镜像/搬运过程中换行被吃掉导致下发的 JS 挤成一行报错。
const MODEL_POOL_OVERRIDE_JS = [
  ';(function () {',
  '  function pool(k) {',
  '    try {',
  '      var a = JSON.parse(localStorage.getItem(k) || "[]");',
  '      if (!Array.isArray(a)) return [];',
  '      return a.map(function (m) { return (typeof m === "string") ? { id: m, label: (m.indexOf("/") >= 0 ? m.split("/").pop() : m) } : m; }).filter(function (m) { return m && m.id; });',
  '    } catch (e) { return []; }',
  '  }',
  '  var f = pool("cfw_models_free_v1"), s = pool("cfw_models_fast_v1");',
  '  if (f.length) window.APP_MODELS_FREE = f;',
  '  if (s.length) window.APP_MODELS_FAST = s;',
  '  function has(list, id) { return (list || []).some(function (m) { return m.id === id; }); }',
  '  if (window.APP_MODELS_FREE.length && !has(window.APP_MODELS_FREE, window.APP_DEFAULT_MODEL_FREE)) window.APP_DEFAULT_MODEL_FREE = window.APP_MODELS_FREE[0].id;',
  '  if (window.APP_MODELS_FAST.length && !has(window.APP_MODELS_FAST, window.APP_DEFAULT_MODEL_FAST)) window.APP_DEFAULT_MODEL_FAST = window.APP_MODELS_FAST[0].id;',
  '  try {',
  '    var cur = localStorage.getItem("cfw_model");',
  '    // 上次选的模型已不在池里(改了池 / 源站下线了这个版本) → 清掉,自动回落厂商默认',
  '    if (cur && !has(window.APP_MODELS_FREE, cur) && !has(window.APP_MODELS_FAST, cur)) localStorage.removeItem("cfw_model");',
  '  } catch (e) {}',
  '})();',
].join("\n");

function clientConfigJs() {
  const free = MODELS_FREE.map((m) => ({ id: m.id, label: m.label }));
  const fast = MODELS_FAST.map((m) => ({ id: m.id, label: m.label }));
  return [
    `window.APP_MODELS_FREE = ${JSON.stringify(free, null, 2)};`,
    `window.APP_MODELS_FAST = ${JSON.stringify(fast, null, 2)};`,
    `window.APP_DEFAULT_MODEL_FREE = ${JSON.stringify(DEFAULT_MODEL_FREE)};`,
    `window.APP_DEFAULT_MODEL_FAST = ${JSON.stringify(DEFAULT_MODEL_FAST)};`,
    `window.DEEPSEEK_PRICING = ${JSON.stringify(DEEPSEEK_PRICING || {}, null, 2)};`,
    // 2026-09-10 候选池改造: 前端可能遇到价格表里没有的新模型名,给一个兜底价避免计费算成 0
    `window.DEEPSEEK_PRICING_DEFAULT = ${JSON.stringify(DEEPSEEK_PRICING_DEFAULT || {})};`,
    // 2026-09-14:模型上下文窗口表(上游 /v1/models 不返回该字段,只能由 worker 配置下发)
    `window.APP_CTX_EXACT = ${JSON.stringify(CTX_EXACT || {})};`,
    `window.APP_CTX_HINTS = ${JSON.stringify(CTX_HINTS || [])};`,
    // 基座候选(来自 bases/index.js 的自动发现注册表)。只下发 id 列表、不下发文本。
    `window.APP_BASE_IDS = ${JSON.stringify(baseIds())};`,
    MODEL_POOL_OVERRIDE_JS,
  ].join("\n");
}

// 2026-09-10 (方案 C): GET /api/models?mode=free|fast —— 翻源站的模型列表给前端候选池抽屉。
// key 始终留在服务端(前端拿不到),返回前先用 isAllowedModelId 过一遭厂商白名单——
// NIM 上百来个模型,不过滤的话抽屉里糊一屏根本没法选。拉不到时回内置兜底表,UI 不至于空。
async function handleModelsList(request, env) {
  if (!requireAuth(request, env)) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "fast" ? "fast" : "free";
  const provider = providerForMode(mode);
  const builtin = (mode === "fast" ? MODELS_FAST : MODELS_FREE).map((m) => ({ id: m.id, label: m.label }));
  const apiKey = env[provider.keyEnv];
  const fail = (error) => resp(
    JSON.stringify({ ok: false, mode, error, models: builtin, source: "builtin" }),
    "application/json; charset=utf-8", 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
  );
  if (!apiKey) return fail(`Missing ${provider.keyEnv}`);
  // 取数与过滤收在 src/model/providers.js(只做模型域的事,不碰 HTTP 组装)
  const res = await fetchUpstreamModels(provider, apiKey, {
    timeoutMs: 20000,
    filter: (id) => isAllowedModelId(mode, id),
  });
  if (!res.ok) return fail(`Upstream ${res.error}`);
  const seen = new Set();
  const models = res.models
    .map((m) => String(m.id || "").trim())
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .sort()
    .map((id) => ({ id, label: id.includes("/") ? id.split("/").pop() : id }));
  if (!models.length) return fail("Upstream returned no usable model");
  return resp(
    JSON.stringify({ ok: true, mode, source: provider.label, count: models.length, models, builtin }),
    "application/json; charset=utf-8", 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
  );
}

// 2026-09-12 (4.70 块⑤): 自定义 OpenAI 兼容端点模型列表代理。
// 前端传 chat/completions 全路径或 base URL 均可；这里归一到 /v1/models。
// Key 不落 KV、不写日志、不返回前端，只用于本次代请求。失败时返回 ok:false，让前端保留手填 fallback。
async function handleCustomEndpointModels(request, env) {
  if (!requireAuth(request, env)) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  let body;
  try { body = await request.json(); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400, { "Access-Control-Allow-Origin": "*" }); }
  const endpoint = String((body && body.endpoint) || "").trim();
  const apiKey = String((body && body.apiKey) || "").trim();
  if (!endpoint) {
    return resp(JSON.stringify({ ok: false, error: "Missing endpoint", models: [] }), "application/json; charset=utf-8", 400, { "Access-Control-Allow-Origin": "*" });
  }
  let u;
  try { u = new URL(endpoint); } catch {
    return resp(JSON.stringify({ ok: false, error: "Bad endpoint", models: [] }), "application/json; charset=utf-8", 400, { "Access-Control-Allow-Origin": "*" });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return resp(JSON.stringify({ ok: false, error: "Only http/https endpoint is allowed", models: [] }), "application/json; charset=utf-8", 400, { "Access-Control-Allow-Origin": "*" });
  }
  if (/\/chat\/completions\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "/models");
  else if (/^\/?$/.test(u.pathname)) u.pathname = "/v1/models"; // 允许只填 https://api.openai.com 这类裸域名
  else if (!/\/models\/?$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/$/, "") + "/models";
  }
  u.search = "";
  const upstream = await fetchWithTimeout(u.toString(), {
    method: "GET",
    headers: {
      ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      "Accept": "application/json",
    },
  }, 20000);
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    return resp(JSON.stringify({ ok: false, error: `Upstream ${upstream.status}`, detail: txt.slice(0, 300), models: [] }), "application/json; charset=utf-8", 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  }
  const data = await upstream.json().catch(() => null);
  const raw = Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  const models = raw
    .map((m) => String((m && m.id) || "").trim())
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .sort()
    .map((id) => ({ id, label: id.includes("/") ? id.split("/").pop() : id }));
  return resp(
    JSON.stringify({ ok: true, source: u.origin, count: models.length, models }),
    "application/json; charset=utf-8", 200, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
  );
}

// 带超时 fetch（不自动重试，避免浪费 token 额度）
async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    return new Response(
      `请求超时或网络错误: ${e.message}`,
      { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}

// 524 修复：上游 SSE 流外包一层心跳，每 25s 向流里注入 `: ping` SSE 注释行。
// 注释行不以 data: 开头，浏览器和标准 SSE 解析器自动忽略，对前端零侵入。
// 防止思考模式长沉默期（V4-Pro 思考 chunk 间隔可超 100s）被 CF 边缘阈值切断。
// 注意: 2026-06-15 起默认聊天流不再包装(直接透传 upstream.body),本函数仅在
// X-Debug-Stream: 1 + debugEcho 的调试路径使用。
function streamWithHeartbeat(upstreamBody, prefixChunk) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      // 携带"真正发给模型"的 system 装配 + 最终 messages 快照。注释行不以 data: 开头,
      if (prefixChunk) { try { controller.enqueue(encoder.encode(prefixChunk)); } catch {} }
      const ticker = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
      }, 25000);
      const reader = upstreamBody.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (err) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(err?.message || err) })}\n\n`));
        } catch {}
      } finally {
        clearInterval(ticker);
        try { controller.close(); } catch {}
      }
    },
    cancel(reason) {
      try { upstreamBody.cancel(reason); } catch {}
    },
  });
}

async function handleChat(request, env) {
  // 软鉴权：带 header 必须对，没带就放行（聊天密码可选）
  if (!requireAuth(request, env)) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return resp("Bad JSON", "text/plain; charset=utf-8", 400);
  }

  // mode: "free"=NVIDIA NIM | "fast"=DeepSeek 官方
  const mode = payload?.mode === "fast" ? "fast" : "free";

  // 两套注册表在 src/prompts/registry.js 里严格隔离 —— 锁定分支根本不读 BASES。

  // 2026-06-16 (4.69 BYO): 自定义模型直连 —— payload.customProvider={endpoint,model,apiKey[,supportsThinking,needsReasoningHistory]} 时,
  // 跳过 free/fast 白名单替换,直连用户自带的 OpenAI 兼容端点(GPT/Qwen/Kimi/本地 vLLM 等)。
  const byo = normalizeByoProvider(payload);

  // 4.69 G1: 是否给 assistant 历史补 reasoning_content,由 provider 能力位决定(不再写死 mode==="fast",将来新增思考型 provider 自动生效)
  const needsReasoningHistory = (byo || providerForMode(mode)).needsReasoningHistory;

  // 2026-09-14:模型解析收敛到 src/model/providers.js。原来非法 id 会**静默回落内置占位符**
  // (`__free_placeholder__`)并发到上游 → 用户看到的是上游的费解报错;现在直接返回可操作的提示。
  const _resolved = resolveRequestedModel(mode, payload?.model, byo);
  if (_resolved.error) {
    // 用 JSON 返回:前端能把这条提示原样显示给用户,比上游那句 "Authorization failed" 之类好懂得多
    return resp(JSON.stringify({ error: _resolved.error }), "application/json; charset=utf-8", 400);
  }
  const model = _resolved.model;

  // 「内置/自定义」总开关。
  const useBuiltinPersona = payload?.use_builtin_persona !== false;
  const customSystemPrompt =
    typeof payload?.custom_system_prompt === "string"
      ? payload.custom_system_prompt.trim()
      : "";
  // 角色卡结构化数据 + 关系/情绪/思考模式开关（Phase 2）
  const characterCard = payload?.characterCard;
  const relation = typeof payload?.relation === "string" ? payload.relation : "default";
  const emotion = typeof payload?.emotion === "string" ? payload.emotion : "neutral";
  const thinking = payload?.thinking === "enabled" ? "enabled" : "disabled";
  // 4.69 G1: DeepSeek 思考强度 + OpenAI 兼容采样/JSON 模式透传(仅 payload 显式提供时带,默认保持旧行为)
  const reasoningEffort = ["high", "medium", "low"].includes(payload?.reasoning_effort) ? payload.reasoning_effort : null;
  const responseFormat = (payload?.response_format && typeof payload.response_format === "object") ? payload.response_format : null;
  const temperature = (typeof payload?.temperature === "number") ? payload.temperature : null;
  const topP = (typeof payload?.top_p === "number") ? payload.top_p : null;
  const maxTokens = (typeof payload?.max_tokens === "number" && payload.max_tokens > 0) ? Math.floor(payload.max_tokens) : null;
  const stop = (Array.isArray(payload?.stop) && payload.stop.length) ? payload.stop.slice(0, 16) : null;
  // 好感度数值（0-100，可选；未传或非法则不注入阶梯指令）
  const affection = typeof payload?.affection === "number" && !isNaN(payload.affection)
    ? Math.max(0, Math.min(100, payload.affection)) : null;
  // 多人对话场景：其他在场角色的名字（不含当前发言者）
  const sceneOtherNames = Array.isArray(payload?.sceneOtherNames) ? payload.sceneOtherNames : [];
  // 4.52 在场感 part2：可召唤的场景外角色名单（前端仅在群聊驱动场景下传入）
  const summonableNames = Array.isArray(payload?.summonableNames) ? payload.summonableNames : [];
  // 阶段 4-②：一次性阈值事件； 4-③：先前剧情摘要
  const thresholdEvents = Array.isArray(payload?.thresholdEvents) ? payload.thresholdEvents : [];
  const priorSummary = typeof payload?.priorSummary === "string" ? payload.priorSummary : "";
  // Phase 4 阶段 11：鱼缸讨论模式（fishbowl-engine 调用时传入）
  // fishbowlMode: "" | "relay" | "discuss"（空串走 orchestrate / V1 兼容路径）
  const fishbowlMode = typeof payload?.fishbowlMode === "string" ? payload.fishbowlMode : "";
  const topic = typeof payload?.topic === "string" ? payload.topic : "";
  // Phase 4 阶段 6：提示词预设库（前端已 join('\n\n') 成一整段，worker 只负责追加在系统提示末尾）
  let extraSystemPrompts = typeof payload?.extraSystemPrompts === "string" ? payload.extraSystemPrompts.trim() : "";
  // 4.21 占位符宏替换: 预设(starter-presets.json / 自定义)中的 char / user 替换为实际名字
  if (extraSystemPrompts) {
    const _charName = (characterCard && typeof characterCard.name === "string" && characterCard.name.trim()) ? characterCard.name.trim() : "角色";
    const _userName = (typeof payload?.userName === "string" && payload.userName.trim()) ? payload.userName.trim() : "用户";
    extraSystemPrompts = extraSystemPrompts
      .replace(/\{\{\s*char\s*\}\}/gi, _charName)
      .replace(/\{\{\s*user\s*\}\}/gi, _userName);
  }
  // 2026-05-29: 回复风格 (default / wechat / verbose) - 所有象限通用追加层
  const replyStyle = (payload?.replyStyle === "wechat" || payload?.replyStyle === "verbose") ? payload.replyStyle : "default";
  //   门禁没放宽,只是换了形状 —— 两支的注册表在 registry.js 里严格隔离,锁定分支根本不读 BASES,
  //   所以「锁定态传 baseId」既拿不到底座文本(有回归用例),也不会报错。
  // promptProfile="rp" 吃 Layer2 状态层(关系/情绪/好感/场景/摘要);"assist" 不吃。
  // 缺省回退: 有角色卡 → rp, 无卡 → assist(旧客户端不发该字段也不炸)。
  const promptProfile = (payload?.promptProfile === "rp" || payload?.promptProfile === "assist")
    ? payload.promptProfile
    : (isValidCard(characterCard) ? "rp" : "assist");
  const isRpProfile = promptProfile === "rp";
  // 2026-10-05: 状态层开关(设置里可见)。这也回答了「为什么默认就是 RP」——判定只有一条
  //   「有角色卡就注入状态层」,这个开关就是那个手动把手;关掉 → 角色卡照旧,只是不再注入
  //   【当前状态】那一段。缺省(字段不存在)= 开,老客户端行为不变。
  const injectStateLayer = payload?.stateLayer !== false;

  // Worker 端拼装 system prompt: 缓存友好分段——静态基座钉前缀,动态状态(Layer2)留到末尾。
  // 角色基座 = 角色卡本身(Layer1);身份铁则层已于 2026-10-05 删除。
  const characterBasePrompt = buildCharacterBasePrompt(characterCard);
  const characterStatePrompt = (isRpProfile && injectStateLayer && isValidCard(characterCard))
    ? buildLayer2(relation, emotion, affection, sceneOtherNames, thresholdEvents, priorSummary, fishbowlMode, topic, characterCard.name || "", replyStyle, summonableNames)
    : "";

  // 2026-06-08 内核 agent 循环: 透传工具调用协议
  //   tools/tool_choice 原样转上游(OpenAI 兼容 function calling)
  //   wantStream=false(payload.stream===false) → 非流式,返回完整 JSON(含 tool_calls)供前端 runAgentLoop 解析
  //   默认 stream=true,保持现有单轮流式聊天零改动
  const tools = Array.isArray(payload?.tools) && payload.tools.length ? payload.tools : null;
  // 2026-10-07 联网搜索：最后一轮要能"摘掉工具"强制作答，所以走一个可变副本（见下方工具循环）。
  let finalTools = tools;
  const toolChoice = payload?.tool_choice !== undefined ? payload.tool_choice : undefined;
  const wantStream = payload?.stream !== false;

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const upstreamMessages = [];

  // ── 2026-06-15 缓存友好的 system 装配 ───────────────────────────────
  // DeepSeek cache_hit 命中条件: 请求前缀逐字稳定。旧装配把动态状态(Layer2: 好感/情绪/摘要/
  // 场景)夹在 system 中段,每轮状态一变就击穿整个前缀,连带后面对话历史一起无法命中。
  // (世界书 + Layer2 状态)统一挪到 system 末尾——既最大化缓存命中,又借 recency 提升状态遵从。
  const debugEcho = requireAuth(request, env) && payload?._debugEcho === true;
  const lorebookEntries = Array.isArray(payload?.lorebook) ? payload.lorebook : [];
  const lorebookInstr = buildLorebookInstruction(lorebookEntries);
  const replyStyleInstr = buildReplyStyleInstruction(replyStyle);

  // 静态前缀段(会话内逐字稳定 → 命中缓存);层顺序/拼接见 src/prompts/layers/assemble.js
  // 各自走白名单(resolve*Id:乱传/缺省回落各自注册表的默认档)。锁定分支**不读 BASES**,
  // 所以「锁定态传 baseId」既拿不到底座文本、也不会报错(隔离回归见 redteam/e2e-prompts.mjs)。
  const promptId = resolveBaseId(payload?.baseId);
  const promptText = useBuiltinPersona ? baseTextForId(promptId) : "";
  const { systemContent, staticParts, dynamicParts } = assembleSystemPrompt({
    baseText: promptText, characterBasePrompt, customSystemPrompt,
    replyStyleInstr, extraSystemPrompts, lorebookInstr, characterStatePrompt,
  });
  if (systemContent) {
    upstreamMessages.push({ role: "system", content: systemContent });
  }

  // 多智能体串话修复(2026-05-29 v4.9):
  //   把「其他角色」的 assistant 消息转成 user 消息 + 【角色名】前缀,
  //   让模型清楚知道 history 里哪条不是自己说的。
  //   只把当前 speaker (characterCard.name) 的 assistant 历史保持 assistant role。
  //   speakerName 缺失时 fallback 保持 assistant(兑现旧历史兼容)。
  const myName = (characterCard && typeof characterCard.name === "string") ? characterCard.name : "";
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    // 2026-06-08 内核 agent 循环: 透传 tool 角色消息(工具执行结果),tool_call_id/name 一并带上
    if (msg.role === "tool") {
      const entry = {
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      };
      if (msg.tool_call_id) entry.tool_call_id = msg.tool_call_id;
      if (msg.name) entry.name = msg.name;
      upstreamMessages.push(entry);
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = typeof msg.content === "string" ? msg.content
      : (Array.isArray(msg.content) ? msg.content : ""); // Vision: 数组 content(图文混合)原样透传
    if (msg.role === "assistant") {
      const speaker = typeof msg.speakerName === "string" ? msg.speakerName : "";
      // 2026-06-08 内核 agent 循环: 带 tool_calls 的 assistant 消息必须原样回传(否则下一轮 tool 结果无法配对)
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const entry = { role: "assistant", content: content || "", tool_calls: msg.tool_calls };
        // G1(4.69): 推理模型要求 assistant 历史必带 reasoning_content,缺失/空也要给 ""(否则 400)
        if (needsReasoningHistory) {
          entry.reasoning_content = (typeof msg.reasoning_content === "string") ? msg.reasoning_content : "";
        }
        upstreamMessages.push(entry);
        continue;
      }
      if (myName && speaker && speaker !== myName) {
        // 其他角色 → 翻译成 user role,加发言者前缀
        upstreamMessages.push({ role: "user", content: `【${speaker}】${content}` });
        continue;
      }
      // 当前角色自己的历史 / 无 speakerName(单人模式) → 保持 assistant
      const entry = { role: "assistant", content };
      // G1(4.69): 推理模型要求 assistant 历史必带 reasoning_content,缺失/空也要给 ""(否则 400)
      if (needsReasoningHistory) {
        entry.reasoning_content = (typeof msg.reasoning_content === "string") ? msg.reasoning_content : "";
      }
      upstreamMessages.push(entry);
    } else {
      upstreamMessages.push({ role: "user", content });
    }
  }

  // Phase 4 阶段 11：鱼缸模式（relay/discuss）需确保 upstream messages 最后一条为 user role
  // 否则 OpenAI 兼容 API 通常会报错（last must be user）。鱼缸引擎调空 user 文本触发，
  // 前端不向 session 注入引导消息，由 worker 端临时追加（不影响 session 历史）
  if (fishbowlMode === "relay" || fishbowlMode === "discuss") {
    const reversed = [...upstreamMessages].reverse();
    const lastConv = reversed.find(m => m.role === "user" || m.role === "assistant");
    if (!lastConv || lastConv.role === "assistant") {
      upstreamMessages.push({ role: "user", content: buildTurnNudge(fishbowlMode, topic) });
    }
  }

  // 2026-10-08 入站协议净化（权威边界）：旧版停止按钮会把"断掉的回合"原样落盘
  // （assistant.tool_calls 之后没有 tool 结果 / 孤儿 role:"tool"），重启后每次请求被上游 400；
  // G1 只删空 assistant，治不了这种协议断裂。客户端已有同语义自愈（app.js sanitizeToolProtocol
  // 复用 agent-kernel.pairPendingToolCalls），这里是第二道防线 —— 一次修好所有设备、所有历史会话
  // （脏数据在各自的 localStorage 里，不能指望每个客户端都跑新代码）。
  // 语义：① 全数组没有任何 assistant.tool_calls 声明过的 tool 消息 → 丢；
  //       ② 未配对的 tool_call → **紧邻**插入合成结果（协议要求 tool 结果紧跟对应调用，
  //          拖到数组末尾在历史中段是非法顺序）。
  function normalizeToolProtocol(list) {
    let touched = false;
    for (const m of list) {
      if (m && (m.role === "tool" || (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length))) { touched = true; break; }
    }
    if (!touched) return list; // 纯 RP/聊天路径零开销

    const declared = new Set();
    for (const m of list) {
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) if (c && c.id) declared.add(c.id);
      }
    }
    const kept = [];
    for (const m of list) {
      if (m && m.role === "tool" && (!m.tool_call_id || !declared.has(m.tool_call_id))) continue;
      kept.push(m);
    }
    const answered = new Set();
    for (const m of kept) if (m && m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
    let repaired = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = kept[i];
      if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
      const missing = m.tool_calls.filter((c) => c && c.id && !answered.has(c.id));
      if (!missing.length) continue;
      const synth = missing.map((c) => ({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify({ error: "回合被中断，工具结果未知（服务端协议自愈）" }),
      }));
      kept.splice(i + 1, 0, ...synth);
      for (const s of synth) answered.add(s.tool_call_id);
      repaired += synth.length;
    }
    if (repaired) {
      // 留痕（不静默：仓库纪律"缺东西要响"）—— 出现即说明有客户端送来了断裂协议
      try { console.log("[api/chat] 入站协议自愈：补写 " + repaired + " 条合成工具结果"); } catch (e) {}
    }
    return kept;
  }

  // G1(4.69 · AstrBot 踩坑②): 过滤"既无 content 又无 tool_calls"的空 assistant 消息(DeepSeek 会 400)
  const cleanedMessages = normalizeToolProtocol(upstreamMessages).filter((m) => {
    if (!m || m.role !== "assistant") return true;
    const hasContent = typeof m.content === "string" && m.content.trim();
    const hasCalls = Array.isArray(m.tool_calls) && m.tool_calls.length;
    return hasContent || hasCalls;
  });

  // 选择 provider(OpenAI 兼容注册表)+ API Key;BYO 直连时 provider 即用户自带配置
  const provider = byo || providerForMode(mode);
  const apiKey = byo ? byo.apiKey : env[provider.keyEnv];
  // BYO 允许空 key(本地 vLLM/ollama 无需鉴权);内置 provider 仍要求配置 secret
  if (!byo && !apiKey) {
    return resp(
      `Missing ${provider.keyEnv} (please set it with wrangler secret).`,
      "text/plain; charset=utf-8",
      500
    );
  }
  const endpoint = provider.endpoint;

  // 2026-06-15 dev 回显快照(只反射不改): 把"真正发给模型"的 system 装配 + 最终 messages 原样打包,
  // 供本人 dev 面板做底层输入核对。仅 debugEcho 命中时构造,普通请求为 null 零开销。
  const _dbg = debugEcho ? {
    v: 1, t: "dbg", at: Date.now(),
    model, mode, upstream: provider.label, authed,
    thinking: provider.supportsThinking ? thinking : "n/a",
    reasoningEffort, temperature, topP, maxTokens, wantStream,
    flags: { useBuiltinPersona, prompt: promptId, replyStyle, needsReasoningHistory, promptProfile, stateLayer: injectStateLayer },
    sysParts: staticParts.length + " static / " + dynamicParts.length + " dynamic",
    sysChars: systemContent.length,
    msgCount: cleanedMessages.length,
    systemContent,
    messages: cleanedMessages,
  } : null;

  const startTime = Date.now();

  // 4.82: 思考参数按 provider 方言装配 —— 免费档(NVIDIA NIM)也能开思考。
  //   · DeepSeek 官方:thinking:{type:"enabled"|"disabled"} + reasoning_effort
  //   · NIM / vLLM 系:chat_template_kwargs.thinking(官方对 deepseek-v3.1 等即以此控制模板 thinking 分支)
  const thinkParams = (() => {
    if (!provider.supportsThinking) return {};
    const enabled = thinking === "enabled";
    const effort = (enabled && reasoningEffort) ? { reasoning_effort: reasoningEffort } : {};
    if (provider.thinkingStyle === "vllm") {
      // 免费档只在「开启思考」时附加该参数 —— 关闭态保持与旧版一字不差的请求体,
      // 否则不认 chat_template_kwargs 的上游会给每次普通对话都多来一轮 400 降级重试。
      return enabled ? { chat_template_kwargs: { thinking: true, ...effort } } : {};
    }
    return { thinking: { type: thinking }, ...effort }; // DeepSeek 官方:关闭态也要显式下发 disabled
  })();
  let activeThinkParams = thinkParams;
  let thinkingDowngraded = false; // 4.82: 因上游 400 去掉思考参数时置位(用 X-Thinking 暴露,便于排查"开了思考没生效")
  // ── 2026-10-07 联网搜索（普通聊天）────────────────────────────────────────
  // 开关打开时给上游挂一个 web_search 工具；模型要搜就由 worker 自己查（复用 runSearch：Exa 可选 + DDG 兜底），
  // 结果回灌后再让它作答。最多 2 轮防跑飞；只有"最后一轮"走原有流式管线，前端打字机效果不变。
  // 为什么在 worker 侧查：DeepSeek 官方 API 没有服务端搜索（官方文档里内置工具标 Ignored），
  // 所以"联网"这件事只能由我们自己的 Worker 代查。
  if (payload?.webSearch === true && !byo) {
    // 深搜(Exa，按次计费)双门控：前端「深度搜索」开关打开 且 Worker 配了 EXA_API_KEY 才允许；
    // 否则模型就算把 deep 写成 true 也只走免费 DDG（不让一次"多花点钱"的调用溜过去）。
    const deepAllowed = payload?.webSearchDeep === true && !!(env && (env.EXA_API_KEY || "").trim());
    const SEARCH_TOOL = {
      type: "function",
      function: {
        name: "web_search",
        description: "联网搜索。需要实时或较新的信息（新闻、价格、版本号、赛事、人物近况、你知识外的事实）时调用；返回标题+摘要+链接。"
          + (deepAllowed ? "" : "注意：本部署未开启深搜，deep 字段请一律填 false。"),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词（中英文均可）" },
            deep: { type: "boolean", description: "是否深搜：普通搜索不够准/不够全时才置 true（可能产生额外成本）" },
          },
          required: ["query", "deep"],
          additionalProperties: false,
        },
        strict: true,
      },
    };
    const stripStrict = (list) => list.map((t) => ({ type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } }));
    let rounds = 0, searched = false;
    while (rounds < 2) {
      const sendTools = (tools || []).concat([SEARCH_TOOL]);
      const probeBody = { model: model, stream: false, messages: cleanedMessages, tools: sendTools, tool_choice: "auto", ...activeThinkParams };
      const probeHeaders = { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" };
      const probeTimeout = thinking === "enabled" ? 90000 : 60000;
      let probe = await fetchWithTimeout(endpoint, { method: "POST", headers: probeHeaders, body: JSON.stringify(probeBody) }, probeTimeout);
      if (!probe.ok && probe.status === 400) {
        // 上游不认 strict（部分 OpenAI 兼容端点）→ 去掉 strict 重试一次，工具本身仍然可用
        const t = await probe.text().catch(() => "");
        if (/strict/i.test(t)) {
          const relaxed = Object.assign({}, probeBody, { tools: stripStrict(sendTools) });
          probe = await fetchWithTimeout(endpoint, { method: "POST", headers: probeHeaders, body: JSON.stringify(relaxed) }, probeTimeout);
        } else {
          break; // 其它 400：不在这里吞，交回正常管线按原逻辑报错
        }
      }
      if (!probe.ok) break;
      const pj = await probe.json().catch(() => null);
      const pmsg = pj && pj.choices && pj.choices[0] && pj.choices[0].message;
      const calls = (pmsg && pmsg.tool_calls) || [];
      const wantSearch = calls.some((c) => c && c.function && c.function.name === "web_search");
      if (!wantSearch) break; // 模型不需要搜索 → 直接进正常出稿
      cleanedMessages.push({ role: "assistant", content: (pmsg && pmsg.content) || "", tool_calls: calls });
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse((c.function && c.function.arguments) || "{}"); } catch (_) {}
        let toolText = "";
        if (c.function && c.function.name === "web_search") {
          const q = String(args.query || "").trim();
          if (!q) toolText = "错误：缺少 query";
          else {
            const r = await runSearch(env, q, { n: 5, deep: deepAllowed && args.deep === true });
            toolText = formatSearchForModel(q, r);
            if (r && r.ok !== false) searched = true;
          }
        } else {
          toolText = "错误：本会话只提供 web_search 工具。";
        }
        cleanedMessages.push({ role: "tool", tool_call_id: c.id, content: toolText });
      }
      rounds++;
    }
    if (searched) {
      cleanedMessages.push({
        role: "system",
        content: "上面的 web_search 结果是你自己 Worker 的实时检索结果。请基于这些结果回答；引用具体信息时在句末附来源链接（如 <https://…>）。若结果与问题无关，就如实说没查到。",
      });
      // 最后一轮摘掉工具：强制它出正文而不是再来一轮搜索（也挡住无限循环）
      finalTools = null;
    }
  }

  const buildUpstreamOptions = (thinkExtra) => ({
    method: "POST",
    headers: {
      ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}), // BYO 本地端点可无鉴权
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: wantStream,
      ...(wantStream ? { stream_options: { include_usage: true } } : {}),
      messages: cleanedMessages,
      // 2026-06-08 内核 agent 循环: 透传 function calling 协议(tools/tool_choice)
      ...(finalTools ? { tools: finalTools } : {}),
      ...(finalTools && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      // 4.69 G1 / 4.82: 思考模式 + 强度(按 provider 方言;见上 thinkParams)
      ...thinkExtra,
      // 4.69 G1: OpenAI 兼容采样 / JSON 模式透传(仅 payload 显式提供时带,保持旧行为零变化)
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(temperature !== null ? { temperature } : {}),
      ...(topP !== null ? { top_p: topP } : {}),
      ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
      ...(stop ? { stop } : {}),
    }),
  });
  const upstreamOptions = buildUpstreamOptions(activeThinkParams);
  // 524 修复：思考模式首字节可能需 30~60s，fetch 超时从 20s 延长到 90s
  // 内核非流式(agent 循环)整段返回也可能偏慢,给 60s
  // 4.82: 超时判断同样不再绑定 fast —— 免费档开思考也需要长超时,否则首字节未到就被 20s 掐断
  const upstreamTimeout = thinking === "enabled" ? 90000 : (!wantStream ? 60000 : 20000);
  let upstream = await fetchWithTimeout(endpoint, upstreamOptions, upstreamTimeout);
  // 4.82 容错:上游不认思考参数时(典型 400 invalid request)去掉该参数重试一次,
  // 让"开了思考"最多退化成"思考未生效",而不是整个请求挂掉(尤其免费档 NIM)。
  if (!upstream.ok && upstream.status === 400 && Object.keys(activeThinkParams).length) {
    thinkingDowngraded = true;
    activeThinkParams = {};
    upstream = await fetchWithTimeout(endpoint, buildUpstreamOptions(activeThinkParams), upstreamTimeout);
  }
  // 4.69 G1: DeepSeek 系统繁忙(429/503,对应 insufficient_system_resource)自动重试一次
  if (provider.retryOnBusy && (upstream.status === 429 || upstream.status === 503)) {
    await new Promise((r) => setTimeout(r, 800));
    upstream = await fetchWithTimeout(endpoint, buildUpstreamOptions(activeThinkParams), upstreamTimeout);
  }

  if (!upstream.ok) {
    // 2026-10-05:不再回显上游错误原文(理由同 summarize 路径) —— 只回状态码。
    return resp(
      `Upstream error ${upstream.status}`,
      "text/plain; charset=utf-8",
      502
    );
  }

  const ttfb = Date.now() - startTime;

  // 2026-06-08 内核 agent 循环: 非流式 → 原样回传上游完整 JSON(含 choices[].message.tool_calls),
  // 供前端 runAgentLoop 解析工具调用;不走 SSE 心跳包装。
  if (!wantStream) {
    const data = await upstream.json().catch(() => null);
    if (!data) {
      return resp("Upstream returned invalid JSON", "text/plain; charset=utf-8", 502);
    }
    if (_dbg) { try { data._debug = _dbg; } catch {} } // 2026-06-15 dev 回显(非流式/agent 路径)
    return resp(JSON.stringify(data), "application/json; charset=utf-8", 200, {
      "X-TTFB-Ms": String(ttfb),
      "X-Model": model,
      "X-Mode": mode,
      "X-Thinking": provider.supportsThinking ? (thinkingDowngraded ? thinking + "-downgraded" : thinking) : "n/a",
      "X-Upstream": provider.label,
    });
  }

  const streamHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-TTFB-Ms": String(ttfb),
    "X-Model": model,
    "X-Mode": mode,
    "X-Thinking": provider.supportsThinking ? (thinkingDowngraded ? thinking + "-downgraded" : thinking) : "n/a",
    "X-Upstream": provider.label,
    "X-Stream-Mode": "passthrough",
  };
  // 2026-09-13: CF Workers 免费版 CPU 极紧；默认不要用 JS 逐 chunk 包装/搬运 SSE。
  // 普通聊天直接把 upstream.body 原样返回，避免长文输出时 read/enqueue/heartbeat 累计 CPU 导致截断。
  // 只有 Dev Panel 显式请求 X-Debug-Stream: 1 时，才启用旧包装，以便注入 __dbg__ 与心跳/错误探针。
  const debugStream = request.headers.get("X-Debug-Stream") === "1" && debugEcho;
  if (!debugStream) {
    return new Response(upstream.body, {
      status: 200,
      headers: streamHeaders,
    });
  }

  const _debugPrefix = _dbg ? (": __dbg__ " + JSON.stringify(_dbg).replace(/\r?\n/g, " ") + "\n\n") : "";
  return new Response(streamWithHeartbeat(upstream.body, _debugPrefix), {
    status: 200,
    headers: {
      ...streamHeaders,
      "X-Stream-Mode": "debug-wrapper",
    },
  });
}

// 阶段 4-③：上下文摘要 — 调 DeepSeek V4-Flash（最便宜）把早期对话压成一段剧情摘要
async function handleSummarize(request, env) {
  if (!requireAuth(request, env)) {
    return resp("Unauthorized", "text/plain; charset=utf-8", 401);
  }
  if (!env.DEEPSEEK_API_KEY) {
    return resp("Missing DEEPSEEK_API_KEY", "text/plain; charset=utf-8", 500);
  }
  let payload;
  try { payload = await request.json(); } catch { return resp("Bad JSON", "text/plain; charset=utf-8", 400); }
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (!messages.length) return resp(JSON.stringify({ summary: "" }), "application/json; charset=utf-8");
  const priorSum = typeof payload?.priorSummary === "string" ? payload.priorSummary.trim() : "";
  const characterName = typeof payload?.characterName === "string" ? payload.characterName.trim() : "";
  const transcript = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => `${m.role === "user" ? "用户" : (m.speakerName || characterName || "角色")}：${m.content}`)
    .join("\n");
  const sysPrompt = buildSummarizeSysPrompt(priorSum);
  const userPrompt = `以下是要压缩的对话（${messages.length} 条）：\n\n${transcript}`;
  // 2026-10-05 修复:原来直接引用 DEEPSEEK_ENDPOINT —— 它是 providers.js 的模块内 const,
  // 没 export,这里一执行就 ReferenceError。配置了 DEEPSEEK_API_KEY 时本接口 100% 坏
  // (没配 key 会在上面的早退处 500,把 bug 遮住,所以一直没暴露)。改走 provider 注册表,
  // 对齐 handleChat 的写法(那边是 `const provider = byo || providerForMode(mode)` ——
  // 不写行号:行号会随改动漂移,上一版这里写的 829 早就指到别处去了)。
  const summarizeProvider = PROVIDERS.deepseek;
  const upstream = await fetchWithTimeout(
    summarizeProvider.endpoint,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash", // 4.69 G1: 旧 deepseek-chat 2026-07-24 弃用,迁移到 v4-flash(最便宜,摘要用)
        stream: false,
        thinking: { type: "disabled" },
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    },
    30000
  );
  if (!upstream.ok) {
    // 2026-10-05:不再回显上游错误原文 —— 上游报错有时会夹带请求内容,回显等于把
    // 用户对话片段写进响应。只回状态码,详情看 worker 日志。
    return resp(`Summarize upstream error ${upstream.status}`, "text/plain; charset=utf-8", 502);
  }
  const data = await upstream.json().catch(() => null);
  const summary = data?.choices?.[0]?.message?.content || "";
  const usage = data?.usage || null;
  return resp(JSON.stringify({ summary: summary.trim(), usage }), "application/json; charset=utf-8");
}

// 2026-10-05(A-5): isPrivateHost 提为共享模块 src/net-guard.js —— 同一 worker 里
// 的 /img/dl、/img/r2/save 原本接受任意 URL 却没有同样的内网拦截,防护不一致。
// 所有"服务端代发任意 URL"的入口统一 import 使用。

// 2026-06-17 (4.73): AgentReach 兜底代理 —— 网页侧 safeFetch 直连被 CORS/混合内容挡时,
// 降级到 GET /api/fetch?url=<encoded>。worker 服务端代发(无 CORS/GFW),原样回传 body,
// 并补 Access-Control-Allow-Origin:* 让网页可读。带超时,避免吊死 worker。仅放行 http/https,
// 转发原始方法/头/体(剔除 Host / CF 专属头 / content-length)。
async function handleFetchProxy(request) {
  const reqUrl = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  const target = reqUrl.searchParams.get("url");
  if (!target) return resp("Missing ?url=", "text/plain; charset=utf-8", 400);
  let targetUrl;
  try { targetUrl = new URL(target); } catch { return resp("Bad url", "text/plain; charset=utf-8", 400); }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return resp("Only http/https allowed", "text/plain; charset=utf-8", 400);
  }
  if (isPrivateHost(targetUrl.hostname)) {
    return resp("Blocked: private/reserved address", "text/plain; charset=utf-8", 400);
  }
  // 2026-10-07: 自引用拦截 —— worker 子请求自己的 host 等于「自己抓自己」，Cloudflare 直接掐断
  // （实测还连带外部跳板一起被识别拒绝，agent 会误判成「网断了」）。这里给出明确指引：
  // 站内资源用同源相对路径读（客户端直读，不经本代理）；读上游源码用公开仓库的 raw 地址。
  if (targetUrl.host === reqUrl.host) {
    return resp(
      "Blocked: this is the site's own address; the worker cannot fetch itself. " +
      "Use same-origin relative paths instead (e.g. fetch_page(\"/js/text/engine/app.js\")) — the page reads them directly. " +
      "本站自身地址请用同源相对路径读取；上游源码可读 https://raw.githubusercontent.com/MaxChen12114/OwnChat/main/<path>。",
      "text/plain; charset=utf-8", 400);
  }
  // 转发原始请求头,剔除会泄露 worker 或干扰上游的头
  const fwd = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length" || lk.startsWith("cf-") ||
        lk === "x-forwarded-for" || lk === "x-forwarded-proto" || lk === "x-real-ip") continue;
    fwd.set(k, v);
  }
  if (!fwd.has("User-Agent")) fwd.set("User-Agent", "Mozilla/5.0 (compatible; OwnChatBot/1.0)");
  const init = { method: request.method === "POST" ? "POST" : "GET", headers: fwd };
  if (init.method === "POST") { try { init.body = await request.text(); } catch {} }
  const upstream = await fetchWithTimeout(targetUrl.toString(), init, 20000);
  const body = await upstream.arrayBuffer();
  const ct = upstream.headers.get("Content-Type") || "application/octet-stream";
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": ct,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
      "Cache-Control": "no-store",
    },
  });
}

// 2026-06-20 (4.70): Exa 搜索后端 —— 服务端搜索 API(x-api-key 鉴权,不按 IP 封)。
// 网页端没有桌面那条「住宅 IP 原生直连」兜底,DDG html 又对 Cloudflare 数据中心出口 IP 屏蔽/限速,
// 故网页 web_search 在 Worker 侧优先走 Exa,真正把搜索做稳。返回与 DDG 分支同构的
// { ok, source:"exa", query, results:[{title,url,snippet] };失败/未配 key 返回 null,交给下面 DDG 降级。
async function searchViaExa(env, q, n) {
  try {
    const upstream = await fetchWithTimeout("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": (env.EXA_API_KEY || "").trim(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        numResults: n,
        type: "auto",
        contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 }, text: { maxCharacters: 300 } },
      }),
    }, 15000);
    if (!upstream.ok) return null;
    const data = await upstream.json().catch(() => null);
    const items = data && Array.isArray(data.results) ? data.results : null;
    if (!items) return null;
    const results = items.slice(0, n).map(function (it) {
      const snippet = (Array.isArray(it.highlights) && it.highlights.length)
        ? it.highlights.join(" … ")
        : (typeof it.text === "string" ? it.text.trim().slice(0, 300) : "");
      return { title: it.title || it.url || "", url: it.url || "", snippet: snippet };
    }).filter(function (r) { return r.url; });
    return { ok: true, source: "exa", query: q, results: results };
  } catch (e) {
    return null;
  }
}

// 2026-06-18 / 4.70: /api/search — 服务端搜索。主通道 Exa(env.EXA_API_KEY,服务端 API、不按 IP 封),
// 未配 key 或 Exa 失败时降级到 DDG html 抓取(对 CF 数据中心出口 IP 易被限速)。无 GFW / 无 CORS。
// 等价 Claude Code 的服务端 WebSearch：搜索在 Cloudflare Worker 执行，客户端无需直连境外站。
// 2026-10-07: 搜索核心抽成 runSearch() —— /api/search 与「普通聊天联网搜索」的工具循环共用同一套后端
// （Exa 可选 + 免费 DDG 兜底），避免两处实现各写一份慢慢漂移。
async function runSearch(env, q, opts) {
  opts = opts || {};
  const n = Math.min(10, Math.max(1, parseInt(opts.n || 5, 10) || 5));
  // 默认走免费 DDG；仅当显式要求深搜且配了 EXA_API_KEY 时才升级 Exa（按次计费 ≈$0.007），Exa 失败再降级。
  if (opts.deep && env && (env.EXA_API_KEY || "").trim()) {
    const exa = await searchViaExa(env, q, n);
    if (exa && exa.results && exa.results.length) return exa;
  }
  const ddgUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q) + "&kl=cn-zh";
  let html = "";
  let ddgErr = "";
  try {
    const upstream = await fetchWithTimeout(ddgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    }, 15000);
    // 2026-10-07: 这里不再直接 return 失败 —— 必须让控制流走到下面的 Bing 兜底
    // （旧写法 DDG 一 504 就整条搜索失败，实测本机 3/3 都这样）。
    if (!upstream.ok) ddgErr = "DDG returned " + upstream.status;
    else html = await upstream.text();
  } catch (e) {
    ddgErr = String(e && e.message ? e.message : e);
  }
  const links = [];
  const linkRe = /class="result__a"[^>]+href="([^"]*)"/gi;
  const titleRe = /class="result__a"[^>]+href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let lm, tm;
  while ((lm = linkRe.exec(html)) !== null && links.length < n) {
    let href = lm[1];
    if (href.indexOf("uddg=") !== -1) {
      try {
        const u = new URL(href.startsWith("//") ? "https:" + href : href);
        const decoded = decodeURIComponent(u.searchParams.get("uddg") || "");
        if (decoded) href = decoded;
      } catch (_) {}
    }
    if (href && href.startsWith("http")) links.push(href);
  }
  const titles = [];
  while ((tm = titleRe.exec(html)) !== null && titles.length < n) {
    titles.push(tm[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").trim());
  }
  const snippets = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm;
  while ((sm = snipRe.exec(html)) !== null) {
    snippets.push(sm[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'").trim());
  }
  const results = links.map(function (href, i) {
    return { title: titles[i] || href, url: href, snippet: snippets[i] || "" };
  });
  if (results.length) return { ok: true, source: "ddg", query: q, results: results };
  // DDG 没结果（常见于 504 或限速）→ 走 Bing RSS 免费兜底
  const bing = await searchViaBingRss(q, n);
  if (bing.length) return { ok: true, source: "bing", query: q, results: bing };
  return { ok: true, source: "ddg", query: q, results: [] };
}

// 搜索结果 → 模型可读文本（标题/摘要/URL）。带 URL 才能让它"附来源"，否则只能空口复述。
function formatSearchForModel(q, r) {
  if (!r || r.ok === false) return "搜索失败：" + ((r && r.error) || "未知错误");
  const list = (r.results || []).slice(0, 6);
  if (!list.length) return "（没有找到与「" + q + "」相关的结果）";
  const src = r.source === "exa" ? "Exa" : (r.source === "bing" ? "Bing" : "DuckDuckGo");
  return "搜索「" + q + "」的结果（来源：" + src + "）：\n"
    + list.map(function (it, i) { return (i + 1) + ". " + it.title + "\n   " + (it.snippet || "") + "\n   " + it.url; }).join("\n");
}

// 2026-10-07 免费兜底：Bing 的 RSS 搜索端点（不需要 key）。为什么必须有它 —— DDG 的 html 端点
// 对数据中心/共享出口 IP 经常直接 504（实测本机连续 3/3 失败、`lite.duckduckgo.com` 更是完全不可达），
// 只留 DDG 会让「联网搜索」时好时坏。Bing RSS 返回标准 XML，解析十几行就能兜住。
async function searchViaBingRss(q, n) {
  try {
    const url = "https://cn.bing.com/search?format=rss&count=" + Math.min(10, n) + "&q=" + encodeURIComponent(q);
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml,application/xml,text/xml",
      },
    }, 15000);
    if (!r.ok) return [];
    const xml = await r.text();
    const strip = (s) => String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
      .trim();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < n) {
      const block = m[1];
      const pick = (tag) => {
        const mm = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
        return mm ? strip(mm[1]) : "";
      };
      const link = pick("link");
      if (!link) continue;
      items.push({ title: pick("title") || link, url: link, snippet: pick("description") });
    }
    return items;
  } catch (e) { return []; }
}

async function handleSearchProxy(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  const reqUrl = new URL(request.url);
  const q = (reqUrl.searchParams.get("q") || "").trim();
  const n = Math.min(10, Math.max(1, parseInt(reqUrl.searchParams.get("n") || "5", 10)));
  if (!q) return resp(JSON.stringify({ ok: false, error: "Missing ?q=" }), "application/json; charset=utf-8", 400);
  const engine = (reqUrl.searchParams.get("engine") || reqUrl.searchParams.get("src") || "").trim().toLowerCase();
  const deep = engine === "exa" || reqUrl.searchParams.get("deep") === "1";
  const out = await runSearch(env, q, { n: n, deep: deep });
  const status = (out && out.ok === false) ? 502 : 200;
  return resp(JSON.stringify(out), "application/json; charset=utf-8", status, { "Access-Control-Allow-Origin": "*" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 2026-10-05: 工具页已移入 /tools/*(public/tools/)。这里对旧地址做 302 兜底,
    // 保住外部书签/历史记录;配合 wrangler.toml 把这些前缀加进 run_worker_first
    // (不进 worker 的请求永远不会经过这里)。/image 特殊:指向 studio(原页本就是壳)。
    const OLD_TOOL_PATHS = {
      "/write": "/tools/write/",
      "/coding": "/tools/coding/",
      "/flow": "/tools/flow/",
      "/studio": "/tools/studio/",
      "/audio": "/tools/audio/",
      "/image": "/tools/studio/",
    };
    {
      const p = url.pathname;
      const base = "/" + p.split("/")[1]; // 首段,如 /write
      const target = OLD_TOOL_PATHS[base];
      if (target && (p === base || p.startsWith(base + "/"))) {
        const suffix = p === base ? "/" : p.slice(base.length);
        return Response.redirect(new URL(target.slice(0, -1) + suffix + url.search, url), 302);
      }
    }

    if (request.method === "GET" && url.pathname === "/config.js") {
      return resp(clientConfigJs(), "text/javascript; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env);
    }

    // 2026-09-10 (方案 C): 模型候选池 —— 设置页点「拉取模型列表」走这里,key 不出服务端
    if (request.method === "GET" && url.pathname === "/api/models") {
      return handleModelsList(request, env);
    }

    // 2026-09-12 (4.70 块⑤): 自定义直连模型列表代理 —— 端点/API Key 由用户显式填写,
    // Worker 只代请求该端点的 /v1/models，避免浏览器 CORS/GFW；不持久化 Key。
    if (request.method === "POST" && url.pathname === "/api/custom-endpoint/models") {
      return handleCustomEndpointModels(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/presets") {
      return handlePresetLibrary(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/summarize") {
      return handleSummarize(request, env);
    }

    // 2026-06-17 (4.73): AgentReach 兜底代理 —— safeFetch 直连失败时走这里(GET ?url=,绕 CORS/GFW)
    if (url.pathname === "/api/fetch") {
      return handleFetchProxy(request);
    }

    // 2026-06-18 / 4.70: 服务端搜索 —— web_search 走这里。主通道 Exa(配 EXA_API_KEY),降级 DDG html。无 GFW / CORS
    if (url.pathname === "/api/search") {
      return handleSearchProxy(request, env);
    }

    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && url.pathname === "/sync") {
      return handleSync(request, env);
    }

    // 4.20: 费用独立同步通道,per-day per-field max merge,跨设备并发 PUT 不丢数据
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && url.pathname === "/sync/cost") {
      return handleSyncCost(request, env);
    }

    // 4.21-F: 排除清单独立同步通道,服务端按条目 ts LWW 合并,跨设备生效
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && url.pathname === "/sync/exclude") {
      return handleSyncExclude(request, env);
    }

    // 4.76: 聊天会话独立同步通道,slot 级合并 + tombstone,跨设备不再整段覆盖聊天
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && url.pathname === "/sync/chat") {
      return handleSyncChat(request, env);
    }

    // 4.78: 角色卡独立同步通道,按卡 id LWW 合并 + tombstone,跨设备不再被 main blob 整段覆盖
    if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && url.pathname === "/sync/chars") {
      return handleSyncChars(request, env);
    }

    // 图像侧统一代理:/img/* (代理 Gitee + /img/dl 下载 + /img/r2 + /img/gallery);非 /img/* 返回 null 交回静态兜底
    const imgResp = await handleImageRequest(request, env);
    if (imgResp) return imgResp;

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return resp(
      "Static assets binding 'ASSETS' is missing. Please configure [assets] in wrangler.toml.",
      "text/plain; charset=utf-8",
      500
    );
  },
};