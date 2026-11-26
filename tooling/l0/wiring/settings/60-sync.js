// 60-sync.js — 云同步与思考显示：同步聊天开关 / KV 配额 / Auth UI / 思考显示 / 外部回灌。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 5. 同步聊天历史 toggle ───
  // 2026-11-13: 「同步聊天历史」开关已撤（跟随云同步总开关，旧值由 sync.js 一次性归一）。
  // 空壳保留，避免旧调用点与历史文档引用报错。
  function initSyncChatToggle() {}

  // ─── 6. 覆盖云端按钮（2026-11-13：原「清空云端」）───
  function initSyncWipeBtn() {
    const wb = document.getElementById('syncWipeBtn');
    if (!wb) return;
    wb.addEventListener('click', async () => {
      const sync = window.syncSvc;
      if (!sync || typeof sync.wipeCloud !== 'function') { await uiAlert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { await uiAlert('请先启用云同步（需要访问码）再覆盖云端'); return; }
      if (!(await uiConfirm('用本机数据覆盖云端吗？\n\n过程：先清空云端副本，再把本机数据完整上传一次。\n影响：其他设备的云端内容会被替换成本机这份（它们重新打开页面后自动跟上）。\n注意：本机数据不受影响；执行期间请勿关闭页面。', { title: '覆盖云端', okText: '覆盖云端', danger: true }))) return;
      const old = wb.textContent; wb.disabled = true; wb.textContent = '覆盖中…';
      try {
        await sync.wipeCloud();
        wb.textContent = '已覆盖';
        const s = document.getElementById('syncStatus');
        if (s) s.textContent = '云端已用本机数据覆盖 · ' + new Date().toLocaleTimeString();
        setTimeout(() => { wb.textContent = old; wb.disabled = false; }, 2000);
      } catch (e) {
        wb.textContent = old; wb.disabled = false;
        await uiAlert('覆盖云端失败:' + (e && e.message || e));
      }
    });
  }

  // ─── 7. KV 配额告警 + cloudExcludeSection ───
  function initCloudExcludeSection() {
    function wireWarn() {
      if (!window.syncSvc || !window.syncSvc.onStatus) { setTimeout(wireWarn, 500); return; }
      window.syncSvc.onStatus((s, d) => {
        if (s !== 'warn' || !d || d.reason !== 'kv-quota') return;
        const w = document.getElementById('syncQuotaWarn');
        if (w) { w.style.display = 'block'; w.textContent = '今日已 push ' + d.count + ' 次到 KV (免费层 1000/日上限),可点顶栏暂停同步避免超额'; }
      });
    }
    wireWarn();
    const listEl = document.getElementById('cloudExcludeList');
    if (!listEl) return;
    var esc = window.escapeSvc.esc;
    function cards() { try { return (window.characterSvc && window.characterSvc.listAllCards) ? (window.characterSvc.listAllCards() || []) : []; } catch(e) { return []; } }
    function slots() { try { const raw = localStorage.getItem(SETTINGS_PAGE_KEYS.chatSession); if (!raw) return []; const m = JSON.parse(raw); return (m && typeof m === 'object' && !Array.isArray(m)) ? Object.keys(m) : []; } catch(e) { return []; } }
    function excluded() { try { return (window.syncSvc && window.syncSvc.getExcluded) ? window.syncSvc.getExcluded() : { roles: [], sessions: [] }; } catch(e) { return { roles: [], sessions: [] }; } }
    function nameOf(id, cs) { if (id === '__none__') return '（未选角色）'; const c = cs.filter(x => x.id === id)[0]; return c ? ((c.icon ? c.icon + ' ' : '') + c.name) : id; }
    function rowHtml(kind, id, label, isEx) {
      const btn = isEx
        ? `<button class="smallbtn" data-act="restore" data-kind="${kind}" data-id="${esc(id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/></svg>恢复同步</button>`
        : `<button class="smallbtn danger" data-act="wipe" data-kind="${kind}" data-id="${esc(id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15"/><path d="M9 6.5V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V6.5"/><path d="M6.8 6.5l.7 12.2a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.7-12.2"/></svg>仅清云端</button>`;
      const tag = kind === 'session' ? '[会话]' : '[角色]';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;${isEx ? 'opacity:.65;' : ''}"><span>${isEx ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="width:12px;height:12px;vertical-align:-1px;margin-right:3px;opacity:.7"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>' : ''}<b style="color:var(--muted);">${tag}</b> ${esc(label)}</span>${btn}</div>`;
    }
    function render() {
      const cs = cards(), ex = excluded(), sl = slots();
      let html = '';
      html += '<div style="font-size:11px;color:var(--muted);margin-top:4px;">角色卡</div>';
      if (!cs.length) html += '<div style="font-size:11px;color:var(--muted);">（无角色卡）</div>';
      cs.forEach(c => { html += rowHtml('role', c.id, (c.icon ? c.icon + ' ' : '') + c.name, ex.roles.indexOf(c.id) >= 0); });
      ex.roles.forEach(id => { if (!cs.filter(x => x.id === id)[0]) html += rowHtml('role', id, id + '（本地已无）', true); });
      html += '<div style="font-size:11px;color:var(--muted);margin-top:8px;">对话会话槽</div>';
      if (!sl.length) html += '<div style="font-size:11px;color:var(--muted);">（无本地会话槽）</div>';
      sl.forEach(k => { html += rowHtml('session', k, nameOf(k, cs), ex.sessions.indexOf(k) >= 0); });
      ex.sessions.forEach(k => { if (sl.indexOf(k) < 0) html += rowHtml('session', k, nameOf(k, cs) + '（本地已无）', true); });
      listEl.innerHTML = html;
    }
    listEl.addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const sync = window.syncSvc;
      if (!sync || !sync.wipeCloudEntity) { await uiAlert('云同步模块未就绪'); return; }
      const st = (sync.getStatus && sync.getStatus()) || {};
      if (!st.enabled || !st.hasToken) { await uiAlert('请先启用云同步(需密码)'); return; }
      const act = b.getAttribute('data-act'), kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
      const old = b.textContent; b.disabled = true; b.textContent = '处理中…';
      try {
        if (act === 'wipe') {
          if (!(await uiConfirm('确定只把这一' + (kind === 'session' ? '个会话' : '个角色') + '从云端清除吗?\n本地保留,且本设备不再上传它。', { title: '只清云端', okText: '清除', danger: true }))) { b.disabled = false; b.textContent = old; return; }
          await sync.wipeCloudEntity(kind, id);
        } else { await sync.restoreCloudEntity(kind, id); }
        render();
      } catch(err) { b.disabled = false; b.textContent = old; await uiAlert('操作失败:' + (err && err.message || err)); }
    });
    const sb  = document.getElementById('settingsBtn');
    if (sb)  sb.addEventListener('click', () => setTimeout(render, 50));
    const sec = document.getElementById('cloudExcludeSection');
    if (sec) sec.addEventListener('toggle', () => { if (sec.open) render(); });
  }

  // ─── 8. 云同步 + Auth UI ───
  function setupSyncAuthUI() {
    const syncEnableToggle  = document.getElementById('syncEnableToggle');
    const syncNowBtn        = document.getElementById('syncNowBtn');
    const syncPullBtn       = document.getElementById('syncPullBtn');
    const syncExportBtn     = document.getElementById('syncExportBtn');
    const syncImportBtn     = document.getElementById('syncImportBtn');
    const syncImportFile    = document.getElementById('syncImportFile');
    const syncStatusEl      = document.getElementById('syncStatus');
    const syncRealtimeToggle = document.getElementById('syncRealtimeToggle');
    const syncRealtimeStatus = document.getElementById('syncRealtimeStatus');
    const authLoginBtn      = document.getElementById('authLoginBtn');
    const authLogoutBtn     = document.getElementById('authLogoutBtn');
    const authStatusEl      = document.getElementById('authStatus');
    if (!syncEnableToggle) return;

    // 未配访问码的部署（公开版默认状态）：登录框永远不会成功，先说明白。
    // 只问一位布尔值，不猜、不试密码；网络失败就保持沉默，不伪造状态。
    let unlockConfigured = null;
    fetch('/api/unlock').then(r => r.json()).then(d => {
      if (!d || typeof d.configured !== 'boolean') return;
      unlockConfigured = d.configured;
      if (!d.configured) refreshAuthUI();
    }).catch(function () {});

    function fmtTime(ms) {
      if (!ms) return '—';
      try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ms); }
    }
    function refreshAuthUI() {
      if (!window.authSvc) return;
      const hasToken = !!window.authSvc.getToken();
      if (authStatusEl) authStatusEl.textContent = unlockConfigured === false
        ? '未检测到访问码配置（Cloudflare Secret CHAT_PASSWORD 未设置），登录功能暂不可用。'
        : hasToken
          ? '已登录（访问码已保存在本机）'
          : '访客模式 · 使用你自己的模型渠道与 API Key';
      if (authLogoutBtn) authLogoutBtn.disabled = !hasToken;
    }
    function refreshSyncUI() {
      if (!window.syncSvc) return;
      const s = window.syncSvc.getStatus();
      syncEnableToggle.checked = s.enabled;
      const parts = [s.enabled ? '已启用' : '未启用'];
      if (s.lastPush) parts.push('上次推送 ' + fmtTime(s.lastPush));
      if (syncStatusEl) syncStatusEl.textContent = parts.join('，');
      if (syncRealtimeToggle) syncRealtimeToggle.checked = !!(window.chatRealtimeSvc && window.chatRealtimeSvc.enabled && window.chatRealtimeSvc.enabled());
      if (syncRealtimeStatus) {
        var rt = null;
        try { rt = (window.chatRealtimeSvc && window.chatRealtimeSvc.status) ? window.chatRealtimeSvc.status() : null; } catch (e) {}
        var map = { connected: '已连接 · 1.5 秒轮询', reconnecting: '重连中', offline: '离线', manual: '不可用 · 已自动回落整段同步', error: '错误' };
        syncRealtimeStatus.textContent = '实时消息同步：' + (rt ? (map[rt.state] || rt.state) : '未加载') + (rt && rt.error ? ' · ' + rt.error : '');
      }
    }

    window.__settingsRefreshAuth = refreshAuthUI;
    window.__settingsRefreshSync = refreshSyncUI;
    if (syncRealtimeToggle) {
      syncRealtimeToggle.addEventListener('change', function () {
        try {
          if (window.chatRealtimeSvc && window.chatRealtimeSvc.setEnabled) window.chatRealtimeSvc.setEnabled(!!syncRealtimeToggle.checked);
        } catch (e) {}
        refreshSyncUI();
      });
    }
    window.addEventListener('chat-realtime-status', function () { try { refreshSyncUI(); } catch (e) {} });

    if (window.syncSvc) {
      window.syncSvc.onStatus((st, detail) => {
        if (!syncStatusEl) return;
        if (st === 'syncing') syncStatusEl.textContent = '同步中…';
        else if (st === 'synced') {
          const size = detail && detail.size ? ` (${(detail.size / 1024).toFixed(1)}KB)` : '';
          syncStatusEl.textContent = '同步完成 ' + fmtTime(Date.now()) + size;
        } else if (st === 'restored') {
          syncStatusEl.textContent = '已从云端还原，即将刷新页面…';
        } else if (st === 'error') {
          syncStatusEl.textContent = '错误：' + (detail && detail.message || '同步失败');
        }
      });
    }

    syncEnableToggle.addEventListener('change', async () => {
      if (!window.syncSvc || !window.authSvc) return;
      if (syncEnableToggle.checked) {
        if (!window.authSvc.getToken()) {
          try {
            const pw = await window.authSvc.promptForPassword({
              title: '启用云同步',
              hint: '输入 Cloudflare Secret <code>CHAT_PASSWORD</code> 的值。密码会保存在本地浏览器，下次自动登录。',
            });
            window.authSvc.setToken(pw);
          } catch { syncEnableToggle.checked = false; return; }
        }
        window.syncSvc.setSyncEnabled(true);
        refreshAuthUI(); refreshSyncUI();
        window.syncSvc.pullOnStartup();
        try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.start) window.chatRealtimeSvc.start(); } catch (e) {}
      } else {
        window.syncSvc.setSyncEnabled(false);
        try { if (window.chatRealtimeSvc && window.chatRealtimeSvc.stop) window.chatRealtimeSvc.stop(); } catch (e) {}
        refreshSyncUI();
      }
    });

    syncNowBtn.addEventListener('click', async () => {
      // 4.75 立即同步反馈修复:原版点了无任何按钮级反馈(只往 #syncStatus 写一行小字),看着像"没反应"。
      // 现加:未登录直接提示 + 按钮态 同步中…/✓ 已同步/同步失败,与"清空云端"按钮一致。
      if (!window.syncSvc) { await uiAlert('云同步模块未就绪'); return; }
      var st = (window.syncSvc.getStatus && window.syncSvc.getStatus()) || {};
      if (!st.hasToken) { await uiAlert('请先在上方打开「启用云同步」并输入密码,再点立即同步'); return; }
      var _old = syncNowBtn.innerHTML;
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = '上传中…';
      try {
        await window.syncSvc.pushNow();
        // 4.78: 立即同步同时补推独立通道(pushNow 只推 main blob;聊天走 /sync/chat)。
        // 2026-11-28 T3-B: 角色卡已迁到统一存储(数据面 chars 表),D1 本身就是同步 —— 这里不再
        // 调用 pushCharsNow 搬运旧 IndexedDB blob;端点与旧客户端通道保留在原处(sync.ts)。
        const _chat = window.syncSvc.pushChatNow ? await window.syncSvc.pushChatNow() : null;
        // 2026-10-07: 如实回报 —— 对话通道没开/没推成时必须说清楚,不再一律"✓ 已同步"(那条假成功让"什么都没同步"看起来像成功了)
        const _when = new Date().toLocaleString('zh-CN', { hour12: false });
        if (_chat && _chat.skipped === 'chat-off') {
          syncNowBtn.textContent = '✓ 已上传(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '对话历史未同步:勾选上方「同步聊天历史」后,对话才会跨设备共享，' + _when;
        } else if (_chat && _chat.skipped === 'sync-off') {
          syncNowBtn.textContent = '✓ 已上传(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '未启用云同步/缺密码:对话未同步，' + _when;
        } else if (_chat && _chat.error) {
          syncNowBtn.textContent = '部分失败';
          if (syncStatusEl) syncStatusEl.textContent = '其余数据已同步,对话同步失败:' + _chat.error + '，' + _when;
        } else {
          syncNowBtn.textContent = '✓ 已上传';
          if (syncStatusEl) syncStatusEl.textContent = '上传完成(含对话 ' + ((_chat && _chat.slots) || 0) + ' 条会话)，' + _when;
        }
      } catch (e) {
        syncNowBtn.textContent = '上传失败';
        await uiAlert('上传失败: ' + (e && e.message || e));
      } finally {
        setTimeout(function () { syncNowBtn.innerHTML = _old; syncNowBtn.disabled = false; }, 1800);
      }
    });
    if (syncPullBtn) syncPullBtn.addEventListener('click', async () => {
      if (!window.syncSvc) { await uiAlert('云同步模块未就绪'); return; }
      var st = (window.syncSvc.getStatus && window.syncSvc.getStatus()) || {};
      if (!st.hasToken) { await uiAlert('请先在上方打开「启用云同步」并输入访问码'); return; }
      var _old = syncPullBtn.innerHTML;
      syncPullBtn.disabled = true;
      syncPullBtn.textContent = '刷新中…';
      try {
        // 主数据：pullOnStartup 在云端更新时会恢复并 reload（预期行为）
        await window.syncSvc.pullOnStartup();
        // 2026-11-13: 强制刷新走全量 3-way 合并（不复用实时补事件），这才是「对齐」的语义
        var c = window.syncSvc.pullChatNow ? await window.syncSvc.pullChatNow({ full: true }) : null;
        // 2026-11-28 T3-B: 角色卡不再从 /sync/chars 拉取 —— 它已经在统一存储里,数据面即真源。
        var _when = new Date().toLocaleString('zh-CN', { hour12: false });
        if (c && c.skipped === 'chat-off') {
          syncPullBtn.textContent = '✓ 已刷新(不含对话)';
          if (syncStatusEl) syncStatusEl.textContent = '对话同步被旧开关关闭过，未拉取对话，' + _when;
        } else if (c && c.error) {
          syncPullBtn.textContent = '部分失败';
          if (syncStatusEl) syncStatusEl.textContent = '主数据已对齐，对话拉取失败:' + c.error + '，' + _when;
        } else {
          syncPullBtn.textContent = '✓ 已刷新';
          if (syncStatusEl) syncStatusEl.textContent = '已与云端对齐，' + _when;
        }
      } catch (e) {
        syncPullBtn.textContent = '拉取失败';
        await uiAlert('拉取失败: ' + (e && e.message || e));
      } finally {
        setTimeout(function () { syncPullBtn.innerHTML = _old; syncPullBtn.disabled = false; }, 1800);
      }
    });
    if (syncExportBtn) syncExportBtn.addEventListener('click', async () => {
      if (!window.syncSvc) return;
      try { await window.syncSvc.exportJSON(); } catch (e) { await uiAlert('导出失败: ' + e.message); }
    });
    if (syncImportBtn) syncImportBtn.addEventListener('click', () => { syncImportFile && syncImportFile.click(); });
    if (syncImportFile) syncImportFile.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!(await uiConfirm('导入将覆盖本地所有数据（角色卡 / 历史 / 指令模块 / 费用日志）。确认？', { title: '导入备份', okText: '覆盖导入', danger: true }))) { syncImportFile.value = ''; return; }
      try {
        await window.syncSvc.importJSON(file);
        await uiAlert('导入成功，即将刷新页面…', { okText: '好' });
        setTimeout(() => location.reload(), 400);
      } catch (err) { await uiAlert('导入失败: ' + err.message); }
      syncImportFile.value = '';
    });

    if (authLoginBtn) authLoginBtn.addEventListener('click', async () => {
      if (!window.authSvc) return;
      try {
        const pw = await window.authSvc.promptForPassword({
          title: '输入访问码',
          hint: '输入访问码（与私密模式解锁时相同）。',
        });
        if (!pw) return;
        window.authSvc.setToken(pw);
        try {
          localStorage.setItem('cfw_unlocked_v1', '1');
          localStorage.setItem('cfw_unlock_token_v1', pw);
          localStorage.setItem('cfw_nsfw_mode_v1', '3');
          localStorage.setItem('cfw_auth_token_v1', pw);
        } catch (e) {}
        location.reload();
      } catch (e) {}
    });

    if (authLogoutBtn) authLogoutBtn.addEventListener('click', async () => {
      if (!window.authSvc) return;
      if (!(await uiConfirm('退出登录会清除本地访问码、退出私密模式，并关闭云同步。确认？', { title: '退出登录', okText: '退出', danger: true }))) return;
      window.authSvc.clearToken();
      if (window.syncSvc) window.syncSvc.setSyncEnabled(false);
      try {
        localStorage.removeItem('cfw_unlocked_v1');
        localStorage.removeItem('cfw_unlock_token_v1');
        localStorage.removeItem('cfw_nsfw_mode_v1');
        localStorage.removeItem('cfw_dev_mode_v1');
      } catch (e) {}
      refreshAuthUI(); refreshSyncUI();
      setTimeout(function () { location.reload(); }, 250);
    });
  }

  // ─── 9. 思考过程显示下拉 ───
  // 2026-10-05: 宿主改成「外观 · 显示设置」卡(它和字号/字体同属"聊天区怎么呈现")。
  // 旧实现靠 #historyKeep 反查宿主,而那张卡(本地对话记忆)后来挪进了「账号」类目 ——
  // 这一行就跟着寄生到与它毫无关系的分类里(用户实测反馈)。宿主判定改为:显示设置卡 > #historyKeep > #customPrompt,
  // 回落链保留只为老页面(缺显示设置卡时仍能显示,不会整行消失)。
  function setupThinkDisplaySetting() {
    if (document.getElementById('thinkDisplaySel')) return;
    const fontEl = document.getElementById('chatFontSizeRange');
    const displayCard = (fontEl && fontEl.closest) ? fontEl.closest('.card') : null;
    const displayTip  = displayCard ? displayCard.querySelector('.settings-tip') : null;
    const historyKeepEl  = document.getElementById('historyKeep');
    const customPromptEl = document.getElementById('customPrompt');
    const anchor = (historyKeepEl && (historyKeepEl.closest('label') || historyKeepEl.parentElement)) || null;
    const legacyHost = (anchor && anchor.parentNode) || (customPromptEl && customPromptEl.parentNode);
    const host = displayCard || legacyHost;
    if (!host) return;
    const wrap = document.createElement('div');
    // 2026-10-04: 独立成行(复用 .rowline 的分隔线/换行兜底),不再作为设置行的第三个 flex 项 ——
    // 它和长标签、清空按钮同排抢宽时,窄宽度下「思考过程显示」会被挤成每行一两个字的竖排。
    wrap.className = 'setting-row think-display-row rowline';
    wrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:14px;';
    const label = document.createElement('span');
    label.textContent = '思考过程显示';
    label.style.whiteSpace = 'nowrap';
    label.title = '解限/思考模式下模型产生的思考内容如何呈现';
    const sel = document.createElement('select');
    sel.id = 'thinkDisplaySel';
    sel.style.cssText = 'padding:4px 8px;border-radius:6px;';
    // 2026-11-17：三态与存储键的唯一家是 services/chat/reasoning.ts（__reasoning 门面），
    // 下拉只负责渲染选项与回调（选项表也来自服务，标签不会与读取规则漂移）。
    const MODES = (window.__reasoning && window.__reasoning.THINK_DISPLAY_MODES) || [['collapse', '折叠(默认)']];
    MODES.forEach((m) => {
      const o = document.createElement('option');
      o.value = Array.isArray(m) ? m[0] : m.value;
      o.textContent = Array.isArray(m) ? m[1] : m.label;
      sel.appendChild(o);
    });
    function getVal() { return window.__reasoning.getThinkDisplay(); }
    sel.value = getVal();
    sel.addEventListener('change', () => {
      window.__reasoning.setThinkDisplay(sel.value);
      if (window.hostApi.app && window.hostApi.app.applyAllThinkDisplay) {
        window.hostApi.app.applyAllThinkDisplay();
      } else {
        document.querySelectorAll('.reasoning-block').forEach(el => {
          try { if (window.hostApi.app && window.hostApi.app.applyThinkDisplay) window.hostApi.app.applyThinkDisplay(el); } catch(e) {}
        });
      }
    });
    wrap.appendChild(label);
    wrap.appendChild(sel);
    // 落点:显示设置卡里插到 tip 之前(即控件区末尾,排在字号/字体/两个 toggle 之后);
    // 没有 tip 就追加到卡尾。走回落宿主时沿用旧行为(插到承载开关的 rowline 之后)。
    if (displayCard) {
      if (displayTip) displayCard.insertBefore(wrap, displayTip);
      else displayCard.appendChild(wrap);
    } else if (host.classList && host.classList.contains('rowline') && host.parentNode) {
      host.parentNode.insertBefore(wrap, host.nextSibling);
    } else {
      host.appendChild(wrap);
    }
  }

  // ─── 2026-10-08 外部改动（云同步回灌 / 别的标签页）后：把设置面板里这些开关/输入的值回读一遍 ───
  // 面板的卡片是"挂载一次"的（各 mount* 用 id 存在与否做守卫），旧版不会因为远端设置变化而更新 ——
  // 用户会看到"设置里显示关着、实际云端是开着的"。这里按"元素 id ← LS 键"的清单逐个回读。
  // （只处理会被同步的、且已直接落到 LS 的开关；内容型数据如角色卡/预设由各自通道的合并逻辑刷新。）
  // 2026-11-25 C6：清单与「缺省=开」回读规则归 services/ui/settings-page.ts
  //（SYNCED_CONTROLS / syncedCheckboxChecked），本文件只遍历并写 DOM。
  function syncSettingsControlsFromLS() {
    if (!document.getElementById("settingsMask")) return;
    SYNCED_CONTROLS.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      try {
        var v = localStorage.getItem(pair[1]);
        if (el.type === "checkbox") el.checked = syncedCheckboxChecked(v);
        else if (v != null) el.value = v;
      } catch (e) {}
    });
    // 下拉类（值域与默认值各不同）单独回读：
    try { var ag = document.getElementById("agentWorkMode"); var w = localStorage.getItem(SETTINGS_PAGE_KEYS.agentWorkMode); if (ag && w) ag.value = w; } catch (e) {}
    try { var at = document.getElementById("agentToolsSel"); var t = localStorage.getItem(SETTINGS_PAGE_KEYS.agentTools); if (at && t) at.value = t; } catch (e) {}
  }
