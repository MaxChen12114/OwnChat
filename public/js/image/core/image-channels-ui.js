/**
 * image-channels-ui.js · 设置 → 模型 API → 图像模型 · 渠道管理
 *
 * 版式对齐聊天渠道卡（settings.js mountByoCard）：左侧渠道列表 + 右侧详情。
 * 渠道列表是数据（localStorage），Gitee 只是内置预设；支持新增/编辑/删除/测试。
 * 保存 ≠ 启用：点「使用此渠道」才切换当前渠道，避免新增时把原来的渠道顶掉。
 *
 * 必须在 image-channels.js 之后加载；在设置面板打开时挂载。
 */
(function () {
  'use strict';
  if (window.__imageChannelsUI) return;

  var C = window.__imageChannels;
  if (!C) { console.warn('[image-channels-ui] 缺少 image-channels.js'); return; }

  function q(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function parseModels(v) {
    return String(v || '').split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function isGitee(ch) { return !!(ch && ch.id === 'gitee'); }
  function isComfy(ch) { return !!(ch && ch.kind === 'comfyui'); }

  // 与聊天渠道卡同一套内联样式
  var INP = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
  var LBL = 'font-size:12px;color:var(--muted);display:block;margin-bottom:4px;';
  var BTN = 'cursor:pointer;text-align:left;width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;line-height:1.5;';

  function channelTag(ch) {
    if (isGitee(ch)) return '站点代理 · ' + (ch.key ? 'Key 已配置' : 'Key 未配置');
    if (isComfy(ch)) return '本机 ComfyUI · ' + (ch.ckpt || '未填 ckpt');
    return 'OpenAI 兼容 · ' + (ch.model ? ('模型 ' + ch.model) : '未选模型');
  }
  function groupLabel(ch) {
    return isGitee(ch) ? '内置预设（站点代理）' : '自定义渠道（本机保存）';
  }
  function field(label, input) {
    return '<div style="margin-top:8px;"><label style="' + LBL + '">' + label + '</label>' + input + '</div>';
  }
  function modelOptions(ch) {
    var models = (ch && ch.models) ? ch.models.slice() : [];
    var cur = (ch && ch.model) || '';
    if (cur && models.indexOf(cur) < 0) models.unshift(cur);
    if (!models.length) return '<option value="">（先填模型列表）</option>';
    return models.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
  }

  function mount() {
    var slot = q('setModelApiSlot'); if (!slot || q('imgChCard')) return;

    var card = document.createElement('div'); card.className = 'card'; card.id = 'imgChCard';
    card.innerHTML = '<h4>图像模型 · 渠道管理</h4>'
      + '<p>图像走哪个渠道，这里说了算。左侧选渠道（点击即切换），右侧看详情：填端点 / Key、模型列表，点「使用此渠道」后，图像工坊、角色立绘、聊天发图和创作工坊页都跟着它走。'
      + '内置 Gitee 预设走站点代理；自定义渠道由浏览器直连（服务商需允许 CORS，本机 ComfyUI 也需允许 CORS），<b>Key 仅存本设备</b>。</p>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;align-items:flex-start;">'
      +   '<div id="imgChList" style="flex:0 0 190px;min-width:158px;display:flex;flex-direction:column;gap:4px;"></div>'
      +   '<div id="imgChDetail" style="flex:1;min-width:230px;border-left:1px solid var(--border,#333);padding-left:12px;"></div>'
      + '</div>';

    // 放在聊天渠道卡下面；聊天卡还没挂上时退到末尾
    var chatCard = q('byoProviderCard');
    if (chatCard && chatCard.parentNode === slot) slot.insertBefore(card, chatCard.nextSibling);
    else slot.appendChild(card);

    var listEl = card.querySelector('#imgChList');
    var detailEl = card.querySelector('#imgChDetail');
    var selId = C.activeId() || (C.list()[0] && C.list()[0].id) || '';

    function setStatus(msg, cls) {
      var s = q('imgChStatus'); if (!s) return;
      s.textContent = msg || '';
      s.style.color = cls === 'err' ? '#e5484d' : (cls === 'ok' ? '#25c2a0' : 'var(--muted)');
    }

    function renderList() {
      var chs = C.list(), html = '', group = '';
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
      if (!chs.some(isGitee)) {
        html += '<button type="button" data-restore="1" style="' + BTN + 'border-style:dashed;color:var(--muted);">恢复 Gitee 预设</button>';
      }
      listEl.innerHTML = html;
    }

    function readForm(id) {
      var old = C.get(id) || {};
      var gitee = id === 'gitee';
      var kind = gitee ? 'openai' : ((q('imgChKind') && q('imgChKind').value) || old.kind || 'openai');
      var modelsEl = q('imgChModels');
      var models = modelsEl ? parseModels(modelsEl.value) : (old.models || []).slice();
      var modelEl = q('imgChModel');
      var model = (modelEl && modelEl.value) || models[0] || '';
      if (model && models.indexOf(model) < 0) models.unshift(model);
      var nameEl = q('imgChName');
      var baseEl = q('imgChBase');
      var keyEl = q('imgChKey');
      var editEl = q('imgChEditModel');
      var ckptEl = q('imgChCkpt');
      var stepsEl = q('imgChSteps');
      return {
        id: id,
        name: gitee ? old.name : ((nameEl && nameEl.value.trim()) || old.name || '未命名渠道'),
        kind: kind,
        transport: kind === 'comfyui' ? 'direct' : (gitee ? 'site' : 'direct'),
        baseUrl: gitee ? (old.baseUrl || 'https://ai.gitee.com/v1') : ((baseEl && baseEl.value.trim()) || old.baseUrl || ''),
        key: (keyEl && keyEl.value.trim()) || old.key || '',
        models: models,
        model: model,
        editModel: gitee ? ((editEl && editEl.value.trim()) || old.editModel || '') : '',
        capabilities: gitee ? ['t2i', 'edit'] : ['t2i'],
        ckpt: (ckptEl && ckptEl.value.trim()) || old.ckpt || '',
        steps: (stepsEl && +stepsEl.value) || old.steps || 9
      };
    }

    // 切换渠道前把当前表单落盘；新建的空草稿不落盘，避免“一新增原来就没了”
    function commitDraft() {
      var ch = C.get(selId); if (!ch) return;
      var form = readForm(selId);
      if (form.kind === 'openai' && !form.baseUrl) return;
      if (form.kind === 'openai' && !form.models.length) return;
      C.save(form);
    }

    function saveCurrent(activate) {
      var form = readForm(selId);
      if (!form.baseUrl) return setStatus('Base URL 不能为空', 'err');
      if (form.kind === 'openai' && !form.models.length) return setStatus('至少填一个模型名', 'err');
      var saved = C.save(form);
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
      var base = String(ch.baseUrl || '').replace(/\/+$/, '');
      if (!base) return setStatus('先填 Base URL', 'err');
      setStatus('测试中…');
      try {
        if (ch.kind === 'comfyui') {
          var r = await fetch(base + '/system_stats', { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return setStatus('ComfyUI 可达', 'ok');
        }
        var h = {}; if (ch.key) h.Authorization = 'Bearer ' + ch.key;
        var url = ch.transport === 'site' ? '/img/v1/models' : base + '/models';
        var rr = await fetch(url, { headers: h, cache: 'no-store' });
        if (!rr.ok) throw new Error('HTTP ' + rr.status + ' ' + (await rr.text().catch(function () { return ''; })).slice(0, 80));
        var j = await rr.json();
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
        html += field('默认模型', '<select id="imgChModel" style="' + INP + '">' + modelOptions(ch) + '</select>');
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
        html += field('默认模型', '<select id="imgChModel" style="' + INP + '">' + modelOptions(ch) + '</select>');
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

    detailEl.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'use') return saveCurrent(true);
      if (act === 'save') return saveCurrent(false);
      if (act === 'test') return testChannel(readForm(selId));
      if (act === 'delete') {
        var ch = C.get(selId); if (!ch || isGitee(ch)) return;
        if (!confirm('删除渠道「' + (ch.name || selId) + '」？Key 一并删除。')) return;
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
