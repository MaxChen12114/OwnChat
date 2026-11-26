/**
 * First-run decisions: what the host setup wizard asks for, in what order, and when it may stay closed.
 *
 * The wizard is three facts, not three pages: an admin password (the sidecar's access gate), a model
 * key (so a chat can actually leave the machine), and the cloud-sync switch (optional, and only
 * meaningful on a host others also reach). This module owns the *decisions* — should it show, which
 * steps are still blocking, what is a usable key, how a probe result reads — and the wiring owns the
 * DOM. Copy is Chinese because the i18n dictionary is keyed by the rendered string; translating
 * happens in the dictionary, not here.
 *
 * Storage split, deliberately: the "already seen" flag lives in the native KV (`ownchat` namespace,
 * via the storage port), while the two values that existing code reads keep their old homes
 * (`cfw_auth_token_v1` in localStorage via authSvc, `cfw_sync_enabled_v1` in localStorage). Moving
 * those readers is T3-D/T4-A work; writing two sources would be the split-brain this repo avoids.
 *
 * `modelKeySaved` is the only wizard-local fact: the provider registry has no "this key came from the
 * wizard" marker, and inferring it from "any custom provider exists" would hide the step from users
 * who tried one and it failed.
 * @module services/platform/oobe
 */

/** Host namespaces and legacy keys the wizard reads or writes. */
export const OOBE_NS = "host";
export const OOBE_DONE_KEY = "oobe_done_v1";
export const OOBE_MODEL_KEY = "oobe_model_key_v1";
export const ACCESS_TOKEN_KEY = "cfw_auth_token_v1";
export const SYNC_ENABLED_KEY = "cfw_sync_enabled_v1";

/** Defaults for the model-key step (a DeepSeek-compatible endpoint; editable by the user). */
export const DEFAULT_MODEL_ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
export const DEFAULT_MODEL_ID = "deepseek-chat";

export type HostHealth = "ok" | "down" | "unknown";

/** What the wiring observed; nothing here is derived from DOM state. */
export interface OobeState {
  readonly shell: boolean;
  readonly health: HostHealth;
  readonly hasToken: boolean;
  readonly modelKeySaved: boolean;
  readonly syncOn: boolean;
  /** The user pressed 完成 at least once (native KV flag). */
  readonly done: boolean;
}

/** One row in the dialog. `blocking` steps gate the 完成 button. */
export interface OobeStepView {
  readonly id: "password" | "modelKey" | "sync";
  readonly title: string;
  readonly done: boolean;
  readonly blocking: boolean;
  readonly status: string;
}

/** `POST /api/unlock` outcome, mirroring services/auth/token.ts (401 = wrong, 500 = store unbound). */
export interface PasswordVerdict {
  readonly ok: boolean;
  readonly message: string;
}

/** A usable model-key submission, or the reason it is not usable. */
export interface ModelKeyPlan {
  readonly ok: boolean;
  readonly error: string;
  readonly name: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Show the wizard when the desktop host is not actually usable yet.
 *
 * A logged-in, key-bearing, healthy host with the flag set stays out of the way; anything else gets a
 * dialog. On the web this never shows: there is no local host to configure (the deployment is the
 * host), and a "paste your admin password" prompt would be the wrong shape there.
 */
export function shouldShow(state: OobeState): boolean {
  if (!state.shell) return false;
  if (!state.done) return true;
  return !state.hasToken || !state.modelKeySaved || state.health === "down";
}

/** The three rows, in the order the dialog renders them. */
export function buildSteps(state: OobeState): OobeStepView[] {
  return [
    {
      id: "password",
      title: "管理员密码",
      done: state.hasToken,
      blocking: true,
      status: state.hasToken ? "已登录" : "需要管理员密码",
    },
    {
      id: "modelKey",
      title: "模型 Key",
      done: state.modelKeySaved,
      blocking: true,
      status: state.modelKeySaved ? "已保存" : "未设置",
    },
    {
      id: "sync",
      title: "同步",
      done: true,
      blocking: false,
      status: state.syncOn ? "已开启" : "关闭",
    },
  ];
}

/** Whether 完成 may close the dialog (optional steps never block). */
export function isComplete(state: OobeState): boolean {
  return state.hasToken && state.modelKeySaved;
}

/** `/config.js` probe result: a 2xx with the OwnChat marker is healthy. */
export function judgeHealth(status: number, bodyHasMarker: boolean): HostHealth {
  if (status >= 200 && status < 300 && bodyHasMarker) return "ok";
  return "down";
}

/** `POST /api/unlock` judgement. Kept in step with services/auth/token.ts. */
export function judgePassword(status: number): PasswordVerdict {
  if (status === 401) return { ok: false, message: "密码错误" };
  if ((status >= 200 && status < 300) || status === 500) return { ok: true, message: "" };
  return { ok: false, message: "网络异常（HTTP " + String(status) + "），请稍后重试" };
}

/**
 * Validate the model-key step. The endpoint must be absolute (a bare host would silently become a
 * page-relative path — the same failure normalizeBase refuses), the model id must be non-empty, and
 * the key must look like a key rather than a placeholder.
 */
export function planModelKey(input: unknown): ModelKeyPlan {
  const rec = isRecord(input) ? input : {};
  const endpoint = (typeof rec.endpoint === "string" && rec.endpoint.trim()) || DEFAULT_MODEL_ENDPOINT;
  const model = (typeof rec.model === "string" && rec.model.trim()) || DEFAULT_MODEL_ID;
  const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
  const name = (typeof rec.name === "string" && rec.name.trim()) || "首次设置的模型";
  const fail = (error: string): ModelKeyPlan => ({ ok: false, error: error, name: name, endpoint: endpoint, model: model, apiKey: "" });
  if (!/^https?:\/\//i.test(endpoint)) return fail("服务地址要以 http:// 或 https:// 开头");
  if (!apiKey) return fail("请填写 API Key");
  if (apiKey.length < 8) return fail("API Key 太短，请检查是否复制完整");
  if (/\s/.test(apiKey)) return fail("API Key 里不能有空格");
  return { ok: true, error: "", name: name, endpoint: endpoint.replace(/\/+$/, ""), model: model, apiKey: apiKey };
}

/** The localStorage value the sync engine reads (`=== "1"` is the only on-state). */
export function syncValue(on: boolean): "1" | "0" {
  return on ? "1" : "0";
}

/** Parse the `host` namespace JSON blobs without letting a corrupt value crash the dialog. */
export function readFlag(raw: string | null): boolean {
  return typeof raw === "string" && raw === "1";
}
