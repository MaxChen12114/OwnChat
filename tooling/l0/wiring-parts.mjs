// tooling/l0/wiring-parts.mjs — single source for split wiring bundles.
//
// Big classic wirings are kept as ordered source fragments but emitted as one product. The map is
// imported by tooling/l0/emit.mjs (assembly) and by tests that need to read a wiring as a whole; a second
// copy of the order would drift, so it lives here only.
//
// Rule: every fragment list must include the host file registered in WIRINGS; the first fragment
// may open the shared IIFE and the host closes it. The emitted product is still syntax/type checked
// as a whole; fragments carrying the `l0-wiring-part:` marker are skipped by the per-file parsers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const WIRING_PARTS = {
  "services/chat/app.ts": [
    "tooling/l0/wiring/app/00-core.js",
    "tooling/l0/wiring/app/10-turn.js",
    "tooling/l0/wiring/app/20-ui.js",
    "tooling/l0/wiring/app/30-agent.js",
    "tooling/l0/wiring/app/40-send.js",
    "tooling/l0/wiring/app/50-relay.js",
    "tooling/l0/wiring/app/60-input.js",
    "tooling/l0/wiring/app.js",
  ],
  "services/ui/settings.ts": [
    "tooling/l0/wiring/settings/00-core.js",
    "tooling/l0/wiring/settings/10-appearance.js",
    "tooling/l0/wiring/settings/20-base.js",
    "tooling/l0/wiring/settings/30-chat.js",
    "tooling/l0/wiring/settings/40-agent.js",
    "tooling/l0/wiring/settings/50-models.js",
    "tooling/l0/wiring/settings/60-sync.js",
    "tooling/l0/wiring/settings/70-images.js",
    "tooling/l0/wiring/settings.js",
  ],
  "services/tools/agent/tools.ts": [
    "tooling/l0/wiring/tools/00-core.js",
    "tooling/l0/wiring/tools/10-image.js",
    "tooling/l0/wiring/tools/20-character.js",
    "tooling/l0/wiring/tools/30-agent.js",
    "tooling/l0/wiring/tools/40-data.js",
    "tooling/l0/wiring/tools/50-settings.js",
    "tooling/l0/wiring/tools/60-misc.js",
    "tooling/l0/wiring/tools/70-video.js",
    "tooling/l0/wiring/tools.js",
  ],
};

/** Fragments for a host file (repo-relative), or the host itself when it was never split. */
export function wiringPartsFor(hostRel) {
  for (const parts of Object.values(WIRING_PARTS)) {
    if (parts.includes(hostRel)) return parts;
  }
  return [hostRel];
}

/** Read a wiring as emit sees it: fragments joined in order, trailing whitespace trimmed. */
export function readWiring(hostRel) {
  return wiringPartsFor(hostRel)
    .map((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8"))
    .join("\n");
}
