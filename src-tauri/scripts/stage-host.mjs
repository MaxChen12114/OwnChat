// src-tauri/scripts/stage-host.mjs — stage the in-app host runtime + the bundled page before a build.
//
// Why staging exists: the desktop shell loads a *fixed origin* (the bundled page) and spawns a Node
// sidecar from inside the installed app. Both need a snapshot of this repo that does not depend on
// the checkout still being there:
//   src-tauri/host/runtime/public/   the page (frontendDist) AND the static tree the sidecar serves
//   src-tauri/host/runtime/server/   server/local.mjs (the `host` entry in services.rs)
//   src-tauri/host/runtime/src/      src/worker.js + prompts + model tables
//   src-tauri/host/runtime/migrations/   the unified schema the sidecar applies
//   src-tauri/host/runtime/scripts/  gen-prompts.mjs, used only if the generated registries are absent
//
// `/config.js` is the one file the worker generates rather than ships. In the browser it is a route;
// on the fixed origin there is no worker in front of the page, so it is rendered here by asking
// src/worker.js itself (one source of truth — a copied model table would drift silently).
//
// Runs as tauri.conf.json's beforeDevCommand/beforeBuildCommand (cwd = src-tauri). Safe to run by
// hand: `node tooling/scripts/stage-host.mjs` from src-tauri, or `node src-tauri/scripts/stage-host.mjs`.
//
// Node floor for this script: whatever the Tauri CI uses (20+). It never imports node:sqlite itself;
// the worker import only needs Web-standard Request/Response, available since Node 18.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_ROOT = path.resolve(HERE, "..");
const ROOT = path.resolve(TAURI_ROOT, "..");
const OUT = path.join(TAURI_ROOT, "host", "runtime");

const COPY_DIRS = ["server", "src", "public", "migrations"];

function die(message) {
  console.error(`[stage-host] ✗ ${message}`);
  process.exit(1);
}

function ensurePromptRegistries() {
  const generated = [
    "src/prompts/bases/unlocked/index.js",
    "src/prompts/bases/locked/index.js",
    "src/prompts/presets/index.js",
    "src/prompts/skills/index.js",
  ];
  if (generated.every((rel) => fs.existsSync(path.join(ROOT, rel)))) return;
  console.log("[stage-host] generated prompt registries missing; running tooling/scripts/gen-prompts.mjs");
  const r = spawnSync(process.execPath, [path.join(ROOT, "tooling", "scripts", "gen-prompts.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) die("tooling/scripts/gen-prompts.mjs failed");
}

/** Copy one tree with a filter; never ship a developer's .dev.vars or a stale local data dir. */
function copyTree(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(OUT, rel);
  if (!fs.existsSync(from)) die(`missing source directory: ${from}`);
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src).toLowerCase();
      if (base === ".dev.vars" || base === ".local-data" || base === "node_modules" || base === ".git") return false;
      if (base.endsWith(".log") && base.startsWith("host")) return false;
      return true;
    },
  });
}

/** Ask the worker for its own /config.js body and write it as a static file for the fixed origin. */
async function writeConfigJs() {
  const workerUrl = new URL(`file://${path.join(OUT, "src", "worker.js").replace(/\\/g, "/")}`).href;
  let body;
  try {
    const mod = await import(workerUrl);
    const handler = mod.default;
    if (!handler || typeof handler.fetch !== "function") die("src/worker.js has no fetch handler");
    const res = await handler.fetch(new Request("http://stage.local/config.js"), {}, { waitUntil() {} });
    if (res.status !== 200) die(`/config.js answered ${res.status}`);
    body = await res.text();
  } catch (e) {
    die(`could not render /config.js: ${(e && e.stack) || e}`);
  }
  if (!body || !body.includes("APP_CTX_EXACT") || !body.includes("APP_MODELS_FREE")) {
    die("/config.js body looks incomplete (APP_CTX_EXACT / APP_MODELS_FREE missing)");
  }
  const target = path.join(OUT, "public", "config.js");
  fs.writeFileSync(target, body, "utf8");
  return body.length;
}

async function main() {
  ensurePromptRegistries();

  // Full rebuild of the staged tree: a file deleted in the repo must not survive in the installer.
  fs.rmSync(path.join(TAURI_ROOT, "host"), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const rel of COPY_DIRS) copyTree(rel);
  // The runtime fallback keeps its published path: host/runtime/scripts/gen-prompts.mjs.
  fs.mkdirSync(path.join(OUT, "server"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tooling", "scripts", "gen-prompts.mjs"), path.join(OUT, "scripts", "gen-prompts.mjs"));

  // Node decides .js is ESM by syntax detection, but only for recent runtimes; a staged
  // package.json with "type":"module" makes the host independent of that heuristic.
  fs.writeFileSync(
    path.join(OUT, "package.json"),
    JSON.stringify({ name: "ownchat-host-runtime", private: true, type: "module" }, null, 2) + "\n",
    "utf8",
  );

  const configBytes = await writeConfigJs();

  const files = fs.readdirSync(OUT).sort();
  console.log(`[stage-host] staged ${path.relative(ROOT, OUT)} (${files.join(", ")})`);
  console.log(`[stage-host] frontendDist = host/runtime/public (config.js ${configBytes} bytes)`);
  console.log("[stage-host] next: cargo/tauri build picks this up; serve it with `node host/runtime/server/local.mjs`");
}

main().catch((e) => die((e && e.stack) || e));
