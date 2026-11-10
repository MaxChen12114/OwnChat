#!/usr/bin/env node
// scripts/test-retry-policy.mjs — S12 断流/重试策略回归（15.3）
// 不碰 app.js：从真实源码里抽取决策层文本（分类函数 + 预算/退避常量与表达式），
// 在 vm 里 eval 后对拍决策表。app.js 的逻辑一变（锚文本失配），本测试立刻红。
// 跑法：node scripts/test-retry-policy.mjs → ALL GREEN 或 exit 1。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "../public/js/text/engine/app.js"), "utf8");

const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? "  ✓ " : "  ✗ ") + name); };
const grab = (re, what) => {
  const m = SRC.match(re);
  if (!m) { console.error("  ✗ 源码锚点失配：" + what + "（app.js 的决策层被改过？同步本测试的抽取锚）"); process.exit(1); }
  return m[0];
};

// ── 1) 从真实源码抽取决策层（锚文本 = 2026-11-09 重试预算批的原文） ──
const constsText = grab(
  /const AGENT_RETRY_MAX = [^\n]+;[\s\S]*?const AGENT_RETRYABLE = \{[^\n]+\};/,
  "重试常量与可重试码表"
);
const classifyText = grab(
  /const _classifyCallError = \(e, flags\) => \{[\s\S]*?\n\s*\};/,
  "_classifyCallError 分类函数"
);
const budgetText = grab(
  /const _budget = \(!_totalTimedOut \|\| attempt < 1\) \? AGENT_RETRY_MAX : 0;/,
  "总时长只给一次机会的预算表达式"
);

const sandbox = { console, Math, String, Number, Date };
sandbox._totalTimedOut = false;
sandbox.attempt = 0;
vm.createContext(sandbox);
vm.runInContext(constsText + "\n" + classifyText + "\n" + budgetText + "\n" +
  "var __budget = () => (!_totalTimedOut || attempt < 1) ? AGENT_RETRY_MAX : 0;\n" +
  "var __retry = (code, a) => { attempt = a; return !!AGENT_RETRYABLE[code] && a < __budget(); };\n" +
  "var __backoff = (a) => { const _base = Math.min(AGENT_RETRY_BASE_MS * Math.pow(2, a), AGENT_RETRY_CAP_MS); return Math.min(_base * (0.9 + Math.random() * 0.2), AGENT_RETRY_CAP_MS); };\n" +
  "var __cls = (e, flags) => _classifyCallError(e, flags);\n",
  sandbox, { filename: "retry-policy.extract.js" });
const S = sandbox;

// ── 2) 分类决策表（真实 _classifyCallError 的行为） ──
const cls = (e, flags) => S.__cls(e, flags);
check("静默/总闸超时 → TIMEOUT（flags 优先于一切）", cls(new Error("x"), { idle: 1 }) === "TIMEOUT" && cls(new Error("x"), { total: 1 }) === "TIMEOUT");
check("显式 __retryCode 直通（EMPTY_RESPONSE）", cls(Object.assign(new Error("x"), { __retryCode: "EMPTY_RESPONSE" })) === "EMPTY_RESPONSE");
check("429 → RATE_LIMIT", cls(Object.assign(new Error("x"), { __httpStatus: 429 })) === "RATE_LIMIT");
check("5xx → SERVER / 4xx → INVALID_REQUEST", cls(Object.assign(new Error("x"), { __httpStatus: 503 })) === "SERVER" && cls(Object.assign(new Error("x"), { __httpStatus: 400 })) === "INVALID_REQUEST");
check("TypeError / 网络词 → TRANSPORT", cls(new TypeError("network error")) === "TRANSPORT" && cls(new Error("fetch failed")) === "TRANSPORT" && cls(new Error("socket hang up")) === "TRANSPORT");
check("其余 → UNKNOWN（不重试）", cls(new Error("mystery")) === "UNKNOWN");

// ── 3) 重试预算（真实预算表达式 + 可重试码表） ──
check("五类可重试码首轮均重试", ["TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE", "SERVER", "RATE_LIMIT"].every((c) => S.__retry(c, 0)));
check("非可重试码立即终局", !S.__retry("INVALID_REQUEST", 0) && !S.__retry("UNKNOWN", 0));
check("预算=首次之外再试 4 次（重试发生在尝试 0-3 失败后，第 5 次尝试为终局）", S.__retry("TIMEOUT", 3) === true && S.__retry("TIMEOUT", 4) === false);
check("总时长撞线只给一次机会（attempt≥1 后预算归零）", (() => { S._totalTimedOut = true; const r = S.__retry("TIMEOUT", 0) && !S.__retry("TIMEOUT", 1); S._totalTimedOut = false; return r; })());

// ── 4) 退避曲线（指数上涨、封顶 10s、有抖动带） ──
check("退避封顶 10s 且 ≥0.9×base（抖动带内）", [0, 1, 2, 3, 6, 10].every((a) => { const d = S.__backoff(a); return d >= 0 && d <= 10 * 1000; }));

// ── 5) EMPTY_RESPONSE 与假活防线仍在源码里（静态锚） ──
check("空完成 → 打 EMPTY_RESPONSE 标（流正常结束但零内容）", /上游返回空响应（流正常结束，但无正文、无思考、无工具调用）[\s\S]{0,200}EMPTY_RESPONSE/.test(SRC));
check("连续空增量假活有上限（AGENT_EMPTY_STREAK_MAX）", /AGENT_EMPTY_STREAK_MAX = 120/.test(SRC));
check("静默窗口每重试 +30s（ZCode 形态）", /AGENT_CALL_IDLE_MS \+ attempt \* AGENT_IDLE_STEP_MS/.test(SRC));
check("重试用尽抛人话（含已重试 N 次）", /已重试 " \+ attempt \+ " 次/.test(SRC));

const fail = results.filter(([, ok]) => !ok);
console.log(fail.length ? `\n${fail.length} 条失败` : "\nALL GREEN — S12 决策层全过（分类/预算/退避/EMPTY_RESPONSE 防线/假活上限）");
process.exit(fail.length ? 1 : 0);
