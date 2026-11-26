(function () {
/**
 * `generate_video_story` — the director's relay: 1-5 storyboard segments, each I2V clip seeded
 * with the previous clip's last frame, so the user can stitch one continuous long video.
 *
 * Everything that makes this tool expensive or easy to get wrong lives here: the hard 5-segment
 * ceiling (one segment is ~20 minutes, so an unbounded list is a runaway agent turn), the key
 * fallback order (a Gitee channel preset wins, then the two legacy localStorage keys — channels
 * migrated and old keys may be empty), the login-state header on protected `/img/*` deployments,
 * the `num_inferenece_steps` typo retry, the per-poll 25s abort, and the exact refusal wording.
 * The relay is serial and the tab must stay open: the browser owns the decoder and the canvas, so
 * the last frame is extracted here through injected DOM ports, never through a direct DOM global.
 *
 * This bundle used to carry all of it inline. It is a tool the agent *chooses* to call, so the
 * `define({...})` schema stays in tools.js and only the decision logic moved down. Every host
 * input — document, storage, the image-channel registry, fetch, the event renderer and the DOM
 * factories — arrives as a port; there is no `window` reference below.
 *
 * @module services/tools/agent/video
 */

/** Minimum canvas context used to copy the decoded frame. */
                                     
                                                                                  
 

/** One structural slice for both the <video> decoder and the <canvas> grabber. */
                                   
                  
                 
                       
              
                   
                      
                     
                      
                
                 
                                                            
                                               
                                                          
 

                                
                                               
 

                               
                                      
 

                               
                
 

                                
                                         
 

                                
              
                 
                          
                           
 

                            
                                                                
 

                                 
                                
                            
 

/** Optional clock/timers: a test can pin them so no 25s/60s host timer is ever armed. */
                              
                
                                           
                               
 

                            
                                                                      
                                   
                                                                                   
                                 
                                                                  
                                   
                                                             
                                                                                                    
                                                              
                        
                            
                       
 

                             
                     
                      
                  
                   
                       
                 
 

                            
                
                   
                 
 

                              
              
                 
                      
                 
                
 

                           
                                                             
 

                   
                 
                          
 

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

function text(v         )         {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** `message` is non-enumerable on Error, so recOf cannot see it — read it directly. */
function errText(e         )         {
  const m = e && typeof e === "object" ? Reflect.get(e, "message") : undefined;
  return m ? String(m) : String(e);
}

/** Original `.trim()` semantics: a non-string throws, which the caller's catch turns into "". */
function trimOf(v         )         {
  if (typeof v !== "string") throw new TypeError("trim of non-string");
  return v.trim();
}

function intOf(v         , fallback        )         {
  return parseInt(text(v), 10) || fallback;
}

/** Host-builtin fallback. The handle is kept in a numeric map so no `as` is needed to clear it. */
function hostTimers()              {
  let seq = 0;
  const handles                                                = {};
  return {
    now: function () { return Date.now(); },
    set: function (fn, ms) {
      const id = ++seq;
      handles[id] = setTimeout(fn, ms);
      return id;
    },
    clear: function (h) {
      const id = typeof h === "number" ? h : -1;
      const handle = handles[id];
      if (handle !== undefined) {
        clearTimeout(handle);
        delete handles[id];
      }
    },
  };
}

function createVideoStoryTools(deps           )           {
  async function run(input            , ctxIn         )                       {
    const ctx = ctxIn || {};
    const emit = function (ev                         )       { deps.onEvent(ev, ctx) };
    const timers = deps.timers || hostTimers();

    const doc = deps.document();
    if (!doc) return { ok: false, error: "无 document,非浏览器环境,无法做视频接力" };

    let apiKey = "";
    try {
      // 视频接力固定走 Gitee Wan2.2：优先取内置 Gitee 渠道，再回落旧 Key（渠道迁移后旧键可能为空）
      const channels = deps.channels();
      const g = channels && typeof channels.get === "function" ? channels.get("gitee") : null;
      const store = deps.storage();
      apiKey = trimOf(
        (g && g.key) ||
        (store ? store.getItem("cfw_image_key_v1") : null) ||
        (store ? store.getItem("moark_api_key") : null) ||
        ""
      );
    } catch (e) {}
    if (!apiKey) return { ok: false, error: "未找到 Gitee API Key：请先到 设置 → 模型 API → 图像渠道 给 Gitee 预设填 Key（只存本机）" };

    // 设了访问密码的部署：/img/* 要求带应用登录态（X-Sync-Token）；Authorization 让给上游 Key
    let syncTok = "";
    try {
      const store = deps.storage();
      syncTok = store ? trimOf(store.getItem("cfw_auth_token_v1") || "") : "";
    } catch (e) {}
    function authHdr(extra                          )                          {
      const h = Object.assign({ Authorization: "Bearer " + apiKey }, extra || {});
      if (syncTok) h["X-Sync-Token"] = syncTok;
      return h;
    }

    const args = recOf(input);
    const rawSegs = arrOf(args.segments);
    const segs = rawSegs
      .map(function (s         )                 {
        const seg = recOf(s);
        if (!s || typeof seg.prompt !== "string" || !seg.prompt.trim()) return null;
        return {
          prompt: seg.prompt.trim(),
          negative_prompt: typeof seg.negative_prompt === "string" ? seg.negative_prompt.trim() : "",
        };
      })
      .filter(function (s)               { return !!s });
    if (!segs.length) return { ok: false, error: "segments 至少要有一段带 prompt 的分镜" };
    if (segs.length > 5) return { ok: false, error: "分镜段数超上限:最多 5 段(单段约20分钟,封顶防失控),当前 " + segs.length + " 段,请合并精简" };
    const initUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
    if (!initUrl) return { ok: false, error: "缺少首帧起始图 image_url:可先用 send_image 生成一张再把其 url 传进来" };
    const width = Math.max(64, Math.min(2048, intOf(args.width, 832)));
    const height = Math.max(64, Math.min(2048, intOf(args.height, 480)));
    const numFrames = Math.max(1, Math.min(300, intOf(args.num_frames, 120)));
    const guidance = 5.0;
    const steps = 30;
    const seedInt = parseInt(text(args.seed), 10);
    const seed = Number.isFinite(seedInt) && seedInt >= 0 ? seedInt : null;

    async function readJson(res               )                   {
      const t = await res.text();
      try { return JSON.parse(t) } catch (e) { return { _text: t } }
    }

    async function dlBlob(url        )                   {
      const r = await deps.fetch("/img/dl?url=" + encodeURIComponent(url), { headers: authHdr() });
      if (!r.ok) throw new Error("下载失败(" + r.status + ")");
      return await r.blob();
    }

    async function createTask(imageBlob         , prompt        , negPrompt        )                  {
      function build(useTypo         )            {
        const fd = deps.formData();
        fd.append("prompt", prompt);
        fd.append("model", "Wan2_2-I2V-A14B");
        fd.append("num_frames", String(numFrames));
        fd.append("guidance_scale", String(guidance));
        fd.append("height", String(height));
        fd.append("width", String(width));
        if (negPrompt) fd.append("negative_prompt", negPrompt);
        if (seed !== null) fd.append("seed", String(seed));
        fd.append(useTypo ? "num_inferenece_steps" : "num_inference_steps", String(steps));
        fd.append("image", imageBlob, "frame.png");
        return fd;
      }
      const hdr = authHdr();
      let res = await deps.fetch("/img/v1/async/videos/image-to-video", { method: "POST", headers: hdr, body: build(false) });
      let j = recOf(await readJson(res));
      if (res.ok && j.task_id) return text(j.task_id);
      res = await deps.fetch("/img/v1/async/videos/image-to-video", { method: "POST", headers: hdr, body: build(true) });
      j = recOf(await readJson(res));
      if (res.ok && j.task_id) return text(j.task_id);
      throw new Error("创建任务失败(" + res.status + "): " + JSON.stringify(j).slice(0, 200));
    }

    async function pollTask(taskId        )                                                            {
      const start = timers.now();
      while (timers.now() - start < 60 * 60 * 1000) {
        // 2026-11-08(审查 P1): 单次轮询 25s 超时 —— 旧版裸 fetch,连接停滞则整个
        // 视频接力与 agent 轮次挂死(同仓 image-common 同型轮询已有 25s 先例)
        const ctl = typeof AbortController === "function" ? new AbortController() : null;
        const tm = ctl ? timers.set(function () { ctl.abort() }, 25000) : null;
        let res               ;
        try {
          res = await deps.fetch("/img/v1/task/" + encodeURIComponent(taskId), {
            method: "GET", headers: authHdr(), signal: ctl ? ctl.signal : undefined,
          });
        } catch (e) {
          if (tm !== null) timers.clear(tm);
          return { status: "error", raw: { error: "轮询网络异常: " + errText(e) } };
        }
        if (tm !== null) timers.clear(tm);
        const j = recOf(await readJson(res));
        const st = j.status ? text(j.status) : "unknown";
        if (st === "success" || st === "failed" || st === "cancelled") return { status: st, raw: j };
        await new Promise      (function (resolve) { timers.set(function () { resolve() }, 8000) });
      }
      return { status: "timeout", raw: {} };
    }

    function extractLastFrame(videoBlob         )                   {
      return new Promise(function (resolve, reject) {
        const url = deps.objectUrl.create(videoBlob);
        const v = doc.createElement("video");
        v.preload = "auto"; v.muted = true; v.playsInline = true; v.src = url;
        let done = false;
        const fail = function (msg        ) {
          if (done) return;
          done = true;
          deps.objectUrl.revoke(url);
          reject(new Error(msg));
        };
        v.addEventListener("loadedmetadata", function () {
          const t = Number.isFinite(v.duration) && v.duration > 0.1 ? v.duration - 0.05 : 0;
          try { v.currentTime = t } catch (e) { fail("seek 失败: " + errText(e)) }
        });
        v.addEventListener("seeked", function () {
          if (done) return;
          try {
            const c = doc.createElement("canvas");
            c.width = v.videoWidth || width;
            c.height = v.videoHeight || height;
            const ctx = c.getContext("2d");
            ctx.drawImage(v, 0, 0, c.width, c.height);
            c.toBlob(function (b) {
              done = true;
              deps.objectUrl.revoke(url);
              b ? resolve(b) : reject(new Error("canvas toBlob 返回空"));
            }, "image/png");
          } catch (e) { fail("尾帧提取失败(可能 canvas 被跨域污染): " + errText(e)) }
        });
        v.addEventListener("error", function () { fail("视频解码失败,无法提取尾帧") });
        timers.set(function () { fail("尾帧提取超时(>60s)") }, 60000);
      });
    }

    const clips              = [];
    let curFrame         ;
    try {
      emit({ type: "video_relay_start", total: segs.length });
      curFrame = await dlBlob(initUrl);
    } catch (e) {
      return { ok: false, error: "首帧图下载失败: " + errText(e) };
    }
    for (let i = 0; i < segs.length; i++) {
      emit({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "submit" });
      let taskId        ;
      try {
        taskId = await createTask(curFrame, segs[i].prompt, segs[i].negative_prompt);
      } catch (e) {
        return { ok: false, error: "第 " + (i + 1) + " 段创建失败: " + errText(e), clips };
      }
      emit({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "poll", taskId });
      const result = await pollTask(taskId);
      if (result.status !== "success") {
        return { ok: false, error: "第 " + (i + 1) + " 段任务 " + result.status + "(task=" + taskId + ")", clips };
      }
      const fileUrl = recOf(recOf(result.raw).output).file_url;
      if (!fileUrl) return { ok: false, error: "第 " + (i + 1) + " 段成功但无 file_url", clips };
      clips.push({ index: i + 1, file_url: text(fileUrl), prompt: segs[i].prompt });
      emit({ type: "video_relay_segment", index: i + 1, total: segs.length, phase: "done", fileUrl });
      if (i < segs.length - 1) {
        try {
          const vblob = await dlBlob(text(fileUrl));
          curFrame = await extractLastFrame(vblob);
        } catch (e) {
          return { ok: false, error: "第 " + (i + 1) + " 段尾帧提取失败,接力中断: " + errText(e), clips };
        }
      }
    }
    emit({ type: "video_relay_done", total: clips.length });
    return {
      ok: true,
      count: clips.length,
      clips: clips,
      note: "已按尾帧接力串行生成 " + clips.length + " 段。各段 file_url 下载后用剪映/FFmpeg 拼接,建议加轻微溶解转场掩盖接缝。",
    };
  }

  return { run };
}

// ── Video story tools (2026-11-25): the 1-5 segment cap, tail-frame relay, Gitee key fallback and
// per-segment fetch/poll live in services/tools/agent/video. No IO to inject from here: the tools
// bundle passes document, storage, image channels, fetch, onEvent and the DOM factories, because it
// owns every host global. Emit's global bridge publishes createVideoStoryTools for that caller.

globalThis.createVideoStoryTools = createVideoStoryTools;
})();
