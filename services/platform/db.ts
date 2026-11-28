/**
 * The DbPort facade: the one object business code (and T3's migrations) see. Adapters register
 * themselves by name; the facade picks one, hands out the port and keeps the runtime context's `db`
 * service in step with it.
 *
 * Why selection is lazy: the facade's script loads before the three adapters (their factories must
 * exist before a provider can be built), and the Tauri probe answers differently depending on when
 * the shell injects its globals. Resolving on the first `get()` — not at load — means both facts
 * are true when the decision is made, and a page that never touches storage pays nothing.
 *
 * Why `provide("db", …)` gets a stable forwarding port instead of the concrete adapter: the runtime
 * kernel cannot replace a service (`provide` fails loud on duplicates), and rebuilding the root
 * context on every switch would dispose whatever T4 mounts into it. A forwarding port keeps the
 * injected service alive across `use()` calls while `get()`/`adapter()` still answer with the
 * concrete implementation, so "switch the host" never invalidates a consumer's captured reference.
 * `get("db") !== dbSvc.adapter()` is therefore by design, not an oversight.
 *
 * Boundary: this file owns selection, registration and the context; it never speaks HTTP, never
 * reads localStorage and never probes the shell itself (the wiring passes `shellAvailable`).
 * @module services/platform/db
 */

import type { DbPort, DbResult, DbRow, DbTx, SearchScope, SearchSurface } from "../../core/db";
import type { RuntimeContext } from "../../core/runtime";

// The kernel is a separate emit product; declaring the bridge keeps this module import-free like
// every other service source. `runtimeCore` is published by `tooling/l0/wiring/runtime.js`.
declare const runtimeCore: {
  readonly createContext: typeof import("../../core/runtime").createContext;
};

/** A registered adapter factory. Called once per selection; throws its own configuration errors. */
export type DbFactory = (options?: unknown) => DbPort;

/** What business code and the shell both type against. */
export interface DbFacade {
  readonly v: 1;
  /** Root runtime context every T4 consumer injects from; holds the `db` service. */
  readonly context: RuntimeContext;
  /** Register an adapter factory under a stable name (`d1` / `node` / `tauri`). */
  register(name: string, factory: DbFactory): void;
  /** Build and select an adapter now; returns the fresh port. Unknown names throw. */
  use(name: string, options?: unknown): DbPort;
  /** The selected port, boot-selecting one on first use. */
  get(): DbPort;
  /** Name of the selected adapter (empty before the first selection). */
  adapter(): string;
  exec(sql: string, params?: unknown[]): Promise<DbResult>;
  tx<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T>;
  search(surface: SearchSurface, scope: SearchScope, q: string, limit?: number): Promise<DbRow[]>;
}

/** Wiring inputs: the shell probe and the fallback name when no shell is present. */
export interface DbFacadeOptions {
  /** True when the desktop shell exposes a working invoke (checked by the wiring). */
  readonly shellAvailable: () => boolean;
  /** Adapter used when the shell is absent or `tauri` was never registered. Default `d1`. */
  readonly fallback?: string;
}

/** Whether a value answers to the whole DbPort shape. Reflection, not a cast: no escape needed. */
function isPort(value: unknown): value is DbPort {
  if (value === null || typeof value !== "object") return false;
  try {
    return (
      typeof Reflect.get(value, "exec") === "function" &&
      typeof Reflect.get(value, "transaction") === "function" &&
      typeof Reflect.get(value, "search") === "function"
    );
  } catch (e) {
    // A hostile getter is "not a port", never a boot-time crash.
    return false;
  }
}

/** Build the facade. One instance per page; the wiring publishes it as `window.dbSvc`. */
export function createDbFacade(options: DbFacadeOptions): DbFacade {
  if (!options || typeof options.shellAvailable !== "function") {
    throw new Error("db: shellAvailable probe is required");
  }
  const factories = new Map<string, DbFactory>();
  const root = runtimeCore.createContext();
  const fallback = typeof options.fallback === "string" && options.fallback ? options.fallback : "d1";
  let currentName = "";
  let currentPort: DbPort | null = null;

  /** Boot-time decision: the shell wins when it can invoke, everything else is D1. */
  function pickDefault(): string {
    let shell = false;
    try {
      shell = options.shellAvailable() === true;
    } catch (e) {
      // A hostile probe must mean "no shell", not a boot-time crash.
      shell = false;
    }
    if (shell && factories.has("tauri")) return "tauri";
    return fallback;
  }

  const facade: DbFacade = {
    v: 1,
    context: root,

    register(name: string, factory: DbFactory): void {
      if (typeof name !== "string" || !name) throw new Error("db: adapter name is required");
      if (typeof factory !== "function") throw new Error("db: adapter factory must be a function: " + name);
      if (factories.has(name)) throw new Error("db: adapter already registered: " + name);
      factories.set(name, factory);
    },

    use(name: string, useOptions?: unknown): DbPort {
      const factory = factories.get(name);
      if (factory === undefined) {
        const known = Array.from(factories.keys()).join(",");
        throw new Error('db: unknown adapter "' + String(name) + '" (registered: ' + (known || "none") + ")");
      }
      const port = factory(useOptions);
      if (!isPort(port)) throw new Error('db: adapter "' + String(name) + '" did not return a DbPort');
      currentName = name;
      currentPort = port;
      return port;
    },

    get(): DbPort {
      if (currentPort !== null) return currentPort;
      return facade.use(pickDefault());
    },

    adapter(): string {
      return currentName;
    },

    exec(sql: string, params?: unknown[]): Promise<DbResult> {
      return facade.get().exec(sql, params);
    },

    tx<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T> {
      return facade.get().transaction<T>(fn);
    },

    search(surface: SearchSurface, scope: SearchScope, q: string, limit?: number): Promise<DbRow[]> {
      return facade.get().search(surface, scope, q, limit);
    },
  };

  // The service consumers inject. Generic method syntax is required: `transaction` must stay
  // generic, and an arrow assigned here would widen T to unknown.
  const bridge: DbPort = {
    exec(sql: string, params?: unknown[]): Promise<DbResult> {
      return facade.get().exec(sql, params);
    },
    transaction<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T> {
      return facade.get().transaction<T>(fn);
    },
    search(surface: SearchSurface, scope: SearchScope, q: string, limit?: number): Promise<DbRow[]> {
      return facade.get().search(surface, scope, q, limit);
    },
  };
  root.provide("db", bridge);
  return facade;
}
