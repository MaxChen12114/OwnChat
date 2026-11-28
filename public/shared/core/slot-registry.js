(function () {
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
                    
                    
                          
                            
                 
                  
                        
                  
                      
                       
                     
                       
                
                 
                      
                   

/**
 * Which area a slot belongs to. Only two values, because the **mount timing differs**: settings-area
 * slots render when the settings drawer opens (modules skip silently with `if (!slot) return`),
 * while shell-area slots mount at startup (sidebar is always present). Merging them into one area
 * makes "should the card exist while the drawer is closed" unanswerable.
 */
                                            

/**
 * Who mounts into the slot.
 * `index-inline` is **a truthful record of the current state**, not the goal: the mount logic for
 * agentConsoleSlot / fishbowlSlot lives inside index.html's inline `<script>` blocks. Touching it
 * first requires extracting those scripts, which contends with the mobile-shell bundle line for
 * the same insertion points.
 */
                                                  

/** Contract for a single slot. */
                           
                      
                                       
                         
                          
                                                                                           
                                        
     
                                                                                                
                                                                                              
                                                
     
                                 
                            
                                                                                    
                               
                                                                                                          
                            
 

// Resolution and claim shapes (signatures only).

/** Slot presence probe. A function on purpose, so resolution is testable without a DOM. */
                                                   

/** The result of one resolution. */
                                 
                             
                                                                                                 
                        
                                                                                                             
                                  
                         
 

/** Resolver: given a request and a presence probe, returns the landing spot; null when the whole chain is gone and root fallback is not allowed. */
                                                                                               

/** A claim. Keyed by cardId — one card mounts once; the slot is only where it lands (header note 1). */
                            
                          
                          
 

/** Claim verdict: `occupied` is the normal idempotent path (a re-mount is blocked), not an error. */
                             
                         
                                                                         

/** A card declaration consumed by {@link SlotRegistryRuntime.declareCard}. */
                               
     
                                                                                              
                                                                                                  
                                                                                                
     
                      
                                                                                                   
                          
     
                                                                                                  
                                                                                                   
                                                              
     
                          
     
                                                                                                 
                                                                                              
     
                                
 

/**
 * Result of one declareCard call. `mounted:false` always carries a reason; the reason set is
 * exhaustive and test-locked. `already-mounted` is the normal idempotent path, not an error.
 */
                                    
                            
                                                                                                
 

/** One row of the declaration ledger returned by declared(). */
                                   
                      
                          
                          
 

/** Registry instance. The app side depends on this interface, never on the table directly. */
                               
                                      
                                         
                        
                                           
                                               
 

// The data table (single source of truth; changing it must stay in sync with index.html — the
// test double-locks both directions).

/**
 * The frozen table of 15 slots. `fallbacks` may only name SlotId members; falling to the #settings
 * root is expressed separately via `rootFallback` (the two fallback semantics differ — merging
 * them into one field leaves the resolver unable to pick the right warning).
 */
const SLOT_SPECS                      = [
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
const SLOT_IDS                    = SLOT_SPECS.map(function (s) {
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
                                   
                                                                                                
                      
                                                                                      
                          
                                                                          
                        
                        
                                                    
                                     
                                                                               
                                       
                                                                                                                      
                                  
                                                                                      
                                      
                                                           
                                   
                                                                                               
                                   
                         
 

const INDEX_INLINE_SCRIPTS                              = [
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
                                   
                                         
                               
                                                           
                            
                                                           
                  
     
                                                                                               
                                                                                               
     
                             
                                                                                        
                                                          
                                                                               
                                         
                                     
                                                
                                                                                
                          
 

/** Resolution with plain strings: the runtime never sees the SlotId union at run time. */
                                    
                             
                        
                                  
                         
 

/** Claim verdict for the runtime (mirrors {@link SlotClaimResult} without the union narrowing). */
                                     
                       
                                                
 

/** What the wiring assigns to `window.slotRegistry`. */
                                      
                                      
                                         
                                                                                            
                                                                
                            
                                                                                         
                                               
     
                                                                                                   
                                                                                            
     
                                                     
                                                                                                    
                                          
 

/**
 * Build the registry runtime. Resolution walks the declared fallback chain (longest observed: two
 * hops); a slot with `rootFallback` lands on `#settings`, which is a different semantic from
 * "fall through to another slot" and therefore reported as `root: true`.
 * @param ports - presence probe and DOM lookups from the wiring.
 * @returns The object the wiring assigns to `window.slotRegistry`.
 */
function createSlotRegistry(ports                  )                      {
  const index                        = new Map();
  for (let i = 0; i < SLOT_SPECS.length; i++) index.set(SLOT_SPECS[i].id, SLOT_SPECS[i]);
  const claims                      = new Map();
  // Mount-API state. fences: cardId → the fence card currently standing in for it (element handles
  // are kept here so a successful mount can retire the fence without a document query). declared:
  // the first-declare ledger. flagged: ids whose no-slot / no-card condition already logged — the
  // settings host re-runs mount functions on re-init, so these stay once-per-condition, not spam.
  const fences                       = new Map();
  const declaredCards                     = [];
  const flagged              = new Set();

  function resolve(requested        , presentFn                          )                           {
    const has = presentFn === undefined ? ports.present : presentFn;
    const via           = [requested];
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

  function get(id        , presentFn                          )          {
    const r = resolve(id, presentFn);
    if (r === null) return null;
    if (r.root) return ports.root();
    return ports.byId(r.host);
  }

  function claim(c                                                      )                     {
    if (index.get(c.slotId) === undefined) return { ok: false, reason: "unknown-slot" };
    if (claims.get(c.cardId) !== undefined) return { ok: false, reason: "occupied" };
    claims.set(c.cardId, c.slotId);
    return { ok: true };
  }

  function occupants(slotId        )                    {
    const out           = [];
    claims.forEach(function (value        , key        ) {
      if (value === slotId) out.push(key);
    });
    return out;
  }

  /** One-error-one-log helper: same card + same condition never repeats (re-init re-runs mounts). */
  function flagOnce(id        , kind        , detail        )       {
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
  function fenceCard(decl              , message        )          {
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

  function declareCard(decl              )                    {
    // Ledger first, regardless of outcome: declared() must show every card that moved over.
    let seen = false;
    for (let i = 0; i < declaredCards.length; i++) {
      if (declaredCards[i].id === decl.id) { seen = true; break; }
    }
    if (!seen) {
      const row                                                 = { id: decl.id, slotId: decl.slotId };
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

  function declared()                              {
    return declaredCards.slice();
  }

  return {
    specs: SLOT_SPECS,
    spec: function (id        ) { return index.get(id); },
    resolve: resolve,
    get: get,
    pick: function (id        ) { return get(id); },
    claim: claim,
    occupants: occupants,
    declareCard: declareCard,
    declared: declared,
  };
}

// Browser wiring for core/slot-registry.ts: the DOM side of the registry. The factory and the
// table are generated by tooling/l0/emit.mjs — this file only supplies document lookups.
// Global name: window.slotRegistry (no __ prefix: the L1a frozen surface is window.__*).
(function () {
  "use strict";
  window.slotRegistry = createSlotRegistry({
    present: function (id) { return !!document.getElementById(id); },
    byId: function (id) { return document.getElementById(id); },
    root: function () { return document.getElementById("settings"); },
    // Mount API (declareCard): the five DOM primitives the fence and the data-card stamping need.
    // Each guard is fail-closed by design: declareCard runs right after build() produced arbitrary
    // values, so a non-element handle must degrade to a no-op instead of throwing inside the very
    // path that is supposed to report other people's errors.
    make: function (tag) { return document.createElement(tag); },
    setAttr: function (el, name, value) { if (el && typeof el.setAttribute === "function") el.setAttribute(name, value); },
    text: function (el, value) { if (el) el.textContent = value; },
    append: function (parent, child) { if (parent && child) parent.appendChild(child); },
    drop: function (el) { if (el && typeof el.remove === "function") el.remove(); },
  });
})();

globalThis.SLOT_SPECS = SLOT_SPECS;
globalThis.SLOT_IDS = SLOT_IDS;
globalThis.INDEX_INLINE_SCRIPTS = INDEX_INLINE_SCRIPTS;
globalThis.createSlotRegistry = createSlotRegistry;
})();
