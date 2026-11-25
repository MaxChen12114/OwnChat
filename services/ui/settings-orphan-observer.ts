/**
 * Settings orphan sweeper: anything appended to the settings root instead of a proper slot gets
 * adopted into the image slot instead of silently landing at the panel bottom.
 *
 * Today nothing depends on it (the avatar and expression-pack cards gained explicit slots), so it
 * is a guard, not a feature: the engine answers "is this node an orphan" and "sweep now"; the
 * root observation, the click re-sweep and the DOM writes arrive through {@link OrphanPorts}.
 * The header, the version tag and the footer live at the root on purpose — they are skipped.
 * @module services/ui/settings-orphan-observer
 */

/** Root-level nodes that belong there; ids must stay in step with the footer keeper's targets. */
export function skipIds(): Record<string, number> {
  return { settingsHeader: 1, appVersionTag: 1, settingsFooter: 1 };
}

/** Ports: element lookup, the shell-subtree probe, children enumeration, adoption and events. */
export interface OrphanPorts {
  /** `getElementById` of the host document. */
  get(id: string): unknown;
  /** `shell.contains(node)`; `false` when there is no shell. DOM `contains` includes the shell
   * itself, which is what keeps the shell from being swept as its own orphan. */
  shellContains(node: unknown): boolean;
  /** Element children of the settings root, in document order. */
  childrenOf(settings: unknown): unknown[];
  /** Adopt an orphan into the image slot. */
  adopt(node: unknown): void;
  /** Observe childList additions on the settings root; each batch is an array of added nodes. */
  observeSettings(onAdded: (nodes: unknown[]) => void): void;
  /** Subscribe the settings-button click. */
  onSettingsClick(cb: () => void): void;
  /** Delayed scheduler; the click re-sweep waits 120ms for late injections. */
  schedule(fn: () => void, ms: number): void;
}

/** Public surface; no frozen contract — the wiring runs it once at boot. */
export interface OrphanApi {
  /** Initial sweep + observation + the click re-sweep. Safe on a missing panel (no-op). */
  run(): void;
  /** One sweep pass; returns how many orphans were adopted. */
  sweep(): number;
}

/** unknown -> plain-object view (the standard bridge, local copy). */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Create the sweeper. Nothing runs until {@link OrphanApi.run}; the wiring calls it once. */
export function createOrphanObserver(ports: OrphanPorts): OrphanApi {
  function isOrphan(node: unknown): boolean {
    const rec = recOf(node);
    if (rec === null) return false;
    if (rec["nodeType"] !== 1) return false;
    const skip = skipIds();
    if (typeof rec["id"] === "string" && skip[rec["id"]] === 1) return false;
    const settings = ports.get("settings");
    if (rec["parentNode"] !== settings) return false;
    if (ports.shellContains(node)) return false;
    return true;
  }

  function sweep(): number {
    const settings = ports.get("settings");
    if (settings === null || settings === undefined) return 0;
    let moved = 0;
    const children = ports.childrenOf(settings);
    for (let i = 0; i < children.length; i++) {
      if (isOrphan(children[i])) {
        ports.adopt(children[i]);
        moved++;
      }
    }
    return moved;
  }

  function run(): void {
    sweep();
    ports.observeSettings(function (nodes) {
      for (let i = 0; i < nodes.length; i++) {
        if (isOrphan(nodes[i])) ports.adopt(nodes[i]);
      }
    });
    ports.onSettingsClick(function () {
      ports.schedule(sweep, 120);
    });
  }

  return { run: run, sweep: sweep };
}
