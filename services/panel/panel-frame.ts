/**
 * The security half of the content-canvas iframe host: which sandbox a payload gets, and the message
 * envelope the frame speaks.
 *
 * Three modes, and the difference between them is the whole point:
 *   trusted     own plugins      `allow-scripts allow-same-origin allow-forms`
 *   host-html   agent-generated  `srcdoc` + **only** `allow-scripts`
 *   external    third-party URL  `allow-scripts allow-same-origin allow-forms` + `no-referrer`
 *
 * `host-html` must never gain `allow-same-origin`. Scripts plus same-origin makes the sandbox
 * meaningless: the framed script can read `window.parent.localStorage`, which holds API keys, role
 * cards and every conversation. An opaque origin still allows canvas, fetch and events — it only
 * severs the parent. For the same reason generated HTML is rendered through `srcdoc`, never a
 * `blob:` URL: `blob:` inherits the creator's origin, so it would be same-origin by construction.
 *
 * The mode is inferred from the payload, not from the caller: any non-empty `html` means `host-html`.
 * The original default (trusted) both handed generated content same-origin rights and, because the
 * trusted branch only sets `src`, silently rendered nothing at all.
 *
 * Mounting, timers, theme reading and the frame element itself stay in `tooling/l0/wiring/panel-frame.js`.
 * One pane = one box element; the tab host owns those boxes, so `mount` never has to know how many
 * frames exist. Background panes stay mounted but are told to pause:
 * `{__panel:1,type:"visibility",data:{visible:false}}` is the freeze signal, and a page that ignores
 * it is destroyed by the host's live-frame cap rather than trusted to behave.
 *
 * Lock: `test/panel-frame.test.mjs` (written with the migration, run against both implementations)
 * and `test/tab-state.test.mjs` for the visibility envelope.
 * @module services/panel/panel-frame
 */

export type PanelMode = "trusted" | "host-html" | "external";

export interface PanelFrameSpec {
  url?: unknown;
  html?: unknown;
  text?: unknown;
  title?: unknown;
  mode?: unknown;
}

export interface SandboxAttrs {
  sandbox: string;
  /** `null` means the attribute must not be set at all. */
  referrerpolicy: string | null;
}

export interface PanelEnvelope {
  __panel: number;
  from: string;
  type: string;
  data: Record<string, unknown>;
  at: number;
}

export const PANEL_FRAME_VERSION = 1;
export const PANEL_HOST_ORIGIN = "panel-host";
/** The freeze/resume message type sent to every pane whose visibility changes. */
export const PANEL_MSG_VISIBILITY = "visibility";
/** The function-name call the agent's `stage_call` reaches a page with. */
export const PANEL_MSG_CALL = "call";

const PANEL_SANDBOX_SCRIPT_ONLY = "allow-scripts";
const PANEL_SANDBOX_OWN = "allow-scripts allow-same-origin allow-forms";

/**
 * Injected into every framed page so `stage_call` works without the page author doing anything.
 * A real page was written that skipped this and every call timed out after 15 s, with the agent
 * misdiagnosing it as a cross-origin problem.
 */
export const PANEL_BOOTSTRAP =
  "(function(){if(window.__stageCall)return;window.__stageCall=1;" +
  "window.addEventListener('message',function(e){var d=e.data;" +
  "if(!d||d.__panel!==1||d.type!=='call')return;" +
  "var id=d.data&&d.data.id,fn=d.data&&d.data.fn;" +
  "var r=function(ok,v){try{parent.postMessage({__panel:1,type:'call-result',data:{id:id,ok:ok,result:ok?v:undefined,error:ok?undefined:String((v&&v.message)||v)}},'*')}catch(_e){}};" +
  "var f=window.__stage&&window.__stage[fn];" +
  "if(typeof f!=='function')return r(false,'这个页面没有注册函数「'+fn+'」。可用：'+(Object.keys(window.__stage||{}).join(' / ')||'（无）'));" +
  "try{var a=d.data.args,o=f.apply(null,(a==null)?[]:(Array.isArray(a)?a:[a]));" +
  "if(o&&typeof o.then==='function')o.then(function(x){r(true,x)},function(er){r(false,er)});else r(true,o)}catch(er){r(false,er)}" +
  "});})();";

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

/** True when the payload is plain text with no url and no html — rendered as `<pre>`, no iframe. */
export function isTextOnlySpec(spec: unknown): boolean {
  const s = recOf(spec);
  return s.text != null && !s.url && s.html == null;
}

/**
 * Picks the security mode.
 * @returns an explicit valid `mode` if the caller gave one, otherwise `host-html` for any non-empty
 * `html` and `trusted` for everything else.
 */
export function inferPanelMode(spec: unknown): PanelMode {
  const s = recOf(spec);
  const m = s.mode;
  if (m === "host-html" || m === "external" || m === "trusted") return m;
  const hasHtml = s.html != null && text(s.html) !== "";
  return hasHtml ? "host-html" : "trusted";
}

/**
 * The sandbox attributes for a mode.
 * @returns the `sandbox` value plus `referrerpolicy` (`null` = do not set). `host-html` is the only
 * mode that gets `allow-scripts` alone; adding `allow-same-origin` there would defeat the sandbox.
 */
export function panelSandbox(mode: PanelMode): SandboxAttrs {
  if (mode === "host-html") return { sandbox: PANEL_SANDBOX_SCRIPT_ONLY, referrerpolicy: null };
  if (mode === "external") return { sandbox: PANEL_SANDBOX_OWN, referrerpolicy: "no-referrer" };
  return { sandbox: PANEL_SANDBOX_OWN, referrerpolicy: null };
}

/** Message envelope. The `__panel` version field keeps old plugin messages from being misread. */
export function panelEnvelope(type: string, data?: unknown, at?: number): PanelEnvelope {
  return {
    __panel: PANEL_FRAME_VERSION,
    from: PANEL_HOST_ORIGIN,
    type: type,
    data: recOf(data),
    at: typeof at === "number" ? at : Date.now(),
  };
}

/**
 * The pause/resume signal for a background pane.
 * @returns the exact envelope the bootstrap and page authors read: `visible:false` means "you are
 * not on screen — stop animations and timers"; `visible:true` is sent on every activation so a
 * page has a single resume path instead of guessing from resize events.
 */
export function visibilityEnvelope(visible: unknown): PanelEnvelope {
  return panelEnvelope(PANEL_MSG_VISIBILITY, { visible: visible === true }, undefined);
}

/** The srcdoc body for `host-html`: the bootstrap first, then the payload verbatim. */
export function panelSrcDoc(html: unknown): string {
  return "<script>" + PANEL_BOOTSTRAP + "</scr" + "ipt>" + text(html);
}
