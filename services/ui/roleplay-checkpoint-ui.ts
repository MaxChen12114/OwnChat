/**
 * Roleplay checkpoint UI flow: the save / restore / list decisions behind the message-row entry.
 *
 * The store and the plan module already own persistence and row shaping; this module owns the
 * order of the calls and every user-facing outcome. DOM, toasts and the list dialog arrive through
 * {@link CheckpointUiPorts}, so a vm can drive the whole flow with fake ports and no document.
 *
 * The plan functions are separate emit products bridged on globalThis; they are declared, not
 * imported, because the emit channel only carries import-free sources.
 * @module services/ui/roleplay-checkpoint-ui
 */

declare const preRestorePlan: typeof import("./roleplay-checkpoint-plan").preRestorePlan;
declare const sortEntries: typeof import("./roleplay-checkpoint-plan").sortEntries;
declare const entryView: typeof import("./roleplay-checkpoint-plan").entryView;
declare const RESTORE_REFUSAL: typeof import("./roleplay-checkpoint-plan").RESTORE_REFUSAL;

/** One row the list presenter receives; structurally the plan's entry view. */
export interface CheckpointView {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly time: string;
  readonly isPreRestore: boolean;
  readonly tag: string;
}

/** Result envelope shared by `put` / `get` / `list`; missing fields are treated as failure. */
export interface CheckpointResult {
  readonly ok?: boolean;
  readonly error?: string;
  readonly payload?: unknown;
  readonly checkpoints?: unknown[];
}

/** The `__checkpoints` surface this flow consumes. */
export interface CheckpointStore {
  captureRoleplay(host: unknown): unknown;
  roleplayHost(): unknown;
  put(scope: string, scopeId: string, payload: unknown, opts: Record<string, unknown>): Promise<CheckpointResult | null | undefined>;
  get(id: string): Promise<CheckpointResult | null | undefined>;
  list(scope: string, scopeId: string, limit: number): Promise<CheckpointResult | null | undefined>;
  applyRoleplay(payload: unknown, host: unknown): Promise<boolean>;
}

/** What the wiring must provide: the store, the active conversation, the clock and the surfaces. */
export interface CheckpointUiPorts {
  cp: CheckpointStore;
  /** Active conversation id, or an empty string when no chat is open. */
  conversationId(): string;
  /** Current epoch milliseconds for the pre-restore snapshot. */
  now(): number;
  /** Local time for the manual checkpoint subject. */
  timeText(): string;
  /** A transient message; `ms` is a hint for the presenter. */
  toast(message: string, ms?: number): void;
  /** Render the list dialog. `actions.restore` continues the flow after a row is chosen. */
  presentList(rows: readonly CheckpointView[], actions: ListActions): void;
}

/** Callbacks the presenter uses; closing is the presenter's own concern. */
export interface ListActions {
  restore(id: string): void;
}

/** Public surface; mirrors the old `window.roleplayCheckpointUi` methods. */
export interface CheckpointUiApi {
  saveHere(): Promise<void>;
  restoreTo(targetId: string): Promise<void>;
  openList(): Promise<void>;
  readonly refusal: string;
}

/**
 * Create the checkpoint UI flow. Nothing runs until one of the three methods is called; a missing
 * conversation stops each flow with a toast instead of throwing.
 * @param ports - store, conversation source, clock, toast and list presenter from the wiring.
 * @returns The three entry points plus the refusal text the wiring exposes.
 */
export function createCheckpointUi(ports: CheckpointUiPorts): CheckpointUiApi {
  function errorOf(res: CheckpointResult | null | undefined): string {
    return res && typeof res.error === "string" && res.error ? res.error : "未知";
  }

  async function saveHere(): Promise<void> {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话，无法存档");
      return;
    }
    const captured = ports.cp.captureRoleplay(ports.cp.roleplayHost());
    const res = await ports.cp.put("roleplay", cid, captured, {
      kind: "manual",
      subject: "手动存档 @" + ports.timeText(),
    });
    if (res && res.ok) ports.toast("已存档（" + cid + "）");
    else ports.toast("存档失败：" + errorOf(res));
  }

  async function restoreTo(targetId: string): Promise<void> {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话");
      return;
    }
    const captured = ports.cp.captureRoleplay(ports.cp.roleplayHost());
    const plan = preRestorePlan(cid, targetId, captured, ports.now());
    if (!plan.ok) {
      ports.toast("error" in plan ? plan.error : "回退目标缺失");
      return;
    }
    const putRes = await ports.cp.put(plan.plan.scope, plan.plan.scopeId, plan.plan.payload, plan.plan.opts);
    if (!putRes || !putRes.ok) {
      ports.toast("恢复前自动存档失败：" + errorOf(putRes));
      return;
    }
    const got = await ports.cp.get(targetId);
    if (!got || !got.ok) {
      ports.toast("回退目标不可用：" + errorOf(got));
      return;
    }
    const ok = await ports.cp.applyRoleplay(got.payload, ports.cp.roleplayHost());
    if (!ok) {
      ports.toast(RESTORE_REFUSAL);
      return;
    }
    ports.toast("已回退；要撤销就再回退到「恢复前自动存档」");
  }

  async function openList(): Promise<void> {
    const cid = ports.conversationId();
    if (!cid) {
      ports.toast("当前没有会话");
      return;
    }
    const res = await ports.cp.list("roleplay", cid, 30);
    const rows = res && res.ok ? sortEntries(res.checkpoints || []) : [];
    const views: CheckpointView[] = [];
    for (let i = 0; i < rows.length; i++) views.push(entryView(rows[i]));
    ports.presentList(views, { restore: restoreTo });
  }

  return { saveHere: saveHere, restoreTo: restoreTo, openList: openList, refusal: RESTORE_REFUSAL };
}
