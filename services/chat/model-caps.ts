/**
 * Model capability decisions: whether the active model can see screenshots.
 *
 * The switch (`cfw_pc_vision_v1`) is explicit when set; otherwise the model id is matched against
 * the known vision families. The model id is user data and may be empty, so the regex is applied to
 * a lowercased string and never assumes a shape.
 * @module services/chat/model-caps
 */

/** PC screenshot vision override. */
export const PC_VISION_KEY = "cfw_pc_vision_v1";

/** Known vision-capable families; the literal list is the contract. */
export const PC_VISION_MODEL_RE = /(deepseek-flash|deepseek-v4|vision|glm-4v|gpt-4o|gemini|claude|qwen[\w.-]*vl)/;

/**
 * @param raw - Stored override (`"1"` on, `"0"` off, anything else unset).
 * @param modelId - Active model id.
 * @returns Whether pc_shot images may be injected as vision input.
 */
export function pcVisionOn(raw: unknown, modelId: unknown): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return PC_VISION_MODEL_RE.test(String(modelId == null ? "" : modelId).toLowerCase());
}
