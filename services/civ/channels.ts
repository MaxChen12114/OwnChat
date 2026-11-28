/**
 * Message routing and the visibility model: public council, one-to-one envoy, and small blocs.
 *
 * Visibility is an audience snapshot taken at post time. That gives three useful properties:
 *   - a private line can never be read by a third faction, even after a later bloc change;
 *   - a new bloc member does not gain the bloc's history;
 *   - a member who leaves keeps what they already saw (they cannot unsee it), while new lines stop
 *     reaching them.
 *
 * Text is data. This module never parses a message for commands, never builds a prompt, and never
 * lets a message mutate state. Proposals and wars only happen through `diplomacy`/`war`, never
 * because a speech said so. Callers that render text MUST escape it; this module stores the exact
 * string so the trace can be audited.
 *
 * @module services/civ/channels
 */

import type {
  Bloc,
  BlocResult,
  ChannelMessage,
  ChannelProjection,
  ChannelRules,
  ChannelState,
  ChannelsApi,
  ChannelsPorts,
  CreateBlocInput,
  FactionId,
  MessageKind,
  PostInput,
  PostResult,
} from "./types";

const MESSAGE_KINDS: MessageKind[] = ["speech", "proposal", "response", "notice"];

function hasFaction(ids: FactionId[], id: FactionId): boolean {
  return ids.indexOf(id) >= 0;
}

function unique(ids: FactionId[]): FactionId[] {
  const out: FactionId[] = [];
  for (const id of ids) if (out.indexOf(id) < 0) out.push(id);
  return out;
}

function sorted(ids: FactionId[]): FactionId[] {
  return [...ids].sort();
}

function normalizeRefs(raw: string[] | undefined, rules: ChannelRules): { ok: boolean; error: string; refs: string[] } {
  const refs: string[] = [];
  if (raw === undefined) return { ok: true, error: "", refs };
  if (!Array.isArray(raw)) return { ok: false, error: "refs 必须是字符串数组", refs };
  if (raw.length > rules.maxRefs) return { ok: false, error: "refs 超过上限 " + rules.maxRefs, refs };
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: "refs 里每一项都必须是字符串", refs };
    const ref = item.trim();
    if (ref === "") return { ok: false, error: "refs 不能有空字符串", refs };
    if (ref.length > rules.maxRefLength) {
      return { ok: false, error: "ref 超过长度上限 " + rules.maxRefLength + ": " + ref.slice(0, 40), refs };
    }
    refs.push(ref);
  }
  return { ok: true, error: "", refs };
}

export function createChannels(ports: ChannelsPorts): ChannelsApi {
  const exists = ports.exists;

  function createState(): ChannelState {
    return { messages: [], blocs: {}, nextMessageId: 0, nextBlocId: 0 };
  }

  function post(
    state: ChannelState,
    input: PostInput,
    rules: ChannelRules,
    factionIds: FactionId[],
  ): PostResult {
    if (!exists(input.from)) {
      return { ok: false, error: "发言方不是已知派系: " + input.from, message: null };
    }
    if (MESSAGE_KINDS.indexOf(input.kind) < 0) {
      return { ok: false, error: "未知消息类型: " + input.kind, message: null };
    }
    if (typeof input.text !== "string") {
      return { ok: false, error: "text 必须是字符串", message: null };
    }
    const body = input.text.trim();
    if (body === "") return { ok: false, error: "text 不能为空", message: null };
    if (body.length > rules.maxTextLength) {
      return { ok: false, error: "text 超过上限 " + rules.maxTextLength + " 字符", message: null };
    }
    const refsResult = normalizeRefs(input.refs, rules);
    if (!refsResult.ok) return { ok: false, error: refsResult.error, message: null };
    if (rules.requireRefsFor.indexOf(input.kind) >= 0 && refsResult.refs.length === 0) {
      return { ok: false, error: input.kind + " 消息必须带可核验 refs", message: null };
    }
    let to: FactionId | null = null;
    let blocId: string | null = null;
    let audience: FactionId[] = [];
    if (input.channel === "council") {
      audience = sorted(factionIds);
    } else if (input.channel === "envoy") {
      if (typeof input.to !== "string" || input.to === "") {
        return { ok: false, error: "envoy 需要 to（收件人）", message: null };
      }
      if (input.to === input.from) return { ok: false, error: "不能给自己发私信", message: null };
      if (!exists(input.to)) {
        return { ok: false, error: "收件人不是已知派系: " + input.to, message: null };
      }
      to = input.to;
      audience = sorted([input.from, input.to]);
    } else if (input.channel === "bloc") {
      if (typeof input.blocId !== "string" || input.blocId === "") {
        return { ok: false, error: "bloc 消息需要 blocId", message: null };
      }
      const bloc = state.blocs[input.blocId];
      if (bloc === undefined) return { ok: false, error: "找不到小圈子: " + input.blocId, message: null };
      if (!hasFaction(bloc.members, input.from)) {
        return { ok: false, error: "发言方不是该小圈子成员", message: null };
      }
      blocId = bloc.id;
      audience = sorted(bloc.members);
    } else {
      return { ok: false, error: "未知频道: " + String(input.channel), message: null };
    }
    const message: ChannelMessage = {
      id: "m:" + input.tick + ":" + state.nextMessageId,
      tick: input.tick,
      channel: input.channel,
      from: input.from,
      to,
      blocId,
      kind: input.kind,
      text: body,
      refs: refsResult.refs,
      audience,
      proposalId: typeof input.proposalId === "string" && input.proposalId !== "" ? input.proposalId : null,
    };
    state.nextMessageId += 1;
    state.messages.push(message);
    return { ok: true, error: "", message };
  }

  function createBloc(state: ChannelState, input: CreateBlocInput, rules: ChannelRules): BlocResult {
    if (typeof input.founder !== "string" || input.founder === "") {
      return { ok: false, error: "小圈子需要 founder", bloc: null };
    }
    if (!exists(input.founder)) return { ok: false, error: "founder 不是已知派系", bloc: null };
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "") return { ok: false, error: "小圈子需要名称", bloc: null };
    const requested = Array.isArray(input.members) ? input.members : [];
    for (const member of requested) {
      if (typeof member !== "string" || member === "") {
        return { ok: false, error: "成员 id 非法", bloc: null };
      }
      if (!exists(member)) return { ok: false, error: "成员不是已知派系: " + member, bloc: null };
    }
    const members = unique([input.founder, ...requested]);
    if (members.length < 2) return { ok: false, error: "小圈子至少需要两个成员", bloc: null };
    if (members.length > rules.maxBlocMembers) {
      return { ok: false, error: "小圈子成员超过上限 " + rules.maxBlocMembers, bloc: null };
    }
    const bloc: Bloc = {
      id: "b:" + input.tick + ":" + state.nextBlocId,
      name,
      founder: input.founder,
      members,
      events: [{ tick: input.tick, type: "create", by: input.founder, member: input.founder }],
    };
    state.nextBlocId += 1;
    state.blocs[bloc.id] = bloc;
    return { ok: true, error: "", bloc };
  }

  function invite(
    state: ChannelState,
    blocId: string,
    by: FactionId,
    members: FactionId[],
    tick: number,
    rules: ChannelRules,
  ): BlocResult {
    const bloc = state.blocs[blocId];
    if (bloc === undefined) return { ok: false, error: "找不到小圈子: " + blocId, bloc: null };
    if (!hasFaction(bloc.members, by)) return { ok: false, error: "邀请方不是小圈子成员", bloc: null };
    const wanted = unique(Array.isArray(members) ? members : []);
    const added: FactionId[] = [];
    for (const member of wanted) {
      if (typeof member !== "string" || member === "") return { ok: false, error: "成员 id 非法", bloc: null };
      if (!exists(member)) return { ok: false, error: "成员不是已知派系: " + member, bloc: null };
      if (hasFaction(bloc.members, member)) continue;
      if (bloc.members.length + added.length >= rules.maxBlocMembers) {
        return { ok: false, error: "小圈子成员超过上限 " + rules.maxBlocMembers, bloc: null };
      }
      added.push(member);
    }
    if (added.length === 0) return { ok: false, error: "没有可加入的新成员", bloc: null };
    for (const member of added) {
      bloc.members.push(member);
      bloc.events.push({ tick, type: "join", by, member });
    }
    return { ok: true, error: "", bloc };
  }

  function leave(state: ChannelState, blocId: string, faction: FactionId, tick: number): BlocResult {
    const bloc = state.blocs[blocId];
    if (bloc === undefined) return { ok: false, error: "找不到小圈子: " + blocId, bloc: null };
    const at = bloc.members.indexOf(faction);
    if (at < 0) return { ok: false, error: "不是该小圈子成员", bloc: null };
    bloc.members.splice(at, 1);
    bloc.events.push({ tick, type: "leave", by: faction, member: faction });
    return { ok: true, error: "", bloc };
  }

  function expel(
    state: ChannelState,
    blocId: string,
    by: FactionId,
    member: FactionId,
    tick: number,
  ): BlocResult {
    const bloc = state.blocs[blocId];
    if (bloc === undefined) return { ok: false, error: "找不到小圈子: " + blocId, bloc: null };
    if (!hasFaction(bloc.members, by)) return { ok: false, error: "操作方不是小圈子成员", bloc: null };
    if (by === member) return { ok: false, error: "请用 leave 退出，不要踢自己", bloc: null };
    const at = bloc.members.indexOf(member);
    if (at < 0) return { ok: false, error: "被踢方不是该小圈子成员", bloc: null };
    bloc.members.splice(at, 1);
    bloc.events.push({ tick, type: "expel", by, member });
    return { ok: true, error: "", bloc };
  }

  function visibleTo(message: ChannelMessage, faction: FactionId): boolean {
    return hasFaction(message.audience, faction);
  }

  function projectFor(state: ChannelState, faction: FactionId): ChannelProjection {
    const messages: ChannelMessage[] = [];
    let omitted = 0;
    for (const message of state.messages) {
      if (visibleTo(message, faction)) messages.push(message);
      else omitted += 1;
    }
    return { faction, messages, omitted };
  }

  function publicLog(state: ChannelState): ChannelMessage[] {
    const out: ChannelMessage[] = [];
    for (const message of state.messages) if (message.channel === "council") out.push(message);
    return out;
  }

  function message(state: ChannelState, id: string): ChannelMessage | null {
    for (const item of state.messages) if (item.id === id) return item;
    return null;
  }

  return {
    createState,
    post,
    createBloc,
    invite,
    leave,
    expel,
    projectFor,
    publicLog,
    message,
    visibleTo,
  };
}
