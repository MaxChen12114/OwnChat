#!/usr/bin/env node
// scripts/run-regression.mjs — 回归总入口（11-10 夜班沉淀）
// 一条命令跑齐今夜新增的测试件：S11 记忆隔离 / S12 重试策略 / 令牌体检 / 语法全检。
// 用法：node scripts/run-regression.mjs   → 全绿 exit 0，任何一项红 exit 1。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = [
  ["S11 记忆隔离", "test-memory-core.mjs"],
  ["S12 重试策略", "test-retry-policy.mjs"],
  ["令牌体检", "check-tokens.mjs"],
  ["语法全检", "check-syntax.mjs"],
];

let fail = 0;
console.log("══ OwnChat 回归套件 ══");
for (const [name, script] of RUNS) {
  const r = spawnSync(process.execPath, [path.join(HERE, script)], { encoding: "utf8" });
  const ok = r.status === 0;
  const tail = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${tail.slice(0, 80)}`);
  if (!ok) {
    fail++;
    (r.stderr || "").split(/\r?\n/).slice(0, 5).forEach((l) => console.log("    " + l));
  }
}
console.log(fail ? `\n${fail} 项失败` : "\nALL GREEN");
process.exit(fail ? 1 : 0);
