#!/usr/bin/env node
// L0b packer: a bundle source (ESM/TS) becomes an IIFE artifact plus an external sourcemap, a
// seven-field manifest and build metadata under `public/bundles/<id>/`.
//
// Classic scripts under public/ are deliberately not bundled. They couple through "top-level
// var/function becomes a window global, plus load order"; esbuild's module scope swallows those
// declarations into the IIFE, so every cross-file bare-global reference breaks at once. That is a
// structural hazard rather than a configuration problem, and it is why "classic domain bundling"
// waits for ESM conversion (>=60%) and a per-domain rewrite. Bundle sources are already scoped and
// reach each other through explicit contracts, so IIFE wrapping preserves their semantics.
//
// The trust gate runs on the manifest at build time (core/trust-gate.ts). A denial throws before
// anything is written, so a rejected bundle cannot leave a half-built directory behind; gate 4
// accepts only ids flagged `builtin:true` in bundles.json, and unsigned/signed fall back to deny
// because no verifier ships yet.
//
// Degradation: without an esbuild install (CI Node 20, fresh clone) every path prints a skip and
// exits 0 — except `--write`, which exits 1. A rebuild that silently did nothing would ship stale
// artifacts as green.
//
// Usage:
//   node l0/bundle.mjs              # read-only report (per bundle: artifact in sync with source?)
//   node l0/bundle.mjs --write      # build/refresh artifacts + manifest, then self-check idempotence
//   node l0/bundle.mjs --pack <id>  # standalone distribution zip under dist/bundles/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REGISTRY = path.join(HERE, "bundles.json");

async function loadTrustGate() {
  // TS stripping is on by default from Node 23.6; older runtimes degrade to a skipped verdict.
  try {
    return await import(pathToFileURL(path.join(ROOT, "core", "trust-gate.ts")).href);
  } catch (e) {
    return null;
  }
}

/** esbuild probe: null on CI Node 20 or a fresh clone, so reports and tests skip instead of fail. */
async function loadEsbuild() {
  try {
    return await import(pathToFileURL(path.join(ROOT, "tooling", "typecheck", "node_modules", "esbuild", "lib", "main.js")).href);
  } catch (e) {
    return null;
  }
}

function lfHash(buf) {
  return crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
}

function readRegistry() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  if (!raw || !Array.isArray(raw.bundles)) throw new Error("l0/bundles.json 损坏（缺 bundles 数组）");
  return raw;
}

async function buildOne(esbuild, bundle, trustGate, ctx, opts) {
  const entryAbs = path.isAbsolute(bundle.entry) ? bundle.entry : path.join(ROOT, bundle.entry);
  if (!fs.existsSync(entryAbs)) throw new Error("bundle " + bundle.id + " 入口不存在：" + bundle.entry);
  const outDir = (opts && opts.outDir) || path.join(ROOT, "public", "bundles", bundle.id);
  const outName = path.basename(bundle.outfile || path.basename(bundle.entry));
  const outfile = path.join(outDir, outName);
  await esbuild.build({
    entryPoints: [entryAbs],
    bundle: true,
    format: "iife",
    target: bundle.target || "es2022",
    sourcemap: "external",
    outfile,
    logLevel: "silent",
    legalComments: "none",
    metafile: false,
  });
  // manifest.json carries exactly the seven fields the trust gate validates (id/version/entry/format/
  // capabilities/slots/trust), so the shipped copy re-validates as-is: one extra field is UNKNOWN_FIELD.
  // Build facts (hash/bytes/time/verdict) live in build-meta.json, apart from the declaration.
  const code = fs.readFileSync(outfile);
  const gateManifest = {
    id: bundle.id,
    version: bundle.version || "0.0.0",
    entry: outName,
    format: "module",
    capabilities: bundle.capabilities || [],
    slots: bundle.slots || [],
    trust: bundle.trust || "core",
  };
  const meta = {
    hash: lfHash(code),
    bytes: code.length,
    generatedAt: new Date().toISOString(),
    formatOutput: "iife",
    trustVerdict: { verdict: "skipped", reason: "" },
  };
  if (trustGate && typeof trustGate.evaluateBundle === "function") {
    const verdict = trustGate.evaluateBundle(gateManifest, ctx);
    meta.trustVerdict.verdict = verdict.allow ? "allow" : "deny";
    meta.trustVerdict.reason = verdict.allow ? "" : JSON.stringify((verdict.errors || []).slice(0, 4));
    if (!verdict.allow) throw new Error("bundle " + bundle.id + " 被信任闸拒绝：" + meta.trustVerdict.reason);
  } else {
    meta.trustVerdict.verdict = "skipped";
    meta.trustVerdict.reason = "trust-gate 不可用（Node 无 TS 剥离）";
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(gateManifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(outDir, "build-meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return { bundle, outfile, gateManifest, meta };
}

/** Is the artifact still what a rebuild produces? Backs --check and the staleness lock in tests. */
async function verifyOne(esbuild, bundle, trustGate, ctx, opts) {
  const outDir = (opts && opts.outDir) || path.join(ROOT, "public", "bundles", bundle.id);
  const outName = path.basename(bundle.outfile || path.basename(bundle.entry));
  const outfile = path.join(outDir, outName);
  const manifestPath = path.join(outDir, "manifest.json");
  const metaPath = path.join(outDir, "build-meta.json");
  if (!fs.existsSync(outfile) || !fs.existsSync(manifestPath) || !fs.existsSync(metaPath)) return { stale: true, reason: "产物缺失" };
  // Snapshot before rebuilding: buildOne writes, so the reverse order lets a rebuild mask tampering.
  const curManifestRaw = fs.readFileSync(manifestPath, "utf8");
  const curMetaRaw = fs.readFileSync(metaPath, "utf8");
  const fresh = await buildOne(esbuild, bundle, trustGate, ctx, opts);
  const curManifest = JSON.parse(curManifestRaw);
  const curMeta = JSON.parse(curMetaRaw);
  const stripTime = (m) => JSON.stringify({ ...m, generatedAt: "" });
  if (JSON.stringify(curManifest) !== JSON.stringify(fresh.gateManifest)) return { stale: true, reason: "manifest 漂移" };
  if (stripTime(curMeta) !== stripTime(fresh.meta)) return { stale: true, reason: "build-meta 漂移" };
  return { stale: false };
}

/** Store-only zip (no dependencies): a directory becomes dist/bundles/<id>-<version>.zip. */
function packZip(bundle, dirOverride) {
  const dir = dirOverride || path.join(ROOT, "public", "bundles", bundle.id);
  if (!fs.existsSync(dir)) throw new Error("bundle " + bundle.id + " 还没构建过");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else files.push(p);
    }
  })(dir);
  // CRC-32 is the only checksum a store-only zip carries.
  const CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const version = String(manifest.version || "0.0.0");
  for (const abs of files) {
    const rel = path.relative(dir, abs).replace(/\\/g, "/");
    const data = fs.readFileSync(abs);
    const nameBuf = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 flag
    local.writeUInt16LE(0, 8);       // method: store
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...chunks, cdBuf, eocd]);
  const outDir = path.join(ROOT, "dist", "bundles");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, bundle.id + "-" + version + ".zip");
  fs.writeFileSync(outPath, zip);
  return outPath;
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes(n);
  const reg = readRegistry();
  const esbuild = await loadEsbuild();
  const trustGate = await loadTrustGate();
  // Trust-gate context: no capability statuses (the only bundle asks for none) but the full id
  // universe, because gate 4 only honours ids flagged builtin:true in bundles.json.
  const ctx = { capabilities: [], capabilityIds: ["workspace", "network", "pcToken", "storage"], slots: [], builtinIds: reg.bundles.filter((b) => b.builtin).map((b) => b.id) };
  if (has("--pack")) {
    const id = argv[argv.indexOf("--pack") + 1];
    const bundle = reg.bundles.find((b) => b.id === id);
    if (!bundle) { console.error("✗ 未知 bundle：" + id); process.exit(1); }
    if (!esbuild) { console.error("✗ esbuild 不可用（先在 tooling/typecheck 下 npm i）"); process.exit(1); }
    await buildOne(esbuild, bundle, trustGate, ctx); // 先保证产物新鲜
    const zip = packZip(bundle);
    console.log("[l0/bundle] --pack " + id + " → " + path.relative(ROOT, zip) + "（" + fs.statSync(zip).size + " 字节，store 型 zip）");
    return;
  }
  if (!esbuild) {
    console.log("[l0/bundle] esbuild 不可用（tooling/typecheck 下 npm i）——跳过（CI 同款降级）");
    if (has("--write")) process.exit(1); // --write 在降级态必须红（不许静默假绿）
    return;
  }
  let stale = 0;
  for (const b of reg.bundles) {
    if (has("--write")) {
      const r = await buildOne(esbuild, b, trustGate, ctx);
      const v = await verifyOne(esbuild, b, trustGate, ctx);
      console.log("  ~ " + b.id + " → public/bundles/" + b.id + "/" + path.basename(r.outfile) + "（hash " + r.meta.hash + " · trust " + r.meta.trustVerdict.verdict + "）" + (v.stale ? " ✗ 幂等失败" : " · 幂等 ✓"));
      if (v.stale) stale++;
    } else {
      const v = await verifyOne(esbuild, b, trustGate, ctx);
      console.log("  " + (v.stale ? "✗ 漂移" : "✓ 同步") + "  " + b.id + (v.stale ? "（" + v.reason + "）" : ""));
      if (v.stale) stale++;
    }
  }
  if (has("--write")) {
    console.log(stale ? "[l0/bundle] ✗ " + stale + " 个 bundle 幂等失败" : "[l0/bundle] --write 完成（" + reg.bundles.length + " 个 bundle）");
    if (stale) process.exit(1);
  } else {
    console.log(stale ? "[l0/bundle] ✗ " + stale + " 个 bundle 与源脱钩：跑 node l0/bundle.mjs --write" : "[l0/bundle] 全部同步（" + reg.bundles.length + " 个）");
    if (stale) process.exit(1);
  }
}

export { buildOne, verifyOne, packZip, readRegistry, lfHash, loadEsbuild, loadTrustGate };

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((e) => { console.error("[l0/bundle] ✗", e && e.message ? e.message : e); process.exit(1); });
}
