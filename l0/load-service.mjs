// l0/load-service.mjs — load the VALUE exports of a services/**/*.ts module directly in Node.
//
// Why it exists: some services are pure modules — no wiring, no boot entry, no runtime load point.
// Their only consumers are build scripts and tests, and giving them an emit product would put a file
// into public/ that nothing ever loads.
//
// Same rule as emitOne() in l0/emit.mjs (the two MUST stay in step):
//   strip types → drop the top-level `export ` prefix → evaluate as a function body → return the
//   requested names.
// Limit: modules without imports only. Every pure module here qualifies; anything with a dependency
// goes through emit or tsc.
//
// Usage:
//   import { loadService } from "../l0/load-service.mjs";
//   const { build } = loadService("services/agent/tool-catalog.ts", ["build"]);
import fs from "node:fs";
import path from "node:path";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stripTypeScriptTypes =
  typeof nodeModule.stripTypeScriptTypes === "function" ? nodeModule.stripTypeScriptTypes : null;

/**
 * @param {string} relPath TS path relative to the repo root, e.g. "services/agent/tool-catalog.ts"
 * @param {string[]} names top-level value names to extract (must be const/let/var/function/class)
 * @returns {Record<string, unknown>}
 */
export function loadService(relPath, names) {
  if (!stripTypeScriptTypes) throw new Error("本 Node 没有 stripTypeScriptTypes（需 22.13+）");
  const src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const stripped = stripTypeScriptTypes(src, { sourceMap: false });
  // Same rule as emit: strip only the top-level value-export prefix (interface/type are already
  // erased by the stripper).
  const body = stripped.replace(/^export (?=(?:const|let|var|function|class)\b)/gm, "");
  if (/^\s*import\s/m.test(body)) {
    throw new Error(`${relPath} 含 import，不能走 loadService（用 emit 产物或 tsc）`);
  }
  const ret = names.map((n) => n + ": " + n).join(", ");
  const factory = new Function("globalThis", "window", "global", body + "\nreturn { " + ret + " };");
  return factory(globalThis, globalThis, globalThis);
}
