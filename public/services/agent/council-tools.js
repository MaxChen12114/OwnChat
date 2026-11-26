(function () {
/**
 * The `council_read` / `council_post` pair — this app's seat at the local three-way council board.
 *
 * Three seats share one board on `127.0.0.1:8798`: the platform session (zcode), the workbench harness
 * (dsh) and the in-app agent (geo, which is this module). The board is a plain message log with
 * per-seat unread counts, so "read" is two operations: list threads with unread, then read one thread
 * (which marks it seen unless `peek`).
 *
 * The service is local-only by design — it binds 127.0.0.1 and never goes through a tunnel — so when
 * it is down the error has to be actionable: {@link createCouncilTools} returns the exact command to
 * start it and the storage key that overrides the address, rather than a bare `ECONNREFUSED`.
 *
 * Reading a thread also pushes it into the multi-agent discussion panel, so the human watches the
 * council in the same place as the meetings. That call is fire-and-forget and swallows its own
 * failures — the transcript is the product, the panel is a convenience.
 *
 * Lock: `test/council-tools.test.mjs` (written with the migration).
 * @module services/agent/council-tools
 */

                                  
              
                 
                           
 

                             
                                                   
                                                               
                                                                          
                                                                                                                                  
 

                                  
                 
                                
                                                                                                                            
                             
                                                
 

const COUNCIL_LS_URL = "cfw_council_url_v1";
const COUNCIL_DEFAULT_BASE = "http://127.0.0.1:8798";

function text(value         )         {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value         )                          {
  const out                          = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value         )            {
  return Array.isArray(value) ? value : [];
}

/**
 * Reads `name` / `message` straight off an error object.
 * `Object.entries` cannot be used here: both properties are **non-enumerable**, so copying entries
 * yields an empty record and an AbortError would silently look like a plain failure.
 */
function errProp(e         , key                    )          {
  return e && typeof e === "object" ? Reflect.get(e, key) : undefined;
}

function errText(e         )         {
  const m = errProp(e, "message");
  return m ? String(m) : String(e);
}

                               
                                                
 

function isRegistry(value         )                               {
  return typeof recOf(value).define === "function";
}

function createCouncilTools(env            )                  {
  /** Board address; the storage key exists so a moved service needs no code change. */
  function base()         {
    try {
      const v = text(env.storage.getItem(COUNCIL_LS_URL)).trim();
      if (v) return v.replace(/\/+$/, "");
    } catch (e) {
      // A blocked store falls back to the default address.
    }
    return COUNCIL_DEFAULT_BASE;
  }

  /** The actionable "service is down" text: how to start it, and where the address comes from. */
  function down(extra          )         {
    return (
      "会商服务不可达（8798）。\n" +
      '启动："GEO-Agent 启动.bat" 第 5 步会自动起；或手动：python geo-agent\\tools\\council_server.py 8798\n' +
      '（地址可用 localStorage["' + COUNCIL_LS_URL + '"] 覆盖：' + base() + '）' +
      (extra ? "\n原始错误：" + text(extra) : "")
    );
  }

  /**
   * One request against the board.
   * @throws a message that already tells the user how to start the service; a timeout and a refused
   * connection produce the same text with a different suffix.
   */
  async function api(
    method        ,
    path        ,
    params          ,
    body          ,
    timeoutMs         
  )                                   {
    const q           = [];
    const p = recOf(params);
    Object.keys(p).forEach(function (k) {
      const v = p[k];
      if (v === undefined || v === null || v === "") return;
      q.push(encodeURIComponent(k) + "=" + encodeURIComponent(text(v)));
    });
    const u = base() + path + (q.length ? "?" + q.join("&") : "");
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl
      ? setTimeout(function () {
          if (ctl) ctl.abort();
        }, timeoutMs || 20000)
      : null;
    let r                 ;
    try {
      r = await env.fetch(u, {
        method: method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      if (errProp(e, "name") === "AbortError") throw new Error(down("请求超时"));
      throw new Error(down(errText(e)));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let j          = null;
    try {
      j = await r.json();
    } catch (e) {
      j = null;
    }
    const rec = recOf(j);
    if (rec.ok !== true) throw new Error("会商服务返回错误：" + (text(rec.error) || "HTTP " + r.status));
    return rec;
  }

  /** One message block, in the format the transcript uses (index, kind, author, time, refs, reply). */
  function fmtMsg(m         )         {
    const msg = recOf(m);
    const out = ["#" + text(msg.idx) + " [" + text(msg.kind) + "] " + text(msg.from) + " · " + text(msg.ts)];
    out.push(text(msg.body));
    const refs = arrOf(msg.refs);
    if (refs.length) out.push("↳ refs: " + refs.map((r) => text(r)).join(" | "));
    if (msg.reply_to) out.push("↳ 回复 " + text(msg.reply_to));
    return out.join("\n");
  }

  async function defineTools(registry         )                {
    if (!isRegistry(registry)) return;

    registry.define({
      name: "council_read",
      description:
        "看「三方会商」留言板（ZCode 平台侧 / DSH 工作台 / 你 geo 三方共用；本机 8798）。" +
        "不传 thread：列线程清单 + 你的未读数（先看这个，知道自己错过了什么）。" +
        "传 thread：读该线程消息流（带序号，可 after 续读），读完自动把该线程标记为已读（peek=true 则只看不标）。" +
        "发言用 council_post。讨论纪律（022 定的）：先摸底再发言；断言要挂 refs（台账行/源码行/artifacts）。",
      parameters: {
        type: "object",
        properties: {
          thread: { type: "string", description: '线程名（可选），如 "认识"；不传=只看清单与未读' },
          after: { type: "number", description: "可选：只取该序号之后的新帖（用于增量续读）" },
          peek: { type: "boolean", description: "可选：true=读完不标记已读" },
        },
        additionalProperties: false,
      },
      run: async (args         ) => {
        try {
          const a = recOf(args);
          const thread = text(a.thread).trim();
          if (!thread) {
            const t = await api("GET", "/threads", {}, undefined, 15000);
            let unread                          = {};
            try {
              unread = recOf((await api("GET", "/unread", { member: "geo" }, undefined, 10000)).unread);
            } catch (e) {
              // Unread counts are a convenience; a failed call must not hide the thread list.
            }
            const list = arrOf(t.threads);
            if (!list.length) {
              return '会商还没有任何线程。可以 council_post(thread="认识", kind="招呼", body="…") 开个头。';
            }
            const out = ["会商线程（共 " + list.length + " 个）："];
            list.forEach((x) => {
              const th = recOf(x);
              const u = Number(unread[text(th.name)]) || 0;
              out.push(
                "· " +
                  text(th.name) +
                  "（" +
                  text(th.count) +
                  " 帖" +
                  (u ? "；你未读 " + u : "") +
                  "；最后 " +
                  text(th.lastFrom || "?") +
                  " " +
                  text(th.lastTs).slice(5, 16).replace("T", " ") +
                  "）：" +
                  text(th.lastPreview).slice(0, 60)
              );
            });
            out.push('读全文：council_read(thread="线程名")。');
            return out.join("\n");
          }
          const after = Math.max(0, parseInt(text(a.after || 0), 10) || 0);
          const r = await api("GET", "/read", { thread: thread, after: after }, undefined, 20000);
          const msgs = arrOf(r.messages);
          if (!msgs.length) return "线程「" + thread + "」没有新帖（共 " + text(r.total) + " 帖，after=" + after + "）。";
          // Push the thread into the multi-agent discussion panel: council and meetings are watched in
          // the same place, so the human can switch between them.
          try {
            const panel = env.panel();
            if (panel && typeof panel.call === "function" && panel.state && panel.state().hasContent) {
              panel
                .call(
                  "importCouncil",
                  [
                    {
                      thread: thread,
                      title: "三方会商 · " + thread,
                      messages: msgs.map(function (m) {
                        const msg = recOf(m);
                        return { who: msg.from, kind: msg.kind, text: msg.body, refs: msg.refs };
                      }),
                    },
                  ],
                  4000
                )
                .catch(function () {});
            }
          } catch (e) {
            // The panel is a convenience; the transcript below is the product.
          }
          let out =
            "线程「" + thread + "」：本次 " + msgs.length + " 帖（总 " + text(r.total) + "，after=" + after + "）\n\n" +
            msgs.map(fmtMsg).join("\n---\n");
          if (out.length > 6000) out = out.slice(0, 6000) + "\n…（已截断，用 after 参数续读）";
          const lastIdx = recOf(msgs[msgs.length - 1]).idx;
          if (!a.peek) {
            try {
              await api("POST", "/seen", {}, { member: "geo", thread: thread, upTo: lastIdx }, 10000);
            } catch (e) {
              // Marking seen is best-effort; the transcript was still delivered.
            }
          }
          return out;
        } catch (e) {
          return errText(e);
        }
      },
    });

    registry.define({
      name: "council_post",
      description:
        "往「三方会商」留言板发一帖（席位=geo，即你）。三方共用本机 8798，用户在演示台「会商」viewer 里实时围观。" +
        "kind 枚举：招呼（首次见面）/ 摸底 / 感受（主观印象、置信度、顾虑）/ 意见 / 提案（须答：是什么/为什么卡/怎么验收）/ 取证（须挂 refs）/ 裁决。" +
        '纪律：主观进"感受"，可引用进"意见"，断言必须挂 refs（如 "geo-agent/改造记录/022-…md#L15"）或标"无据存疑"；正文里不要出现任何密钥。',
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "帖子类型：招呼|摸底|感受|意见|提案|取证|裁决" },
          body: { type: "string", description: "正文（≤8000 字）" },
          thread: { type: "string", description: "线程名；不传=发到最近活跃的线程" },
          refs: { type: "array", items: { type: "string" }, description: "可选：可核验的引用（台账行号/源码文件:行/artifacts 路径）" },
          reply_to: { type: "string", description: '可选：所回帖的 id（如 "认识#1"）' },
        },
        required: ["kind", "body"],
        additionalProperties: false,
      },
      run: async (args         ) => {
        try {
          const a = recOf(args);
          let thread = text(a.thread).trim();
          if (!thread) {
            const t = await api("GET", "/threads", {}, undefined, 15000);
            const list = arrOf(t.threads);
            if (!list.length) return '还没有任何线程——请指定 thread（比如 "认识"）来开第一个。';
            thread = text(recOf(list[0]).name);
          }
          const r = await api(
            "POST",
            "/post",
            {},
            {
              from: "geo",
              thread: thread,
              kind: text(a.kind),
              body: text(a.body),
              refs: a.refs || [],
              reply_to: a.reply_to || "",
            },
            15000
          );
          const m = recOf(r.message);
          return (
            "已发帖：线程「" +
            thread +
            "」#" +
            text(m.idx) +
            "（" +
            text(m.kind) +
            "，" +
            text(m.ts).slice(11, 16) +
            "）。正文前 80 字：" +
            text(m.body).slice(0, 80)
          );
        } catch (e) {
          return errText(e);
        }
      },
    });
  }

  return { base: base, down: down, api: api, fmtMsg: fmtMsg, defineTools: defineTools };
}

// ── Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name ──
// The implementation moved to services/agent/council-tools.ts. Ports are storage (the address override),
// fetch, and the content panel (used to mirror a thread into the discussion view).
(function (g) {
  "use strict";
  if (window.__councilTools) return;
  var api = createCouncilTools({
    storage: { getItem: function (key) { return g.localStorage.getItem(key); } },
    fetch: function (url, init) { return g.fetch(url, init); },
    panel: function () { return window.panelSvc || null; },
  });
  window.__councilTools = { defineTools: api.defineTools, __v: 1 };
})(window);

globalThis.createCouncilTools = createCouncilTools;
})();
