/**
 * Deploy settings card: the pack catalogue, the first-connect copy and the result/preview
 * formatting shared by the card and the first-connect notice.
 *
 * Why the copy lives here instead of in `core/runtime-manifest.ts`: the core module decides
 * (whether a host is new, which choice is destructive, whether a backup is required); this module
 * turns ids and warning codes into **addressed copy** (`Copy = { key, params }`), and the wiring
 * renders it through `__i18n.tCopy`. Keys and their text live in `public/locales/<lang>.json`, so
 * this module never imports the engine and never contains a translatable sentence of its own.
 *
 * Params may nest descriptors (`{ profile: { key: "settings.deploy.profile.guest" } }`) — the renderer
 * resolves them depth-first, which is how a composed line ("profile: X · capabilities: Y") stays two
 * catalog messages instead of a sentence glued together in code.
 *
 * Boundary: pure functions over `unknown` JSON plus the pack catalogue. Fetching a pack, reading
 * localStorage, calling `backupSvc`/`syncSvc` and touching the DOM all stay in the wiring.
 * @module services/ui/settings-deploy
 */

/** A message in the catalog: `key` plus interpolation params (params may nest descriptors). */
export interface Copy {
  readonly key: string;
  readonly params?: Record<string, unknown>;
}

/** unknown JSON → plain-object view; null, arrays and scalars become an empty object. */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  }
  return out;
}

/** One selectable deploy pack: the served file and the label shown before it is fetched. */
export interface DeployPackRef {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly target: string;
  readonly profile: string;
}

/**
 * Catalogue of packs shipped under `public/deploy/` (generated from `deploy/*.json` by
 * `deploy/publish.mjs`). Deliberately tiny: the card fetches the chosen pack for its inputs and
 * steps, so this table only needs what the selector renders before that fetch. `label` is a product
 * name (Cloudflare Worker / VPS · Docker), not UI prose, so it stays untranslated by design.
 */
export const DEPLOY_PACK_CATALOG: readonly DeployPackRef[] = [
  { id: "cloudflare", label: "Cloudflare Worker", file: "/deploy/cloudflare.json", target: "cloudflare", profile: "account" },
  { id: "vps-docker", label: "VPS / Docker", file: "/deploy/vps-docker.json", target: "vps", profile: "selfhost" },
];

/** Storage keys the wiring owns: previous host, pending host, latest choice, run state. */
export const DEPLOY_STORAGE_KEYS = {
  host: "cfw_host_id_v1",
  pending: "cfw_host_pending_v1",
  choice: "cfw_host_choice_v1",
  hostConfig: "cfw_host_config_v1",
  runState: "cfw_deploy_state_v1",
  lastRun: "cfw_deploy_last_v1",
};

/** Profile label used inside the capability line; the four ids come from the runtime manifest. */
export function deployProfileCopy(profile: unknown): Copy {
  if (profile === "account") return { key: "settings.deploy.profile.account" };
  if (profile === "desktop") return { key: "settings.deploy.profile.desktop" };
  if (profile === "selfhost") return { key: "settings.deploy.profile.selfhost" };
  return { key: "settings.deploy.profile.guest" };
}

/** "profile: guest · capabilities: chat, search" — one line under the card title. */
export function capabilityCopy(manifest: unknown): Copy {
  if (!manifest || typeof manifest !== "object") return { key: "settings.deploy.manifestPending" };
  const record = recOf(manifest);
  const profile = typeof record.profile === "string" ? record.profile : "guest";
  const caps = recOf(record.capabilities);
  const on: string[] = [];
  for (const key of Object.keys(caps)) if (caps[key] === true) on.push(key);
  return {
    key: "settings.deploy.capability.line",
    params: {
      profile: deployProfileCopy(profile),
      caps: on.length ? on.join(", ") : { key: "settings.deploy.capability.none" },
    },
  };
}

/** The confirm preview: one descriptor per line, rendered by the wiring and joined with "\n". */
export function formatPlanLines(entries: unknown): Copy[] {
  if (!Array.isArray(entries) || !entries.length) return [{ key: "settings.deploy.plan.empty" }];
  const out: Copy[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = recOf(entries[i]);
    const index = String(i + 1).padStart(2, " ");
    const title = typeof entry.title === "string" ? entry.title : String(entry.stepId || "");
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    out.push({ key: "settings.deploy.plan.line", params: { index: index, title: title, kind: kind } });
    if (typeof entry.skipped === "string" && entry.skipped) {
      out.push({ key: "settings.deploy.plan.skipped", params: { reason: entry.skipped } });
      continue;
    }
    if (typeof entry.preview === "string" && entry.preview) out.push({ key: "settings.deploy.plan.preview", params: { text: entry.preview } });
    if (typeof entry.inverse === "string" && entry.inverse) out.push({ key: "settings.deploy.plan.inverse", params: { text: entry.inverse } });
    if (typeof entry.note === "string" && entry.note) out.push({ key: "settings.deploy.plan.note", params: { text: entry.note } });
  }
  return out;
}

/** A run outcome: the sentence plus the raw error text the wiring appends with `outcome.detail`. */
export interface OutcomeCopy {
  readonly base: Copy;
  /** "" when the outcome carries no error; otherwise the first error's message. */
  readonly detail: string;
}

/** Human outcome for a run result; unknown shapes answer a neutral line. */
export function deployOutcomeCopy(result: unknown): OutcomeCopy {
  if (!result || typeof result !== "object") return { base: { key: "settings.deploy.outcome.none" }, detail: "" };
  const record = recOf(result);
  const reason = typeof record.stopReason === "string" ? record.stopReason : "";
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError = errors.length ? String(recOf(errors[0]).message || "") : "";
  if (reason === "done") return { base: { key: "settings.deploy.outcome.done" }, detail: "" };
  if (reason === "dry_run") return { base: { key: "settings.deploy.outcome.dryRun" }, detail: "" };
  if (reason === "aborted") return { base: { key: "settings.deploy.outcome.aborted" }, detail: "" };
  if (reason === "verify_failed") return { base: { key: "settings.deploy.outcome.verifyFailed" }, detail: firstError };
  if (reason === "step_failed") return { base: { key: "settings.deploy.outcome.stepFailed" }, detail: firstError };
  if (reason === "invalid") return { base: { key: "settings.deploy.outcome.invalid" }, detail: firstError };
  if (reason) return { base: { key: "settings.deploy.outcome.other", params: { reason: reason } }, detail: firstError };
  return { base: { key: "settings.deploy.outcome.otherUnknown" }, detail: firstError };
}

/** The three first-connect choices, in the order the requirement lists them. */
export interface FirstConnectChoiceView {
  readonly id: "local" | "host" | "merge";
  readonly title: Copy;
  readonly detail: Copy;
  readonly requiresBackup: boolean;
  readonly destructive: boolean;
}

export interface FirstConnectView {
  readonly show: boolean;
  readonly title: Copy;
  /** null when there is nothing to warn about. */
  readonly warning: Copy | null;
  readonly options: readonly FirstConnectChoiceView[];
}

const FIRST_CONNECT_COPY: readonly { id: "local" | "host" | "merge"; titleKey: string; detailKey: string }[] = [
  {
    id: "local",
    titleKey: "settings.deploy.firstConnect.localTitle",
    detailKey: "settings.deploy.firstConnect.localDetail",
  },
  {
    id: "host",
    titleKey: "settings.deploy.firstConnect.hostTitle",
    detailKey: "settings.deploy.firstConnect.hostDetail",
  },
  {
    id: "merge",
    titleKey: "settings.deploy.firstConnect.mergeTitle",
    detailKey: "settings.deploy.firstConnect.mergeDetail",
  },
];

/**
 * Turn the core plan into card copy. `show` is false unless the core says this is a different
 * host; an unknown-host warning is shown only when the core could not identify the current host.
 */
export function firstConnectView(plan: unknown): FirstConnectView {
  const record = recOf(plan);
  const warningCode = typeof record.warning === "string" ? record.warning : "";
  let warning: Copy | null = null;
  if (warningCode === "backup_missing") warning = { key: "settings.deploy.firstConnect.warning.backupMissing" };
  else if (warningCode === "host_unknown") warning = { key: "settings.deploy.firstConnect.warning.hostUnknown" };
  const show = record.isNewHost === true;
  const options: FirstConnectChoiceView[] = [];
  for (let i = 0; i < FIRST_CONNECT_COPY.length; i++) {
    const copy = FIRST_CONNECT_COPY[i];
    options.push({
      id: copy.id,
      title: { key: copy.titleKey },
      detail: { key: copy.detailKey },
      requiresBackup: true,
      destructive: copy.id !== "merge",
    });
  }
  return {
    show: show,
    title: { key: "settings.deploy.firstConnect.title" },
    warning: warning,
    options: options,
  };
}

/** One of the first-connect choice titles, for the toast/audit record; null for an unknown id. */
export function firstConnectChoiceCopy(id: unknown): Copy | null {
  for (let i = 0; i < FIRST_CONNECT_COPY.length; i++) {
    if (FIRST_CONNECT_COPY[i].id === id) return { key: FIRST_CONNECT_COPY[i].titleKey };
  }
  return null;
}

/** Does the current manifest allow the deploy card to run? */
export function deployAllowed(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const caps = recOf(recOf(manifest).capabilities);
  return caps.deploy === true;
}
