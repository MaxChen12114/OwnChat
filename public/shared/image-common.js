// image-common.js —— 图像侧统一底层管线
// 暴露 window.__imageCommon：endpoints + 鉴权 + dlFetch + 出图/改图原语 + R2 转存 + 基准图存储。
// 三链(image-chat / image-quickgen / image-embed)统一调用本模块；语义差异(改图 steps/guidance、
// 画风拼接方式、轮询间隔、task_types)一律由调用方传参，本模块不写死。
// 必须在 image-chat.js / image-quickgen.js / image-embed.js 之前加载。
(function () {
  if (window.__imageCommon) return;

  // ── 端点常量(唯一真源)──
  var ENDPOINTS = {
    generations: '/img/v1/images/generations',
    editsAsync:  '/img/v1/async/images/edits',
    task:        '/img/v1/task/',     // + encodeURIComponent(taskId)
    download:    '/img/dl?url=',      // + encodeURIComponent(url)
  };

  // ── key / 鉴权(对齐 image-quickgen / image-chat / image-embed 约定)──
  // 渠道是数据：Gitee 只是内置的 openai/site 预设；自定义渠道用自己的 key。
  function getChannel() {
    try { return window.__imageChannels && window.__imageChannels.getActive ? window.__imageChannels.getActive() : null; }
    catch (e) { return null; }
  }
  function getKey() {
    var ch = getChannel();
    if (ch && ch.key) return ch.key;
    try { return localStorage.getItem('cfw_image_key_v1') || localStorage.getItem('moark_api_key') || ''; }
    catch (e) { return ''; }
  }
  function authHeaders(extra) {
    return headersFor(getChannel(), extra);
  }
  // 指定渠道的鉴权头：per-call 渠道(工坊下拉)优先，不能误用当前激活渠道的 key
  function headersFor(ch, extra) {
    var h = extra || {};
    var k = (ch && ch.key) || getKey();
    if (k) h['Authorization'] = 'Bearer ' + k;
    // 2026-10-09：设了 CHAT_PASSWORD 的部署，/img/* 要求带应用登录态（服务端 checkSync 读 X-Sync-Token）。
    // 不能借 Authorization —— 那个位置是上游 Gitee Key 的透传位。
    var t = appToken();
    if (t) h['X-Sync-Token'] = t;
    return h;
  }
  function appToken() {
    try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || localStorage.getItem('cfw_auth_token_v1') || ''; }
    catch (e) { return ''; }
  }
  // ── 4.81 修(手机端发图卡死): 给裸 fetch 套单次超时,网络停滞时快速失败而非无限挂起。
  //    调用方已自带 signal 时不二次包装(尊重外部中止语义)。──
  function fetchWithTimeout(url, init, ms) {
    init = init || {};
    if (init.signal) return fetch(url, init);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 60000);
    return fetch(url, Object.assign({}, init, { signal: ctrl.signal }))
      .finally(function () { clearTimeout(timer); });
  }
  // R2 写入用云同步 token(= CHAT_PASSWORD)，复用画廊那套
  function syncToken() { try { return (window.__auth && window.__auth.getToken && window.__auth.getToken()) || ''; } catch (e) { return ''; } }
  function syncHeaders(extra) { var h = extra || {}; var t = syncToken(); if (t) h['Authorization'] = 'Bearer ' + t; return h; }

  // ── 4.42-fix：data:URL 与同源链接直 fetch，只有跨域 http(s) 才走 /img/dl 代理 ──
  function dlFetch(u, opts) {
    u = u || '';
    opts = opts || {};
    var init = { method: 'GET', signal: opts.signal || null };
    if (/^data:/i.test(u)) return fetch(u, init);
    if (u.charAt(0) === '/') return fetch(u, init);
    var h = {}; var t = appToken(); if (t) h['X-Sync-Token'] = t;
    init.headers = h; // /img/dl 也过 checkSync；不把渠道 key 透给下载代理
    return fetch(ENDPOINTS.download + encodeURIComponent(u), init);
  }

  // ── 把任意图转存 R2 拿同源直链；未绑 R2(501)或失败 → 原链兜底 ──

  // ── 文生图原语：返回 url 数组(调用方决定取第几张；prompt 必须已是最终词，画风由调用方拼好)──
  function parseSize(size) {
    var m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || ''));
    return m ? [Math.max(64, +m[1]), Math.max(64, +m[2])] : [1024, 1024];
  }
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }
  async function genComfy(ch, opts, model, size) {
    var base = String(ch.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('ComfyUI 渠道未配置 Base URL');
    var wh = parseSize(size), w = Math.round(wh[0] / 8) * 8, h = Math.round(wh[1] / 8) * 8;
    var steps = Math.max(1, Math.min(80, +ch.steps || 9));
    var cfg = Math.max(0, +ch.cfg || 1);
    var wf = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ch.ckpt || 'z-image-turbo-fp8-aio.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt || '', clip: ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative || '', clip: ['1', 1] } },
      '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } },
      '6': { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0], seed: Math.floor(Math.random() * 2147483647), steps: steps, cfg: cfg, sampler_name: ch.sampler || 'res_multistep', scheduler: ch.scheduler || 'simple', denoise: 1 } },
      '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
      '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'site_channel' } }
    };
    var cid = 'site_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var pr = await fetchWithTimeout(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: cid }) }, 30000);
    if (!pr.ok) throw new Error('ComfyUI 提交失败 ' + pr.status + ' ' + (await pr.text().catch(function () { return ''; })));
    var pj = await pr.json();
    var pid = pj.prompt_id;
    if (!pid) throw new Error('ComfyUI 未返回 prompt_id');
    var start = Date.now();
    while (Date.now() - start < 180000) {
      await new Promise(function (rs) { setTimeout(rs, 2000); });
      var hr = await fetchWithTimeout(base + '/history/' + encodeURIComponent(pid), {}, 15000);
      if (!hr.ok) continue;
      var hj = await hr.json();
      var e = hj[pid];
      if (!e) continue;
      if (e.status && e.status.status_str === 'error') throw new Error('ComfyUI 执行失败');
      var im = null;
      Object.keys(e.outputs || {}).forEach(function (nid) {
        var o = e.outputs[nid];
        if (o && o.images && o.images.length) im = o.images[o.images.length - 1];
      });
      if (im) {
        var q = 'filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder || '') + '&type=' + encodeURIComponent(im.type || 'output');
        var ir = await fetchWithTimeout(base + '/view?' + q, {}, 30000);
        if (!ir.ok) throw new Error('ComfyUI 取图失败 ' + ir.status);
        return [await blobToDataURL(await ir.blob())];
      }
    }
    throw new Error('ComfyUI 出图超时');
  }
  async function genImage(opts) {
    opts = opts || {};
    var ch = opts.channel || getChannel();
    var model = opts.model || (ch && (ch.model || (ch.models && ch.models[0]))) || '';
    var n = opts.n || 1;
    var size = opts.size || '1024x1024';
    if (ch && ch.kind === 'comfyui') return genComfy(ch, opts, model, size);
    if (ch && ch.kind === 'openai' && ch.transport === 'direct') {
      if (!model) throw new Error('渠道未配置模型：请在设置 → 图像渠道填写模型名');
      var base = String(ch.baseUrl || '').replace(/\/+$/, '');
      if (!base) throw new Error('渠道未配置 Base URL');
      var dh = { 'Content-Type': 'application/json' };
      if (ch.key) dh['Authorization'] = 'Bearer ' + ch.key;
      var dr = await fetchWithTimeout(base + '/images/generations', {
        method: 'POST', headers: dh,
        body: JSON.stringify({ prompt: opts.prompt || '', model: model, n: n, size: size })
      }, opts.timeoutMs || 120000);
      if (!dr.ok) throw new Error('生图失败 ' + dr.status + ' ' + (await dr.text().catch(function () { return ''; })));
      var dj = await dr.json();
      var darr = (dj.data || []).map(function (d) { return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : ''); }).filter(Boolean);
      if (!darr.length) throw new Error('无返回图片');
      return darr;
    }
    // 站点代理（Gitee 预设 / transport:'site'）
    var body = { prompt: opts.prompt || '', model: model || 'z-image-turbo', n: n, size: size };
    var r = await fetchWithTimeout(ENDPOINTS.generations, {
      method: 'POST',
      headers: headersFor(ch, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }, 90000); // 4.81: z-image 同步出图最长 90s,超时即失败,不再无限挂手机端
    if (!r.ok) throw new Error('生图失败 ' + r.status + ' ' + (await r.text().catch(function () { return ''; })));
    var j = await r.json();
    var arr = (j.data || []).map(function (d) { return d.url || (d.b64_json ? 'data:image/png;base64,' + d.b64_json : ''); }).filter(Boolean);
    if (!arr.length) throw new Error('无返回图片');
    return arr;
  }

  // ── 改图任务轮询：命中 file_url 即返回；fail/error/cancel 抛错；支持中止/超时/间隔/onTick ──
  async function pollTask(taskId, o) {
    o = o || {};
    var intervalMs = o.intervalMs || 6000;
    // 4.81 修: 默认超时 30min→3min。改图任务通常 10-30s 完成; 30min 会让 agent 发图工具挂死数分钟,
    // 在手机端表现为「消息卡住截断」。需更长的调用方(如工坊批量)可显式传 timeoutMs。
    var timeoutMs = o.timeoutMs || 3 * 60 * 1000;
    var start = Date.now();
    var netErrs = 0;
    while (true) {
      if (o.isAborted && o.isAborted()) throw new Error('已取消');
      if (Date.now() - start > timeoutMs) throw new Error('出图超时');
      await new Promise(function (rs) { setTimeout(rs, intervalMs); });
      // 4.81 修: 单次轮询套 25s 超时 + 容忍偶发网络抖动(手机切网/代理断流);
      // 连续 5 次失败才放弃,期间靠总超时兜底,不再因一次断流就永久挂起或直接报错。
      var pj;
      try {
        var pr = await fetchWithTimeout(ENDPOINTS.task + encodeURIComponent(taskId), { headers: headersFor(o.channel || getChannel(), {}) }, 25000);
        if (!pr.ok) throw new Error('轮询失败 ' + pr.status);
        pj = await pr.json();
        netErrs = 0;
      } catch (e) {
        if (++netErrs >= 5) throw new Error('轮询网络异常: ' + (e && e.message ? e.message : e));
        continue;
      }
      var status = pj.status || pj.state || (pj.output ? 'success' : '');
      if (o.onTick) o.onTick(status || '处理中', pj);
      var fileUrl = (pj.output && pj.output.file_url) ||
        (pj.raw && pj.raw.output && pj.raw.output.file_url) ||
        (pj.data && pj.data[0] && pj.data[0].url);
      if (fileUrl) return fileUrl;
      if (status && /fail|error|cancel/i.test(status)) throw new Error('任务失败:' + status);
    }
  }

  // ── 改图原语：提交 async edit → 轮询 → 返回 {fileUrl, taskId}
  //    steps/guidance/model/taskTypes/intervalMs 全部由调用方传(三链语义不同，不写死)──
  async function genEdit(opts) {
    opts = opts || {};
    var ch = opts.channel || getChannel();
    if (ch && (ch.kind !== 'openai' || ch.transport !== 'site' || !(window.__imageChannels && window.__imageChannels.hasEdit(ch)))) {
      throw new Error('当前渠道不支持改图：请在设置里选择带站点代理的 OpenAI 兼容渠道（Gitee 预设）');
    }
    var blob = opts.blob || await (await dlFetch(opts.srcUrl, { signal: opts.signal })).blob();
    var fd = new FormData();
    fd.append('prompt', opts.prompt || '');
    fd.append('model', opts.model || (ch && ch.editModel) || 'Qwen-Image-Edit-2511');
    if (opts.steps != null) fd.append('num_inference_steps', String(opts.steps));
    if (opts.guidance != null) fd.append('guidance_scale', String(opts.guidance));
    if (opts.taskTypes && opts.taskTypes.length) opts.taskTypes.forEach(function (t) { fd.append('task_types', t); });
    fd.append('image', blob, opts.filename || 'src.png');
    if (opts.image2) fd.append('image', opts.image2, opts.filename2 || 'src2.png');
    var r = await fetch(ENDPOINTS.editsAsync, { method: 'POST', headers: headersFor(ch, {}), body: fd, signal: opts.signal || null });
    if (!r.ok) throw new Error('改图提交失败 ' + r.status + ' ' + (await r.text().catch(function () { return ''; })));
    var j = await r.json();
    var taskId = j.id || j.task_id || (j.data && (j.data.id || j.data.task_id));
    if (!taskId) throw new Error('未取到任务 id');
    var fileUrl = await pollTask(taskId, { intervalMs: opts.intervalMs, timeoutMs: opts.timeoutMs, onTick: opts.onTick, isAborted: opts.isAborted, channel: ch });
    return { fileUrl: fileUrl, taskId: taskId };
  }

  // ── 全局画风原料(image-portrait 托管 cfw_image_style_v1)。拼接方式各链不同，故只给原料 ──
  function styleSuffix() { try { var t = window.__portrait && window.__portrait.getStyleTags && window.__portrait.getStyleTags(); return (t || '').trim(); } catch (e) { return ''; } }

  // ── 角色发图基准图存储(characterId -> 同源持久链)。集中于此便于三链一致 ──
  var LS_BASE = 'cfw_chat_base_v1';
  function loadBaseMap() { try { return JSON.parse(localStorage.getItem(LS_BASE) || '{}') || {}; } catch (e) { return {}; } }
  function saveBaseMap(m) { try { localStorage.setItem(LS_BASE, JSON.stringify(m)); } catch (e) {} }
  function getBaseImage(characterId) { var m = loadBaseMap(); return m[characterId || 'default'] || null; }
  // 4.82: data:URL 压缩 —— 手机照片原图 base64 直写 localStorage 必超 5MB 配额,saveBaseMap 的 catch
  // 会静默吞掉写入而 UI 仍提示成功。统一在入库前把大图压到长边 ≤ maxEdge 的 JPEG;任一步失败回退原图。
  function shrinkDataUrl(dataUrl, maxEdge, quality) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var scale = Math.min(1, maxEdge / Math.max(w, h));
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(w * scale));
            cv.height = Math.max(1, Math.round(h * scale));
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            var out = cv.toDataURL('image/jpeg', quality || 0.85);
            resolve(out && out.length < dataUrl.length ? out : dataUrl);
          } catch (e) { resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      } catch (e) { resolve(dataUrl); }
    });
  }
  async function setBaseImage(characterId, imageUrl) {
    if (!imageUrl) return null;
    var src = imageUrl;
    // 4.82: 超过 ~300KB 的 data:URL 先压缩(R2 已绑定且非 data: 时走转存,不受影响)
    if (/^data:/i.test(src) && src.length > 300 * 1024) {
      src = await shrinkDataUrl(src, 1024, 0.85);
    }
    // 2026-11-08(审查 P1): R2 路由已删,转存调用恒失败回落 srcUrl —— 直用 src,删掉死调用
    var m = loadBaseMap(); m[characterId || 'default'] = src; saveBaseMap(m);
    return src;
  }
  function clearBaseImage(characterId) {
    var id = characterId || 'default';
    var m = loadBaseMap();
    if (m[id] != null) { delete m[id]; saveBaseMap(m); }
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