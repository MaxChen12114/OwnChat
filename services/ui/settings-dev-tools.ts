/**
 * DevTools settings: the three storage keys behind the source / artifact tool group.
 *
 * The write side used to live in `public/js/text/ui/settings.js` (mountDevToolsCard) and the read
 * side in `services/agent/source-tools.ts`, each spelling the same literals and the same switch rule
 * independently. Store an on value with spaces in one place and the card shows one state while the
 * agent sees another, with no error anywhere. The keys, the switch polarity and the URL rules now
 * live here once; both sides consume this module.
 *
 * Notably the old card read URLs raw (`getItem(key) || ''`) while source-tools trimmed them, so a
 * manually stored trailing space rendered differently on the two sides. This module trims on both
 * reads and writes, and keeps `sourceToolsState` ('1' / '0' / '') for the card's three-way status
 * text alongside `sourceToolsOn`, the normalized boolean source-tools actually uses.
 *
 * Zero window, zero any: storage and hostname arrive as ports; the wiring wraps localStorage.
 * @module services/ui/settings-dev-tools
 */

export const SOURCE_ON_KEY = "cfw_source_tools_on_v1";
export const SOURCE_URL_KEY = "cfw_source_url_v1";
export const ARTIFACT_URL_KEY = "cfw_artifact_url_v1";

export const DEFAULT_SOURCE_URL = "http://127.0.0.1:8797";
export const DEFAULT_ARTIFACT_URL = "http://127.0.0.1:8796/artifacts";

/** Storage port; the wiring wraps localStorage so quota errors never reach this module. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Injected environment: storage plus the page hostname for the unset-switch default. */
export interface DevToolsPorts {
  storage: KvStorage;
  hostname(): string;
}

/** `text()` in source-tools.ts: null reads as empty, strings pass through, the rest stringify. */
function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

/** `ls()` in source-tools.ts: defensive read + trim; a throwing storage reads as empty. */
function ls(storage: KvStorage, key: string): string {
  try {
    return text(storage.getItem(key)).trim();
  } catch (e) {
    return "";
  }
}

/**
 * The switch rule, byte-for-byte `enabled()` in source-tools.ts: an explicit '1' / '0' wins,
 * otherwise loopback hostnames default on and every other host defaults off.
 */
export function normalizeSourceToolsOn(raw: string | null, hostname: string): boolean {
  const on = text(raw).trim();
  if (on === "1") return true;
  if (on === "0") return false;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** `base()` / `artBase()` in source-tools.ts: trim, strip trailing slashes, else the default. */
export function normalizeUrl(raw: string | null, fallback: string): string {
  return text(raw).trim().replace(/\/+$/, "") || fallback;
}

export interface DevToolsSettings {
  /** '1' | '0' | '' (unset) — the trimmed stored state the settings card paints. */
  sourceToolsState: string;
  /** Normalized boolean — exactly what source-tools.enabled() returns. */
  sourceToolsOn: boolean;
  /** Trimmed stored URL, '' when unset — the value the card shows in its input. */
  sourceUrl: string;
  artifactUrl: string;
  /** Effective URLs (trailing slashes stripped, default applied) — source-tools.base()/artBase(). */
  sourceBase: string;
  artifactBase: string;
}

export interface DevToolsWrite {
  sourceToolsOn: boolean;
  sourceUrl: string;
  artifactUrl: string;
}

export interface SettingsDevToolsApi {
  read(): DevToolsSettings;
  write(next: DevToolsWrite): void;
  /** Exported so callers never re-spell the literals. */
  keys: { ON_KEY: string; URL_KEY: string; ART_KEY: string };
}

export function createSettingsDevTools(ports: DevToolsPorts): SettingsDevToolsApi {
  /** A throwing hostname() means "not loopback" — the same fail-closed shape as source-tools.ts. */
  function hostnameSafe(): string {
    try {
      return text(ports.hostname());
    } catch (e) {
      return "";
    }
  }

  function read(): DevToolsSettings {
    const on = ls(ports.storage, SOURCE_ON_KEY);
    const sourceUrl = ls(ports.storage, SOURCE_URL_KEY);
    const artifactUrl = ls(ports.storage, ARTIFACT_URL_KEY);
    return {
      sourceToolsState: on,
      sourceToolsOn: normalizeSourceToolsOn(on, hostnameSafe()),
      sourceUrl: sourceUrl,
      artifactUrl: artifactUrl,
      sourceBase: normalizeUrl(sourceUrl, DEFAULT_SOURCE_URL),
      artifactBase: normalizeUrl(artifactUrl, DEFAULT_ARTIFACT_URL),
    };
  }

  function write(next: DevToolsWrite): void {
    ports.storage.setItem(SOURCE_URL_KEY, text(next.sourceUrl).trim());
    ports.storage.setItem(ARTIFACT_URL_KEY, text(next.artifactUrl).trim());
    ports.storage.setItem(SOURCE_ON_KEY, next.sourceToolsOn ? "1" : "0");
  }

  return {
    read: read,
    write: write,
    keys: { ON_KEY: SOURCE_ON_KEY, URL_KEY: SOURCE_URL_KEY, ART_KEY: ARTIFACT_URL_KEY },
  };
}
