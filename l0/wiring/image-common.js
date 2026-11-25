// Browser adapter, appended by l0/emit.mjs. Engine: services/image/common.ts; this file owns the
// frozen global name, every network call, the canvas/FileReader work and the base-image storage.
//
// Load order matters: this must run before image-chat / image-quickgen / image-embed, because all
// three read it once at load time and give up if it is missing.
(function () {
  if (window.__imageCommon) return;

  var LS_BASE = "cfw_chat_base_v1";

  function readLS(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }

  function getChannel() {
    try { return window.__imageChannels && window.__imageChannels.getActive ? window.__imageChannels.getActive() : null; }
    catch (e) { return null; }
  }

  function appToken() {
    try {
      return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || readLS("cfw_auth_token_v1") || "";
    } catch (e) { return ""; }
  }

  function legacyKey() {
    return readLS("cfw_image_key_v1") || readLS("moark_api_key") || "";
  }

  function getKey() {
    var ch = getChannel();
    var own = ch && ch.key ? String(ch.key) : "";
    return own || legacyKey();
  }

  function authHeaders(extra) {
    return headersFor(getChannel(), extra);
  }

  function headersFor(ch, extra) {
    return buildAuthHeaders({ channel: ch, token: appToken(), legacyKey: legacyKey(), extra: extra });
  }

  function syncToken() {
    try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ""; } catch (e) { return ""; }
  }

  function syncHeaders(extra) {
    return buildSyncHeaders(syncToken(), extra);
  }

  // A single timeout per raw fetch: on a stalled mobile network the request must fail fast instead
  // of hanging. A caller-supplied signal wins — wrapping it would swallow its abort.
  function fetchWithTimeout(url, init, ms) {
    var o = init || {};
    if (o.signal) return window.fetch(url, o);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 60000);
    var withSignal = {};
    for (var k in o) withSignal[k] = o[k];
    withSignal.signal = ctrl.signal;
    return window.fetch(url, withSignal).finally(function () { clearTimeout(timer); });
  }

  // data: and same-origin links are fetched directly; only a cross-origin http(s) URL goes through
  // the download proxy, and the proxy never sees the channel key.
  function dlFetch(u, opts) {
    var url = u || "";
    var o = opts || {};
    var init = { method: "GET", signal: o.signal || null };
    if (/^data:/i.test(url)) return window.fetch(url, init);
    if (url.charAt(0) === "/") return window.fetch(url, init);
    var h = {};
    var t = appToken();
    if (t) h["X-Sync-Token"] = t;
    init.headers = h;
    return window.fetch(ENDPOINTS.download + encodeURIComponent(url), init);
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error("图片读取失败")); };
      fr.readAsDataURL(blob);
    });
  }

  // 4.82: an inline photo can exceed the localStorage quota, and the write would fail silently
  // while the UI still says "saved". Shrink to a bounded edge before it ever gets near storage;
  // any failure along the way keeps the original.
  function shrinkDataUrl(dataUrl, maxEdge, quality) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var scale = Math.min(1, maxEdge / Math.max(w, h));
            var cv = document.createElement("canvas");
            cv.width = Math.max(1, Math.round(w * scale));
            cv.height = Math.max(1, Math.round(h * scale));
            cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
            resolve(preferSmaller(cv.toDataURL("image/jpeg", quality || 0.85), dataUrl));
          } catch (e) { resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      } catch (e) { resolve(dataUrl); }
    });
  }

  async function comfyRun(base, wf) {
    var cid = "site_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var pr = await fetchWithTimeout(base + "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: wf, client_id: cid })
    }, 30000);
    if (!pr.ok) throw new Error("ComfyUI 提交失败 " + pr.status + " " + (await pr.text().catch(function () { return ""; })));
    var pj = await pr.json();
    var pid = pj.prompt_id;
    if (!pid) throw new Error("ComfyUI 未返回 prompt_id");
    var start = Date.now();
    while (Date.now() - start < 180000) {
      await new Promise(function (rs) { setTimeout(rs, 2000); });
      var hr = await fetchWithTimeout(base + "/history/" + encodeURIComponent(pid), {}, 15000);
      if (!hr.ok) continue;
      var hj = await hr.json();
      if (!hj[pid]) continue;
      if (comfyFailed(hj, pid)) throw new Error("ComfyUI 执行失败");
      var im = comfyImageFrom(hj, pid);
      if (im) {
        var q = "filename=" + encodeURIComponent(String(im.filename || "")) +
          "&subfolder=" + encodeURIComponent(String(im.subfolder || "")) +
          "&type=" + encodeURIComponent(String(im.type || "output"));
        var ir = await fetchWithTimeout(base + "/view?" + q, {}, 30000);
        if (!ir.ok) throw new Error("ComfyUI 取图失败 " + ir.status);
        return [await blobToDataURL(await ir.blob())];
      }
    }
    throw new Error("ComfyUI 出图超时");
  }

  async function genComfy(ch, opts, size) {
    var base = baseUrlOf(ch);
    if (!base) throw new Error("ComfyUI 渠道未配置 Base URL");
    var wf = buildComfyTextWorkflow(ch, opts, size, Math.floor(Math.random() * 2147483647));
    return comfyRun(base, wf);
  }

  async function genComfyEdit(ch, opts) {
    var base = baseUrlOf(ch);
    if (!base) throw new Error("ComfyUI 渠道未配置 Base URL");
    var blob = opts.blob || await (await dlFetch(opts.srcUrl, { signal: opts.signal })).blob();
    var fd = new FormData();
    fd.append("image", blob, opts.filename || "src.png");
    fd.append("overwrite", "true");
    var ur = await fetchWithTimeout(base + "/upload/image", { method: "POST", body: fd }, 60000);
    if (!ur.ok) throw new Error("ComfyUI 参考图上传失败 " + ur.status);
    var uj = await ur.json().catch(function () { return null; });
    if (!uj || !uj.name) throw new Error("ComfyUI 上传未返回文件名");
    var imgRef = (uj.subfolder ? uj.subfolder + "/" : "") + uj.name;
    var wf = buildComfyEditWorkflow(ch, opts, imgRef, Math.floor(Math.random() * 2147483647));
    return comfyRun(base, wf);
  }

  async function genImage(opts) {
    var o = opts || {};
    var ch = o.channel || getChannel();
    var model = pickModel(ch, o);
    var n = o.n || 1;
    var size = o.size || "1024x1024";
    if (isComfy(ch)) return genComfy(ch, o, size);
    if (isDirectOpenAI(ch)) {
      if (!model) throw new Error("渠道未配置模型：请在设置 → 图像渠道填写模型名");
      var base = baseUrlOf(ch);
      if (!base) throw new Error("渠道未配置 Base URL");
      var dh = { "Content-Type": "application/json" };
      if (ch.key) dh["Authorization"] = "Bearer " + ch.key;
      var dr = await fetchWithTimeout(base + "/images/generations", {
        method: "POST",
        headers: dh,
        body: JSON.stringify({ prompt: o.prompt || "", model: model, n: n, size: size })
      }, o.timeoutMs || 120000);
      if (!dr.ok) throw new Error("生图失败 " + dr.status + " " + (await dr.text().catch(function () { return ""; })));
      var urls = pickImageUrls(await dr.json());
      if (!urls.length) throw new Error("无返回图片");
      return urls;
    }
    var body = { prompt: o.prompt || "", model: model || "z-image-turbo", n: n, size: size };
    var r = await fetchWithTimeout(ENDPOINTS.generations, {
      method: "POST",
      headers: headersFor(ch, { "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    }, 90000); // z-image synchronous generation tops out near 90s
    if (!r.ok) throw new Error("生图失败 " + r.status + " " + (await r.text().catch(function () { return ""; })));
    var arr = pickImageUrls(await r.json());
    if (!arr.length) throw new Error("无返回图片");
    return arr;
  }

  // Poll one edit task. Tolerates transient network failures (5 in a row) because a phone switching
  // networks is not a failed task; the overall timeout is what stops the loop.
  async function pollTask(taskId, o) {
    var opt = o || {};
    var intervalMs = opt.intervalMs || 6000;
    var timeoutMs = opt.timeoutMs || 3 * 60 * 1000;
    var start = Date.now();
    var netErrs = 0;
    while (true) {
      if (opt.isAborted && opt.isAborted()) throw new Error("已取消");
      if (Date.now() - start > timeoutMs) throw new Error("出图超时");
      await new Promise(function (rs) { setTimeout(rs, intervalMs); });
      var pj;
      try {
        var pr = await fetchWithTimeout(ENDPOINTS.task + encodeURIComponent(taskId), { headers: headersFor(opt.channel || getChannel(), {}) }, 25000);
        if (!pr.ok) throw new Error("轮询失败 " + pr.status);
        pj = await pr.json();
        netErrs = 0;
      } catch (e) {
        if (++netErrs >= 5) throw new Error("轮询网络异常: " + (e && e.message ? e.message : e));
        continue;
      }
      var st = pollState(pj);
      if (opt.onTick) opt.onTick(st.status || "处理中", pj);
      if (st.fileUrl) return st.fileUrl;
      if (st.failed) throw new Error("任务失败:" + st.status);
    }
  }

  async function genEdit(opts) {
    var o = opts || {};
    var ch = o.channel || getChannel();
    if (isComfy(ch)) return await genComfyEdit(ch, o);
    if (isDirectOpenAI(ch)) {
      if (!ch.editModel) throw new Error("当前直连渠道未配置改图模型：渠道详情 → 改图模型");
      var base = baseUrlOf(ch);
      if (!base) throw new Error("渠道未配置 Base URL");
      var blob = o.blob || await (await dlFetch(o.srcUrl, { signal: o.signal })).blob();
      var fd = new FormData();
      fd.append("model", ch.editModel);
      fd.append("prompt", o.prompt || "");
      fd.append("image", blob, o.filename || "src.png");
      if (o.image2) fd.append("image", o.image2, o.filename2 || "src2.png");
      fd.append("n", "1");
      if (o.size) fd.append("size", o.size);
      var r = await fetchWithTimeout(base + "/images/edits", {
        method: "POST",
        headers: { "Authorization": "Bearer " + (ch.key || "") },
        body: fd
      }, o.timeoutMs || 180000);
      if (!r.ok) throw new Error("改图失败 " + r.status + " " + (await r.text().catch(function () { return ""; })));
      var urls = pickImageUrls(await r.json());
      if (!urls.length) throw new Error("改图返回为空");
      return { fileUrl: urls[0], taskId: null };
    }
    if (!(window.__imageChannels && window.__imageChannels.hasEdit(ch))) {
      throw new Error("当前渠道不支持改图：Gitee 预设 / 配置了改图模型的自定义渠道 / ComfyUI 可用");
    }
    var srcBlob = o.blob || await (await dlFetch(o.srcUrl, { signal: o.signal })).blob();
    var form = new FormData();
    form.append("prompt", o.prompt || "");
    form.append("model", o.model || (ch && ch.editModel) || "Qwen-Image-Edit-2511");
    if (o.steps != null) form.append("num_inference_steps", String(o.steps));
    if (o.guidance != null) form.append("guidance_scale", String(o.guidance));
    if (o.taskTypes && o.taskTypes.length) o.taskTypes.forEach(function (t) { form.append("task_types", t); });
    form.append("image", srcBlob, o.filename || "src.png");
    if (o.image2) form.append("image", o.image2, o.filename2 || "src2.png");
    var sub = await window.fetch(ENDPOINTS.editsAsync, {
      method: "POST",
      headers: headersFor(ch, {}),
      body: form,
      signal: o.signal || null
    });
    if (!sub.ok) throw new Error("改图提交失败 " + sub.status + " " + (await sub.text().catch(function () { return ""; })));
    var j = await sub.json();
    var taskId = j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
    if (!taskId) throw new Error("未取到任务 id");
    var fileUrl = await pollTask(taskId, {
      intervalMs: o.intervalMs, timeoutMs: o.timeoutMs, onTick: o.onTick, isAborted: o.isAborted, channel: ch
    });
    return { fileUrl: fileUrl, taskId: taskId };
  }

  // Raw style tags only: each chain concatenates them differently, so this module does not join.
  function styleSuffix() {
    try {
      var t = window.__portrait && window.__portrait.getStyleTags && window.__portrait.getStyleTags();
      return (t || "").trim();
    } catch (e) { return ""; }
  }

  function readBaseMap() { return parseBaseMap(readLS(LS_BASE)); }
  function writeBaseMap(m) { try { window.localStorage.setItem(LS_BASE, JSON.stringify(m)); } catch (e) {} }

  function getBaseImage(characterId) {
    var v = baseEntry(readBaseMap(), characterId);
    return v || null;
  }

  async function setBaseImage(characterId, imageUrl) {
    if (!imageUrl) return null;
    var src = imageUrl;
    if (needsShrink(src)) src = await shrinkDataUrl(src, SHRINK_EDGE, SHRINK_QUALITY);
    // Generated links expire, and an expired base image breaks both selfies and edits. Localise the
    // bytes before storing; a failed fetch keeps the URL, which is still better than nothing.
    if (!isInline(src)) {
      try {
        var b = await (await dlFetch(src, {})).blob();
        var d = await blobToDataURL(b);
        if (isInline(d)) src = needsShrink(d) ? await shrinkDataUrl(d, SHRINK_EDGE, SHRINK_QUALITY) : d;
      } catch (e) {}
    }
    writeBaseMap(setBaseEntry(readBaseMap(), characterId, src));
    return src;
  }

  function clearBaseImage(characterId) {
    var id = baseId(characterId);
    var m = readBaseMap();
    if (m[id] != null) writeBaseMap(dropBaseEntry(m, characterId));
    return id;
  }

  window.__imageCommon = {
    ENDPOINTS: ENDPOINTS,
    getKey: getKey, getChannel: getChannel, authHeaders: authHeaders,
    syncToken: syncToken, syncHeaders: syncHeaders,
    dlFetch: dlFetch,
    genImage: genImage, genEdit: genEdit, pollTask: pollTask,
    styleSuffix: styleSuffix,
    baseImage: { get: getBaseImage, set: setBaseImage, clear: clearBaseImage, LS_KEY: LS_BASE }
  };
})();
