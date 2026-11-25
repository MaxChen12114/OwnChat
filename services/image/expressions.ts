/**
 * Expression pack: re-renders the active character's base image once per expression, changing only
 * the face. Every run goes through the chat-image edit port, which is also what files the result
 * into the local gallery — this module never talks to a provider and keeps no image state.
 *
 * The presets double as the UI's button list and the generation queue, so their order is the order
 * the pack is produced in. Editing instructions are English because the edit model is prompted in
 * it; only the keys (labels) are user-facing.
 * @module services/image/expressions
 */

export interface ExpressionPreset {
  /** Label shown on the button and on the thumbnail caption; also the key callers pass to generate. */
  key: string;
  /** Appended to the edit instruction. */
  en: string;
}

export const EXPRESSION_PRESETS: ExpressionPreset[] = [
  { key: "开心", en: "a happy bright cheerful smile" },
  { key: "害羞", en: "a shy bashful expression with a light blush" },
  { key: "生气", en: "an angry annoyed expression with a slight pout" },
  { key: "惊讶", en: "a surprised expression with wide open eyes" },
  { key: "难过", en: "a sad sorrowful downcast expression" },
  { key: "微笑", en: "a gentle soft warm smile" }
];

const EXPRESSION_PREFIX =
  "Keep the SAME person, identical pose, outfit, hairstyle, camera framing and background from the source image. Change ONLY the facial expression to ";
const EXPRESSION_SUFFIX = ". consistent character, natural, high quality.";

/** Edit instruction for one expression. Pose, outfit and framing are pinned in the prefix: an
 * instruction that only names the expression drifts the whole frame. */
export function expressionInstruction(en: string): string {
  return EXPRESSION_PREFIX + en + EXPRESSION_SUFFIX;
}

export interface ExpressionEditArg {
  characterId: string;
  instruction: string;
}

export interface ExpressionPorts {
  /** False when the chat-image edit module is not loaded; nothing is started in that case. */
  hasEdit(): boolean;
  /** One edited image. Resolves to the provider payload; `imageUrl` is read off it. */
  edit(arg: ExpressionEditArg): Promise<unknown>;
  /** The active card, or null. Dynamic JSON — every field is read defensively. */
  activeCard(): unknown;
  /** Progress text for the settings card. Wording is decided here, rendering is the wiring's job. */
  status(msg: string): void;
  /** One finished image, called before the status line is updated. */
  onResult(key: string, url: string): void;
}

export interface Expressions {
  /** Resolves to the image URL, or null for an unknown key, a missing edit module, an empty result
   * or a rejection. Failures are reported through {@link ExpressionPorts.status}, never thrown. */
  generate(exprKey?: unknown): Promise<string | null>;
  /** Runs the whole pack in preset order, one image at a time, and does not stop on failures. The
   * closing status line is written even when every run failed — that is what the card always did. */
  generateAll(): Promise<void>;
  readonly list: ExpressionPreset[];
}

function recOf(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && e.message) return String(e.message);
  return String(e);
}

/** Character id for the edit call; the gallery files results under it. */
function activeCharId(card: Record<string, unknown>): string {
  const id = card.id;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && id !== 0 && Number.isFinite(id)) return String(id);
  return "default";
}

export function createExpressions(ports: ExpressionPorts): Expressions {
  /** A port that throws is treated as "no card": a broken bridge must not take down the button. */
  function activeCard(): Record<string, unknown> {
    try {
      return recOf(ports.activeCard());
    } catch (e) {
      return {};
    }
  }

  function presetFor(key: unknown): ExpressionPreset | null {
    return (
      EXPRESSION_PRESETS.filter(function (e) {
        return e.key === key;
      })[0] || null
    );
  }

  async function generate(exprKey?: unknown): Promise<string | null> {
    const item = presetFor(exprKey);
    if (!item) return null;
    if (!ports.hasEdit()) {
      ports.status("发图模块未就绪，无法生成");
      return null;
    }
    ports.status("正在生成「" + item.key + "」…（首次无基准图会先造一张，约 30-45s）");
    try {
      const res = recOf(
        await ports.edit({
          characterId: activeCharId(activeCard()),
          instruction: expressionInstruction(item.en)
        })
      );
      const url = strOf(res.imageUrl);
      if (url) {
        ports.onResult(item.key, url);
        ports.status("「" + item.key + "」已生成，已存入本地画廊");
        return url;
      }
      ports.status("「" + item.key + "」未返回结果");
    } catch (e) {
      ports.status("生成失败:" + errText(e));
    }
    return null;
  }

  async function generateAll(): Promise<void> {
    for (let i = 0; i < EXPRESSION_PRESETS.length; i++) {
      await generate(EXPRESSION_PRESETS[i].key);
    }
    ports.status("全套表情已生成完毕，去本地画廊查看/管理");
  }

  return { generate, generateAll, list: EXPRESSION_PRESETS };
}
