#!/usr/bin/env node
// deploy/publish.mjs — copy the deploy packs into the served asset tree.
//
// Why a copy exists at all: `deploy/` is the authoring location (it is where the plan puts the
// packs and where the tests read them), while `public/` is the only directory wrangler uploads and
// the Tauri shell loads. The browser card fetches `/deploy/<id>.json`, so the served mirror must
// exist. The mirror is generated, never hand-edited; `test/deploy-pack.test.mjs` compares every
// pair byte for byte so a pack edit that forgets this script turns the lock red.
//
// Usage: node deploy/publish.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "public", "deploy");

/** Pack files are the two top-level JSON documents of deploy/ (the vps/ folder is a template). */
const packs = fs.readdirSync(HERE).filter((name) => name.endsWith(".json")).sort();
if (packs.length === 0) {
  console.log("[deploy/publish] 没有找到部署包（deploy/*.json）");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const name of packs) {
  const src = fs.readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n");
  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch (e) {
    console.log(`[deploy/publish] ✗ ${name} 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
    console.log(`[deploy/publish] ✗ ${name} 缺少 id`);
    process.exit(1);
  }
  const target = path.join(OUT, name);
  fs.writeFileSync(target, src, "utf8");
  console.log(`  ~ public/deploy/${name}`);
}
console.log(`[deploy/publish] 已发布 ${packs.length} 个部署包到 public/deploy/`);
