// l0/wiring-parts.mjs — single source for split wiring bundles.
//
// Big classic wirings are kept as ordered source fragments but emitted as one product. The map is
// imported by l0/emit.mjs (assembly) and by tests that need to read a wiring as a whole; a second
// copy of the order would drift, so it lives here only.
//
// Rule: every fragment list must include the host file registered in WIRINGS; the first fragment
// may open the shared IIFE and the host closes it. The emitted product is still syntax/type checked
// as a whole; fragments carrying the `l0-wiring-part:` marker are skipped by the per-file parsers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const WIRING_PARTS = {
  "services/chat/app.ts": [
    "l0/wiring/app/00-core.js",
    "l0/wiring/app/10-turn.js",
    "l0/wiring/app/20-ui.js",
    "l0/wiring/app/30-agent.js",
    "l0/wiring/app/40-send.js",
    "l0/wiring/app/50-relay.js",
    "l0/wiring/app/60-input.js",
    "l0/wiring/app.js",
  ],
  "services/ui/settings.ts": [
    "l0/wiring/settings/00-core.js",
    "l0/wiring/settings/10-appearance.js",
    "l0/wiring/settings/20-base.js",
    "l0/wiring/settings/30-chat.js",
    "l0/wiring/settings/40-agent.js",
    "l0/wiring/settings/50-models.js",
    "l0/wiring/settings/60-sync.js",
    "l0/wiring/settings/70-images.js",
    "l0/wiring/settings.js",
  ],
  "services/tools/agent/tools.ts": [
    "l0/wiring/tools/00-core.js",
    "l0/wiring/tools/10-image.js",
    "l0/wiring/tools/20-character.js",
    "l0/wiring/tools/30-agent.js",
    "l0/wiring/tools/40-data.js",
    "l0/wiring/tools/50-settings.js",
    "l0/wiring/tools/60-misc.js",
    "l0/wiring/tools/70-video.js",
    "l0/wiring/tools.js",
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
