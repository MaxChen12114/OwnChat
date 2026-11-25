/**
 * Image generation, as one tool: `send_image` gives the user a picture.
 *
 * The 150-second ceiling is the reason this file exists as code rather than as a one-line forward.
 * The image pipeline already has its own timeouts, but a tool that never returns hangs the whole
 * agent loop and leaves the bubble spinning — so there is a hard limit here too, and a timeout is
 * reported as a normal failure the model can retry or explain. Nothing below may await the facade
 * without that race.
 *
 * Two callbacks come from outside, because the tools bundle owns both: the facade (a global looked
 * up per call — the image module is a classic script and may land after this one) and the renderer
 * that puts the returned URL into the transcript.
 *
 * @module services/tools/agent/image
 */

/** Hard ceiling for one generation. Past this the tool fails rather than hanging the loop. */
export const SEND_IMAGE_TIMEOUT_MS = 150000;

export interface ImageFacade {
  sendPhoto(input: { kind?: string; characterId?: unknown; scenePrompt?: unknown }): Promise<unknown>;
}

export interface ImageDeps {
  /** The image pipeline, looked up per call. Null means the module never landed. */
  chatImage(): ImageFacade | null;
  /** Renders the produced URL into the transcript. Missing means render nothing, not fail. */
  onImage?: (url: string, meta: Record<string, unknown>, ctx: unknown) => void;
}

export interface ImageInput {
  type?: unknown;
  scene_prompt?: unknown;
  character_id?: unknown;
}

export interface ImageResult {
  ok: boolean;
  imageUrl?: string;
  error?: string;
}

export interface ImageApi {
  send(input: ImageInput, ctx: unknown): Promise<ImageResult>;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}
function text(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

export function createImageTools(deps: ImageDeps): ImageApi {
  async function send(input: ImageInput, ctx: unknown): Promise<ImageResult> {
    const args = recOf(input);
    const facade = deps.chatImage();
    if (!facade || typeof facade.sendPhoto !== "function") {
      return { ok: false, error: "发图模块未就绪 (image-chat.js / window.__chatImage)" };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error("发图超时(>150s),可能网络不稳或出图服务繁忙"));
      }, SEND_IMAGE_TIMEOUT_MS);
    });

    let res: unknown;
    try {
      res = await Promise.race([
        facade.sendPhoto({
          kind: text(args.type) === "scene" ? "scene" : undefined,
          characterId: args.character_id,
          scenePrompt: args.scene_prompt,
        }),
        deadline,
      ]);
    } catch (e) {
      const err = recOf(e);
      return { ok: false, error: "发图失败: " + text(err.message || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const out = recOf(res);
    const url = text(out.imageUrl);
    if (url && typeof deps.onImage === "function") {
      deps.onImage(url, { type: args.type, taskId: out.taskId }, ctx);
    }
    return url ? { ok: true, imageUrl: url } : { ok: false, error: "发图无返回" };
  }

  return { send };
}
