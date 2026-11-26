#!/usr/bin/env node
// l0/emit.mjs — 服务层 TS → classic 产物 发射器（四层架构：services/** 的浏览器通道）
// ─────────────────────────────────────────────────────────────
// 为什么需要它：services/** 是 TS 源（check-types 管、Node 22+ 可直接 import），但
// 浏览器 boot 清单加载的是 classic script。类型剥离用 Node 内置 stripTypeScriptTypes
//（无第三方依赖、无 tsc：tsc 不进内环）。
//
// 接线模板 = l0/wiring/<name>.js 真实文件（2026-11-14 从内嵌字符串数组迁移为文件：
// 引号嵌套在字符串数组里是转义地狱，改三次错三次；文件版可读、可审、可测）。
// 产物 = 剥离体 + 接线文件内容，字节比对兜底。
//
// 约束与降级：
//   · TS 源必须「可擦除」（无 enum / namespace / 参数属性）—— 剥离器遇到不可擦语法
//     会直接抛错（fail-closed）；
//   · 剥离后把顶层 `export` 前缀去掉（classic 无 export），产物底部接接线文件；
//   · CI 是 Node 20 没有剥离 API：--check 在无剥离 API 时跳过并提示（产物已入库，
//     不会假绿）；--write 在无剥离 API 时红（改源不重发射必须红，不许静默）。
//
// 用法：
//   node l0/emit.mjs            # 报告（每个服务：产物是否与源同步）
//   node l0/emit.mjs --check    # 有漂移 → 退出码 1
//   node l0/emit.mjs --write    # 重发射入库
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 静态导入 + 运行时探测：Node 20（CI）没有这个 API → 优雅降级；
// 之前用动态 import 在 Windows Node 24 上触发 libuv 断言崩溃（进程退出竞态），勿改回去。
import * as nodeModule from "node:module";
import { WIRING_PARTS } from "./wiring-parts.mjs";
const stripTypeScriptTypes = typeof nodeModule.stripTypeScriptTypes === "function" ? nodeModule.stripTypeScriptTypes : null;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 服务 → 接线文件（相对仓根）。新增服务 = 加一行 + 写一个 l0/wiring/<name>.js。
 * 拆分大件走 l0/wiring-parts.mjs 的 WIRING_PARTS；命中时忽略本表登记的单文件内容，但仍要求
 * 本表登记宿主文件（保持登记表可解析、测试有锚）。 */
const WIRINGS = {
  // Platform port (B4): the only shell-name reader; must load before version-painter and every
  // other Tauri consumer in l0/scripts.json.
  "services/platform/tauri.ts": "l0/wiring/tauri.js",
  // Unified storage port (T2): the facade picks an adapter, the three adapters register themselves,
  // and db-http is the only HTTP implementation (d1 = same origin, node = sidecar origin + token).
  // Boot order (l0/scripts.json): runtime → db → db.js (facade) → db-search → db-http → the three
  // adapters. The facade may precede the adapters because it resolves on the first get().
  "services/platform/db.ts": "l0/wiring/db.js",
  "services/platform/db-http.ts": "l0/wiring/db-http.js",
  "services/platform/db-d1.ts": "l0/wiring/db-d1.js",
  "services/platform/db-node.ts": "l0/wiring/db-node.js",
  "services/platform/db-tauri.ts": "l0/wiring/db-tauri.js",
  // Hot-window KV (T4-B): synchronous mirror + coalescing write queue over the shell's kv_* commands,
  // preloaded once; the web sibling is localStorage with the same port shape. Boot row sits with the
  // storage block, before auth, because the host provider's key seam reads it and the first-run
  // wizard (loaded late) writes its flags there.
  "services/platform/storage.ts": "l0/wiring/storage.js",
  // Host provider (T4-B): decides transport/key/db for the fixed-origin shell, installs the fetch
  // router for the existing relative /api|/sync|/img call sites, and reads /api/runtime when T4-C
  // ships (a missing endpoint is a recorded fallback, never a boot failure). MUST load before
  // services/auth/token.js so the auth wrapper sees the already-rewritten URL.
  "services/platform/host.ts": "l0/wiring/host.js",
  // First-run wizard (T4-B): should-show / step / key-validation decisions here; the modal, the shell
  // calls and the legacy localStorage writes in the wiring. Loads after providersSvc and settings.
  "services/platform/oobe.ts": "l0/wiring/oobe.js",
  // Deploy executor (T4-C 2026-11-28): declarative packs, dry-run preview, journaled resume,
  // verify-fail stop and LIFO rollback. Ports arrive per call from the settings card.
  "services/platform/deployer.ts": "l0/wiring/deployer.js",
  "services/cost/ledger.ts": "l0/wiring/cost.js",
  // Session event truth (T3-D, 2026-11-28): append-only `session_events` plus the same-transaction
  // `messages` projection; `replay` rebuilds the projection and repairs a missing `turn/end` once.
  // The DbPort is late-bound because this script loads before the app but after the facade.
  "services/session/events.ts": "l0/wiring/session-events.js",
  // Backup / restore (T3-E): full-table ZIP export and wholesale import that rebuilds the message
  // and summary projections from `session_events` via the service above. Ports: DbPort, the two
  // ZIP cores (lazy-loaded), the session-events truth and an alert channel. The card and the two
  // platform exits live in the wiring.
  "services/data/backup.ts": "l0/wiring/backup.js",
  "services/session/store.ts": "l0/wiring/session.js",
  "services/conv/store.ts": "l0/wiring/conv.js",
  // Per-conversation prior summaries (2026-11-25): the table, the one-shot legacy migration and
  // the delete/clear cascades; the host keeps only the synchronous in-memory mirror.
  "services/conv/summary.ts": "l0/wiring/conv-summary.js",
  "services/usage/stats.ts": "l0/wiring/usage.js",
  "services/conv/autoname.ts": "l0/wiring/autoname.js",
  "services/memory/core.ts": "l0/wiring/memory.js",
  // Memory settings (2026-11-25): defaults/clamps in one table; mounted on __memCore.config.
  "services/memory/config.ts": "l0/wiring/memory-config.js",
  // End-of-reply auto writer (2026-11-26): one decision point for the agent turn and ordinary chat.
  "services/memory/auto-write.ts": "l0/wiring/memory-auto.js",
  // B3（2026-11-14）：char-memory L3/L4 层并入 memory 域。T3-A（2026-11-28）：底座换 kb_* SQL，
  // 一次性 IDB 迁移与 v1 导入 UI 在接线层
  "services/memory/char-memory.ts": "l0/wiring/char-memory.js",
  // B1 chat 域（2026-11-14）：实现迁 services/chat/，冻结名在接线层继续挂
  "services/chat/retry.ts": "l0/wiring/retry.js",
  "services/chat/request.ts": "l0/wiring/request.js",
  "services/chat/text-format.ts": "l0/wiring/text-format.js",
  "services/chat/reasoning.ts": "l0/wiring/reasoning.js",
  // chat 域剩余存量（2026-11-14 并行搬迁）：源 services/chat/*.ts，冻结名在接线层继续挂
  "services/chat/markdown.ts": "l0/wiring/markdown.js",
  "services/chat/pipeline.ts": "l0/wiring/pipeline.js",
  "services/chat/context.ts": "l0/wiring/context.js",
  // Auto-compaction runner (2026-11-26): pairing-safe cutoff, shared by ordinary chat and agent.
  "services/chat/compact.ts": "l0/wiring/chat-compact.js",
  // Turn formalization (T4-A, 2026-11-28): the pure send/cancel/retry plan and the five turn trace
  // events. Both are decision-only products; the send paths execute what they return.
  "services/chat/turn-plan.ts": "l0/wiring/turn-plan.js",
  "services/chat/turn-events.ts": "l0/wiring/turn-events.js",
  // Chat attachments (2026-11-15): DOCX/XLSX/CSV text extraction, ZIP reader as a port.
  "services/chat/doc-extract.ts": "l0/wiring/doc-extract.js",
  // Image quota (2026-11-15): daily counter arithmetic here, fetch interception in the wiring.
  "services/image/quota.ts": "l0/wiring/image-quota.js",
  // Image prompt cache (2026-11-15): TTL/LRU arithmetic here, fetch replay in the wiring.
  "services/image/cache.ts": "l0/wiring/image-cache.js",
  // Image portrait (2026-11-15): prompt composition here, provider call and base-image hand-off
  // in the wiring.
  "services/image/portrait.ts": "l0/wiring/image-portrait.js",
  // Chat photos (2026-11-15): chat semantics only; the pipeline module stays a classic script.
  "services/image/chat.ts": "l0/wiring/image-chat.js",
  // Image channels (2026-11-15): channel data and its merge stamps here, localStorage in the wiring.
  "services/image/channels.ts": "l0/wiring/image-channels.js",
  // Image pipeline (2026-11-15): request shapes and workflows here, every fetch in the wiring.
  "services/image/common.ts": "l0/wiring/image-common.js",
  // Avatars and expression packs (2026-11-15): map/instruction semantics here, the edit call and
  // both settings cards in the wirings.
  "services/image/avatar.ts": "l0/wiring/image-avatar.js",
  "services/image/expressions.ts": "l0/wiring/image-expressions.js",
  // One-click generation (2026-11-15): prompt templates and SSE parsing here, panels in the wiring.
  "services/image/quickgen.ts": "l0/wiring/image-quickgen.js",
  // Local album (2026-11-15): capture/eviction policy here, IndexedDB and the modal in the wiring.
  "services/image/album.ts": "l0/wiring/image-album.js",
  // Workshop gallery (2026-11-15): metadata list semantics here, storage and the tab in the wiring.
  "services/image/gallery.ts": "l0/wiring/image-gallery.js",
  // Chat photo signals (2026-11-15): marker parsing and send policy here, bubbles in the wiring.
  "services/image/chat-text.ts": "l0/wiring/chat-image-text.js",
  // Channel card (2026-11-15): draft building and validation here, the panes in the wiring.
  "services/image/channels-ui.ts": "l0/wiring/image-channels-ui.js",
  // Workshop shell (2026-11-15): resolution table, request plans and badge strings here, DOM in the
  // wiring.
  "services/image/embed.ts": "l0/wiring/image-embed.js",
  // Access token (2026-11-15): which URLs carry it and how a password attempt is judged here, the
  // store and the fetch wrapper in the wiring.
  // Access token (2026-11-15): which URLs carry it and how a password attempt is judged here, the
  // store and the fetch wrapper in the wiring.
  "services/auth/token.ts": "l0/wiring/auth.js",
  // Developer console (2026-11-15): capture ring, SSE re-assembly, record shaping and export
  // composition in the engine; fetch interception, IndexedDB and every panel surface in the wiring.
  "services/dev/console.ts": "l0/wiring/dev.js",
  // Private mode (2026-11-15): derived content mode and the write/remove plans here, DOM in the wiring.
  "services/auth/unlock.ts": "l0/wiring/unlock.js",
  // Turn registry (2026-11-15): the whole lifecycle here, the frozen global name in the wiring.
  "services/agent/turn-runtime.ts": "l0/wiring/turn-runtime.js",
  // Top-level mode (2026-11-15): payload assembly and conversation follow here, the button in the wiring.
  "services/conv/app-mode.ts": "l0/wiring/app-mode.js",
  // Status panel (2026-11-15): snapshot math and section HTML here, both hosts and the refresh loop
  // in the wiring.
  "services/ui/status-panel.ts": "l0/wiring/status-panel.js",
  // Theme (2026-11-15): style/scheme derivation, track tables and deck persistence here; the DOM
  // apply, Web Audio mixer and settings wiring stay here.
  "services/ui/theme.ts": "l0/wiring/theme.js",
  // Chat UX (2026-11-15): turn-delete span, sidx parsing, resend give-up and scroll-follow rules
  // here; the row buttons, observers and scroll listeners in the wiring.
  "services/ui/chat-ux.ts": "l0/wiring/chat-ux.js",
  // Chat appearance (2026-11-17): the per-device font / text-effects plan (option normalization,
  // preset lookup, preview payload) here; localStorage and the DOM in the wiring.
  "services/ui/chat-appearance.ts": "l0/wiring/chat-appearance.js",
  // Chat extras (2026-11-17): quote/code-block action menus and jump-back card rules here; the
  // bubble listeners, clipboard and scroll hand-off in the wiring.
  "services/ui/chat-extras.ts": "l0/wiring/chat-extras.js",
  // Settings footer keeper (2026-11-17): keeps the version tag and footer at the end of the
  // settings panel; runs once at boot, no frozen contract.
  "services/ui/settings-footer-keeper.ts": "l0/wiring/settings-footer-keeper.js",
  // Tool-page sidebar (2026-11-25): catalog parsing, the defensive re-sort, field coercion and the
  // icon fallback here; every DOM lookup and append in the wiring.
  "services/ui/tools-pages.ts": "l0/wiring/tools-pages.js",
  // Settings generation parameters (2026-11-17): overlay parse/merge/presets here ("blank means do
  // not interfere"); localStorage and the card's inputs in the wiring/settings.js.
  "services/ui/settings-gen-params.ts": "l0/wiring/settings-gen-params.js",
  // Settings toggles (2026-11-17): the switch table (key/polarity/class) and its two polarities
  // here; checkboxes, <html> class flips and localStorage in the wiring.
  "services/ui/settings-toggles.ts": "l0/wiring/settings-toggles.js",
  // Settings category nav (2026-11-17): the visibility gates (dev mode, shell-only voice tab) and
  // the remembered-category fallback here; tab DOM and localStorage in the wiring.
  "services/ui/settings-cat-nav.ts": "l0/wiring/settings-cat-nav.js",
  // Settings card order (2026-11-18): the frozen mount order with one ordering reason per card;
  // the panel walks the plan through its mapping table instead of line-ordered calls.
  "services/ui/settings-card-order.ts": "l0/wiring/settings-card-order.js",
  // Settings autoname (2026-11-18): the master/sub gating rule and its two mixed-polarity keys
  // here; checkboxes in the settings wiring.
  "services/ui/settings-autoname.ts": "l0/wiring/settings-autoname.js",
  // Agent-personalization instruction budget (2026-11-21): byte cap, trim/empty-save rule and the
  // trimmed read shared by settings.js (write) and engine/app.js (request injection); IO in wiring.
  "services/ui/settings-personalize.ts": "l0/wiring/settings-personalize.js",
  // Agent tools settings (2026-11-21): access-mode whitelist, round ceiling and tool-profile rules,
  // shared with services/agent/registry.ts on the read side; storage IO stays in the wiring.
  "services/ui/settings-agent-tools.ts": "l0/wiring/settings-agent-tools.js",
  // Chat-background settings (2026-11-21): stored bg shape, asymmetric slider parsing, centre label,
  // upload ceiling and apply/clear key rules; DOM, file picker and status text stay in settings.js.
  "services/ui/settings-background.ts": "l0/wiring/settings-background.js",
  // Appearance-tab polarities (2026-11-25): mobile-tabs default depends on the Android shell, rich
  // effects are opt-in, idle memory is opt-out and language is en/zh. localStorage and the DOM stay
  // in settings.js; the bridge is a non-`__` global.
  "services/ui/settings-appearance.ts": "l0/wiring/settings-appearance.js",
  // DeepSeek kit switches (2026-11-25): two keys and the literal-"1" rule here; localStorage and the
  // cards in settings.js. Shared with prompt-profile's deepseekKitPayload read side.
  "services/ui/settings-deepseek-kit.ts": "l0/wiring/settings-deepseek-kit.js",
  // Persona switch (2026-11-25): the missing-means-on default here; localStorage and the broadcast
  // in settings.js. Shared with engine/app.js's cached useBuiltin reader.
  "services/ui/settings-persona.ts": "l0/wiring/settings-persona.js",
  // Settings page shell (2026-11-25): page-level keys, the synced-control table and the open/sync
  // normalizations here; the whole settings panel (cards, dialogs, listeners) is the wiring.
  "services/ui/settings.ts": "l0/wiring/settings.js",
  // Deploy card + first-connect notice (T4-C 2026-11-28): pack catalogue, copy and preview text
  // here; pack fetch, backupSvc/syncSvc, localStorage and the three-way choice in the wiring.
  "services/ui/settings-deploy.ts": "l0/wiring/settings-deploy.js",
  // Agent console (2026-11-25): event plans, status labels, formatting, the permission signature
  // and the write_file card shape here; elements, styles, timers and permission promises in the wiring.
  "services/ui/agent-console.ts": "l0/wiring/agent-console.js",
  // Group chat (2026-11-25): @-mention matching, relay switches, the orchestration gate and the
  // group-chat prompt fragment here; app.js keeps the cards/storage reads and the send loop.
  "services/conv/group-chat.ts": "l0/wiring/group-chat.js",
  // Model caps (2026-11-25): the screenshot-vision override and the known vision families here;
  // app.js reads the switch and passes the active model id.
  "services/chat/model-caps.ts": "l0/wiring/model-caps.js",
  // System prompts (2026-11-26): preset filtering/sort/COT-in-fast and the agent-mode predicate
  // here; app.js reads the preset JSON and the card's presetIds snapshot.
  "services/chat/system-prompts.ts": "l0/wiring/system-prompts.js",
  // Auto relay (2026-11-26): summon tag, barge pick, subset drop and the three delay formulas here;
  // app.js keeps the loop, typing, cancellation and sendOne.
  "services/conv/auto-relay.ts": "l0/wiring/auto-relay.js",
  // Chat engine shell (2026-11-26): restore guard, summary normalization and flush debounce here;
  // the whole chat engine (DOM rows, SSE, billing, turns, agent loop) is the wiring.
  "services/chat/app.ts": "l0/wiring/app.js",
  // Settings data-layer trio (2026-11-25): each key's normalization lives once in the service and
  // is shared with its read-side consumer via an equivalence lock (prompt-profile / source-tools);
  // localStorage + hostname IO stay in the wiring. Non-`__` globals keep the frozen contract surface.
  "services/ui/settings-web-search.ts": "l0/wiring/settings-web-search.js",
  "services/ui/settings-dev-tools.ts": "l0/wiring/settings-dev-tools.js",
  "services/ui/settings-base-id.ts": "l0/wiring/settings-base-id.js",
  // Multi-agent orchestration card (2026-11-25): the three switch defaults ("absent = on") and three
  // numeric caps, with the meetingMax default unified at 3 against peer-calls' read side. The six
  // keys and their clamps live once here; the switch/cap DOM loops stay in settings.js.
  "services/ui/settings-multi-agent.ts": "l0/wiring/settings-multi-agent.js",
  // Custom-pricing card (2026-11-25): the `cfw_custom_pricing_v1` object guard and price validation
  // live once here, shared with cost/ledger's getCustomPricing via an equivalence lock. DOM stays in settings.js.
  "services/ui/settings-custom-pricing.ts": "l0/wiring/settings-custom-pricing.js",
  // Reply-style card (2026-11-25): the three-value whitelist and default live once here, shared
  // with chat/request, peer-calls and app-mode's rp read via an equivalence lock. <select> DOM stays in settings.js.
  "services/ui/settings-reply-style.ts": "l0/wiring/settings-reply-style.js",
  // Tool mode card row (2026-11-19): the full/directory gate, the effective-mode display rule and
  // the row model here; localStorage, the row DOM and the attach glue in the wiring.
  "services/ui/tool-mode-card.ts": "l0/wiring/tool-mode-card.js",
  // Left sidebar toggle (2026-11-17): the mobile drawer open/close plan (auto-close decision and
  // Escape gate) here; listeners, matchMedia and the 60ms delay in the wiring.
  "services/ui/left-sidebar-toggle.ts": "l0/wiring/left-sidebar-toggle.js",
  // Android shell marker (2026-11-17): the class plan from query param and storage here;
  // URLSearchParams, localStorage, classList and the three rebind events in the wiring.
  "services/ui/android-mark.ts": "l0/wiring/android-mark.js",
  // Version painter (2026-11-17): shell-version read (plugin API then raw invoke) and the paint
  // plan here; __TAURI__ access, text sinks and the environment version mirror in the wiring.
  "services/ui/version-painter.ts": "l0/wiring/version-painter.js",
  // Agent trace boot (2026-11-17): the bounded install poll (40 x 100ms) and the ready gate here;
  // window reads and the __agentTraceBoot diagnostics sink in the wiring.
  "services/agent/trace-boot.ts": "l0/wiring/trace-boot.js",
  // Settings orphan sweeper (2026-11-17): the orphan decision and sweep counting here; lookups,
  // the MutationObserver, the click re-sweep and adoptions in the wiring.
  "services/ui/settings-orphan-observer.ts": "l0/wiring/settings-orphan-observer.js",
  // Choices (2026-11-15): the [选项] block parser, bullet stripper, option normalization and the
  // auto-scan gate here; the stylesheet, panel DOM, send fallback chain, bubble TreeWalker strip
  // and the scanning observer in the wiring.
  "services/ui/choices.ts": "l0/wiring/choices.js",
  // Attachments (2026-11-15): formatting, type colors, pending partition, restage plan, GC
  // keep-list, token estimation, fold threshold and expansion arithmetic here; the SQLite
  // attachments store (text/body split + one-time IndexedDB import), lightbox gestures,
  // pending-strip DOM and the async IO orchestration in the wiring.
  "services/ui/attachments.ts": "l0/wiring/attachments.js",
  // Message list (2026-11-15): spacer math, near-bottom threshold, tool-turn collector, empty
  // shells, bubble hide/remove, stats lines and speaker cards here; the row factory, clear
  // whitelist, RAF scroll and the render loop in the wiring.
  "services/ui/message-list.ts": "l0/wiring/message-list.js",
  // Conv list (2026-11-15): relative-time labels, the content signature, both redraw gates,
  // preview/title copy, menu placement geometry and the rename commit rule here; the sidebar
  // mount, stylesheet, row/menu/rename DOM and the poll/event wiring stay here.
  "services/ui/conv-list.ts": "l0/wiring/conv-list.js",
  // Mobile shell (2026-11-16): scroll-to-hide decisions, menu placement and layout choice here;
  // the scroll listener, rAF throttle, node moves and matchMedia in the wiring.
  "services/ui/mobile-shell.ts": "l0/wiring/mobile-shell.js",
  // Sidebar fold groups (2026-11-16): the wrap plan, fold resolution and toggle rules here; the
  // nav scan, wrapper nodes, stylesheet, listeners and observer in the wiring.
  "services/ui/sidebar-groups.ts": "l0/wiring/sidebar-groups.js",
  // Tab strips (2026-11-16): both strips answer "what should the whole strip look like after this
  // tap", never "what to do to the clicked button"; the mobile strip also owns the body flag that
  // CSS reads. Query passes, listeners and the three automatic switches stay in the wirings.
  "services/ui/mobile-tabs.ts": "l0/wiring/mobile-tabs.js",
  "services/ui/right-sidebar-tabs.ts": "l0/wiring/right-sidebar-tabs.js",
  // Prompt editor (2026-11-16): preset ordering/grouping, library merge, JSON-source validation,
  // SillyTavern preset import, card mapping both ways, PNG chunks, world-row summaries and the import
  // report here; the modal, three panes, file inputs and drag-and-drop in the wiring.
  "services/ui/prompt-editor.ts": "l0/wiring/prompt-editor.js",
  // Roleplay checkpoint plan (2026-11-18): entry sorting, pre-restore arguments and the refusal
  // text; pure functions, bridged onto globalThis for the DOM glue in js/text/ui.
  "services/ui/roleplay-checkpoint-plan.ts": "l0/wiring/roleplay-checkpoint-plan.js",
  // Roleplay checkpoint UI (2026-11-25): the save/restore/list flow and every outcome here; the row
  // decoration, dialog, toast and MutationObserver in the wiring. Declares the plan bridge above.
  "services/ui/roleplay-checkpoint-ui.ts": "l0/wiring/roleplay-checkpoint-ui.js",
  // Group-chat empty-state CTA (2026-11-16): the live-first / storage-fallback mode read and the
  // two-state button+copy plan here; DOM lookups, literal guidance strings and listeners stay in the
  // wiring. Publishes no global — the row's contract is the DOM it owns.
  "services/ui/fishbowl-cta.ts": "l0/wiring/fishbowl-cta.js",
  // Chat attachments (2026-11-15): the pending-attachment state machine, message metadata
  // shaping, token estimation and the request-assembly expansion here; the SQLite attachment
  // store (legacy IndexedDB only as fallback/source), the chip/card DOM, the lightbox gestures,
  // the pending strip and the facade in the wiring.
  "services/ui/attachments.ts": "l0/wiring/attachments.js",
  // Fishbowl (2026-11-15): tag parsing, name matching, speaker selection and limits here; the run
  // loop, LS accessors and hostApi calls in the wiring.
  "services/agent/fishbowl.ts": "l0/wiring/fishbowl.js",
  // Agent steps (2026-11-15): the brief line, step/panel states, summary text and the replay
  // dispatch here; CSS, DOM builders and the live controller in the wiring.
  "services/agent/steps.ts": "l0/wiring/agent-steps.js",
  // Work/History core (2026-11-17): trace -> story/presence, time-ordered playback and the
  // History lane/SVG layout. Pure modules; no window.__* contract and no boot row until the panel.
  "services/agent/story.ts": "l0/wiring/agent-story.js",
  "services/agent/playback.ts": "l0/wiring/agent-playback.js",
  "services/ui/history-tree.ts": "l0/wiring/agent-history-tree.js",
  // B2 model-router 域（2026-11-14）：providers/provider-merge/model-catalog/model-think
  "services/model-router/provider-merge.ts": "l0/wiring/provider-merge.js",
  "services/model-router/providers.ts": "l0/wiring/providers.js",
  "services/model-router/model-think.ts": "l0/wiring/model-think.js",
  "services/model-router/model-catalog.ts": "l0/wiring/model-catalog.js",
  // A31 agent-host（2026-11-14）：循环体迁 services/agent/turn.ts（2026-11-17 目录并入 agent/），冻结名 __agentTurn 新契约
  "services/agent/turn.ts": "l0/wiring/agent-turn.js",
  // T4-A: the per-turn compiled tool set with pre/execute/post (scoped registry, unload on dispose).
  "services/agent/tool-runtime.ts": "l0/wiring/tool-runtime.js",
  // agent 域存量（2026-11-14 并行搬迁）：重试+看门狗循环迁 services/agent/call-loop.ts
  "services/agent/call-loop.ts": "l0/wiring/call-loop.js",
  "services/agent/events.ts": "l0/wiring/agent-events.js",
  "services/agent/registry.ts": "l0/wiring/agent-registry.js",
  // agent 域第七块砖（2026-11-15）：平级角色模型调用原语迁 services/agent/peer-calls.ts
  "services/agent/peer-calls.ts": "l0/wiring/agent-peer-calls.js",
  // agent 域第八块砖（2026-11-15）：三个动作的编排（小会/耳语/上台）迁 services/agent/peer-actions.ts
  "services/agent/peer-actions.ts": "l0/wiring/agent-peer-actions.js",
  // agent 域第九块砖（2026-11-17）：工具调用内核（注册表 + while 循环）迁 services/agent/agent-kernel.ts
  "services/agent/agent-kernel.ts": "l0/wiring/agent-kernel.js",
  // B2 C-3（2026-11-19）：policy 域入 emit 通道 —— 编译器/registry 适配器/tool_search 运行时/模式接线。
  // 依赖靠 emit 的 globalThis 桥 + boot 顺序（tool-policy 在前），跨文件 import 一律改 declare const。
  "services/policy/tool-policy.ts": "l0/wiring/tool-policy.js",
  "services/policy/registry-adapter.ts": "l0/wiring/policy-adapter.js",
  "services/policy/tool-search.ts": "l0/wiring/tool-search.js",
  "services/policy/tool-mode.ts": "l0/wiring/tool-mode.js",
  // data 域第一块砖（2026-11-14 深夜）：基座/中性/状态层/角色能力/生成参数/联网
  "services/data/prompt-profile.ts": "l0/wiring/prompt-profile.js",
  // data 域第二、三块砖（2026-11-15）：设定集数据层 + /api/chat 流式调用（SSE 单一实现）
  "services/data/lorebook.ts": "l0/wiring/lorebook.js",
  "services/data/chat-stream.ts": "l0/wiring/chat-stream.js",
  // data 域第四块砖（2026-11-15）：Agent 文件工作区迁 services/data/agent-workspace.ts
  // 2026-11-28 T3-C：存储从 IDB 换到统一 SQLite 三表（现行文件 / 追加版本 / 内容寻址正文），
  // 旧 IDB 只在缺 0003 表的宿主回退并一次性导入后删库；接线层负责三张表的行映射与迁移。
  "services/data/agent-workspace.ts": "l0/wiring/agent-workspace.js",
  // 预设数据层统一（2026-11-25）：cfw_prompt_presets_v1 的 load/save/uid/order 唯一实现；save 经
  // 接线层的 onSave 触发 touchSync，修掉 agent 建/改预设漏推云同步的 bug。须先于 tools.js 与
  // prompt-editor.js 加载；桥点 window.presetStore 刻意不带 __ 前缀，冻结契约面保持 137。
  "services/data/presets.ts": "l0/wiring/presets.js",
  // Checkpoints (2026-11-17): roleplay/work/sandbox 的通用存档信封与内容寻址 blob；
  // roleplay 适配器与三个 host hook 同批，work/sandbox 适配器后续接。
  "services/data/checkpoints.ts": "l0/wiring/checkpoints.js",
  // data 域第五块砖（2026-11-15）：实时聊天事件通道迁 services/data/chat-realtime.ts
  "services/data/chat-realtime.ts": "l0/wiring/chat-realtime.js",
  // data 域第四块砖（2026-11-15）：角色卡数据层 + 角色卡面板（UI 随接线层下发）
  "services/data/character.ts": "l0/wiring/character.js",
  // data 域收尾（2026-11-15）：云同步引擎五通道（main blob / cost / exclude / chat / chars）
  "services/data/sync.ts": "l0/wiring/sync.js",
  // Shared sync logic (2026-11-17): event diffing and the character conflict merge move out of
  // public/shared/sync/. Both keep their frozen global names; the wirings only publish them.
  "services/sync/chat-events.ts": "l0/wiring/chat-events.js",
  "services/sync/char-sync-merge.ts": "l0/wiring/char-sync-merge.js",
  // scene domain (2026-11-15): multi-character mode, stage membership and summon-by-name move to
  // services/scene/multi-agent.ts; the group-chat console and the topbar toggle stay in the wiring.
  "services/scene/multi-agent.ts": "l0/wiring/scene-multi-agent.js",
  // Topbar mode pill (2026-11-16): the pill text/glyph/tooltip per channel state and the mode a click
  // moves to here; providers/auth reads, localStorage and the DOM in the wiring.
  "services/ui/channel-mode.ts": "l0/wiring/channel-mode.js",
  // Composer (2026-11-16): send-button shape, `@` query/insertion, candidate filtering and stepping,
  // keyboard inset and popup placement here; the textarea, popup node, rAF throttle and CSS variable
  // in the wiring.
  "services/ui/composer.ts": "l0/wiring/composer.js",
  // Conversation lifecycle (2026-11-15): switch/create/rename/delete, remote apply, the memory-slot
  // cache and the render hand-off here; canonical session ownership, the turn-mirror and turn
  // teardown stay in the engine.
  "services/conv/lifecycle.ts": "l0/wiring/conv-lifecycle.js",
  // Autopilot (2026-11-15): mode gate, director prompt, exclusivity snapshot, caps and
  // pacing here; localStorage, the send loop, TTS gating and choice chips in the wiring.
  "services/agent/autopilot.ts": "l0/wiring/autopilot.js",
  // Group chat (2026-11-15): membership diff, name rules and every HTML fragment here;
  // stylesheet, DOM creation, events and the frozen global in the wiring.
  "services/ui/wechat-group.ts": "l0/wiring/wechat-group.js",
  // Agent-mode orchestrator (2026-11-15): mode flag, button state, console health, target
  // container, external-settings keys and startup plan here; mounting in the wiring.
  "services/ui/agent-mode-orchestrator.ts": "l0/wiring/agent-mode-orchestrator.js",
  // Boot rules batch (2026-11-15): startup scripts keep DOM wiring here; pure decisions
  // (effort aliases, sync status, greeting, nav category, collapse state) live in services.
  "services/ui/think-level-map.ts": "l0/wiring/think-level-map.js",
  "services/ui/sync-indicator.ts": "l0/wiring/sync-indicator.js",
  "services/ui/welcome-greeting.ts": "l0/wiring/welcome-greeting.js",
  "services/ui/settings-nav-init.ts": "l0/wiring/settings-nav-init.js",
  "services/ui/sidebar-collapse.ts": "l0/wiring/sidebar-collapse.js",
  // Cost log card (2026-11-16): bucket folding, the four windows and both HTML fragments here; the
  // slot mount, the three buttons and the facade/localStorage reads in the wiring.
  "services/ui/cost-log.ts": "l0/wiring/cost-log.js",
  // Reply pacing (2026-11-16): the debounce timing and the group answer plan here, the timers, the
  // typing row and the storage reads in the wiring.
  "services/ui/pacing.ts": "l0/wiring/pacing.js",
  // Thinking policy (2026-11-16): table compilation, request fields and menu rows here; the toggle
  // button, the popup and the channel lookups in the wiring.
  "services/ui/think-control.ts": "l0/wiring/think-control.js",
  // Read/search windowing (2026-11-17): slicing, glob translation, literal/regex search and output
  // budgeting here; the wiring only publishes the frozen port for the workspace adapter.
  "services/agent/text-search.ts": "l0/wiring/text-search.js",
  // File export boundary (2026-11-17): shell-vs-browser decision, result shapes and the base64 split
  // here; the Tauri probe, the Blob/anchor lifetime and the frozen global in the wiring.
  "services/save-file.ts": "l0/wiring/save-file.js",
  // Local-exec tools (2026-11-17): the four tool descriptors, request shapes and setup hint here;
  // localStorage, fetch and the desktop probe in the wiring. The published tool-group object keeps
  // its frozen name and three members.
  "services/local/local-exec-tools.ts": "l0/wiring/local-exec-tools.js",
  // Remote desk (2026-11-17): the sixteen tool descriptions, the clamps and every result string here;
  // the gate storage, the Web/desktop split, both deadlines and the image hooks in the wiring.
  "services/local/pc-tools.ts": "l0/wiring/pc-tools.js",
  // Remote-PC settings card (2026-11-17): card markup, placement, the health/status line, failure
  // copy and the three toggle plans here; localStorage, fetch, the shell probe and the listeners in
  // the wiring.
  "services/local/pc-settings-card.ts": "l0/wiring/pc-settings-card.js",
  // Content-canvas tools (2026-11-17): the five tool texts, their size caps and result wording
  // here; the facade lookup and the group bridge in the wiring.
  "services/ui/stage-tools.ts": "l0/wiring/stage-tools.js",
  // Local service card (2026-11-17): row markup, the list rule and the action plan here; the shell
  // probe, the invoke port, the status line and the mount in the wiring.
  "services/local/service-manager.ts": "l0/wiring/service-manager.js",
  // Top-bar billing button (2026-11-17): the mode gate, both amount spellings, the card markup and the
  // placement arithmetic here; the two elements, the listeners and the facade reads in the wiring.
  "services/ui/topbar-cost.ts": "l0/wiring/topbar-cost.js",
  // Agent tool kit (2026-11-21): the tool bodies, their permission gates and the reach transports
  // live here; storage, fetch, DOM and the frozen global names stay in the wirings. skills.ts owns
  // the catalogue, the SKILL.md parser and the enable flags — the settings card it renders stays in
  // the wiring, which calls back through onChange().
  "services/agent/source-tools.ts": "l0/wiring/source-tools.js",
  "services/agent/reach.ts": "l0/wiring/agent-reach.js",
  "services/agent/ambient-tools.ts": "l0/wiring/ambient-tools.js",
  "services/agent/env-context.ts": "l0/wiring/env-context.js",
  "services/agent/skills.ts": "l0/wiring/skills.js",
  // Skill-package import (2026-11-24): path/size/conflict gates here, the store and the lazily
  // loaded ZIP reader arrive as per-call ports; the facade keeps its frozen name in the wiring.
  "services/agent/skills-import.ts": "l0/wiring/skills-import.js",
  // B7 workflow (2026-11-24): schema validation and the step machine move to services; the runner
  // takes the schema as an injected port, and both frozen names stay mounted in the bindings.
  "services/agent/workflow-schema.ts": "l0/wiring/workflow-schema.js",
  "services/agent/workflow-runner.ts": "l0/wiring/workflow-runner.js",
  "services/agent/job-tools.ts": "l0/wiring/job-tools.js",
  "services/agent/council-tools.ts": "l0/wiring/council-tools.js",
  "services/agent/trace.ts": "l0/wiring/agent-trace.js",
  // Desktop tool set (2026-11-21): the local_* tools, their descriptions and the working-directory
  // gate here; the Tauri invoke is resolved per call in the wiring, because the shell may inject
  // `__TAURI__` after this script runs and registration happens when the registry is built.
  "services/agent/agent-local-tools.ts": "l0/wiring/agent-local-tools.js",
  // Sub-agent delegation (2026-11-21): the recursion ceiling, the child's least-privilege profile,
  // the event pair and the error normalisation here. It used to be 70 lines inside tools.js; it is
  // still a tool the agent chooses to call, which is why it sits under tools/ rather than in the
  // multi-agent domain — a peer is a role card, this is a worker the agent spins up itself.
  "services/tools/agent/subagent/index.ts": "l0/wiring/tool-subagent.js",
  // Image tools (2026-11-21): the generation call and its hard 150s ceiling. A tool that never
  // returns hangs the whole loop and leaves the bubble spinning, so the race lives in the service
  // rather than in the tool body where it used to be copy-pasteable away.
  "services/tools/agent/image/index.ts": "l0/wiring/tool-image.js",
  // Cost and speech (2026-11-21): both are answer-shape problems — which book a number belongs to,
  // and whether absent speech is a failure. Both used to be decided inside a tool body.
  "services/tools/agent/cost/index.ts": "l0/wiring/tool-cost.js",
  "services/tools/agent/speak/index.ts": "l0/wiring/tool-speak.js",
  // Skill and choice chips (2026-11-21): both are contracts about *refusal* — "exists but not
  // enabled" must not be read as "try harder", and an empty chip list is a refusal, not a render.
  "services/tools/agent/skill/index.ts": "l0/wiring/tool-skill.js",
  "services/tools/agent/choices/index.ts": "l0/wiring/tool-choices.js",
  // Character tools (2026-11-21): the only writer of persistent relationship state, and the reason
  // `delta` and `value` are both in the result — the store clamps, so echoing the request would
  // report a change that did not happen.
  "services/tools/agent/character/index.ts": "l0/wiring/tool-character.js",
  // Data-facade tools (2026-11-25): character-card / lorebook / preset CRUD, merge rules and error
  // strings here; the tools bundle passes the three stores, the active-id read and the event bridge.
  "services/tools/agent/cards/index.ts": "l0/wiring/tool-cards.js",
  // History archive search (T3-D, 2026-11-28): query clamp, conv scoping and hit clipping here;
  // the tools bundle passes the DbPort search and the active-conversation lookup.
  "services/tools/agent/history/index.ts": "l0/wiring/tool-history.js",
  // Theme tool (2026-11-25): style whitelist, scheme literals and empty-patch rejection here; the
  // tools bundle passes the theme facade.
  "services/tools/agent/theme/index.ts": "l0/wiring/tool-theme.js",
  // Tools bundle shell (2026-11-25): the core/full/char/sub allow-lists, the multi-agent gate keys
  // and its predicate here; every tool schema and the DOM-bound tools live in the wiring.
  "services/tools/agent/tools.ts": "l0/wiring/tools.js",
  // Video story relay (2026-11-25): the 1-5 segment cap, tail-frame relay, Gitee key fallback and
  // the per-segment fetch/poll live in services/tools/agent/video. The tools bundle injects every
  // host input (document, storage, image channels, fetch, onEvent and the DOM factories), so the
  // wiring only bridges the factory name for that caller.
  "services/tools/agent/video/index.ts": "l0/wiring/tool-video.js",
  // Local speech (2026-11-21): tag stripping, sentence splitting and the emphasis/parenthetical
  // filters here; the Rust config, the port probe, synthesis and the playback queue stay in the
  // wiring, because all four are IO against the desktop shell.
  "services/media/tts-text.ts": "l0/wiring/tts.js",
  // Cloud speech (2026-11-25): config keys, voice whitelist and text chunking here; the /api/tts
  // fetch, Audio playback queue and frozen global stay in the wiring so this stays a pure decision.
  "services/media/cloud-tts.ts": "l0/wiring/cloud-tts.js",
  // Feedback surface (2026-11-21): the toast stack and the modal state machine here; the document
  // port, the stylesheet and the frozen global stay in the wiring.
  "services/ui/feedback.ts": "l0/wiring/feedback.js",
  // Sandbox views (2026-11-27): URL construction, seed/body/auto validation, page descriptors,
  // the unconfigured/mobile/cross-origin guidance here; localStorage and location.origin in the
  // wiring. The service never imports the AGPL sandbox: it only knows the two public demo paths.
  "services/sandbox/views.ts": "l0/wiring/sandbox-views.js",
  // Panel (2026-11-21): the mode/view/tab state machine, width clamping, persisted record and the
  // frame contract here; the bar, the drag handles, the two menus and the detached window stay in
  // the wirings. 2026-11-26: tab identity/persistence moved to tab-state — it loads before the frame
  // and the host, because both read `panelTabs`.
  "services/panel/tab-state.ts": "l0/wiring/tab-state.js",
  "services/panel/panel-frame.ts": "l0/wiring/panel-frame.js",
  "services/panel/panel-host.ts": "l0/wiring/panel-host.js",
};

/**
 * Core services (`core/*.ts`) write their browser product into `public/shared/core/`, not
 * `public/services/` — same emit path, different output root. The hand-written twins these
 * replace are why core upgrades used to need four manual syncs; the plan's §P1 (a) keeps the
 * products committed and lets `--check` skip on Node 20 without a strip API.
 */
const CORE_WIRINGS = {
  "core/host-api.compat.ts": "l0/wiring/host-api-compat.js",
  "core/slot-registry.ts": "l0/wiring/slot-registry.js",
  // Shared floor (2026-11-21): the escaper, the translation engine and the ZIP reader were the last
  // hand-written twins under public/shared/core/. Emitting them from core/ keeps every boot path
  // byte-identical — including the dictionary loader's /shared/core/i18n-dict.js, which stays a
  // separate data file because it is loaded lazily and only for the English UI.
  "core/escape.ts": "l0/wiring/escape.js",
  "core/i18n.ts": "l0/wiring/i18n.js",
  "core/zip-read.ts": "l0/wiring/zip-read.js",
  // Backup writer (T3-E): the mirror of the reader — deflate-raw via CompressionStream plus a
  // self-computed CRC32. Loaded on demand by the backup card, not at boot (same posture as the
  // reader), so the pairing stays "writer ↔ reader, nothing else".
  "core/zip-write.ts": "l0/wiring/zip-write.js",
  // Unified storage port (T2): the DbPort contract + wire codec, the search SQL builder, and the
  // runtime kernel's first boot consumer (the facade provides `db` into a root context).
  "core/db.ts": "l0/wiring/db-core.js",
  "core/db-search.ts": "l0/wiring/db-search.js",
  "core/runtime.ts": "l0/wiring/runtime.js",
  // Runtime manifest (T4-C 2026-11-28): profile/capabilities/limits parser, capability registry,
  // provider-starting kernel and first-connect planning; the facade + /api/runtime fetch are the
  // wiring. Loads after the storage block so `dbSvc` already exists when it boots.
  "core/runtime-manifest.ts": "l0/wiring/runtime-manifest.js",
};

/** Services + core: one emit loop, two output roots. */
const SERVICES = Object.keys(WIRINGS).concat(Object.keys(CORE_WIRINGS));

/** TS → classic：剥类型 → 去顶层 export 前缀 → 接线文件，整体包进一个 IIFE。 */
function emitOne(tsPath) {
  if (!stripTypeScriptTypes) throw new Error("本 Node 没有 stripTypeScriptTypes（需 22.13+）");
  const src = fs.readFileSync(path.join(ROOT, tsPath), "utf8");
  const stripped = stripTypeScriptTypes(src, { sourceMap: false });
  // 顶层导出的名字先记下来：它们是模块的公开面，产物末尾要桥接回全局（测试与既有调用方按名字取）；
  // 没导出的私有辅助（recOf / strOf …）不进全局，见下面的 IIFE 包裹。
  const exportedNames = [];
  for (const m of stripped.matchAll(
    /^export (?=(?:async\s+)?(?:const|let|var|function|class)\b)(?:async\s+)?(?:const|let|var|function|class) ([A-Za-z_$][\w$]*)/gm,
  )) {
    exportedNames.push(m[1]);
  }
  // 只去「顶层值导出」前缀（interface/type 已被剥离器擦掉）；
  // 作者风格约定：字符串/注释里不得出现行首的 "export const|let|var|function|class"。
  // `async function` 也是值导出：此前漏剥会在 classic 产物里留下 export 关键字
  // （装载即 SyntaxError——语法门抓得住，但先坏在测试装载）。
  const body = stripped.replace(/^export (?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, "");
  // core 与 services 共用一条发射路径，接线表也合看：先 services 后 core，互不覆盖。
  const wiringRel = Object.prototype.hasOwnProperty.call(WIRINGS, tsPath) ? WIRINGS[tsPath] : CORE_WIRINGS[tsPath];
  if (wiringRel === undefined) throw new Error(`服务 ${tsPath} 没有登记接线文件`);
  const wiringPath = path.join(ROOT, wiringRel);
  if (!fs.existsSync(wiringPath)) throw new Error(`服务 ${tsPath} 的接线文件缺失：${wiringRel}`);
  const parts = WIRING_PARTS[tsPath];
  let wiring;
  if (parts !== undefined) {
    for (const rel of parts) {
      if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`服务 ${tsPath} 的接线片段缺失：${rel}`);
    }
    wiring = parts.map((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\s*$/, "\n")).join("\n");
  } else {
    wiring = fs.readFileSync(wiringPath, "utf8").replace(/\s*$/, "\n");
  }
  // 整个产物包进 IIFE：工厂函数与私有辅助（recOf / strOf / normalize …）留在函数作用域，
  // 只有「原本 export 过的名字」和 window.__x 赋值出域。裸顶层声明在 classic 脚本里共享全局，
  // 后加载者会覆盖先加载者——2026-11-15 真窗事故：26 个产物都声明顶层 recOf，其中两处靠它
  // 返回 null 判「不是对象」，被返回 {} 的版本盖掉后世界书导入静默返回 0 条。
  // 接线文件与工厂同处一个作用域，所以闭包取工厂不受影响；接线自带的 IIFE 保留（幂等）。
  const bridge = exportedNames.map((n) => "globalThis." + n + " = " + n + ";").join("\n");
  return (
    "(function () {\n" +
    body.replace(/\s*$/, "\n") +
    "\n" +
    wiring +
    (bridge === "" ? "" : "\n" + bridge + "\n") +
    "})();\n"
  );
}

function main() {
  const argv = process.argv.slice(2);
  const has = (name) => argv.includes(name);
  const results = [];
  let drift = 0;

  for (const tsPath of SERVICES) {
    const artifactPath = tsPath.startsWith("core/")
      ? path.join(ROOT, "public", "shared", "core", tsPath.slice("core/".length).replace(/\.ts$/, ".js"))
      : path.join(ROOT, "public", tsPath.replace(/\.ts$/, ".js"));
    if (!stripTypeScriptTypes) {
      results.push({ tsPath, artifactPath, skipped: true });
      continue;
    }
    const fresh = emitOne(tsPath);
    const current = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : null;
    const dirty = current !== fresh;
    if (dirty) drift++;
    results.push({ tsPath, artifactPath, dirty, fresh });
  }

  if (has("--write")) {
    if (!stripTypeScriptTypes) {
      console.log("[l0/emit] ✗ 本 Node 没有 stripTypeScriptTypes（需 22.13+），拒绝静默跳过 --write");
      process.exit(1);
    }
    for (const r of results) {
      if (!r.skipped && r.dirty) {
        fs.mkdirSync(path.dirname(r.artifactPath), { recursive: true });
        fs.writeFileSync(r.artifactPath, r.fresh, "utf8");
        console.log(`  ~ ${path.relative(ROOT, r.artifactPath)} 已重发射`);
      }
    }
    console.log(`[l0/emit] --write 完成（${SERVICES.length} 个服务，重发射 ${results.filter((r) => !r.skipped && r.dirty).length} 个）`);
    return;
  }

  for (const r of results) {
    if (r.skipped) {
      console.log(`  - ${r.tsPath}：本 Node 无类型剥离 API，跳过核对（产物以入库版本为准）`);
      continue;
    }
    console.log(`  ${r.dirty ? "✗ 漂移" : "✓ 同步"}  ${r.tsPath} → ${path.relative(ROOT, r.artifactPath)}`);
  }
  if (has("--check")) {
    if (drift) {
      console.log(`[l0/emit] ✗ ${drift} 个服务的产物与 TS 源脱钩：本地跑 node l0/emit.mjs --write`);
      process.exit(1);
    }
    console.log("[l0/emit] --check 通过：全部产物与 TS 源一致");
    return;
  }
  console.log("[l0/emit] 只读完成（--check 报漂移 / --write 重发射）");
}

main();
