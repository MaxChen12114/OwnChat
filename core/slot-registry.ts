// core/slot-registry.ts — the L1b slot registry contract skeleton: types plus the frozen data
// table, no runtime attached.
//
// Why it exists: settings/sidebar cards used to be mounted by whoever loaded first, each doing its
// own getElementById('xxxSlot') with one of three lookup styles and a hand-strung `||` fallback
// chain. A wrong chain made a card vanish on some devices — no error, no log. This file collapses
// "which slots exist, who mounts into them, where they fall back" from the call sites into one
// table.
//
// Contract layer only: no implementation, no assembly, nothing written to window (the L1a frozen
// list forbids new globals). The runtime twin is public/shared/core/slot-registry.js; the app side
// consumes only the interfaces below. Zero imports, zero type escapes — the check-types escape
// ratchet only goes down, so a new file must start at 0.
//
// Three semantics read out of the implementations that callers MUST keep:
//  1. Occupancy is keyed by card id, not slot: `if (!slot || document.getElementById(cardId))
//     return;` everywhere — a slot may hold several cards, a cardId mounts exactly once.
//  2. Order is card-level, not slot-level: some cards prepend, some append. A `mount` field on
//     SlotSpec would therefore be a fake contract; order travels with the claim instead.
//  3. Two fallback kinds must stay separate: falling back to another slot keeps the card styling,
//     falling back to the #settings root changes the style context entirely. Hence `fallbacks` and
//     `rootFallback` are two fields, never one.
//
// The mount API (declareCard) absorbs the old three-line boilerplate — `pick` → `claim` →
// `getElementById(cardId)` guard — one card at a time. It re-uses pick/claim unchanged (no
// re-resolution logic of its own), stamps `data-card="<id>"` on the mounted element so card CSS
// can move under a per-card scope, and fences build() failures into a visible placeholder card:
// the original wrong-chain bug was "a card vanish on some devices — no error, no log", so a mount
// failure here must never be silent — fence + console.error. A build() that returns without
// leaving `getElementById(id)` resolvable is reported as "no-card" (the same vanish, now logged).
// Existing pick/claim call sites stay valid; migration is per-card, and a card whose guard id
// sits on an inner control must move that id onto the card element before converting.
// There is no dev HUD error channel today (the dev console service captures chat traffic only),
// so the fence reports through console.error only; hook a HUD here if one ever appears.
//
// Every `evidence` entry below is re-read by the test against the named file and line; evidence
// that does not actually contain the slot id fails the build.
// @module core/slot-registry

// Slot ids (15; double-locked against public/index.html).

/**
 * Slot ids. **The order is the document order of index.html**, not alphabetical — the settings
 * page's section order lives in the HTML, and a reordered table would drop cards into the wrong
 * section.
 */
export type SlotId =
  | "setAccountSlot"
  | "setAppearanceTopSlot"
  | "setAppearanceThemeSlot"
  | "setChatSlot"
  | "setAgentSlot"
  | "setPersonalizeSlot"
  | "setSkillSlot"
  | "setImageChatSlot"
  | "settingsImageSlot"
  | "setModelApiSlot"
  | "settingsVoiceSlot"
  | "setDevSlot"
  | "setCostSlot"
  | "agentConsoleSlot"
  | "fishbowlSlot";

/**
 * Which area a slot belongs to. Only two values, because the **mount timing differs**: settings-area
 * slots render when the settings drawer opens (modules skip silently with `if (!slot) return`),
 * while shell-area slots mount at startup (sidebar is always present). Merging them into one area
 * makes "should the card exist while the drawer is closed" unanswerable.
 */
export type SlotArea = "settings" | "shell";

/**
 * Who mounts into the slot.
 * `index-inline` is **a truthful record of the current state**, not the goal: the mount logic for
 * agentConsoleSlot / fishbowlSlot lives inside index.html's inline `<script>` blocks. Touching it
 * first requires extracting those scripts, which contends with the mobile-shell bundle line for
 * the same insertion points.
 */
export type SlotOwner = "module" | "index-inline";

/** Contract for a single slot. */
export interface SlotSpec {
  readonly id: SlotId;
  /** Document order, starting at 1. */
  readonly order: number;
  readonly area: SlotArea;
  /** Slots to try, in order, when this one is missing (longest observed chain: 2 hops). */
  readonly fallbacks: readonly SlotId[];
  /**
   * Whether falling through to the `#settings` root container is allowed. true means "render at
   * the page root rather than drop the card silently", at the cost of a changed style context
   * (see the fallback note in the table below).
   */
  readonly rootFallback: boolean;
  readonly owner: SlotOwner;
  /** Mobile host container id: used when the slot itself is invisible or absent. */
  readonly mobileHost?: string;
  /** Proof as `<path relative to public/>:<line>`; that line must contain this slot id (test-checked). */
  readonly evidence: string;
}

// Resolution and claim shapes (signatures only).

/** Slot presence probe. A function on purpose, so resolution is testable without a DOM. */
export type SlotPresence = (id: SlotId) => boolean;

/** The result of one resolution. */
export interface SlotResolution {
  readonly requested: SlotId;
  /** Final host; `root` is true when the host is the requested slot's #settings root instead. */
  readonly host: SlotId;
  /** The chain actually walked (including `requested`). Longer than 1 means a fallback fired — warn once. */
  readonly via: readonly SlotId[];
  readonly root: boolean;
}

/** Resolver: given a request and a presence probe, returns the landing spot; null when the whole chain is gone and root fallback is not allowed. */
export type SlotResolver = (requested: SlotId, present: SlotPresence) => SlotResolution | null;

/** A claim. Keyed by cardId — one card mounts once; the slot is only where it lands (header note 1). */
export interface SlotClaim {
  readonly cardId: string;
  readonly slotId: SlotId;
}

/** Claim verdict: `occupied` is the normal idempotent path (a re-mount is blocked), not an error. */
export type SlotClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "occupied" | "unknown-slot" };

/** A card declaration consumed by {@link SlotRegistryRuntime.declareCard}. */
export interface SlotCardDecl {
  /**
   * The card's mount marker: `getElementById(id)` is the idempotency probe (header note 1 — a
   * cardId mounts exactly once) and the element that receives `data-card="<id>"`. The id must sit
   * on the card element itself; a guard id on an inner control would stamp the control instead.
   */
  readonly id: string;
  /** Requested slot; the declared fallback chain and rootFallback apply exactly as with pick(). */
  readonly slotId: string;
  /**
   * Recorded per card (header note 2: order is card-level). Insertion position stays the caller's
   * job — build() prepends or appends as the old boilerplate did — so this is a declaration record
   * read back through declared(), never a layout instruction.
   */
  readonly order?: number;
  /**
   * Builds the card into the resolved slot: create the element (id = decl.id), append or insert,
   * bind. Whatever it throws is fenced by declareCard, so it must not swallow its own errors.
   */
  build(slot: unknown): unknown;
}

/**
 * Result of one declareCard call. `mounted:false` always carries a reason; the reason set is
 * exhaustive and test-locked. `already-mounted` is the normal idempotent path, not an error.
 */
export interface SlotDeclareResult {
  readonly mounted: boolean;
  readonly reason?: "already-mounted" | "unknown-slot" | "no-slot" | "build-failed" | "no-card";
}

/** One row of the declaration ledger returned by declared(). */
export interface SlotDeclaredCard {
  readonly id: string;
  readonly slotId: string;
  readonly order?: number;
}

/** Registry instance. The app side depends on this interface, never on the table directly. */
export interface SlotRegistry {
  readonly specs: readonly SlotSpec[];
  spec(id: SlotId): SlotSpec | undefined;
  resolve: SlotResolver;
  claim(claim: SlotClaim): SlotClaimResult;
  occupants(slotId: SlotId): readonly string[];
}

// The data table (single source of truth; changing it must stay in sync with index.html — the
// test double-locks both directions).

/**
 * The frozen table of 15 slots. `fallbacks` may only name SlotId members; falling to the #settings
 * root is expressed separately via `rootFallback` (the two fallback semantics differ — merging
 * them into one field leaves the resolver unable to pick the right warning).
 */
export const SLOT_SPECS: readonly SlotSpec[] = [
  {
    id: "setAccountSlot",
    order: 1,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/30-chat.js:91",
  },
  {
    id: "setAppearanceTopSlot",
    order: 2,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/10-appearance.js:13",
  },
  {
    // The two appearance slots are treated as one landing spot in 5 places: `Theme || Top`.
    id: "setAppearanceThemeSlot",
    order: 3,
    area: "settings",
    fallbacks: ["setAppearanceTopSlot"],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/10-appearance.js:37",
  },
  {
    id: "setChatSlot",
    order: 4,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/30-chat.js:14",
  },
  {
    // Agent config became its own section (2026-09-14); pages without the slot fall back to chat.
    // Evidence re-anchored 2026-11-28 (card-shell batch 3): the 40-agent picks moved into
    // declareCard calls, so the anchor is now multiAgentCard's slotId line.
    id: "setAgentSlot",
    order: 5,
    area: "settings",
    fallbacks: ["setChatSlot"],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/40-agent.js:13",
  },
  {
    id: "setPersonalizeSlot",
    order: 6,
    area: "settings",
    fallbacks: ["setAgentSlot"],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/30-chat.js:184",
  },
  {
    id: "setSkillSlot",
    order: 7,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "services/agent/skills.js:576",
  },
  {
    id: "setImageChatSlot",
    order: 8,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/chat-image-text.js:262",
  },
  {
    // Both image cards (avatar / expressions) mount settingsImageSlot; the page root is the
    // last resort when the slot is missing. Since 2026-11-15 the mount points live in the
    // wiring layer after the services migration, so evidence points there.
    id: "settingsImageSlot",
    order: 9,
    area: "settings",
    fallbacks: [],
    rootFallback: true,
    owner: "module",
    evidence: "../tooling/l0/wiring/image-avatar.js:84",
  },
  {
    // The model-key card also falls to the page root when its slot is missing.
    id: "setModelApiSlot",
    order: 10,
    area: "settings",
    fallbacks: [],
    rootFallback: true,
    owner: "module",
    evidence: "../tooling/l0/wiring/image-channels-ui.js:38",
  },
  {
    // The only slot that returns null instead of falling back when missing.
    id: "settingsVoiceSlot",
    order: 11,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/settings/70-images.js:10",
  },
  {
    id: "setDevSlot",
    order: 12,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/dev.js:738",
  },
  {
    id: "setCostSlot",
    order: 13,
    area: "settings",
    fallbacks: [],
    rootFallback: false,
    owner: "module",
    evidence: "../tooling/l0/wiring/cost-log.js:52",
  },
  {
    // Mount logic lives in index.html's inline scripts; the mobile shell moves the whole right
    // sidebar into its console, so the same slot is the mobile host too.
    id: "agentConsoleSlot",
    order: 14,
    area: "shell",
    fallbacks: [],
    rootFallback: false,
    owner: "index-inline",
    evidence: "index.html:1245",
  },
  {
    // The mobile shell moves this slot (inside #rightSidebar) into the console; body is no longer
    // a fallback host.
    id: "fishbowlSlot",
    order: 15,
    area: "shell",
    fallbacks: [],
    rootFallback: false,
    owner: "index-inline",
    evidence: "index.html:1255",
  },
];

/** Document-order id list. Assembly, gates and generators take ids from here; never copy a second list. */
export const SLOT_IDS: readonly SlotId[] = SLOT_SPECS.map(function (s) {
  return s.id;
});

// Inventory of index.html's inline scripts (read line by line after the α2 pass, not guessed).
//
// Why it exists: after α2 the page still carried 17 business inline scripts plus the boot line.
// The acceptance for the slot work is "all getElementById('*Slot') calls resolve through the
// registry", and the mounts for agentConsoleSlot / fishbowlSlot are exactly in those inline
// blocks — so before extracting them, there must be a table of which slots each one touches and
// whether it can move into the boot manifest.
//
// Evidence style (line numbers rot, literals do not): each inline is located by an `anchor`, a
// stable literal from its body that the test must find exactly once in index.html; `line` is only
// a human-readable snapshot.
//
// Extraction rules that were applied: mid-page inline blocks mount to the head or tail of the
// boot manifest so they still see an equal-or-larger DOM with relative order preserved; the
// three head guards (inline-0/1/2) write html data-* / classes before first paint and must stay
// synchronous in <head> — moving them into the manifest would run them after first paint.
export interface InlineScriptSpec {
  /** Sequence number in writing order (the boot line itself is the 11th inline, not listed). */
  readonly id: string;
  /** Stable body literal: the test reads index.html and must find it exactly once. */
  readonly anchor: string;
  /** Line-number snapshot taken after α2; drifts, human-readable only. */
  readonly line: number;
  readonly role: string;
  /** Slots this script mounts into (write side). */
  readonly mounts: readonly SlotId[];
  /** Slots it only observes / tabs / relocates (read side, mounts nothing). */
  readonly observes: readonly SlotId[];
  /** Implicit global it creates (no `window.` assignment, invisible to check-load-order; registered by hand here). */
  readonly createsGlobal?: string;
  /** Whether it must run synchronously at its current position (head-guard class). */
  readonly positionSensitive: boolean;
  /** Whether it can safely move into the boot manifest. */
  readonly externalizable: boolean;
  /** Where it landed after extraction (path relative to public/); undefined for the guards. */
  readonly externalizedAs?: string;
  readonly note?: string;
}

export const INDEX_INLINE_SCRIPTS: readonly InlineScriptSpec[] = [
  {
    id: "inline-0",
    anchor: 'var ALLOWED = unlocked ? { glass: 1, lumen: 1, candle: 1 } : { glass: 1, lumen: 1 };',
    line: 481,
    role: "头部守卫：URL 参数旗标（预览/调试形态）→ html 类",
    mounts: [],
    observes: [],
    positionSensitive: true,
    externalizable: false,
    note: "必须在首绘前同步执行，留在 head",
  },
  {
    id: "inline-1",
    anchor: "ls.getItem('cfw_hide_msg_actions_v1')",
    line: 514,
    role: "头部守卫：localStorage 主题/强调色早设（防主题闪跳）",
    mounts: [],
    observes: [],
    positionSensitive: true,
    externalizable: false,
    note: "必须在首绘前同步执行，留在 head",
  },
  {
    id: "inline-2",
    anchor: "cfw_left_collapsed_v1') === '1' && !window.matchMedia",
    line: 553,
    role: "头部守卫：壳环境即时判定（Tauri/WebView scheme）",
    mounts: [],
    observes: [],
    positionSensitive: true,
    externalizable: false,
    note: "1 行，必须在首绘前同步执行，留在 head",
  },
  {
    id: "inline-3",
    anchor: "createVersionPainter({",
    line: 1273,
    role: "顶栏版本号绘制（appVersionTag / appVersionTagHome）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/version-painter.js",
    note: "2026-11-17 服务层搬迁：源=services/ui/version-painter.ts，接线 tooling/l0/wiring；只读顶栏节点，均在 boot 之前",
  },
  {
    id: "inline-4",
    anchor: "createFooterKeeper({",
    line: 1306,
    role: "设置页 footer 版本与 settingsBtn 联动",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/settings-footer-keeper.js",
    note: "2026-11-17 服务层搬迁：源=services/ui/settings-footer-keeper.ts，接线在 tooling/l0/wiring；触碰节点 settings/settingsFooter/settingsBtn 均在 boot 之前",
  },
  {
    id: "inline-6",
    anchor: "createLeftSidebarToggle({",
    line: 1441,
    role: "左栏开关（menuToggle / backdrop / sidebarCloseBtn）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/left-sidebar-toggle.js",
    note: "2026-11-17 服务层搬迁：源=services/ui/left-sidebar-toggle.ts，接线 tooling/l0/wiring；触碰节点 962–1078，均在 boot 之前",
  },
  {
    id: "inline-7",
    anchor: "function refresh(){",
    line: 1469,
    role: "同步状态指示器格式化与轮换（syncStatusIndicator）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/sync-indicator.js",
    note: "触碰节点 1108，在 boot 之前",
  },
  {
    id: "inline-8",
    anchor: "getElementById(\"rightSidebar\")",
    line: 1538,
    role: "右栏 tab 控制器：活动/群聊/图像三栏切换 + fishbowlSlot 变化观察",
    mounts: [],
    observes: ["fishbowlSlot", "agentConsoleSlot"],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/right-sidebar-tabs.js",
    note: "2026-11-16 迁 services 时去掉了隐式全局 agentConsoleSlot：inline-17 自己 getElementById 赋值，从未读过那个全局；触碰节点 1330/1351/1361 均在 boot 之前",
  },
  {
    id: "inline-9",
    anchor: "function ctaPlan(",
    line: 1602,
    role: "群聊空态引导按钮（wgConsoleBuildBtn / fishbowlEmptyHint）",
    mounts: [],
    observes: ["fishbowlSlot"],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/fishbowl-cta.js",
    note: "触碰节点 1357/1362，在 boot 之前",
  },
  {
    id: "inline-10",
    anchor: "navigator.serviceWorker.register('/service-worker.js')",
    line: 1628,
    role: "serviceWorker 注册（window load 之后）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "js/text/boot/sw-register.js",
  },
  {
    id: "inline-12",
    anchor: "function syncThinkEffort(){",
    line: 1640,
    role: "思考档位归一映射（low/medium/high 别名表，DOMContentLoaded 后生效）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/think-level-map.js",
    note: "DCL 守卫，位置无关",
  },
  {
    id: "inline-13",
    anchor: "createAndroidMark({",
    line: 1686,
    role: "Android 壳标记（html 类）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/android-mark.js",
    note: "2026-11-17 服务层搬迁：源=services/ui/android-mark.ts，接线 tooling/l0/wiring；只写 documentElement，位置无关",
  },
  {
    id: "inline-14",
    anchor: "getElementById('ownchatWelcome')",
    line: 1707,
    role: "欢迎屏/首日问候（ownchatWelcome / owGreeting）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/welcome-greeting.js",
    note: "触碰节点 1120/1123，在 boot 之前",
  },
  {
    id: "inline-15",
    anchor: "querySelector('.settings-cat-nav')",
    line: 1732,
    role: "设置页分类导航 init（横屏渐隐/scroll-snap，DCL 后生效）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/settings-nav-init.js",
    note: "DCL 守卫；分类导航节点在 591 行",
  },
  {
    id: "inline-16",
    anchor: "createOrphanObserver({",
    line: 1759,
    role: "设置孤儿卡兜底观察器：谁往 #settings 根 append 就搬进 settingsImageSlot",
    mounts: [],
    observes: ["settingsImageSlot"],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/settings-orphan-observer.js",
    note: "2026-11-17 服务层搬迁：源=services/ui/settings-orphan-observer.ts，接线 tooling/l0/wiring；观察器须在业务模块挂卡之前就位（boot 清单头部段不变）；SKIP_IDS 里的 settingsFooter 与 footer-keeper 的搬移目标相扣，两件锁互为护栏",
  },
  {
    id: "inline-17",
    anchor: "function safeInit(){ if (_agentInited) return; _agentInited = true; init(); }",
    line: 1799,
    role: "Agent 模式编排器：控制台挂载（agentConsoleSlot||fishbowlSlot）、断点自愈、外部设置同步",
    mounts: ["agentConsoleSlot"],
    observes: ["fishbowlSlot"],
    createsGlobal: "agentConsoleSlot",
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/agent-mode-orchestrator.js",
    note: "init 有 DCL 守卫 + 400ms 兜底，位置无关；但必须排在 boot 清单里 agent-console.js 之后（读 __agentConsole）；与 inline-8 共用隐式全局 agentConsoleSlot，二者相对顺序必须保持",
  },
  {
    id: "inline-18",
    anchor: "getElementById('sidebarCollapseBtn')",
    line: 2063,
    role: "桌面侧栏折叠按钮（sidebarCollapseBtn）",
    mounts: [],
    observes: [],
    positionSensitive: false,
    externalizable: true, externalizedAs: "services/ui/sidebar-collapse.js",
    note: "触碰节点 971，在 boot 之前",
  },
];

// ── Runtime (emitted into public/shared/core/slot-registry.js) ────────────────────────────────
// The classic product used to be a hand-written twin carrying its own SPECS table; that second
// copy could drift silently because nothing compared the two. The runtime now lives here and the
// product is generated, so the table has exactly one home.

/** Ports: presence probe plus the two DOM lookups; the wiring owns `document`. */
export interface SlotRuntimePorts {
  /** `!!document.getElementById(id)`. */
  present(id: string): boolean;
  /** `document.getElementById(id)`; `null` when absent. */
  byId(id: string): unknown;
  /** The `#settings` root used by `rootFallback` slots. */
  root(): unknown;
  /**
   * `document.createElement(tag)` — fence cards for the mount API. The wiring owns `document`,
   * so the runtime never names it; the same rule that keeps resolution testable without a DOM.
   */
  make(tag: string): unknown;
  /** `el.setAttribute(name, value)`; a no-op on a non-element handle, never a throw. */
  setAttr(el: unknown, name: string, value: string): void;
  /** `el.textContent = value`; fence messages go in as text, never as HTML. */
  text(el: unknown, value: string): void;
  /** `parent.appendChild(child)`. */
  append(parent: unknown, child: unknown): void;
  /** `el.remove()`; retires a previous fence card when the real card mounts. */
  drop(el: unknown): void;
}

/** Resolution with plain strings: the runtime never sees the SlotId union at run time. */
export interface RuntimeResolution {
  readonly requested: string;
  readonly host: string;
  readonly via: readonly string[];
  readonly root: boolean;
}

/** Claim verdict for the runtime (mirrors {@link SlotClaimResult} without the union narrowing). */
export interface RuntimeClaimResult {
  readonly ok: boolean;
  readonly reason?: "occupied" | "unknown-slot";
}

/** What the wiring assigns to `window.slotRegistry`. */
export interface SlotRegistryRuntime {
  readonly specs: readonly SlotSpec[];
  spec(id: string): SlotSpec | undefined;
  resolve(requested: string, presentFn?: (id: string) => boolean): RuntimeResolution | null;
  get(id: string, presentFn?: (id: string) => boolean): unknown;
  pick(id: string): unknown;
  claim(claim: { readonly cardId: string; readonly slotId: string }): RuntimeClaimResult;
  occupants(slotId: string): readonly string[];
  /**
   * Mount API: pick + claim + idempotent DOM probe + build(), with the build fenced. Idempotent by
   * the `getElementById(decl.id)` probe — a second call is `already-mounted`, not an error.
   */
  declareCard(decl: SlotCardDecl): SlotDeclareResult;
  /** The declaration ledger in first-declare order: the rollout's "which cards moved over" view. */
  declared(): readonly SlotDeclaredCard[];
}

/**
 * Build the registry runtime. Resolution walks the declared fallback chain (longest observed: two
 * hops); a slot with `rootFallback` lands on `#settings`, which is a different semantic from
 * "fall through to another slot" and therefore reported as `root: true`.
 * @param ports - presence probe and DOM lookups from the wiring.
 * @returns The object the wiring assigns to `window.slotRegistry`.
 */
export function createSlotRegistry(ports: SlotRuntimePorts): SlotRegistryRuntime {
  const index: Map<string, SlotSpec> = new Map();
  for (let i = 0; i < SLOT_SPECS.length; i++) index.set(SLOT_SPECS[i].id, SLOT_SPECS[i]);
  const claims: Map<string, string> = new Map();
  // Mount-API state. fences: cardId → the fence card currently standing in for it (element handles
  // are kept here so a successful mount can retire the fence without a document query). declared:
  // the first-declare ledger. flagged: ids whose no-slot / no-card condition already logged — the
  // settings host re-runs mount functions on re-init, so these stay once-per-condition, not spam.
  const fences: Map<string, unknown> = new Map();
  const declaredCards: SlotDeclaredCard[] = [];
  const flagged: Set<string> = new Set();

  function resolve(requested: string, presentFn?: (id: string) => boolean): RuntimeResolution | null {
    const has = presentFn === undefined ? ports.present : presentFn;
    const via: string[] = [requested];
    let cur = requested;
    for (let depth = 0; depth < 16; depth++) {
      if (has(cur)) return { requested: requested, host: cur, via: via.slice(), root: false };
      const spec = index.get(cur);
      if (spec === undefined) return null;
      if (spec.fallbacks.length > 0) {
        via.push(spec.fallbacks[0]);
        cur = spec.fallbacks[0];
        continue;
      }
      if (spec.rootFallback) return { requested: requested, host: requested, via: via.slice(), root: true };
      return null;
    }
    return null; // chain longer than the cap means the table loops; the source lock catches it
  }

  function get(id: string, presentFn?: (id: string) => boolean): unknown {
    const r = resolve(id, presentFn);
    if (r === null) return null;
    if (r.root) return ports.root();
    return ports.byId(r.host);
  }

  function claim(c: { readonly cardId: string; readonly slotId: string }): RuntimeClaimResult {
    if (index.get(c.slotId) === undefined) return { ok: false, reason: "unknown-slot" };
    if (claims.get(c.cardId) !== undefined) return { ok: false, reason: "occupied" };
    claims.set(c.cardId, c.slotId);
    return { ok: true };
  }

  function occupants(slotId: string): readonly string[] {
    const out: string[] = [];
    claims.forEach(function (value: string, key: string) {
      if (value === slotId) out.push(key);
    });
    return out;
  }

  /** One-error-one-log helper: same card + same condition never repeats (re-init re-runs mounts). */
  function flagOnce(id: string, kind: string, detail: string): void {
    const key = id + ":" + kind;
    if (flagged.has(key)) return;
    flagged.add(key);
    console.error('[slot-registry] card "' + id + '" ' + detail);
  }

  /**
   * The visible placeholder card for a failed build. Low-key on purpose: a dashed muted border,
   * small text, the card id and the error message — diagnostics for the owner, not an alarm for
   * the user. The message goes in through ports.text (textContent), never through HTML.
   */
  function fenceCard(decl: SlotCardDecl, message: string): unknown {
    const prev = fences.get(decl.id);
    if (prev !== undefined) {
      ports.drop(prev);
      fences.delete(decl.id);
    }
    const card = ports.make("div");
    ports.setAttr(card, "class", "card slot-card-error");
    ports.setAttr(card, "data-card", decl.id);
    ports.setAttr(card, "id", decl.id + ":error");
    const title = ports.make("div");
    ports.setAttr(title, "class", "slot-card-error-title");
    ports.text(title, "卡片加载失败");
    const body = ports.make("div");
    ports.setAttr(body, "class", "slot-card-error-msg");
    ports.text(body, "卡片 " + decl.id + " 渲染时出错：" + message + "。其它功能不受影响，重试或刷新页面可再试一次。");
    ports.append(card, title);
    ports.append(card, body);
    fences.set(decl.id, card);
    return card;
  }

  function declareCard(decl: SlotCardDecl): SlotDeclareResult {
    // Ledger first, regardless of outcome: declared() must show every card that moved over.
    let seen = false;
    for (let i = 0; i < declaredCards.length; i++) {
      if (declaredCards[i].id === decl.id) { seen = true; break; }
    }
    if (!seen) {
      const row: { id: string; slotId: string; order?: number } = { id: decl.id, slotId: decl.slotId };
      if (decl.order !== undefined) row.order = decl.order;
      declaredCards.push(row);
    }

    if (index.get(decl.slotId) === undefined) {
      flagOnce(decl.id, "unknown-slot", 'declares into unknown slot "' + decl.slotId + '" — the id is not in SLOT_IDS');
      return { mounted: false, reason: "unknown-slot" };
    }
    // Idempotency probe = header note 1 verbatim: the DOM id is the only "already mounted" truth.
    if (ports.byId(decl.id)) return { mounted: false, reason: "already-mounted" };
    const slot = get(decl.slotId);
    if (!slot) {
      flagOnce(decl.id, "no-slot", 'slot "' + decl.slotId + '" is missing and no fallback fired — the old boilerplate would have dropped it silently');
      return { mounted: false, reason: "no-slot" };
    }
    try {
      decl.build(slot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ports.append(slot, fenceCard(decl, message));
      console.error('[slot-registry] card "' + decl.id + '" failed to mount in "' + decl.slotId + '": ' + message, err);
      return { mounted: false, reason: "build-failed" };
    }
    const el = ports.byId(decl.id);
    if (!el) {
      flagOnce(decl.id, "no-card", 'build ran without throwing but getElementById("' + decl.id + '") still misses — the card vanished silently, header note 1 contract broken');
      return { mounted: false, reason: "no-card" };
    }
    ports.setAttr(el, "data-card", decl.id);
    const standing = fences.get(decl.id);
    if (standing !== undefined) {
      ports.drop(standing);
      fences.delete(decl.id);
    }
    // Claim only on success, so occupants() lists cards that are really in the DOM. The DOM probe
    // above already guarantees mount-once; a stale "occupied" verdict (claim left behind by a
    // previous fence cycle) must not block the re-mount, hence the verdict is deliberately ignored.
    claim({ cardId: decl.id, slotId: decl.slotId });
    return { mounted: true };
  }

  function declared(): readonly SlotDeclaredCard[] {
    return declaredCards.slice();
  }

  return {
    specs: SLOT_SPECS,
    spec: function (id: string) { return index.get(id); },
    resolve: resolve,
    get: get,
    pick: function (id: string) { return get(id); },
    claim: claim,
    occupants: occupants,
    declareCard: declareCard,
    declared: declared,
  };
}
