/**
 * What the image workshop decides before it touches the page: the resolution table, the two request
 * shapes (text-to-image and edit), the status strings that go into the badge, and the file name a
 * finished picture is downloaded as.
 *
 * The workshop is a modal with two forms, and almost all of it is markup. What is not markup is the
 * ordering below, and each step has cost real money or real minutes when it was wrong:
 *  - The site preset needs a key before a request goes out. Asking first turns "generation failed"
 *    into "fill in the key", and no request is billed.
 *  - The edit path needs a channel that can edit, at least one source image, a prompt, and one task
 *    type. The original form let the last one through empty and the provider answered with a
 *    generic 400 that took a while to read.
 *  - Polling is slow by nature (an edit takes minutes), so the status carries the attempt number and
 *    says out loud that waiting is normal. A silent badge was read as a hang.
 *
 * Numbers are clamped here rather than trusted from the inputs: they are number fields a user can
 * type into, and `parseInt("")` is NaN, not 1.
 * @module services/image/embed
 */

export interface Resolution {
  key: string;
  width: number;
  height: number;
}

/** The choices offered in the resolution select, in the order the select shows them. */
export const RESOLUTIONS: Resolution[] = [
  { key: "1:1 (2048x2048)", width: 2048, height: 2048 },
  { key: "1:1 (1024x1024)", width: 1024, height: 1024 },
  { key: "3:4 (768x1024)", width: 768, height: 1024 },
  { key: "4:3 (1024x768)", width: 1024, height: 768 },
  { key: "16:9 (1024x576)", width: 1024, height: 576 },
  { key: "9:16 (576x1024)", width: 576, height: 1024 },
];

/**
 * 1024 rather than the 2048 entry that sorts first: the square 2048 costs four times as much per
 * picture, and it is the first thing a new user would trigger by pressing the button.
 */
export const DEFAULT_RESOLUTION = "1:1 (1024x1024)";

/** Task types the edit endpoint accepts. */
export const EDIT_TASK_TYPES = ["id", "style", "pose", "layout", "color", "background"];

/** Pre-ticked boxes: keeping the subject and the style is what "edit this picture" usually means. */
export const EDIT_DEFAULT_TYPES: Record<string, number> = { id: 1, style: 1 };

export const DEFAULT_TEXT_MODEL = "z-image-turbo";
export const DEFAULT_EDIT_MODEL = "Qwen-Image-Edit-2511";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * Integer field with a fallback. A blank or non-numeric field is the default, not `Math.max(lo, NaN)`.
 */
export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = parseInt(String(v), 10);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

export function clampFloat(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = parseFloat(String(v));
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** `WxH` for a resolution key; unknown keys fall back to the default entry, not to NaN. */
export function sizeOf(key: string): string {
  const found = RESOLUTIONS.filter((r) => r.key === key)[0];
  const r = found || RESOLUTIONS[1];
  return r.width + "x" + r.height;
}

/** `YYYYMMDD_HHMMSS` in local time, used only to keep download names apart. */
export function stampOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => (n < 10 ? "0" + n : String(n));
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** `gen-<stamp>-<index>.png` for a batch, `edit-<stamp>.png` for a single edit result. */
export function fileName(kind: "gen" | "edit", stamp: string, index?: number): string {
  if (kind === "edit") return "edit-" + stamp + ".png";
  return "gen-" + stamp + "-" + (index || 1) + ".png";
}

export interface ChannelOption {
  id: string;
  label: string;
}

export interface ChannelChoices {
  options: ChannelOption[];
  value: string;
}

/**
 * Rows for the channel select. The active channel wins only when it survives the filter — opening
 * the edit tab on a text-only channel must not leave the select claiming it, so the first eligible
 * row is picked instead and the caller stores nothing.
 */
export function channelChoices(
  list: unknown,
  activeId: string,
  onlyEdit: boolean,
  hasEdit: (ch: unknown) => boolean
): ChannelChoices {
  const all = Array.isArray(list) ? list.slice() : [];
  const kept = onlyEdit ? all.filter((ch) => !!hasEdit(ch)) : all;
  const options = kept.map((ch) => {
    const c = recOf(ch);
    return {
      id: str(c.id),
      label: str(c.name) + (str(c.kind) === "comfyui" ? "（本地）" : ""),
    };
  });
  const wanted = options.filter((o) => o.id === activeId)[0];
  return { options: options, value: wanted ? wanted.id : options[0] ? options[0].id : "" };
}

export interface ModelChoices {
  options: string[];
  value: string;
}

/**
 * Rows for the model select. `preferred` is prepended when the channel's list does not carry it yet:
 * a channel can be saved with a model the list predates, and dropping it would silently switch the
 * model on the next run.
 */
export function modelChoices(models: unknown, preferred: string): ModelChoices {
  const list = arrOf(models).slice();
  const want = str(preferred);
  if (want && list.indexOf(want) < 0) list.unshift(want);
  return { options: list, value: want || (list[0] || "") };
}

export interface TextPlan {
  prompt: string;
  n: number;
  size: string;
  model: string;
  channelName: string;
  /** Badge text while the request is in flight. */
  status: string;
}

export interface TextPlanResult {
  error: string;
  plan: TextPlan | null;
}

export interface TextInput {
  channel: unknown;
  /** Whether the current channel already has its own key, or the site preset's key is set. */
  hasKey: boolean;
  prompt: string;
  n: unknown;
  resolutionKey: string;
  /** What the model select shows; empty means "whatever the channel defaults to". */
  model: string;
}

/**
 * The text-to-image request. The key check comes first and only applies to the site transport: a
 * direct endpoint without a key would fail upstream with a 401 the badge could not explain, while a
 * local ComfyUI channel needs no key at all.
 */
export function planText(input: TextInput): TextPlanResult {
  const ch = recOf(input.channel);
  if (str(ch.kind) === "openai" && str(ch.transport) === "site" && !input.hasKey) {
    return { error: "请先在 设置 → 模型 API → 图像渠道 填写当前渠道的 Key", plan: null };
  }
  const prompt = str(input.prompt).trim();
  if (!prompt) return { error: "请输入提示词", plan: null };
  const n = clampInt(input.n, 1, 4, 1);
  const size = sizeOf(input.resolutionKey);
  const model = str(input.model) || str(ch.model) || DEFAULT_TEXT_MODEL;
  const name = str(ch.name) || "默认渠道";
  return {
    error: "",
    plan: { prompt: prompt, n: n, size: size, model: model, channelName: name, status: "文生图 生成中…（" + name + " / " + model + "）" },
  };
}

/** The meta line under a finished batch item: channel, model, size, n. */
export function textMeta(plan: TextPlan): string {
  return "渠道=" + plan.channelName + "，模型=" + plan.model + "，size=" + plan.size + "，n=" + plan.n;
}

export interface EditPlan {
  model: string;
  steps: number;
  guidance: number;
  taskTypes: string[];
  channelName: string;
  status: string;
}

export interface EditPlanResult {
  error: string;
  plan: EditPlan | null;
}

export interface EditInput {
  channel: unknown;
  /** Whether the selected channel can edit at all. */
  canEdit: boolean;
  hasImage: boolean;
  prompt: string;
  taskTypes: string[];
  steps: unknown;
  guidance: unknown;
  model: string;
}

/**
 * The edit request. The four refusals are ordered the way the form is filled top to bottom, so the
 * message points at the first thing that is still missing rather than the last.
 */
export function planEdit(input: EditInput): EditPlanResult {
  const ch = recOf(input.channel);
  if (!input.canEdit) {
    return {
      error: "当前渠道不支持改图：请在设置里选择带站点代理的 OpenAI 兼容渠道（Gitee 预设）",
      plan: null,
    };
  }
  const prompt = str(input.prompt).trim();
  if (!input.hasImage || !prompt) return { error: "请至少上传 1 张图片并输入提示词", plan: null };
  const types = Array.isArray(input.taskTypes) ? input.taskTypes.filter((t) => typeof t === "string") : [];
  if (!types.length) return { error: "至少选择一个 task_type", plan: null };
  const steps = clampInt(input.steps, 1, 50, 4);
  const guidance = clampFloat(input.guidance, 0, 10, 1.0);
  const model = str(input.model) || str(ch.editModel) || DEFAULT_EDIT_MODEL;
  const name = str(ch.name) || "默认渠道";
  return {
    error: "",
    plan: {
      model: model,
      steps: steps,
      guidance: guidance,
      taskTypes: types,
      channelName: name,
      status: "改图 创建任务…（" + name + " / " + model + "）",
    },
  };
}

/**
 * Badge text between two polls. The attempt count is the point: an edit legitimately takes minutes,
 * and a badge that only said "processing" was read as a frozen page.
 */
export function editTick(tick: number, upstream: string): string {
  return "改图 轮询中… 第 " + tick + " 次检查（" + (upstream || "处理中") + "），正常等待并非卡死";
}

/** The meta line under an edit result: channel, model, task prefix, image count, task types. */
export function editMeta(plan: EditPlan, taskId: string, twoImages: boolean): string {
  return (
    "渠道=" + plan.channelName +
    "，模型=" + plan.model +
    "，task=" + taskId.slice(0, 8) +
    "，" + (twoImages ? "2 图" : "1 图") +
    "，" + plan.taskTypes.join("+")
  );
}

export interface EditFailure {
  status: string;
  badge: string;
  title: string;
}

/**
 * A failed edit. A user-initiated cancel is not an error: it gets the neutral badge and a title that
 * says so, because the poll had already been running for minutes before the user gave up on it.
 */
export function editFailure(aborted: boolean): EditFailure {
  if (aborted) return { status: "改图 已取消", badge: "info", title: "改图已取消" };
  return { status: "改图 失败", badge: "err", title: "改图失败" };
}

/** The edit result had no `file_url`: success from the provider, nothing to show. */
export function editNoFile(): EditFailure {
  return { status: "改图 无 file_url", badge: "err", title: "成功但无 file_url" };
}
