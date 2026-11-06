/**
 * image-channels-ui.js · 设置 → 图像渠道
 * 渠道列表是数据（localStorage），Gitee 只是内置预设；支持新增/编辑/删除/测试。
 * 必须在 image-channels.js 之后加载；在设置面板打开时挂载。
 */
(function () {
  'use strict';
  if (window.__imageChannelsUI) return;

  var C = window.__imageChannels;
  if (!C) { console.warn('[image-channels-ui] 缺少 image-channels.js'); return; }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function q(id) { return document.getElementById(id); }
  function modelsOf(ch) { return (ch.models || []).join(', '); }
  function fillModelSelect(ch) {
    var sel = q('imgChModel'); if (!sel) return;
    sel.innerHTML = '';
    (ch.models || []).forEach(function (m) {
      var o = el('option', { value: m }, m); sel.appendChild(o);
    });
    var cur = ch.model || (ch.models && ch.models[0]) || '';
    if (cur && !(ch.models || []).some(function (m) { return m === cur; })) sel.appendChild(el('option', { value: cur }, cur));
    if (cur) sel.value = cur;
  }
  function fillForm(ch) {
    if (!ch) return;
    var isGitee = ch.id === 'gitee';
    q('imgChName').value = ch.name || '';
    q('imgChKind').value = ch.kind || 'openai';
    q('imgChKind').disabled = isGitee; // 内置预设不允许改成别的协议，避免一键毁掉 Gitee 改图
    q('imgChBase').value = ch.baseUrl || '';
    q('imgChBase').disabled = isGitee;
    q('imgChKey').value = ch.key || '';
    q('imgChModels').value = modelsOf(ch);
    fillModelSelect(ch);
    q('imgChEditModel').value = ch.editModel || '';
    q('imgChEditModel').disabled = !isGitee;
    q('imgChCkpt').value = ch.ckpt || '';
    q('imgChSteps').value = ch.steps || 9;
    q('imgChTransport').value = ch.transport || 'direct';
    q('imgChTransport').disabled = true; // 站点代理只给内置 Gitee 预设；自定义渠道一律浏览器直连
    q('imgChComfy').style.display = ch.kind === 'comfyui' ? '' : 'none';
  }
  function readForm() {
    var old = C.get(q('imgChSelect').value) || {};
    var kind = q('imgChKind').value;
    var isGitee = old.id === 'gitee';
    var models = String(q('imgChModels').value || '').split(/[,，\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
    var model = q('imgChModel').value || models[0] || '';
    if (model && models.indexOf(model) < 0) models.unshift(model);
    var editModel = isGitee ? q('imgChEditModel').value.trim() : '';
    return {
      id: old.id,
      name: q('imgChName').value.trim() || '未命名渠道',
      kind: kind,
      transport: kind === 'comfyui' ? 'direct' : (isGitee ? 'site' : 'direct'),
      baseUrl: q('imgChBase').value.trim(),
      key: q('imgChKey').value.trim(),
      models: models,
      model: model,
      editModel: editModel,
      capabilities: (kind === 'openai' && isGitee) ? ['t2i', 'edit'] : ['t2i'],
      ckpt: q('imgChCkpt').value.trim(),
      steps: +q('imgChSteps').value || 9
    };
  }
  function refreshSelect(activeId) {
    var sel = q('imgChSelect'); if (!sel) return;
    sel.innerHTML = '';
    C.list().forEach(function (ch) {
      var o = el('option', { value: ch.id }, ch.name + (ch.id === C.activeId() ? ' ✓' : ''));
      sel.appendChild(o);
    });
    sel.value = activeId || C.activeId();
    fillForm(C.get(sel.value) || C.getActive());
  }
  function status(msg, cls) {
    var s = q('imgChStatus'); if (!s) return;
    s.textContent = msg || '';
    s.style.color = cls === 'err' ? '#e5484d' : (cls === 'ok' ? '#25c2a0' : 'var(--muted)');
  }
  async function test(ch) {
    var base = String(ch.baseUrl || '').replace(/\/+$/, '');
    if (!base) return status('先填 Base URL', 'err');
    try {
      if (ch.kind === 'comfyui') {
        var r = await fetch(base + '/system_stats', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return status('ComfyUI 可达', 'ok');
      }
      var h = {}; if (ch.key) h.Authorization = 'Bearer ' + ch.key;
      var url = ch.transport === 'site' ? '/img/v1/models' : base + '/models';
      var rr = await fetch(url, { headers: h, cache: 'no-store' });
      if (!rr.ok) throw new Error('HTTP ' + rr.status + ' ' + (await rr.text().catch(function () { return ''; })).slice(0, 80));
      var j = await rr.json();
      var n = (j.data || []).length;
      status('可达，返回 ' + n + ' 个模型', 'ok');
    } catch (e) { status('连接失败：' + (e.message || e), 'err'); }
  }
  function mount() {
    var slot = q('setModelApiSlot'); if (!slot || q('imgChCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'imgChCard';
    card.innerHTML =
      '<h4>图像渠道</h4><p>渠道是数据，Gitee 只是内置预设；可新增任意 OpenAI 兼容渠道，或本地 ComfyUI。Key 只存本设备，不进云同步。</p>' +
      '<div class="rowline" style="align-items:center;gap:8px;margin-top:8px;"><select id="imgChSelect" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></select><button class="smallbtn" id="imgChAdd">+ 新增</button><button class="smallbtn danger" id="imgChDel">删除</button></div>' +
      '<div class="rowline" style="align-items:center;gap:8px;margin-top:8px;"><input id="imgChName" placeholder="渠道名称" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><select id="imgChKind" style="padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><option value="openai">OpenAI 兼容</option><option value="comfyui">本地 ComfyUI</option></select></div>' +
      '<div class="rowline" style="margin-top:8px;"><input id="imgChBase" placeholder="Base URL（OpenAI 兼容填 /v1；ComfyUI 填 http://127.0.0.1:8188）" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></div>' +
      '<div class="rowline" style="align-items:center;gap:8px;margin-top:8px;"><select id="imgChTransport" style="padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><option value="direct">浏览器直连</option><option value="site">站点代理（/img/v1）</option></select><input id="imgChKey" type="password" placeholder="API Key（Gitee / 自定义）" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></div>' +
      '<div class="rowline" style="align-items:center;gap:8px;margin-top:8px;"><input id="imgChModels" placeholder="模型列表，逗号分隔" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><select id="imgChModel" style="min-width:170px;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></select></div>' +
      '<div class="rowline" style="align-items:center;gap:8px;margin-top:8px;"><input id="imgChEditModel" placeholder="改图模型（仅站点代理/Gitee）" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></div>' +
      '<div id="imgChComfy" style="display:none;margin-top:8px;"><div class="rowline" style="align-items:center;gap:8px;"><input id="imgChCkpt" placeholder="ComfyUI ckpt 文件名" style="flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><input id="imgChSteps" type="number" min="1" max="80" value="9" style="width:80px;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;"></div></div>' +
      '<div class="rowline" style="margin-top:10px;"><div class="btns"><button class="smallbtn" id="imgChSave">保存</button><button class="smallbtn" id="imgChTest">测试</button></div></div>' +
      '<div id="imgChStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>' +
      '<div class="settings-tip"><span>OpenAI 兼容渠道必须是浏览器可直连（CORS）或站点代理白名单；本地 ComfyUI 只在你自己机器上可用。创建/聊天页的出图会跟随这里的当前渠道。</span></div>';
    if (slot.firstChild) slot.insertBefore(card, slot.firstChild); else slot.appendChild(card);

    q('imgChSelect').addEventListener('change', function () { C.setActive(this.value); refreshSelect(this.value); status('已切换渠道', 'ok'); });
    q('imgChKind').addEventListener('change', function () {
      q('imgChComfy').style.display = this.value === 'comfyui' ? '' : 'none';
      if (this.value === 'comfyui') q('imgChTransport').value = 'direct';
    });
    q('imgChModels').addEventListener('input', function () {
      var fake = readForm(); fillModelSelect(fake);
    });
    q('imgChAdd').addEventListener('click', function () { var ch = C.create(); refreshSelect(ch.id); fillForm(ch); status('已新增，填好后保存', 'ok'); });
    q('imgChDel').addEventListener('click', function () {
      var id = q('imgChSelect').value;
      var ch = C.get(id) || {};
      if (!confirm('删除渠道「' + (ch.name || id) + '」？' + (id === 'gitee' ? '\n这是内置改图预设，删除后改图需要另建渠道。' : ''))) return;
      if (!C.remove(id)) return status('至少保留一个渠道', 'err');
      refreshSelect(); status('已删除', 'ok');
    });
    q('imgChSave').addEventListener('click', function () {
      var ch = readForm();
      if (!ch.baseUrl) return status('Base URL 不能为空', 'err');
      if (ch.kind === 'openai' && !ch.models.length) return status('至少填一个模型名', 'err');
      var saved = C.save(ch); refreshSelect(saved.id); status('已保存并设为当前渠道', 'ok');
    });
    q('imgChTest').addEventListener('click', function () { test(readForm()); });
    refreshSelect();
    status('当前：' + (C.getActive() && C.getActive().name));
  }

  window.__imageChannelsUI = { mount: mount };
})();
