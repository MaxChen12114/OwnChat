(function () {
/**
 * The image-channel settings card, minus the DOM: the list labels, the draft the form describes, the
 * two checks that decide whether a draft may be written, and the shape of a "test this channel" call.
 *
 * A draft is built from a snapshot of the form, not from the form itself, which is what makes the
 * save/validate rules testable without a browser. Two of those rules are the ones that used to bite:
 *  - Saving must not clear a custom channel's edit model. Only the ComfyUI branch has no such field;
 *    an OpenAI-compatible channel keeps whatever was typed, which is the difference between "supports
 *    editing" and "looks like it does".
 *  - A draft that is not yet filled in must not be written when the user simply switches channels,
 *    or a fresh "new channel" row would overwrite the one that was there.
 *
 * Support for a preset and a custom endpoint differ in wording only here: the guest filter and the
 * tag text are presentation, but they carry real policy (a guest may not pick the site preset).
 * @module services/image/channels-ui
 */

                                               

                        
             
               
                    
                    
                  
              
                   
                
                    
                         
               
                
 

/** Form snapshot: exactly the fields the card offers, already read off the DOM by the caller. */
                             
                
                
                   
               
                  
                 
                     
                
                 
 

function str(v         )         {
  return typeof v === "string" ? v : "";
}

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function arrOf(v         )           {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

function isGitee(ch         )          {
  return str(recOf(ch).id) === "gitee";
}

function isComfy(ch         )          {
  return str(recOf(ch).kind) === "comfyui";
}

/** Comma / full-width comma / newline separated model names, trimmed and non-empty. */
function parseModels(v         )           {
  return String(v || "")
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** One-line summary under a channel name in the list. */
function channelTag(ch         )         {
  const c = recOf(ch);
  if (isGitee(c)) return "站点代理 · " + (c.key ? "Key 已配置" : "Key 未配置");
  if (isComfy(c)) return "本机 ComfyUI · " + (str(c.ckpt) || "未填 ckpt");
  return "OpenAI 兼容 · " + (str(c.model) ? "模型 " + str(c.model) : "未选模型");
}

function groupLabel(ch         )         {
  return isGitee(ch) ? "内置预设（站点代理）" : "自定义渠道（账号同步）";
}

/** A guest may not see or select the site's own preset. */
function visibleFor(list         , isGuest         )            {
  const arr = Array.isArray(list) ? list.slice() : [];
  return isGuest ? arr.filter((ch) => !isGitee(ch)) : arr;
}

/** Options for the model select; the current model is inserted when the list does not carry it. */
function modelOptions(ch         )                                         {
  const c = recOf(ch);
  const models = arrOf(c.models).slice();
  const cur = str(c.model);
  if (cur && models.indexOf(cur) < 0) models.unshift(cur);
  return models.map((m) => ({ value: m, selected: m === cur }));
}

/**
 * Build the channel a save would write. The preset keeps its fixed identity (name, endpoint,
 * transport); everything else comes from the form, falling back to the stored channel.
 */
function buildDraft(id        , old         , form            )        {
  const prev = recOf(old);
  const gitee = id === "gitee";
  const kind              = gitee ? "openai" : ((str(form.kind) || str(prev.kind) || "openai") === "comfyui" ? "comfyui" : "openai");
  const models = form.models != null ? parseModels(form.models) : arrOf(prev.models).slice();
  let model = str(form.model) || models[0] || "";
  if (model && models.indexOf(model) < 0) models.unshift(model);
  const editModel = str(form.editModel).trim();
  const capabilities =
    kind === "comfyui"
      ? ["t2i", "edit"]
      : (gitee ? ["t2i", "edit"] : ["t2i"]).concat(kind === "openai" && editModel ? ["edit"] : []);
  return {
    id: id,
    name: gitee ? str(prev.name) : (str(form.name).trim() || str(prev.name) || "未命名渠道"),
    kind: kind,
    transport: kind === "comfyui" ? "direct" : (gitee ? "site" : "direct"),
    baseUrl: gitee ? (str(prev.baseUrl) || "https://ai.gitee.com/v1") : (str(form.baseUrl).trim() || str(prev.baseUrl)),
    key: str(form.key).trim() || str(prev.key),
    models: models,
    model: model,
    // An OpenAI-compatible channel keeps its edit model; the ComfyUI branch has no such field.
    editModel: kind === "openai" ? (editModel || str(prev.editModel)) : "",
    capabilities: capabilities,
    ckpt: str(form.ckpt).trim() || str(prev.ckpt),
    steps: Number(form.steps) || Number(prev.steps) || 9
  };
}

/** Why a draft may not be saved, or null when it may. */
function validateDraft(d       )                {
  if (!d.baseUrl) return "Base URL 不能为空";
  if (d.kind === "openai" && !d.models.length) return "至少填一个模型名";
  return null;
}

/**
 * Whether switching away may write the current draft. A half-filled new channel is left unsaved on
 * purpose: committing it would replace the channel the user was looking at.
 */
function canCommit(d       )          {
  if (d.kind === "openai" && !d.baseUrl) return false;
  if (d.kind === "openai" && !d.models.length) return false;
  return true;
}

                              
              
                                  
 

/**
 * The probe a "test" click performs: ComfyUI answers on /system_stats, an OpenAI-compatible endpoint
 * on /models — through the site proxy for the preset, directly for a user's own endpoint.
 */
function testRequest(ch         )                     {
  const c = recOf(ch);
  const base = str(c.baseUrl).replace(/\/+$/, "");
  if (!base && !isGitee(c)) return null;
  if (isComfy(c)) return { url: base + "/system_stats", headers: {} };
  const headers                         = {};
  if (str(c.key)) headers["Authorization"] = "Bearer " + str(c.key);
  const url = c.transport === "site" ? "/img/v1/models" : base + "/models";
  return { url: url, headers: headers };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/image/channels-ui.ts; this file owns the
// card markup, the list/detail panes and the click wiring.
//
// Layout mirrors the chat channel card: channel list on the left, details on the right. The list is
// data, so the preset is just one row. Saving is not switching — only "use this channel" changes the
// active one, which is why adding a channel cannot knock the current one out.
//
// Loads after the channel registry; mounted when settings opens.
(function () {
  'use strict';
  if (window.__imageChannelsUI) return;

  var C = window.__imageChannels;
  if (!C) { console.warn('[image-channels-ui] 缺少 image-channels.js'); return; }

  function q(id) { return document.getElementById(id); }
  var esc = window.__ownEscape.esc;
  function guest() { try { return !!(window.__auth && window.__auth.getToken && !window.__auth.getToken()); } catch (e) { return false; } }

  // Same inline styles as the chat channel card.
  var INP = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
  var LBL = 'font-size:12px;color:var(--muted);display:block;margin-bottom:4px;';
  var BTN = 'cursor:pointer;text-align:left;width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;line-height:1.5;';

  function field(label, input) {
    return '<div style="margin-top:8px;"><label style="' + LBL + '">' + label + '</label>' + input + '</div>';
  }
  // The option list itself comes from the service; only the markup is built here.
  function modelOptionsHtml(ch) {
    var opts = modelOptions(ch);
    if (!opts.length) return '<option value="">（先填模型列表）</option>';
    return opts.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.selected ? ' selected' : '') + '>' + esc(o.value) + '</option>';
    }).join('');
  }

  function mount() {
    var slot = q('setModelApiSlot'); if (!slot || q('imgChCard')) return;

    var card = document.createElement('div'); card.className = 'card'; card.id = 'imgChCard';
    card.innerHTML = '<h4>图像模型 · 渠道管理</h4>'
      + '<p>图像走哪个渠道，这里说了算。左侧选渠道（点击即切换），右侧看详情：填端点 / Key、模型列表，点「使用此渠道」后，图像工坊、角色立绘、聊天发图和创作工坊页都跟着它走。'
      + '内置 Gitee 预设走站点代理；自定义渠道由浏览器直连（服务商需允许 CORS，本机 ComfyUI 也需允许 CORS），<b>API Key 随账号同步</b>（存在你自己的 Cloudflare KV）。</p>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;align-items:flex-start;">'
      +   '<div id="imgChList" style="flex:0 0 190px;min-width:158px;display:flex;flex-direction:column;gap:4px;"></div>'
      +   '<div id="imgChDetail" style="flex:1;min-width:230px;border-left:1px solid var(--border,#333);padding-left:12px;"></div>'
      + '</div>';

    // Sits right below the chat channel card; appended when that card is not there yet.
    var chatCard = q('byoProviderCard');
    if (chatCard && chatCard.parentNode === slot) slot.insertBefore(card, chatCard.nextSibling);
    else slot.appendChild(card);

    var listEl = card.querySelector('#imgChList');
    var detailEl = card.querySelector('#imgChDetail');
    var _all = visibleFor(C.list(), guest());
    var _act = C.activeId();
    var selId = (_all.some(function (ch) { return ch.id === _act; }) ? _act : (_all[0] && _all[0].id)) || '';

    function setStatus(msg, cls) {
      var s = q('imgChStatus'); if (!s) return;
      s.textContent = msg || '';
      s.style.color = cls === 'err' ? '#e5484d' : (cls === 'ok' ? '#25c2a0' : 'var(--muted)');
    }

    function renderList() {
      var chs = visibleFor(C.list(), guest());
      var html = '';
      if (guest()) html += '<div style="font-size:11px;color:var(--muted);margin:0 0 6px;">访客模式：本站生图预设已关闭，请新增自己的图像渠道（自带 Key）。</div>';
      var group = '';
      chs.forEach(function (ch) {
        var g = isGitee(ch) ? 'preset' : 'custom';
        if (g !== group) {
          group = g;
          html += '<div style="font-size:11px;color:var(--muted);margin:' + (html ? '8px' : '0') + ' 0 2px;">' + groupLabel(ch) + '</div>';
        }
        var isAct = C.activeId() === ch.id, isSel = selId === ch.id;
        var badge = isAct ? '<span style="color:var(--accent,#7aa2f7);">　● 使用中</span>' : '';
        html += '<button type="button" data-id="' + esc(ch.id) + '" style="' + BTN + (isSel ? 'border-color:var(--accent,#7aa2f7);' : '') + '">'
          + '<b style="font-size:12.5px;">' + esc(ch.name) + badge + '</b>'
          + '<small style="color:var(--muted);font-size:11px;display:block;margin-top:1px;word-break:break-all;">' + esc(channelTag(ch)) + '</small></button>';
      });
      html += '<button type="button" data-new="1" style="' + BTN + 'border-style:dashed;color:var(--muted);">＋ 新增图像渠道</button>';
      if (!guest() && !chs.some(isGitee)) {
        html += '<button type="button" data-restore="1" style="' + BTN + 'border-style:dashed;color:var(--muted);">恢复 Gitee 预设</button>';
      }
      listEl.innerHTML = html;
    }

    // Snapshot the form, then let the service decide what the channel looks like.
    function readForm(id) {
      var val = function (el) { return el ? el.value : undefined; };
      return buildDraft(id, C.get(id) || {}, {
        name: val(q('imgChName')),
        kind: val(q('imgChKind')),
        baseUrl: val(q('imgChBase')),
        key: val(q('imgChKey')),
        models: val(q('imgChModels')),
        model: val(q('imgChModel')),
        editModel: val(q('imgChEditModel')),
        ckpt: val(q('imgChCkpt')),
        steps: (function () { var el = q('imgChSteps'); return el ? +el.value : undefined; })()
      });
    }

    // Write the current form before switching away. An empty new draft is skipped on purpose:
    // committing it would replace the channel the user was looking at.
    function commitDraft() {
      if (!C.get(selId)) return;
      var draft = readForm(selId);
      if (!canCommit(draft)) return;
      C.save(draft);
    }

    function saveCurrent(activate) {
      var draft = readForm(selId);
      var why = validateDraft(draft);
      if (why) return setStatus(why, 'err');
      var saved = C.save(draft);
      if (activate) C.setActive(saved.id);
      selId = saved.id;
      renderList(); renderDetail();
      setStatus(activate ? '已切换到这个渠道' : '已保存此渠道', 'ok');
    }

    function fillModelSelectFromInput() {
      var sel = q('imgChModel'); if (!sel) return;
      var cur = sel.value;
      var models = parseModels((q('imgChModels') || {}).value);
      if (!models.length) { sel.innerHTML = '<option value="">（先填模型列表）</option>'; return; }
      sel.innerHTML = models.map(function (m) {
        return '<option value="' + esc(m) + '">' + esc(m) + '</option>';
      }).join('');
      if (cur && models.indexOf(cur) >= 0) sel.value = cur;
    }

    async function testChannel(ch) {
      var req = testRequest(ch);
      if (!req) return setStatus('先填 Base URL', 'err');
      setStatus('测试中…');
      try {
        var r = await window.fetch(req.url, { headers: req.headers, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text().catch(function () { return ''; })).slice(0, 80));
        if (ch.kind === 'comfyui') return setStatus('ComfyUI 可达', 'ok');
        var j = await r.json();
        return setStatus('可达，返回 ' + ((j.data || []).length) + ' 个模型', 'ok');
      } catch (e) {
        setStatus('连接失败：' + ((e && e.message) || e), 'err');
      }
    }

    function renderDetail() {
      var ch = C.get(selId);
      if (!ch) { var all = C.list(); ch = all[0] || null; if (ch) selId = ch.id; }
      if (!ch) { detailEl.innerHTML = ''; return; }
      var gitee = isGitee(ch), comfy = isComfy(ch);
      var active = C.activeId() === ch.id;
      var useBtn = active
        ? '<span style="font-size:12px;color:var(--accent,#7aa2f7);">● 当前渠道</span>'
        : '<button class="smallbtn" type="button" data-act="use">使用此渠道</button>';
      var html = '<div style="font-weight:600;font-size:14px;">' + esc(ch.name)
        + '<span style="font-size:11px;color:var(--muted);font-weight:400;">　'
        + (gitee ? '内置预设 · 站点代理' : (comfy ? '自定义 · 本机 ComfyUI' : '自定义 · OpenAI 兼容'))
        + '</span></div>';

      if (gitee) {
        html += '<div style="font-size:12px;color:var(--muted);margin-top:4px;">站点代理：Endpoint 固定为 <code>https://ai.gitee.com/v1</code>，经部署的 <code>/img/v1</code> 代理调用。</div>';
        html += field('API Key', '<input id="imgChKey" type="password" placeholder="Gitee API Key" style="' + INP + '" value="' + esc(ch.key) + '">');
        html += field('模型列表（逗号分隔）', '<input id="imgChModels" placeholder="z-image-turbo, Qwen-Image-Edit-2511" style="' + INP + '" value="' + esc((ch.models || []).join(', ')) + '">');
        html += field('默认模型', '<select id="imgChModel" style="' + INP + '">' + modelOptionsHtml(ch) + '</select>');
        html += field('改图模型', '<input id="imgChEditModel" placeholder="Qwen-Image-Edit-2511" style="' + INP + '" value="' + esc(ch.editModel) + '">');
        html += '<div class="btns" style="margin-top:12px;">' + useBtn
          + '<button class="smallbtn" type="button" data-act="save">保存</button>'
          + '<button class="smallbtn" type="button" data-act="test">测试</button></div>';
      } else {
        html += field('渠道名称', '<input id="imgChName" placeholder="渠道名称" style="' + INP + '" value="' + esc(ch.name) + '">');
        html += field('渠道类型', '<select id="imgChKind" style="' + INP + '">'
          + '<option value="openai"' + (comfy ? '' : ' selected') + '>OpenAI 兼容</option>'
          + '<option value="comfyui"' + (comfy ? ' selected' : '') + '>本地 ComfyUI</option></select>');
        html += field('Base URL', '<input id="imgChBase" placeholder="OpenAI 兼容填 .../v1；ComfyUI 填 http://127.0.0.1:8188" style="' + INP + '" value="' + esc(ch.baseUrl) + '">');
        html += '<div id="imgChOpenAiFields" style="display:' + (comfy ? 'none' : '') + ';">';
        html += field('API Key', '<input id="imgChKey" type="password" placeholder="可留空（本地端点）" style="' + INP + '" value="' + esc(ch.key) + '">');
        html += field('模型列表（逗号分隔）', '<input id="imgChModels" placeholder="模型名，逗号分隔" style="' + INP + '" value="' + esc((ch.models || []).join(', ')) + '">');
        html += field('默认模型', '<select id="imgChModel" style="' + INP + '">' + modelOptionsHtml(ch) + '</select>');
        html += '</div>';
        html += '<div id="imgChComfyFields" style="display:' + (comfy ? '' : 'none') + ';">';
        html += field('ckpt 文件名', '<input id="imgChCkpt" placeholder="z-image-turbo-fp8-aio.safetensors" style="' + INP + '" value="' + esc(ch.ckpt) + '">');
        html += field('steps', '<input id="imgChSteps" type="number" min="1" max="80" value="' + (ch.steps || 9) + '" style="' + INP + '">');
        html += '</div>';
        html += '<div class="btns" style="margin-top:12px;">' + useBtn
          + '<button class="smallbtn" type="button" data-act="save">保存此渠道</button>'
          + '<button class="smallbtn" type="button" data-act="test">测试</button>'
          + '<button class="smallbtn danger" type="button" data-act="delete">删除</button></div>';
      }
      html += '<div id="imgChStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
      detailEl.innerHTML = html;

      var kindEl = q('imgChKind');
      if (kindEl) kindEl.addEventListener('change', function () {
        var c = this.value === 'comfyui';
        var a = q('imgChOpenAiFields'), b = q('imgChComfyFields');
        if (a) a.style.display = c ? 'none' : '';
        if (b) b.style.display = c ? '' : 'none';
      });
      var modelsEl = q('imgChModels');
      if (modelsEl) modelsEl.addEventListener('input', fillModelSelectFromInput);
    }

    listEl.addEventListener('click', function (e) {
      var restore = e.target.closest && e.target.closest('[data-restore]');
      if (restore) {
        var saved = C.save(C.DEFAULT_GITEE);
        selId = saved.id;
        renderList(); renderDetail();
        setStatus('已恢复 Gitee 预设', 'ok');
        return;
      }
      var add = e.target.closest && e.target.closest('[data-new]');
      if (add) {
        commitDraft();
        var ch = C.create();
        selId = ch.id;
        renderList(); renderDetail();
        setStatus('已新增渠道 · 填好后点「保存此渠道」', 'ok');
        return;
      }
      var btn = e.target.closest && e.target.closest('[data-id]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (id === selId) return;
      commitDraft();
      selId = id;
      renderList(); renderDetail();
    });

    detailEl.addEventListener('click', async function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'use') return saveCurrent(true);
      if (act === 'save') return saveCurrent(false);
      if (act === 'test') return testChannel(readForm(selId));
      if (act === 'delete') {
        var ch = C.get(selId); if (!ch || isGitee(ch)) return;
        const okDel = (window.__feedback && window.__feedback.confirm)
          ? await window.__feedback.confirm({ title: '删除渠道', message: '删除渠道「' + (ch.name || selId) + '」？Key 一并删除。', okText: '删除', danger: true })
          : confirm('删除渠道「' + (ch.name || selId) + '」？Key 一并删除。');
        if (!okDel) return;
        var wasActive = C.activeId() === ch.id;
        if (!C.remove(ch.id)) return setStatus('至少保留一个渠道', 'err');
        selId = C.activeId() || (C.list()[0] && C.list()[0].id) || '';
        renderList(); renderDetail();
        setStatus(wasActive ? '已删除，并切到当前渠道' : '已删除', 'ok');
      }
    });

    renderList();
    renderDetail();
  }

  window.__imageChannelsUI = { mount: mount };
})();

globalThis.isGitee = isGitee;
globalThis.isComfy = isComfy;
globalThis.parseModels = parseModels;
globalThis.channelTag = channelTag;
globalThis.groupLabel = groupLabel;
globalThis.visibleFor = visibleFor;
globalThis.modelOptions = modelOptions;
globalThis.buildDraft = buildDraft;
globalThis.validateDraft = validateDraft;
globalThis.canCommit = canCommit;
globalThis.testRequest = testRequest;
})();
