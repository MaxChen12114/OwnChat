/**
 * Deploy settings card: the pack catalogue, the first-connect copy and the result/preview
 * formatting shared by the card and the first-connect notice.
 *
 * Why the copy lives here instead of in `core/runtime-manifest.ts`: the core module decides
 * (whether a host is new, which choice is destructive, whether a backup is required); this module
 * turns ids and warning codes into Chinese sentences. That keeps the core free of UI strings and
 * leaves the dictionary as the only translation surface.
 *
 * Boundary: pure functions over `unknown` JSON plus the pack catalogue. Fetching a pack, reading
 * localStorage, calling `backupSvc`/`syncSvc` and touching the DOM all stay in the wiring.
 * @module services/ui/settings-deploy
 */

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
 * steps, so this table only needs what the selector renders before that fetch.
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

/** Profile labels used in the card header; the four ids come from the runtime manifest. */
export function deployProfileLabel(profile: unknown): string {
  if (profile === "account") return "account（已登录）";
  if (profile === "desktop") return "desktop（桌面本机）";
  if (profile === "selfhost") return "selfhost（自托管）";
  return "guest（访客）";
}

/** "profile: guest · 能力: chat, search" — one line under the card title. */
export function capabilityLine(manifest: unknown): string {
  if (!manifest || typeof manifest !== "object") return "运行时 manifest 尚未加载";
  const record = recOf(manifest);
  const profile = typeof record.profile === "string" ? record.profile : "guest";
  const caps = recOf(record.capabilities);
  const on: string[] = [];
  for (const key of Object.keys(caps)) if (caps[key] === true) on.push(key);
  return "profile：" + deployProfileLabel(profile) + " · 能力：" + (on.length ? on.join(", ") : "无");
}

/** "1. title [kind]\n   preview\n   回滚：..." for the confirm preview. */
export function formatPlan(entries: unknown): string {
  if (!Array.isArray(entries) || !entries.length) return "（没有可预览的步骤）";
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = recOf(entries[i]);
    const index = String(i + 1).padStart(2, " ");
    const title = typeof entry.title === "string" ? entry.title : String(entry.stepId || "");
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (typeof entry.skipped === "string" && entry.skipped) {
      lines.push(index + ". " + title + " [" + kind + "]");
      lines.push("    （跳过：" + entry.skipped + "）");
      continue;
    }
    lines.push(index + ". " + title + " [" + kind + "]");
    if (typeof entry.preview === "string" && entry.preview) lines.push("    " + entry.preview);
    if (typeof entry.inverse === "string" && entry.inverse) lines.push("    回滚：" + entry.inverse);
    if (typeof entry.note === "string" && entry.note) lines.push("    注意：" + entry.note);
  }
  return lines.join("\n");
}

/** Human outcome for a run result; unknown shapes answer a neutral line. */
export function deployOutcomeText(result: unknown): string {
  if (!result || typeof result !== "object") return "没有收到部署结果";
  const record = recOf(result);
  const reason = typeof record.stopReason === "string" ? record.stopReason : "";
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const firstError = errors.length ? String(recOf(errors[0]).message || "") : "";
  const suffix = firstError ? "：" + firstError : "";
  if (reason === "done") return "部署完成，宿主 profile 已回填。";
  if (reason === "dry_run") return "预览完成（未执行任何步骤）。";
  if (reason === "verify_failed") return "verify 失败，已停止后续步骤" + suffix;
  if (reason === "step_failed") return "步骤失败，已停止" + suffix;
  if (reason === "aborted") return "已取消";
  if (reason === "invalid") return "部署包或输入不合法" + suffix;
  return "部署结束（" + (reason || "未知原因") + "）" + suffix;
}

/** The three first-connect choices, in the order the requirement lists them. */
export interface FirstConnectChoiceView {
  readonly id: "local" | "host" | "merge";
  readonly title: string;
  readonly detail: string;
  readonly requiresBackup: boolean;
  readonly destructive: boolean;
}

export interface FirstConnectView {
  readonly show: boolean;
  readonly title: string;
  readonly warning: string;
  readonly options: readonly FirstConnectChoiceView[];
}

const FIRST_CONNECT_COPY: readonly { id: "local" | "host" | "merge"; title: string; detail: string }[] = [
  {
    id: "local",
    title: "本机为准",
    detail: "保留本机设置与热窗口，下一次同步以本机为准上传；不会删除宿主上的角色卡与记忆（它们本来就在宿主存储里）。",
  },
  {
    id: "host",
    title: "宿主为准",
    detail: "从宿主拉取设置与对话热窗口，覆盖本机这份；角色卡与记忆直接从宿主读取。",
  },
  {
    id: "merge",
    title: "合并",
    detail: "按较新时间合并两边热窗口，冲突不静默覆盖；动手前先自动备份。",
  },
];

/**
 * Turn the core plan into card copy. `show` is false unless the core says this is a different
 * host; an unknown-host warning is shown only when the core could not identify the current host.
 */
export function firstConnectView(plan: unknown): FirstConnectView {
  const record = recOf(plan);
  const warningCode = typeof record.warning === "string" ? record.warning : "";
  const warning = warningCode === "backup_missing"
    ? "备份模块（backupSvc）未就绪：继续不会自动备份。建议先到「设置 → 云同步」导出备份。"
    : warningCode === "host_unknown"
      ? "无法识别当前宿主（缺少 origin），首连选择暂不可用。"
      : "";
  const show = record.isNewHost === true;
  const options: FirstConnectChoiceView[] = [];
  for (let i = 0; i < FIRST_CONNECT_COPY.length; i++) {
    const copy = FIRST_CONNECT_COPY[i];
    options.push({
      id: copy.id,
      title: copy.title,
      detail: copy.detail,
      requiresBackup: true,
      destructive: copy.id !== "merge",
    });
  }
  return {
    show: show,
    title: "检测到新宿主：先选哪边为准",
    warning: warning,
    options: options,
  };
}

/** One-line description of a first-connect choice for the toast/audit record. */
export function firstConnectChoiceLabel(id: unknown): string {
  for (let i = 0; i < FIRST_CONNECT_COPY.length; i++) if (FIRST_CONNECT_COPY[i].id === id) return FIRST_CONNECT_COPY[i].title;
  return String(id || "");
}

/** Does the current manifest allow the deploy card to run? */
export function deployAllowed(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const caps = recOf(recOf(manifest).capabilities);
  return caps.deploy === true;
}
