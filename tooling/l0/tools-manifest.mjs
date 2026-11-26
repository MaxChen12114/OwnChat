#!/usr/bin/env node
// L2 stage 2: the full tool manifest, generated from a runtime capture.
//
// Why a capture instead of a vm replay: the registry loads eleven provider shells into the kernel in
// a fixed order, and each shell carries its own environment gate (PC trio, canvas, local-exec token,
// dev tools). Faking all fourteen module surfaces inside node:vm hung the process, so the source of
// truth is the real runtime — run `__agentRegistry.build({})` in a browser, serialize
// registry.list(), and keep it in tooling/bundles/agent/manifest/tools.capture.json. Re-run the capture
// snippet when the tool set changes, then --write.
//
// Flow: capture -> tool-catalog.build(defs) supplies group/summary/keywords/schema (reusing the
// project's own classification) -> governance fields derive from the name prefix -> schema.json
// validates -> two artifacts: tooling/bundles/agent/manifest/tools.json (data) and
// public/bundles/agent/manifest/tools.js (runtime, assigned into hostApi.tools.manifest so no new
// global appears).
//
// Usage: node tooling/l0/tools-manifest.mjs            # report
//        node tooling/l0/tools-manifest.mjs --check    # manifest out of step with the capture -> exit 1
//        node tooling/l0/tools-manifest.mjs --write    # re-emit both artifacts
import fs from "node:fs";
import path from "node:path";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CAPTURE = path.join(ROOT, "tooling", "bundles", "agent", "manifest", "tools.capture.json");
const JSON_PATH = path.join(ROOT, "tooling", "bundles", "agent", "manifest", "tools.json");
const RUNTIME_PATH = path.join(ROOT, "public", "bundles", "agent", "manifest", "tools.js");

/**
 * Governance derivation table, keyed by name prefix; order is priority. `requires` lists tool
 * preconditions — host bits (unlocked/pcEnabled) and tokens (pcToken/network/workspace) — which is a
 * separate taxonomy from a bundle's capabilities. `provider` is the global name of the implementing
 * module, and generation fails when that name maps to no file.
 */
const PROVIDER_RULES = [
  [/^pc_/, { provider: "__pcTools", requires: ["unlocked", "pcEnabled", "pcToken"], risk: "external", sideEffect: false, defaultEnabled: false, residentCandidate: false }],
  [/^(web_|search_|fetch_|read_rss$)/, { provider: "AgentReach", requires: ["network"], risk: "external", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^(read_file|list_files|search_file)$/, { provider: "__agentWorkspace", requires: ["workspace"], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^(write_file|export_file|delete_file|edit_file)$/, { provider: "__agentWorkspace", requires: ["workspace"], risk: "write", sideEffect: true, defaultEnabled: true, residentCandidate: true }],
  [/^(local_list_dir|local_read_file)/, { provider: "__localExecTools", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^source_/, { provider: "__sourceTools", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^stage_/, { provider: "__stageTools", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^memory_/, { provider: "__memCore", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^load_skill$/, { provider: "__skills", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^(manage_|adjust_|speak$)/, { provider: "OwnChatTools", requires: [], risk: "write", sideEffect: true, defaultEnabled: true, residentCandidate: true }],
  [/^(delegate_|convene_|invite_)/, { provider: "__agentRegistry", requires: [], risk: "write", sideEffect: true, defaultEnabled: false, residentCandidate: false }],
  [/^(job_|council_)/, { provider: "__jobTools", requires: [], risk: "write", sideEffect: true, defaultEnabled: false, residentCandidate: false }],
  [/^(ambient_|director_)/, { provider: "AmbientTools", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true }],
  [/^(send_image$|generate_)/, { provider: "chatImageSvc", requires: [], risk: "write", sideEffect: true, defaultEnabled: true, residentCandidate: true }],
];
const PROVIDER_DEFAULT = { provider: "OwnChatTools", requires: [], risk: "read", sideEffect: false, defaultEnabled: true, residentCandidate: true };
/**
 * provider -> implementation file. Anything already migrated points at the emitted artifact under
 * public/services/, never the TS source: the manifest is read in a browser, where only the artifact
 * exists.
 */
const PROVIDER_FILES = {
  __pcTools: "public/services/local/pc-tools.js",
  AgentReach: "public/services/agent/reach.js",
  __agentWorkspace: "public/services/data/agent-workspace.js",
  __sourceTools: "public/services/agent/source-tools.js",
  __localExecTools: "public/services/local/local-exec-tools.js",
  __stageTools: "public/services/ui/stage-tools.js",
  __memCore: "public/services/memory/core.js",
  __skills: "public/services/agent/skills.js",
  OwnChatTools: "public/services/tools/agent/tools.js",
  __agentRegistry: "public/services/agent/registry.js",
  __jobTools: "public/services/agent/job-tools.js",
  AmbientTools: "public/services/agent/ambient-tools.js",
  chatImageSvc: "public/services/image/chat-text.js",
};

function toRecord(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = v;
  return out;
}

function derive(name, destructiveKind, catalogEntry) {
  const hit = PROVIDER_RULES.find(([re]) => re.test(name));
  const rule = hit ? hit[1] : PROVIDER_DEFAULT;
  // The kernel's own destructive flag beats the prefix guess: bool-true means always destructive,
  // fn means "depends on arguments" and is raised to at least write.
  let risk = rule.risk;
  if (destructiveKind === "bool-true") risk = "destructive";
  else if (destructiveKind === "fn") risk = risk === "read" ? "write" : risk;
  return {
    id: name,
    group: catalogEntry.group,
    summary: catalogEntry.summary,
    keywords: catalogEntry.keywords,
    provider: rule.provider,
    requires: rule.requires,
    risk,
    sideEffect: rule.sideEffect || destructiveKind !== "bool-false",
    residentCandidate: rule.residentCandidate,
    defaultEnabled: rule.defaultEnabled,
    schema: catalogEntry.schema,
  };
}

/** Minimal draft-07 validation, covering only the keywords schema.json actually uses. */
export function validateManifest(manifest, schema) {
  const errors = [];
  const entrySchema = schema.definitions.entry;
  for (const entry of manifest.entries) {
    for (const field of entrySchema.required) {
      if (!(field in entry)) errors.push(`${entry.id || "?"} 缺字段 ${field}`);
    }
    for (const [k, v] of Object.entries(entry)) {
      const def = entrySchema.properties[k];
      if (!def) { errors.push(`${entry.id} 多余字段 ${k}（additionalProperties:false）`); continue; }
      if (def.type === "string") {
        if (typeof v !== "string") errors.push(`${entry.id}.${k} 应为 string`);
        else if (def.pattern && !new RegExp(def.pattern).test(v)) errors.push(`${entry.id}.${k} 不匹配 pattern：${v}`);
        else if (def.enum && !def.enum.includes(v)) errors.push(`${entry.id}.${k} 不在枚举：${v}`);
        else if (def.maxLength && v.length > def.maxLength) errors.push(`${entry.id}.${k} 超 maxLength`);
        else if (def.minLength && v.length < def.minLength) errors.push(`${entry.id}.${k} 低于 minLength`);
      } else if (def.type === "array" && !Array.isArray(v)) {
        errors.push(`${entry.id}.${k} 应为 array`);
      } else if (def.type === "boolean" && typeof v !== "boolean") {
        errors.push(`${entry.id}.${k} 应为 boolean`);
      }
    }
  }
  return errors;
}

function buildManifest() {
  const capture = JSON.parse(fs.readFileSync(CAPTURE, "utf8"));
  // Classification stays in tool-catalog.build; only governance fields come from the table.
  //
  // The TS module is read directly instead of evaluating a classic script. The old path required
  // that file to stay in IIFE shape forever and faked a sandbox by injecting globalThis — the same
  // Function still ran in this process. Stripping the types gives the single implementation, with
  // no global and no sandbox pretence.
  //
  // Inlined rather than imported from tooling/l0/load-service.mjs: this generator is locked to node:
  // built-ins only (test/tools-manifest.test.mjs). The stripping rule matches tooling/l0/emit.mjs emitOne().
  const strip = typeof nodeModule.stripTypeScriptTypes === "function" ? nodeModule.stripTypeScriptTypes : null;
  if (!strip) throw new Error("this Node has no stripTypeScriptTypes (needs 22.13+)");
  const catalogTs = fs.readFileSync(path.join(ROOT, "services/agent/tool-catalog.ts"), "utf8");
  const catalogBody = strip(catalogTs, { sourceMap: false }).replace(/^export (?=(?:const|let|var|function|class)\b)/gm, "");
  const catalogApi = new Function(catalogBody + "\nreturn { build: build };")();
  const cat = catalogApi.build(capture.defs.map(function (d) { return { name: d.name, description: d.description, parameters: d.parameters }; }));
  const entries = cat.entries.map(function (e) {
    const def = capture.defs.find(function (d) { return d.name === e.name; });
    return derive(e.name, def ? def.destructiveKind : "bool-false", e);
  });
  entries.sort(function (a, b) { return a.id.localeCompare(b.id); });
  const absent = (capture.report || []).filter(function (r) { return !r.ok; });
  return { version: 1, capturedAt: capture.capturedAt, capturedFrom: capture.source, entries, absent };
}

function main() {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes(n);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "tooling", "bundles", "agent", "manifest", "schema.json"), "utf8"));
  const manifest = buildManifest();

  const providerErrors = [];
  for (const p of new Set(manifest.entries.map((x) => x.provider))) {
    const file = PROVIDER_FILES[p];
    if (!file || !fs.existsSync(path.join(ROOT, file))) providerErrors.push(p + (file ? `（缺 ${file}）` : "（未登记实现文件）"));
  }
  const errors = validateManifest(manifest, schema);
  const names = manifest.entries.map((e) => e.id);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) errors.push("重复 id：" + dup.join(","));
  const absent = manifest.absent || [];
  if (absent.length) errors.push("捕获时缺席的壳（清单不完整）：" + absent.map((r) => r.name).join(","));

  console.log(`[tools-manifest] 实测捕获 ${manifest.entries.length} 个 · provider ${new Set(manifest.entries.map((x) => x.provider)).size} 个 · 分组 ${new Set(manifest.entries.map((x) => x.group)).size} 个 · 捕获于 ${manifest.capturedAt}`);

  const json = JSON.stringify({ version: manifest.version, capturedAt: manifest.capturedAt, capturedFrom: manifest.capturedFrom, entries: manifest.entries }, null, 2) + "\n";
  const runtime = "// ⚠ 生成物（tooling/l0/tools-manifest.mjs --write，勿手改）—— 运行时把全量清单赋进 hostApi.tools.manifest\n" +
    "// 数据源：tooling/bundles/agent/manifest/tools.json（同一次发射）；捕获于 " + manifest.capturedAt + "\n" +
    "(function () {\n  var G = (typeof window !== \"undefined\" ? window : globalThis);\n" +
    "  if (!G.hostApi || !G.hostApi.tools) return; // compat 未就绪则跳过（boot 清单保证 compat 先行）\n" +
    "  G.hostApi.tools.manifest = " + JSON.stringify({ entries: manifest.entries }) + ";\n})();\n";

  if (has("--write")) {
    if (errors.length || providerErrors.length) {
      console.log("[tools-manifest] ✗ 校验失败，拒绝落盘：");
      errors.concat(providerErrors).forEach((x) => console.log("  ✗ " + x));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
    fs.writeFileSync(JSON_PATH, json, "utf8");
    fs.writeFileSync(RUNTIME_PATH, runtime, "utf8");
    console.log(`[tools-manifest] 已写入 ${path.relative(ROOT, JSON_PATH)} + ${path.relative(ROOT, RUNTIME_PATH)}`);
    return;
  }
  if (errors.length || providerErrors.length) {
    console.log("[tools-manifest] ✗ 校验失败：" + errors.concat(providerErrors).slice(0, 5).join(" | "));
    process.exit(1);
  }
  const currentJson = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, "utf8") : null;
  const currentRt = fs.existsSync(RUNTIME_PATH) ? fs.readFileSync(RUNTIME_PATH, "utf8") : null;
  const drift = currentJson !== json || currentRt !== runtime;
  if (has("--check")) {
    if (drift) { console.log("[tools-manifest] ✗ 清单与捕获脱钩：跑 node tooling/l0/tools-manifest.mjs --write"); process.exit(1); }
    console.log("[tools-manifest] --check 通过：清单与实测捕获逐名对齐");
    return;
  }
  console.log(drift ? "[tools-manifest] 有漂移（--write 重发射）" : "[tools-manifest] 只读完成（已是最新）");
}

main();
