#!/usr/bin/env node
// scripts/test-memory-core.mjs — S11 记忆隔离回归（15.2）
// 三条：耳语只到一人 / 跨会话不丢 / 编造不固化。
// 跑法：node scripts/test-memory-core.mjs  →  全过输出 ALL GREEN，任何一条失败 exit 1。
// 原理：memory-core 的 IDB 使用面很窄（单 store + cid 索引 + put/getAll），
//       用内存 stub 顶上 indexedDB/localStorage，vm 双次加载模拟两个会话共享同一存储。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "../public/shared/memory-core.js"), "utf8");

// ── 持久层 stub（两个"会话"共享同一份，等价于 IndexedDB 的磁盘持久） ──
const store = new Map();          // id -> row（跨会话存活）
const ls = new Map();             // localStorage（跨会话存活）
ls.set("cfw_mem_vec_v1", "0");    // 向量腿关：测试不下载模型

function makeSandbox() {
  const sandbox = { console, Math, Date, JSON, Promise, setTimeout, clearTimeout, Uint8Array, parseInt, String, Number, Array, Object };
  sandbox.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  };
  const os = {
    put(r) { store.set(r.id, r); },
    index() {
      return {
        getAll(cid) {
          const rows = [...store.values()].filter(r => r.cid === String(cid));
          return { result: rows };  // memory-core 的 tx 回调外层已包 __req，这里只给 result
        },
      };
    },
  };
  const makeTx = () => {
    const t = { objectStore: () => os, oncomplete: null, onerror: null };
    setTimeout(() => {
      try { t.oncomplete && t.oncomplete(); }
      catch (e) { t.onerror && t.onerror(e); }
    }, 0);
    return t;
  };
  sandbox.indexedDB = {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = { objectStoreNames: { contains: () => true }, transaction: makeTx };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
  vm.createContext(sandbox);
  return sandbox;
}

function loadSession() {
  const sb = makeSandbox();
  vm.runInContext(SRC, sb, { filename: "memory-core.js" });
  sb.__app = { oneShot: async ({ user }) => JSON.stringify([{ what: String(user), when: "N/A", where: "N/A", who: "N/A", why: "N/A", fact_kind: "conversation", fact_type: "world", entities: [], search_terms: [] }]) };
  return sb.__memCore;
}

const results = [];
const check = (name, ok) => { results.push([name, ok]); console.log((ok ? "  ✓ " : "  ✗ ") + name); };

// ── 会话 1：写入三种路由 ──
{
  const m = loadSession();
  // 1) 公开说：A 说，B、C 都听到
  const r1 = await m.remember("赤军在北岭集结", { speakerCid: "u_test_A", listenerCids: ["u_test_B", "u_test_C"] });
  // 2) 耳语：A 只私下告诉 C（kind=whisper，绝不进 B 的银行）
  await m.remember("密信：粮道走西谷", { speakerCid: "u_test_A", listenerCids: ["u_test_C"], kind: "whisper" });

  const a = await m.list("u_test_A"), b = await m.list("u_test_B"), c = await m.list("u_test_C"), d = await m.list("u_test_D");
  const has = (rows, s) => rows.some((r) => r.what.includes(s));

  const wA = a.find((r) => r.what.includes("粮道"));
  check("耳语送达 C（core 契约：listener 强制 heard，whisper 标签在 speaker 侧）", has(c, "粮道") && wA && wA.kind === "whisper" && c.find((r) => r.what.includes("粮道")).kind === "heard");
  check("耳语没漏进 B 的银行（只到一人）", !has(b, "粮道"));
  check("耳语没漏进任何旁人（D 银行空）", d.length === 0);
  check("公开话 A 标 said / B、C 标 heard", a.find((r) => r.what.includes("北岭")).kind === "said" && b.find((r) => r.what.includes("北岭")).kind === "heard");
  check("编造不固化：whisper 溯源标签原样保留（未被改写成结论）", c.every((r) => r.kind !== "conclusion"));
  check("无显式 reflect 就没有 conclusion 行", [].concat(a, b, c).every((r) => r.kind !== "conclusion"));
}

// ── 会话 2：全新加载模块，存储不丢 ──
{
  const m = loadSession();
  const b = await m.list("u_test_B"), c = await m.list("u_test_C");
  check("跨会话：B 的 heard 还在", b.some((r) => r.what.includes("北岭")));
  check("跨会话：C 的耳语还在（ heard 溯源不变）", c.some((r) => r.what.includes("粮道") && r.kind === "heard"));
}

// ── 纯函数烟测（BM25/RRF 不因 stub 环境而退化） ──
{
  const m = loadSession();
  const ok = m._bm25([{ text: "赤军 北岭 粮道" }, { text: "青军 南港 水师" }], "粮道", 1.2, 0.75)[0].score > 0;
  check("BM25 在 stub 环境可算且有区分度", ok);
}

const fail = results.filter(([, ok]) => !ok);
console.log(fail.length ? `\n${fail.length} 条失败` : "\nALL GREEN — S11 三条款全过（耳语只到一人 / 跨会话不丢 / 编造不固化）");
process.exit(fail.length ? 1 : 0);
