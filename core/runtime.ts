/**
 * Browser-safe runtime kernel: the subset of Cordis semantics this repo actually needs.
 *
 * Three ideas, no framework:
 *   · services — provide/get by name, child scopes may shadow, same-scope duplicates fail loud;
 *   · inject — declarative dependencies; missing deps are PENDING with an explainable reason,
 *     activation happens when the graph is ready and re-runs when a provider appears;
 *   · effects — every side effect returns its inverse; dispose unwinds LIFO, scoped per fork.
 *
 * Deliberately not included: Node's loader, HMR, config patches, React slots, or a plugin
 * marketplace. `l0/scripts.json` remains the boot-order source; this kernel only gives runtime
 * objects a lifecycle once their code is loaded.
 *
 * P0 is kernel-only: nothing wires it into the app yet. That is what makes the semantics testable
 * without touching the frozen `window.__*` surface.
 * @module core/runtime
 */

/** Undo one side effect. Returning it from `effect`/`apply` is mandatory for managed effects. */
export type Disposer = () => void;

/** Lifecycle state shared by injectors and plugins. */
export type RuntimeStatus = "pending" | "active" | "disposed" | "error";

/** A plugin module in the small subset: optional name/inject plus an apply body. */
export interface PluginModule {
  readonly name?: string;
  /** Hard dependency gate: when non-empty, apply waits until every name resolves. */
  readonly inject?: readonly string[];
  /** Return a disposer when the plugin owns reversible work. */
  readonly apply: (ctx: RuntimeContext, config?: unknown) => Disposer | void;
}

/** Handle for an `inject` registration. Getters stay live after activation/disposal. */
export interface InjectHandle {
  readonly id: string;
  readonly status: RuntimeStatus;
  readonly missing: readonly string[];
  readonly error: unknown;
  dispose(): void;
}

/** Handle for a mounted plugin; `dispose` tears down the plugin's child scope. */
export interface PluginHandle {
  readonly id: string;
  readonly status: RuntimeStatus;
  readonly missing: readonly string[];
  readonly error: unknown;
  dispose(): void;
}

/** What `explain()` returns; enough for a status panel without reading internals. */
export interface ExplainResult {
  readonly id: string;
  readonly status: RuntimeStatus;
  readonly missing: readonly string[];
  readonly error: unknown;
}

interface ServiceEntry {
  readonly value: unknown;
  readonly ready: Promise<unknown> | null;
}

interface EffectRecord {
  readonly inverse: Disposer;
  spent: boolean;
}

interface InjectorRecord {
  readonly id: string;
  readonly deps: readonly string[];
  readonly activate: (ctx: RuntimeContext) => Disposer | void;
  ctx: RuntimeContext;
  status: RuntimeStatus;
  missing: readonly string[];
  error: unknown;
  generation: number;
  disposer: Disposer | null;
  disposed: boolean;
}

interface PluginRecord {
  readonly id: string;
  readonly ctx: RuntimeContext;
  status: RuntimeStatus;
  error: unknown;
  disposer: Disposer | null;
  injector: InjectorRecord | null;
  disposed: boolean;
}

/** Thenable without trusting a property access: used for async service readiness. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch (e) {
    return false;
  }
}

/** Read a service's `ready` promise, if any, without casting the service object. */
function readyOf(value: unknown): Promise<unknown> | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    const ready = Reflect.get(value, "ready");
    return isThenable(ready) ? Promise.resolve(ready) : null;
  } catch (e) {
    return null;
  }
}

/** The context object. One class, no prototypes tricks; every scope is an instance. */
export class RuntimeContext {
  private readonly parent: RuntimeContext | null;
  private readonly services: Map<string, ServiceEntry>;
  private readonly children: RuntimeContext[];
  private readonly effects: EffectRecord[];
  private readonly injectors: InjectorRecord[];
  private readonly plugins: PluginRecord[];
  private readonly disposeHooks: Disposer[];
  private disposed: boolean;
  private serial: number;

  constructor(parent: RuntimeContext | null = null) {
    this.parent = parent;
    this.services = new Map();
    this.children = [];
    this.effects = [];
    this.injectors = [];
    this.plugins = [];
    this.disposeHooks = [];
    this.disposed = false;
    this.serial = 0;
  }

  /** Register a service. Same-scope duplicates throw; child scopes may shadow the parent. */
  provide(name: string, value: unknown): void {
    if (this.disposed) throw new Error("runtime: cannot provide on a disposed context");
    if (this.services.has(name)) throw new Error("runtime: service already provided: " + name);
    this.services.set(name, { value: value, ready: readyOf(value) });
    this.notify(name);
  }

  /** Read a service; missing returns undefined (PENDING is the injector's business, not a throw). */
  get(name: string): unknown {
    const entry = this.lookup(name);
    return entry === null ? undefined : entry.value;
  }

  has(name: string): boolean {
    return this.lookup(name) !== null;
  }

  private lookup(name: string): ServiceEntry | null {
    const own = this.services.get(name);
    if (own !== undefined) return own;
    return this.parent === null ? null : this.parent.lookup(name);
  }

  /** Declare a dependency gate. The callback runs when every dep is present and its `ready` settles. */
  inject(deps: readonly string[], activate: (ctx: RuntimeContext) => Disposer | void, id?: string): InjectHandle {
    if (this.disposed) throw new Error("runtime: cannot inject on a disposed context");
    const record: InjectorRecord = {
      id: id || "inject-" + ++this.serial,
      deps: deps.slice(),
      activate: activate,
      ctx: this,
      status: "pending",
      missing: deps.slice(),
      error: null,
      generation: 0,
      disposer: null,
      disposed: false,
    };
    this.injectors.push(record);
    this.evaluate(record);
    return this.handleFor(record);
  }

  /** Register a reversible effect. The callback MUST return its inverse. */
  effect(fn: () => Disposer): Disposer {
    if (this.disposed) throw new Error("runtime: cannot add an effect on a disposed context");
    const inverse = fn();
    if (typeof inverse !== "function") {
      throw new Error("runtime: effect must return a disposer");
    }
    return this.addInverse(inverse);
  }

  /** Store an already-built inverse; used by effect() and by plugin apply results. */
  private addInverse(inverse: Disposer): Disposer {
    const record: EffectRecord = { inverse: inverse, spent: false };
    this.effects.push(record);
    return () => this.spendEffect(record);
  }

  /** Mount a plugin in a child scope; `inject` is a hard gate, apply errors are captured. */
  plugin(mod: PluginModule, config?: unknown): PluginHandle {
    if (this.disposed) throw new Error("runtime: cannot mount a plugin on a disposed context");
    const id = typeof mod.name === "string" && mod.name ? mod.name : "plugin-" + ++this.serial;
    const child = this.fork();
    const record: PluginRecord = {
      id: id,
      ctx: child,
      status: "pending",
      error: null,
      disposer: null,
      injector: null,
      disposed: false,
    };
    this.plugins.push(record);
    const run = (): void => {
      if (record.disposed) return;
      try {
        const result = mod.apply(child, config);
        if (typeof result === "function") child.addInverse(result);
        record.status = "active";
      } catch (e) {
        record.status = "error";
        record.error = e;
      }
    };
    if (mod.inject !== undefined && mod.inject.length > 0) {
      const injector = child.inject(mod.inject, run, id + ":inject");
      record.injector = this.injectorOf(child, injector.id);
    } else {
      run();
    }
    return this.pluginHandleFor(record);
  }

  /** A child scope: inherits services, isolates provides/effects/injectors, disposed first. */
  fork(): RuntimeContext {
    if (this.disposed) throw new Error("runtime: cannot fork a disposed context");
    const child = new RuntimeContext(this);
    this.children.push(child);
    return child;
  }

  /** Register a disposal hook (LIFO with effects). */
  on(event: "dispose", fn: Disposer): Disposer {
    if (event !== "dispose") throw new Error("runtime: unknown event " + String(event));
    if (this.disposed) throw new Error("runtime: cannot listen on a disposed context");
    this.disposeHooks.push(fn);
    return () => {
      const i = this.disposeHooks.indexOf(fn);
      if (i >= 0) this.disposeHooks.splice(i, 1);
    };
  }

  /** Tear down this scope: children, injectors, effects, hooks, services — LIFO and idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const record = this.plugins[i];
      if (record.disposed) continue;
      record.disposed = true;
      record.status = "disposed";
    }
    for (let i = this.children.length - 1; i >= 0; i--) this.children[i].dispose();
    for (let i = this.injectors.length - 1; i >= 0; i--) {
      const record = this.injectors[i];
      record.disposed = true;
      record.generation++;
      this.deactivate(record);
      record.status = "disposed";
    }
    for (let i = this.effects.length - 1; i >= 0; i--) this.spendEffect(this.effects[i]);
    for (let i = this.disposeHooks.length - 1; i >= 0; i--) this.runHook(this.disposeHooks[i]);
    this.injectors.length = 0;
    this.effects.length = 0;
    this.disposeHooks.length = 0;
    this.services.clear();
  }

  /** Explain one injector/plugin by id (searches this scope and descendants). */
  explain(id: string): ExplainResult | null {
    const own = this.findRecord(id);
    if (own !== null) return own;
    for (const child of this.children) {
      const found = child.explain(id);
      if (found !== null) return found;
    }
    return null;
  }

  private findRecord(id: string): ExplainResult | null {
    for (const record of this.injectors) {
      if (record.id === id) {
        return { id: record.id, status: record.status, missing: record.missing.slice(), error: record.error };
      }
    }
    for (const record of this.plugins) {
      if (record.id !== id) continue;
      const missing = record.injector === null ? [] : record.injector.missing.slice();
      return { id: record.id, status: record.status, missing: missing, error: record.error };
    }
    return null;
  }

  private injectorOf(ctx: RuntimeContext, id: string): InjectorRecord | null {
    for (const record of ctx.injectors) if (record.id === id) return record;
    return null;
  }

  private evaluate(record: InjectorRecord): void {
    if (record.disposed || this.disposed) return;
    const missing = record.deps.filter((name) => !this.has(name));
    record.missing = missing;
    const generation = ++record.generation;
    if (missing.length > 0) {
      this.deactivate(record);
      record.status = "pending";
      return;
    }
    const entries = record.deps.map((name) => this.lookup(name));
    const waits: Promise<unknown>[] = [];
    for (const entry of entries) {
      if (entry === null) return;
      if (entry.ready !== null) waits.push(entry.ready);
    }
    const run = (): void => {
      if (record.disposed || this.disposed || record.generation !== generation) return;
      try {
        const result = record.activate(record.ctx);
        record.disposer = typeof result === "function" ? result : null;
        record.status = "active";
        record.error = null;
      } catch (e) {
        record.status = "error";
        record.error = e;
      }
    };
    if (waits.length === 0) {
      this.deactivate(record);
      run();
      return;
    }
    Promise.all(waits).then(run, (e) => {
      if (record.generation !== generation || record.disposed) return;
      record.status = "error";
      record.error = e;
    });
  }

  private deactivate(record: InjectorRecord): void {
    if (record.disposer !== null) {
      const inverse = record.disposer;
      record.disposer = null;
      try { inverse(); } catch (e) { /* an inverse failure must not block the rest of teardown */ }
    }
    if (record.status === "active" || record.status === "error") record.status = "pending";
  }

  private notify(name: string): void {
    for (const record of this.injectors.slice()) {
      if (record.deps.includes(name)) this.evaluate(record);
    }
    for (const child of this.children.slice()) child.notify(name);
  }

  private spendEffect(record: EffectRecord): void {
    if (record.spent) return;
    record.spent = true;
    try { record.inverse(); } catch (e) { /* every inverse gets its turn; one failure is isolated */ }
  }

  private runHook(fn: Disposer): void {
    try { fn(); } catch (e) { /* dispose hooks are best-effort cleanup */ }
  }

  private handleFor(record: InjectorRecord): InjectHandle {
    return {
      get id() { return record.id; },
      get status() { return record.status; },
      get missing() { return record.missing.slice(); },
      get error() { return record.error; },
      dispose: () => {
        if (record.disposed) return;
        record.disposed = true;
        record.generation++;
        this.deactivate(record);
        record.status = "disposed";
        const i = this.injectors.indexOf(record);
        if (i >= 0) this.injectors.splice(i, 1);
      },
    };
  }

  private pluginHandleFor(record: PluginRecord): PluginHandle {
    return {
      get id() { return record.id; },
      get status() { return record.status; },
      get missing() {
        const injector = record.injector;
        return injector === null ? [] : injector.missing.slice();
      },
      get error() { return record.error; },
      dispose: () => {
        if (record.disposed) return;
        record.disposed = true;
        record.ctx.dispose();
        record.status = "disposed";
        const i = this.plugins.indexOf(record);
        if (i >= 0) this.plugins.splice(i, 1);
      },
    };
  }
}

/** Create a root context. `parent` is only for internal forks; exposed for tests. */
export function createContext(parent: RuntimeContext | null = null): RuntimeContext {
  return new RuntimeContext(parent);
}
