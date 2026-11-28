(function () {
/**
 * The three *actions* a peer character can be asked to take: a closed-door meeting, a whisper, and
 * an invitation onto the timeline.
 *
 * `peer-calls` produces one string or one accounting entry and touches nothing else; this module
 * turns those strings into one act of collaboration — who attends the meeting, whether there is a
 * second review round, how the conclusion gets back to the main agent, how a whisper reaches exactly
 * one character, and how an invited character becomes an AI row in the timeline.
 *
 * Three invariants, each of which has already caused an incident:
 *
 *   1. The meeting is **context-isolated by default** (`context: "isolated"`). Each attendee gets its
 *      own card and the brief, never the shared transcript — four characters reading one session is
 *      not four agents, it is one model changing hats. Pass `context: "chat"` to opt out.
 *   2. Names past `meetingMax` are **not silently truncated**: they come back in `dropped`, because
 *      the caller has to be able to notice that a participant went missing.
 *   3. An on-stage line is **extracted once and then distributed**: `remember` with `listenerCids`
 *      for everyone else on stage. Four listeners must not cost four extractions of one sentence.
 *
 * Every capability arrives through {@link PeerActionsPorts}; nothing here reaches for the page or the
 * document. The timeline row is a three-field structural handle (`bubble`, `rowEl`) rather than DOM
 * calls, so a test can hand back a plain object and still observe the paint order.
 *
 * Lock: `test/peer-actions.test.mjs` (vm, fake host) pins the event/push ordering, the isolation
 * default, the `dropped` contract, the agenda merge rules and the single-extraction invariant.
 * @module services/agent/peer-actions
 */

/** A role card as this module sees it: addressed by `id` / `name`, otherwise opaque. */
                       
                         
               
                 
                 
 

/** What `makeRow` hands back: a bubble to fill and the element to decorate. */
                              
                                                      
                                             
 

/** Meeting knobs as clamped by `peer-calls.cfg()`. */
                                
                       
                          
                    
 

/** Return of `runCharacterAgent`: `said` on success, display text in `error` on failure. */
                             
               
                  
                 
 

/** One participant's answer, or the reason there is none. */
                                
              
                  
               
                 
                                                                                 
                  
 

/** Return of {@link PeerActions.runPeerMeeting}. `dropped` appears only when names were cut. */
                                
              
                 
                 
                  
                
                     
                   
                            
                           
                
 

/** Return of {@link PeerActions.whisperTo}. */
                                
              
                 
              
                
 

/** Return of {@link PeerActions.inviteCharacterToTimeline}. */
                               
              
                 
               
                
                
 

/**
 * Every page-level capability this module needs, one member per old `host` field. All optional: a
 * missing port falls back the way the old code did. Only `callPeerModel` fails loudly, because a
 * meeting with no model is a wiring bug rather than a degraded mode.
 */
                                   
                                                                                            
                                      
                        
                                                                 
                                                                                    
                                                         
                                                                     
                                                                         
                                                                      
                                                                
                           
                                        
                      
                                                                                  
                                                                      
                                                 
                                                                      
                                       
                              
                                                                    
                             
                                   
                                        
                                             
                                                   
                                                   
                   
                        
                          
                                                                               
                                                                              
                         
                                                                   
                                                                                     
 

/** Public surface, name for name what `create()` used to return. The `v` stamp lives on the
 *  window binding, as before, not on this object. */
                              
                                                         
                                           
                                                                   
 

/** One meeting attendee while the roster is being resolved. */
                 
               
                    
                 
 

const DEFAULT_CFG                = { meetingMax: 6, meetingRounds: 1, ctxMsgs: 60 };

/** Fallback aspects when nobody matched a card: still separate calls, just no persona. */
const GENERIC_ASPECTS = ["总体评估", "风险与代价", "替代方案"];

function isRecord(value         )                                   {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recOf(value         )                          {
  return isRecord(value) ? value : {};
}

function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

function cardOf(value         )              {
  return isRecord(value) ? value : null;
}

/** String coercion matching the old `String(x || "")`, which let numbers through as well. */
function textOf(value         )         {
  return value === null || value === undefined ? "" : String(value);
}

/** The old `a || b` on opaque values: first truthy one wins. */
function firstOf(a         , b         )          {
  return a ? a : b;
}

/** Integers from user input: `parseInt` semantics, garbage becomes the fallback. */
function intOf(value         , fallback        )         {
  const n = Number.parseInt(textOf(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Error text the way the old code shaped it: `err.message` when present, the value otherwise. */
function errText(err         )         {
  return isRecord(err) ? textOf(err.message) || textOf(err) : textOf(err);
}

/** Event sinks come straight off the caller's options object, so they are narrowed here: an options
 *  bag is `Record<string, unknown>`, and a narrowed `Function` still needs one hop to be callable
 *  with our own argument type. */
function sinkOf(value         )                                           {
  if (typeof value !== "function") return noopEvent;
  const callable = value;
  return function (event                         )       {
    callable.call(undefined, event);
  };
}

function noopEvent()       {
  /* no listener attached */
}

function createPeerActions(ports                  )              {
  const port                   = ports || {};

  const cardByName = typeof port.cardByName === "function" ? port.cardByName : function ()          { return null; };
  const cfg = typeof port.cfg === "function" ? port.cfg : function ()                { return DEFAULT_CFG; };
  const callPeerModel = typeof port.callPeerModel === "function" ? port.callPeerModel : async function ()                   {
    throw new Error("callPeerModel 未注入");
  };
  const runCharacterAgent = typeof port.runCharacterAgent === "function" ? port.runCharacterAgent : async function ()                      {
    return { ok: false, error: "runCharacterAgent 未注入" };
  };
  const councilPush = typeof port.councilPush === "function" ? port.councilPush : async function ()                {};
  const getSession = typeof port.getSession === "function" ? port.getSession : function ()            { return []; };
  const scopeKey = typeof port.scopeKey === "function" ? port.scopeKey : function ()         { return ""; };
  const scopeTagMsg = typeof port.scopeTagMsg === "function" ? port.scopeTagMsg : function (m                         )                          { return m; };
  const speakerView = typeof port.speakerView === "function" ? port.speakerView : function ()            { return []; };
  const getSceneCards = typeof port.getSceneCards === "function" ? port.getSceneCards : function ()            { return []; };
  const agentStageMode = typeof port.agentStageMode === "function" ? port.agentStageMode : function ()          { return false; };
  const cleanText = typeof port.cleanText === "function" ? port.cleanText : function (t        )         { return textOf(t); };
  const renderMarkdown = typeof port.renderMarkdown === "function" ? port.renderMarkdown : function (t        )         { return textOf(t); };
  const makeRow = typeof port.makeRow === "function" ? port.makeRow : function ()                     { return null; };
  const decorateAiRow = typeof port.decorateAiRow === "function" ? port.decorateAiRow : function ()       {};
  const setStreaming = typeof port.setStreaming === "function" ? port.setStreaming : function ()       {};
  const persist = typeof port.persist === "function" ? port.persist : function ()       {};
  const updateSpacer = typeof port.updateSpacer === "function" ? port.updateSpacer : function ()       {};
  const scrollToBottom = typeof port.scrollToBottom === "function" ? port.scrollToBottom : function ()       {};
  const memBuildInjection = typeof port.memBuildInjection === "function" ? port.memBuildInjection : async function ()                  { return ""; };
  const memEnabled = typeof port.memEnabled === "function" ? port.memEnabled : function ()          { return false; };
  const memRemember = typeof port.memRemember === "function" ? port.memRemember : function ()       {};
  const memPutFacts = typeof port.memPutFacts === "function" ? port.memPutFacts : function ()       {};

  /**
   * A closed-door meeting: attendees answer in parallel from their own context, an optional second
   * round reviews the first, and the conclusion goes back to the main agent instead of the timeline.
   */
  async function runPeerMeeting(opts          )                         {
    const o = recOf(opts);
    const topic = textOf(o.topic).trim();
    if (!topic) return { ok: false, error: "缺少议题（topic）" };
    const conf = recOf(cfg());
    const max = intOf(conf.meetingMax, 6);
    const onEvent = sinkOf(o.onEvent);
    const requested = intOf(o.rounds, 0);
    const rounds = Math.max(1, Math.min(2, requested || intOf(conf.meetingRounds, 1)));

    // Attendees see the transcript through the group projection: a meeting is a scene-level event,
    // so they are visible to each other, while each answer is still its own call and own context.
    const scope = "group";
    let names = arrOf(o.participants).map((x) => textOf(x).trim()).filter((x) => x.length > 0);
    if (!names.length) {
      names = getSceneCards().map((c) => textOf(recOf(c).name)).filter((n) => n.length > 0);
    }
    let entries          = names.slice(0, max).map((n) => ({ name: n, card: cardOf(cardByName(n)), aspect: "" }));

    // The agenda assigns an aspect to a named attendee; an unnamed entry lands by position instead.
    const agenda = arrOf(o.agenda);
    agenda.slice(0, max).forEach((raw, i) => {
      if (!raw) return;
      const a = recOf(raw);
      const who = a.who ? cardOf(cardByName(a.who)) : null;
      const aspect = textOf(a.aspect);
      if (who) {
        const exist = entries.find((e) => e.card !== null && e.card.id === who.id);
        if (exist) {
          exist.aspect = aspect;
          return;
        }
        entries.push({ name: textOf(who.name), card: who, aspect: aspect });
      } else if (entries[i]) {
        entries[i].aspect = aspect;
      }
    });

    // Invariant 2: whoever fell off the roster is reported, never dropped on the floor.
    const dropped = names.slice(max);
    entries = entries.filter((e) => e.card !== null).slice(0, max);
    if (!entries.length) {
      // Nobody matched a card: fall back to generic viewpoints. Still one call and one context per
      // participant, only the persona is replaced by an expert stance.
      const aspects = (agenda.length ? agenda.map((a) => textOf(recOf(a).aspect)) : GENERIC_ASPECTS)
        .filter((a) => a.length > 0)
        .slice(0, max);
      entries = aspects.map((a, i) => ({ name: "视角" + (i + 1) + "：" + a, card: null, aspect: a }));
    }

    // Invariant 1: isolated unless the caller explicitly asks for the chat transcript.
    const isolated = (textOf(o.context) || "isolated") !== "chat";
    const ctxMsgs = intOf(conf.ctxMsgs, 60);
    const capView = (card             )            => {
      if (isolated) return [];
      let view = speakerView({ scope: scope, card: card });
      if (ctxMsgs > 0 && view.length > ctxMsgs) view = view.slice(-ctxMsgs);
      return view;
    };

    const participants = ()           => entries.map((e) => e.name);
    // One attendee is the designated reviewer for round 1. Prefer an aspect that already names
    // risk/cost/security; otherwise the last attendee. A meeting where everybody agrees is not a
    // decision aid, so the demand for a rigorous critique is structural, not left to chance.
    // The reviewer argues against the bar (stable + correct + efficient + high-quality), not for a
    // cheaper option; the proposer gets the floor to rebut in round 2.
    const reviewerIdx = entries.findIndex((e) => /反方|风险|成本|安全|审查|质疑|反对/.test(e.aspect));
    const reviewer = entries[(reviewerIdx >= 0 ? reviewerIdx : entries.length - 1)].name;
    onEvent({ type: "meeting_start", topic: topic, participants: participants(), rounds: rounds });
    await councilPush("begin", [{ topic: topic, rounds: rounds, isolated: isolated, participants: participants() }]);

    const stanceOf = (s        )         => {
      const m = s.match(/(?:^|\n)\s*(?:\*\*)?(?:最终)?立场(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(赞成|反对|有条件|中立)/);
      return m ? m[1] : "";
    };
    const answers                  = [];
    const runRound = async (roundNo        , withReview         )                           => {
      await councilPush("round", [roundNo]);
      return await Promise.all(entries.map(async (e)                         => {
        const aspectLine = e.aspect ? "\n本会议你负责的方面：" + e.aspect : "";
        const roleLine = roundNo === 1 && e.name === reviewer
          ? "\n本轮你是挑剔审查者（不是为反对而反对）：以“绝对稳定、正确、高效、优质”同时成立为门槛，逐条质疑方案的关键假设、边界、失败路径与隐性成本，并给出你认为更优的设计。不要用“够用”当通过理由。"
          : "";
        const review = withReview
          ? "\n【上一轮其他人的结论】\n" + answers.map((a) => "· " + a.who + (a.stance ? "（" + a.stance + "）" : "") + "：" + textOf(a.text).slice(0, 800)).join("\n") +
            "\n逐条回应与你不同的结论：提案人先回应质疑（可反驳、可修改方案）；其他人至少明确接受一处、至少明确不同意一处，不要只重复赞同。"
          : "";
        const debate = roundNo === 1
          ? "\n这是决策讨论，不是表态。请严格按下面格式输出：\n立场：赞成 / 反对 / 有条件（三选一）\n方案/判断：你主张的做法，或你对该议题的判断\n关键假设：这个方案成立依赖什么\n失败路径：至少两条，写清触发条件与后果\n最优解门槛：在稳定、正确、高效、优质四个维度里，它还差什么\n改变立场的条件：什么证据会让你改判"
          : "\n这是复核轮。请严格按下面格式输出：\n回应：如果你上一轮提出了方案，逐条回应针对它的质疑（哪些接受、哪些反驳、方案怎么改）；如果你没有提方案，指出至少一处必须修改的地方\n让步：明确接受上一轮的哪一条（至少一处）\n坚持：明确不同意哪一条，并说明理由\n最终立场：赞成 / 反对 / 有条件（可以改判）";
        const brief = "【私下小会·第 " + roundNo + " 轮】议题：" + topic + aspectLine + roleLine + review + debate +
          "\n不要寒暄、不要提问、不要输出方括号标记。";
        try {
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "start" });
          await councilPush("speaking", [e.name]);
          const memInj = textOf(await memBuildInjection(firstOf(e.card && e.card.id, e.card && e.card.name), brief));
          const text = await callPeerModel(e.card, capView(e.card), brief + memInj);
          const clean = textOf(text).trim();
          const stance = stanceOf(clean);
          // Drop a bare `立场：X` line: the panel renders the same fact as a chip. Keep the line when
          // the model put its reasoning on it (we only remove an exact, standalone stance line).
          const body = clean.replace(/^\s*(?:\*\*)?(?:最终)?立场(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(?:赞成|反对|有条件|中立)\s*(?:\*\*)?\s*[。.]?\s*\n?/m, "").trim() || clean;
          // `text` carries the full answer (the steps panel reads what the meeting actually said);
          // `summary` is only the one-line preview for the right-hand console.
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "done", summary: body.slice(0, 200), text: body });
          await councilPush("say", [{ who: e.name, text: body, stance: stance }]);
          if (e.card && memEnabled()) {
            memRemember("【" + e.name + "】" + body, { speakerCid: e.card.id });
          }
          return { who: e.name, aspect: e.aspect, text: body, stance: stance || undefined };
        } catch (err) {
          const msg = errText(err);
          onEvent({ type: "meeting_speaker", who: e.name, round: roundNo, phase: "error", error: msg });
          await councilPush("say", [{ who: e.name, error: msg }]);
          return { who: e.name, aspect: e.aspect, text: "", error: msg };
        }
      }));
    };

    const firstRound = await runRound(1, false);
    answers.push.apply(answers, firstRound);
    let reviewRound                         = null;
    if (rounds >= 2) reviewRound = await runRound(2, true);
    onEvent({ type: "meeting_done", topic: topic, participants: answers.map((a) => a.who) });
    // The closing card carries the final-round balance, so the owner can see at a glance whether the
    // meeting actually debated (and the main agent gets the same tally in its tool result).
    const finalAnswers = reviewRound || firstRound;
    const tally = { "赞成": 0, "反对": 0, "有条件": 0 };
    finalAnswers.forEach((a) => { if (a.stance && tally[a.stance                      ] != null) tally[a.stance                      ]++; });
    const tallyText = (tally["赞成"] || tally["反对"] || tally["有条件"])
      ? " · 赞成 " + tally["赞成"] + " / 反对 " + tally["反对"] + " / 有条件 " + tally["有条件"]
      : "";
    await councilPush("done", [{ note: rounds + " 轮结束" + tallyText + " · 结论已回给主 agent" }]);
    return {
      ok: true,
      topic: topic,
      rounds: rounds,
      room: "/tools/council/index.html",
      dropped: dropped.length ? dropped : undefined,
      context: isolated ? "isolated" : "chat",
      answers: answers.map((a)                => ({ who: a.who, aspect: a.aspect || undefined, text: a.text, error: a.error || undefined, stance: a.stance || undefined })),
      review: reviewRound ? reviewRound.map((a)                => ({ who: a.who, text: a.text, error: a.error || undefined, stance: a.stance || undefined })) : undefined,
      note: "以上为多智能体讨论结论（未进聊天时间线）。过程在右栏讨论区可见（room 字段的地址，用 stage_open 打开）。" +
        "可据此作答；也可用 invite_character 请其中一位上台直接回答。",
    };
  }

  /**
   * A private channel: exactly one character learns the fact and everyone else — including the main
   * agent — never sees it. That information gap is what makes a group chat multi-agent rather than
   * one transcript wearing different personas.
   */
  function whisperTo(opts          )                {
    const o = recOf(opts);
    const wanted = firstOf(o.to, o.name);
    const card = cardOf(cardByName(wanted === undefined ? "" : wanted));
    if (!card) return { ok: false, error: "找不到角色：" + textOf(wanted) };
    const text = textOf(o.text).trim();
    if (!text) return { ok: false, error: "需要 text" };
    const name = textOf(card.name);
    getSession().push({ role: "user", content: "（私下对" + name + "）" + text, sc: scopeKey(), to: name });
    // The whisper lands only in the recipient's memory: nobody else can read it now or recall it later.
    if (memEnabled()) {
      memPutFacts(card.id, [{ what: text, why: "whisper", fact_type: "world", fact_kind: "conversation", entities: [] }], { kind: "whisper" });
    }
    persist();
    return { ok: true, to: name, note: "只有 " + name + " 能看到这条；其他角色看不到。" };
  }

  /**
   * An invitation: the character answers in the timeline under its own name and avatar, either as one
   * bare call or — in agent mode — as an agent that can look things up with tools first.
   */
  async function inviteCharacterToTimeline(opts          )                        {
    const o = recOf(opts);
    const card = cardOf(cardByName(textOf(o.name)));
    if (!card) return { ok: false, error: "找不到角色：" + textOf(o.name) };
    const name = textOf(card.name);
    const onEvent = sinkOf(o.onEvent);
    onEvent({ type: "peer_invite", who: name, phase: "start" });
    try {
      const conf = recOf(cfg());
      const ctxMsgs = intOf(conf.ctxMsgs, 60);
      let view = speakerView({ scope: scopeKey(), card: card });
      if (ctxMsgs > 0 && view.length > ctxMsgs) view = view.slice(-ctxMsgs);
      const brief0 = textOf(o.brief).trim();
      // Recall what *this* character remembers before it speaks; stores are per card, so another
      // character's memories are not reachable from here.
      const memInj = textOf(await memBuildInjection(firstOf(card.id, card.name), brief0 || "当前局面"));
      // Agent mode puts the character on stage as an agent that can verify facts with tools; plain
      // mode keeps the single cheap call.
      const useLoop = typeof o.loop === "boolean" ? o.loop : agentStageMode();
      let text = "";
      if (useLoop) {
        const reply = recOf(await runCharacterAgent(card, brief0 || "用户刚把你请进这段对话，请按你的身份接住当前话题、直接说话。"));
        if (!reply.ok) throw new Error(textOf(reply.error) || (name + " 没有产出内容"));
        text = textOf(reply.said);
      } else {
        const brief = brief0 + memInj;
        text = textOf(await callPeerModel(
          card,
          view,
          brief
            ? "【被请上台】" + brief + "\n请按你的身份直接回答（不要寒暄、不要提问、不要输出方括号标记）。"
            : "【被请上台】用户刚把你请进这段对话，请按你的身份接住当前话题、直接说话（不要寒暄、不要输出方括号标记）。"
        ));
      }
      const clean = cleanText(textOf(text));
      if (!clean.trim()) {
        onEvent({ type: "peer_invite", who: name, phase: "done" });
        return { ok: false, error: name + " 没有产出内容" };
      }
      const row = makeRow("assistant");
      if (!row) throw new Error("makeRow 未注入");
      // One AI row carrying this character's name and avatar, persisted like any other turn.
      row.bubble.innerHTML = renderMarkdown(clean);
      try {
        decorateAiRow(row.rowEl, card);
      } catch (e) {
        /* decoration is cosmetic: a broken avatar must not lose the line */
      }
      setStreaming(row.rowEl, false);
      // Invariant 3: this line enters its own memory and, as one extraction, the memory of everyone
      // else on stage. Four listeners would otherwise mean four extractions of the same sentence.
      if (memEnabled()) {
        const others = getSceneCards()
          .map((c) => recOf(c))
          .filter((c) => c.id !== undefined && c.id !== card.id)
          .map((c) => c.id);
        memRemember("【" + name + "】" + clean, { speakerCid: card.id, listenerCids: others });
      }
      const msg = { role: "assistant", content: clean, speakerId: card.id, speakerName: name, speakerIcon: textOf(card.icon) || "🙂" };
      getSession().push(scopeTagMsg(msg));
      try {
        row.rowEl.dataset.sidx = String(getSession().length - 1);
      } catch (e) {
        /* a detached row still keeps its text; only retry/delete-by-index breaks */
      }
      persist();
      updateSpacer();
      scrollToBottom();
      onEvent({ type: "peer_invite", who: name, phase: "done", text: clean });
      return { ok: true, who: name, said: clean, note: "已请「" + name + "」在时间线上回答（用户能看到它的气泡）。" };
    } catch (err) {
      onEvent({ type: "peer_invite", who: name, phase: "done" });
      return { ok: false, error: errText(err) };
    }
  }

  return { runPeerMeeting, whisperTo, inviteCharacterToTimeline };
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// agent domain, eighth brick (2026-11-15): the orchestration moved to services/agent/peer-actions.ts.
// `app.js` still owns the page — rows, session, persistence, memory core — and hands all of it in as
// ports, so this file only binds the frozen name and guards a double install. Nothing to resolve
// here: unlike `peer-calls`, no port needs a window global of its own.
(function () {
  if (window.__peerActions && window.__peerActions.v === 1) return;

  window.__peerActions = {
    v: 1,
    create: function (host) {
      return createPeerActions(host || {});
    },
  };
})();

globalThis.createPeerActions = createPeerActions;
})();
