/**
 * Version painter: reads the app version from the Tauri shell and paints both version tags.
 *
 * Two shell shapes are supported (plugin API first, raw invoke second), both routed through
 * {@link PainterPorts} so the plan asserts in a vm with fake objects; web builds have no
 * `__TAURI__` and stay unpainted. The painted text is also mirrored onto `window.__appVersion`
 * through the ports — env-context reads that global, the wiring owns the assignment.
 * @module services/ui/version-painter
 */

/** Ports: shell access, the two text sinks and the global version mirror. */
export interface PainterPorts {
  /** `window.__TAURI__`; `null`/`undefined` on web builds. */
  getTauri(): unknown;
  /** Raw invoke for shells without the app plugin; resolves to a version string. */
  invoke(cmd: string): Promise<unknown>;
  /** `textContent` write on a version tag; missing elements are skipped by the wiring. */
  setText(id: string, text: string): void;
  /** Mirror the version onto `window.__appVersion`. */
  setGlobalVersion(v: string): void;
}

/** Public surface; no frozen contract of its own — `__appVersion` already is one. */
export interface PainterApi {
  /** One pass: read, mirror, paint. Resolves after the sink writes (or immediately when absent). */
  run(): Promise<void>;
}

/** unknown -> plain-object view (the standard bridge, local copy). */
function recOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** The painted text for both tags; single source so the two sinks cannot drift. */
export function versionText(v: string): string {
  return "OwnChat v" + v;
}

/** Read the shell version: app plugin first, raw invoke second, empty string when neither. */
export async function readTauriVersion(tauri: unknown, invoke: (cmd: string) => Promise<unknown>): Promise<string> {
  const rec = recOf(tauri);
  if (rec === null) return "";
  const app = recOf(rec["app"]);
  if (app !== null && typeof app["getVersion"] === "function") {
    const v = await Promise.resolve(app["getVersion"]());
    return typeof v === "string" ? v : "";
  }
  const core = recOf(rec["core"]);
  if (core !== null && typeof core["invoke"] === "function") {
    const v = await Promise.resolve(core["invoke"]("plugin:app|version"));
    return typeof v === "string" ? v : "";
  }
  return "";
}

/** Create the painter. Nothing runs until {@link PainterApi.run}; the wiring calls it once. */
export function createVersionPainter(ports: PainterPorts): PainterApi {
  async function run(): Promise<void> {
    let v = "";
    try {
      v = await readTauriVersion(ports.getTauri(), ports.invoke);
    } catch (e) {
      v = "";
    }
    if (v === "" || typeof v !== "string") return;
    ports.setGlobalVersion(v);
    const text = versionText(v);
    ports.setText("appVersionTag", text);
    ports.setText("appVersionTagHome", text);
  }
  return { run: run };
}
