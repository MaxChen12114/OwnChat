/**
 * Group-chat panel rules: membership diff, group-name handling, the active-group predicate and
 * every HTML fragment. The wiring owns DOM creation, stylesheet injection, events and the frozen
 * global facade.
 *
 * All markup is escaped through an injected port: card names and group names come from user data
 * and are inserted into attribute and text positions, so the caller MUST supply the shared esc.
 * @module services/ui/wechat-group
 */

export const WG_LS_NAME = "cfw_wechat_group_name_v1";
export const WX_GREEN = "#07c160";
export const WX_GREEN_SOFT = "rgba(7,193,96,.14)";
/** Linear chat-bubble icon; member avatars keep their emoji. */
export const WG_SVG_CHAT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H7l-3 2v-6.2A7.4 7.4 0 0 1 3.5 12 7.5 7.5 0 0 1 11 4.5h1.5a7.5 7.5 0 0 1 7.5 7.5z"/></svg>';

export interface WgCard {
  id: string;
  icon?: string;
  name?: string;
}

/** @returns the stored group name, trimmed; a missing or non-string value is empty. */
export function wgGroupName(raw: unknown): string {
  return String(raw ?? "").trim();
}

/** @returns the value to persist; non-string input clears the name. */
export function wgNameForWrite(n: unknown): string {
  return typeof n === "string" ? n : "";
}

/** A group exists only in multi-agent mode with at least two stage members. */
export function wgIsGroupActive(isMulti: boolean, sceneCount: number): boolean {
  return isMulti && sceneCount >= 2;
}

/**
 * @returns members to remove (current order) and to add (requested order). Duplicates in the
 * requested list are intentionally not de-duplicated here: the caller owns the Set.
 */
export function wgDiffMembers(ids: string[], cur: string[]): { remove: string[]; add: string[] } {
  const want = new Set(ids);
  const remove: string[] = [];
  const add: string[] = [];
  for (const id of cur) if (!want.has(id)) remove.push(id);
  for (const id of ids) if (cur.indexOf(id) < 0) add.push(id);
  return { remove, add };
}

/** @returns the selection after toggling one id, without mutating the input. */
export function wgToggle(sel: string[], id: string): string[] {
  const out = sel.filter((x) => x !== id);
  if (sel.indexOf(id) < 0) out.push(id);
  return out;
}

/** @returns the selected-count label shown in the builder. */
export function wgCountText(n: number): string {
  return n + " 人已选";
}

/** A group needs at least two members. */
export function wgCanCreate(n: number): boolean {
  return n >= 2;
}

/** @returns one card button; esc is injected so no import is needed in the classic artifact. */
export function wgCardHtml(c: WgCard, on: boolean, esc: (s: string) => string): string {
  return '<button type="button" class="wg-card' + (on ? " on" : "") + '" data-id="' + esc(c.id) + '">'
    + '<span class="wg-card-ava">' + esc(c.icon || "🙂") + '</span>'
    + '<span class="wg-card-name">' + esc(c.name || "未命名") + '</span>'
    + '<span class="wg-card-mark">' + (on ? "✓" : "+") + '</span>'
    + '</button>';
}

/** @returns the builder panel markup. The caller binds the card/cancel/create handlers. */
export function wgBuilderHtml(cards: WgCard[], sel: string[], name: string, esc: (s: string) => string): string {
  const itemsHtml = cards.map((c) => wgCardHtml(c, sel.indexOf(c.id) >= 0, esc)).join("");
  return '<div class="wg-bd-head">' + WG_SVG_CHAT + '群聊</div>'
    + '<div class="wg-bd-body">'
    + '<div class="wg-desc">把不同世界观的角色拉进同一个群,他们能看到彼此发言、相互 @、自动接话,产生戏剧效果。勾选 ≥2 个成员即可建群。</div>'
    + '<div class="wg-flabel">群名称</div>'
    + '<input id="wgName" type="text" maxlength="24" placeholder="例如:跨次元茶话会" value="' + esc(name) + '" class="wg-name">'
    + '<div class="wg-selrow"><span class="wg-flabel" style="margin:0;">选择成员(可跨世界观)</span><span id="wgCount" class="wg-count"></span></div>'
    + '<div id="wgGrid" class="wg-grid">' + itemsHtml + '</div>'
    + '<div class="wg-foot">'
    + '<button id="wgCancel" type="button" class="wg-btn">取消</button>'
    + '<button id="wgCreate" type="button" class="wg-btn wg-btn-go">建群并进入</button>'
    + '</div>'
    + '</div>';
}

/** @returns the first five avatars plus the "+N" overflow marker. */
export function wgAvatarsHtml(cards: WgCard[], esc: (s: string) => string): string {
  return cards.slice(0, 5)
    .map((c) => '<span class="wg-h-av" title="' + esc(c.name || "") + '">' + esc(c.icon || "🙂") + '</span>')
    .join("")
    + (cards.length > 5 ? '<span class="wg-h-extra">+' + (cards.length - 5) + '</span>' : '');
}

/** @returns the sticky header markup; an empty group name falls back to the default label. */
export function wgHeaderHtml(cards: WgCard[], name: string, esc: (s: string) => string): string {
  return '<div class="wg-h-avs">' + wgAvatarsHtml(cards, esc) + '</div>'
    + '<div class="wg-h-title">' + esc(name || "群聊") + '<small>(' + cards.length + ')</small></div>'
    + '<div class="wg-h-menu" id="wgMenu">'
    + '<button class="wg-h-btn" id="wgMenuBtn" title="更多" aria-label="更多">⋯</button>'
    + '<div class="wg-h-pop">'
    + '<button class="wg-h-item" id="wgManageBtn">管理成员 / 改群名</button>'
    + '<button class="wg-h-item" id="wgLeaveBtn">退出群聊</button>'
    + '</div>'
    + '</div>';
}

/** A running or paused fishbowl must be stopped before the group chat takes over. */
export function wgShouldStopFishbowl(state: unknown): boolean {
  return state === "running" || state === "paused";
}
