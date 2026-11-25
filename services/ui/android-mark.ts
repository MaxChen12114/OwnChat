/**
 * Android shell marker: tags the document element so CSS can branch app-only behaviour.
 *
 * `?shell=android` plants the sticky flag; from then on the classes survive reloads and re-apply
 * on every pageshow / focus / visibilitychange. Full effects stay opt-in (same rule as the head
 * FOUC script). The engine returns the class plan from three reads; storage, classes and the
 * rebind subscriptions arrive through {@link AndroidMarkPorts}, so the plan asserts in a vm.
 * @module services/ui/android-mark
 */

/** Sticky flag: once planted, the classes apply even without the query param. */
export const LS_SHELL = "cfw_android_app_shell_v1";
/** Full-effects opt-in; shared with the head FOUC script. */
export const LS_FX = "cfw_app_fx_rich_v1";

/** Ports: query-param read, the two storage keys, class flips and the rebind subscriptions. */
export interface AndroidMarkPorts {
  /** `?shell=` value of the current URL; `null` when absent. */
  shellParam(): string | null;
  lsGet(key: string): string | null;
  lsSet(key: string, value: string): void;
  /** Add classes to `document.documentElement`; missing classes are skipped by the caller. */
  rootAdd(cls: string): void;
  /** Subscribe a callback to pageshow / focus / visibilitychange. */
  onRebind(cb: () => void): void;
}

/** Public surface; no frozen contract — the wiring runs it once at boot. */
export interface AndroidMarkApi {
  /** One pass: plant the flag when asked, then add the classes the current state implies. */
  run(): void;
  /** Bind the three re-runs; called once by the wiring. */
  auto(): void;
}

/**
 * Pure plan: given the three reads, which classes land on `document.documentElement`.
 * Empty array means "no marker" — the caller then does nothing at all.
 */
export function markPlan(shellParam: string | null, lsShell: string | null, lsFx: string | null): string[] {
  const classes: string[] = [];
  if (shellParam === "android" || lsShell === "1") classes.push("android-app");
  if (classes.length > 0 && lsFx === "1") classes.push("fx-rich");
  return classes;
}

/** Create the marker. Nothing runs until {@link AndroidMarkApi.run} / {@link AndroidMarkApi.auto}. */
export function createAndroidMark(ports: AndroidMarkPorts): AndroidMarkApi {
  function run(): void {
    const param = ports.shellParam();
    if (param === "android") ports.lsSet(LS_SHELL, "1");
    const classes = markPlan(param, ports.lsGet(LS_SHELL), ports.lsGet(LS_FX));
    for (let i = 0; i < classes.length; i++) ports.rootAdd(classes[i]);
  }
  function auto(): void {
    run();
    ports.onRebind(run);
  }
  return { run: run, auto: auto };
}
