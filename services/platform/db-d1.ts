/**
 * D1 adapter: the web deployment's DbPort. Same-origin `/api/data/*`, nothing else — the page's own
 * fetch wrapper adds the access token for `/api/*` (`services/auth/token.ts`), so this adapter must
 * stay relative. Prefixing an origin here would silently drop the Authorization header and turn
 * every call into a 401 that looks like "the data plane is off".
 *
 * The HTTP semantics live in `services/platform/db-http.ts`; this file only declares the D1 shape so
 * the facade can register it by name.
 * @module services/platform/db-d1
 */

import type { DbPort } from "../../core/db";

declare const createHttpDbPort: typeof import("./db-http").createHttpDbPort;

/** Build the D1 port. Options are ignored on purpose: D1 is always same-origin. */
export function createD1Port(): DbPort {
  return createHttpDbPort({ base: "" });
}
