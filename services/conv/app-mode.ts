/**
 * The top-level "work / role-play" mode, minus the button: the payload the request assembler should
 * get for each mode, the reply-style gate, and how the mode follows a conversation switch.
 *
 * `work` is delivery-oriented: it sends the "assist" prompt profile, skips the role-state layer, and
 * forces the default reply style. Its temperature stabiliser only fills a gap — a temperature the
 * user set in settings is respected, never overwritten.
 *
 * The mode is stored twice on purpose: a global default (`cfw_app_mode_v1`) that new conversations
 * inherit, and a per-conversation `appMode` field that follows the conversation — switching back to a
 * role-play conversation returns to role-play, not to whatever the top bar said last.
 *
 * Deliberately unrelated: the private unlock gate (a different axis), and the agent work loop
 * (`cfw_agent_mode_v1`, a "who drives" axis) — tying either to this button would force every chat
 * through multi-turn tool calls or break the unlock flow.
 * @module services/conv/app-mode
 */

export const APP_MODE_LS_KEY = "cfw_app_mode_v1";
export const META_FIELD = "appMode";
export const MODE_WORK = "work";
export const MODE_RP = "rp";

export function normMode(v: unknown): string {
  return v === MODE_WORK ? MODE_WORK : MODE_RP;
}

export interface PayloadOpts {
  replyStyle?: string;
  stateLayer?: Record<string, unknown>;
  genParams?: Record<string, unknown>;
}

export interface PayloadDecision {
  promptProfile: string;
  replyStyle: string;
  stateLayer: Record<string, unknown>;
  genParams: Record<string, unknown>;
}

/** Request assembly for a mode: the three payload slots decided in one place. */
export function decidePayload(mode: string, opts: PayloadOpts | undefined): PayloadDecision {
  const o = opts || {};
  const isWork = normMode(mode) === MODE_WORK;
  const gen: Record<string, unknown> = {};
  const src = o.genParams || {};
  for (const k of Object.keys(src)) gen[k] = src[k];
  // Work mode adds the stable default only when the user has not set one; an explicit value from the
  // settings card wins.
  if (isWork && gen["temperature"] === undefined) gen["temperature"] = 0.3;
  return {
    promptProfile: isWork ? "assist" : "rp",
    replyStyle: isWork ? "default" : o.replyStyle || "default",
    stateLayer: isWork ? { stateLayer: false } : o.stateLayer || {},
    genParams: gen,
  };
}

export interface ModeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface AppModePorts {
  storage?: ModeStorage;
  activeConvId?: () => string;
  touchConv?: (convId: string, patch: Record<string, unknown>) => void;
  loadConvMeta?: () => Record<string, unknown> | null;
  setIcon?: (el: HTMLElement | null, name: string, label: string) => void;
  emit?: (mode: string) => void;
  button?: () => HTMLElement | null;
}

export function createAppMode(host: AppModePorts | undefined) {
  const h = host || {};
  const storage = h.storage || {
    getItem: (k: string): string | null => {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    setItem: (k: string, v: string): void => {
      try {
        localStorage.setItem(k, v);
      } catch (e) {}
    },
  };
  const activeConvId = typeof h.activeConvId === "function" ? h.activeConvId : () => "";
  const touchConv = typeof h.touchConv === "function" ? h.touchConv : () => {};
  const loadConvMeta = typeof h.loadConvMeta === "function" ? h.loadConvMeta : () => ({});
  const setIcon = typeof h.setIcon === "function" ? h.setIcon : () => {};
  const emit = typeof h.emit === "function" ? h.emit : () => {};
  const btn: HTMLElement | null = typeof h.button === "function" ? h.button() : null;

  function read(k: string): string | null {
    try {
      return storage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function write(k: string, v: string): void {
    try {
      storage.setItem(k, v);
    } catch (e) {}
  }

  // Default rp: verbatim the pre-mode behaviour, where the main chat always got the full RP layer.
  let current = normMode(read(APP_MODE_LS_KEY));

  function isWork(): boolean {
    return current === MODE_WORK;
  }

  /** Work mode forces the default style (no group-chat bursts, no long-form narration); rp reads the user's setting. */
  function replyStyle(): string {
    return isWork() ? "default" : read("cfw_reply_style_v1") || "default";
  }

  /** Request assembly; the caller spreads the result. */
  function payload(extra: PayloadOpts | undefined): PayloadDecision {
    return decidePayload(current, {
      replyStyle: read("cfw_reply_style_v1") || "default",
      stateLayer: (extra && extra.stateLayer) || {},
      genParams: (extra && extra.genParams) || {},
    });
  }

  function paint(): void {
    if (!btn) return;
    const w = isWork();
    setIcon(btn, w ? "modeWork" : "modeRp", w ? "工作" : "角色扮演");
    btn.title = w
      ? "工作模式：按交付办事，不吃角色状态层与长段叙事（点击切到角色扮演）"
      : "角色扮演：完整角色层（状态 / 关系 / 氛围）（点击切到工作）";
    // The guards keep stub buttons (vm tests, future hosts without a full element) from throwing.
    if (btn.setAttribute) {
      btn.setAttribute("aria-label", w ? "当前工作模式，点击切到角色扮演" : "当前角色扮演，点击切到工作");
      btn.setAttribute("aria-pressed", w ? "true" : "false");
    }
    if (btn.classList && btn.classList.toggle) btn.classList.toggle("is-work", w);
  }

  /** `silent` keeps the change in memory and the button only — used when applying a conversation. */
  function set(v: string, opts: { silent?: boolean } | undefined): string {
    current = normMode(v);
    write(APP_MODE_LS_KEY, current);
    if (!(opts && opts.silent)) {
      try {
        const id = activeConvId();
        if (id) touchConv(id, { appMode: current });
      } catch (e) {}
    }
    paint();
    emit(current);
    return current;
  }

  function toggle(): string {
    return set(isWork() ? MODE_RP : MODE_WORK, undefined);
  }

  /** Switching conversations: a stored per-conversation mode wins, else the global default. */
  function applyConv(convId: string): string {
    let meta: Record<string, unknown> = {};
    try {
      // Copy instead of trusting the port's return: hosts have handed odd shapes here before.
      const loaded = loadConvMeta();
      if (loaded && typeof loaded === "object") {
        for (const k of Object.keys(loaded)) meta[k] = loaded[k];
      }
    } catch (e) {}
    const raw = (convId && meta[convId]) || {};
    const field: Record<string, unknown> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of Object.keys(raw)) field[k] = raw[k];
    }
    current = normMode(field[META_FIELD] || read(APP_MODE_LS_KEY));
    paint();
    return current;
  }

  function bind(el: HTMLElement | null): void {
    if (el) el.addEventListener("click", toggle);
  }

  paint();
  return {
    get: () => current,
    isWork: isWork,
    set: set,
    toggle: toggle,
    applyConv: applyConv,
    paint: paint,
    bind: bind,
    replyStyle: replyStyle,
    payload: payload,
    LS_MODE: APP_MODE_LS_KEY,
  };
}
