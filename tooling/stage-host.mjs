// tooling/stage-host.mjs — stable entry for Tauri's beforeBuildCommand.
//
// Why this file exists: Tauri runs beforeBuildCommand from the repository root in CI (tauri-action),
// but from src-tauri/ in a local `cargo tauri build`. The real script lives at
// src-tauri/scripts/stage-host.mjs, so a single literal path cannot work from both cwds.
//
// This root shim resolves the real script relative to its own location:
//   · cwd = repo root   → this file runs and spawns the real script;
//   · cwd = src-tauri/  → `tooling/stage-host.mjs` resolves to the real script directly (no shim).
// Either way the real script sees its own path and derives ROOT from it, so nothing depends on cwd.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const real = path.join(here, "..", "src-tauri", "scripts", "stage-host.mjs");
const result = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(typeof result.status === "number" ? result.status : 1);
