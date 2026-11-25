// core/host-api.compat.ts — the hostApi compat shadow contract (L1a, item 3 / α4)
//
// The shadow phase is two stages. This file is stage one: hostApi is the official entry point while
// the eight facades behind it are lazy getters that read the old globals at access time. Lazy is the
// non-obvious choice, and it is what makes load order irrelevant — compat can be the first script in
// the boot list, the old names remain the real implementation, business modules keep assigning them,
// and the frozen-name counter keeps measuring how far each name has drained.
//
// Stage two (per-domain migration) moves the real implementations into hostApi and turns the old
// names into getters pointing back, with a dev warning. That needs the assignment sites to move
// first, so it is deliberately not started here.
//
// The browser artifact is a hand-written twin, public/shared/core/host-api.compat.js, not a
// type-stripped product: CI runs Node 20 without stripTypeScriptTypes, the repository root must not
// carry a package.json (a check-syntax precondition), and tsc is kept out of the inner loop by plan
// §7.5. The convention is therefore: TS is the contract source, JS is the browser twin, and
// test/host-api-compat.test.mjs compares the two literally — whichever side drifts goes red.
//
// `tools` is a contract slot, not a collected facade: it exists so policy code can read
// hostApi.tools before a generator supplies a manifest (see ToolHostApi in host-api.ts).
//
// Retire: the whole file is deleted once stage two of the migration lands.
//
// @module core/host-api.compat

/** compat member → old global name. The strings are the contract: the JS twin and the test read them back literally. */
export interface HostApiTargets {
  readonly app: string;
  readonly cost: string;
  readonly pipeline: string;
  readonly turnRuntime: string;
  readonly sync: string;
  readonly character: string;
  readonly multi: string;
  readonly auth: string;
}

/**
 * Single source of truth: the compat factory below iterates it, so no second table exists.
 * `Record<string, string>` is what makes the iteration typed without a cast (the interface still
 * pins the eight required members at compile time).
 */
export const HOST_API_TARGETS: HostApiTargets & Record<string, string> = {
  app: "__app",
  cost: "__cost",
  pipeline: "__pipeline",
  turnRuntime: "__turnRuntime",
  sync: "__sync",
  character: "__character",
  multi: "__multi",
  auth: "__auth",
};

/**
 * The runtime shape compat exposes, described structurally (no import of host-api.ts: core keeps a
 * zero-runtime-import rule, and member parity is what the lock checks):
 *   · eight facade members: getters, undefined while a module is missing or failed to load, so the
 *     entry point never throws during boot;
 *   · tools: a real object whose manifest is undefined until the generator is wired in.
 * Names and order match the HostApi interface; the type-level declaration lives in host-api.ts.
 */
export interface CompatRuntimeShape {
  readonly tools: { readonly manifest?: unknown };
}

/** Ports: read a global by name. The wiring owns `window`, this module stays environment-free. */
export interface CompatPorts {
  readGlobal(name: string): unknown;
}

/**
 * Build the compat facade. Every target becomes a lazy getter, so load order never matters and a
 * module that has not loaded (or failed to) reads `undefined` instead of throwing — the entry point
 * must never break boot. `tools` is a real object whose manifest stays undefined until the
 * manifest generator is wired in: the contract slot exists before its producer.
 * @param ports - global reader from the wiring.
 * @returns The object the wiring assigns to `window.hostApi`.
 */
export function createCompatHostApi(ports: CompatPorts): Record<string, unknown> {
  const api: Record<string, unknown> = { tools: { manifest: undefined } };
  const entries = Object.entries(HOST_API_TARGETS);
  for (let i = 0; i < entries.length; i++) {
    const member = entries[i][0];
    const target = entries[i][1];
    Object.defineProperty(api, member, {
      get: function () {
        return ports.readGlobal(target);
      },
      enumerable: true,
      configurable: false,
    });
  }
  return api;
}
