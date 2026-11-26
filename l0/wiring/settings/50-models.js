// 50-models.js — 模型渠道：DeepSeek 全家桶 / 渠道管理 / 自定义定价。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §模型API. DeepSeek 全家桶卡（2026-11-25 服务端内置工具）───
  // read_url / safety_check 是聊天请求里的服务端内置工具（worker 只在 DeepSeek 渠道挂）。
  // 联网搜索主站已有独立卡，这里不重复造。云端语音在「语音」分类，本卡只指向它。
  function mountDeepSeekKitCard() {
    var slot = window.slotRegistry.pick('setModelApiSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'deepseekKitCard', slotId: 'setModelApiSlot' });
    if (!slot || document.getElementById('deepseekKitCard')) return;
    // 2026-11-25 C5：键与「只有 "1" 算开」的归一化归 services/ui/settings-deepseek-kit.ts，
    // 与 prompt-profile.deepseekKitPayload 读侧同源。
    var kit = window.settingsDeepSeekKit;
    var KIT = kit.KEYS;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'deepseekKitCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>DeepSeek 全家桶</h4>'
      + '<p>服务端内置工具，选 DeepSeek 渠道即自动生效：<b>读链接</b>把消息里的网址交给服务端抓取；<b>安全校验</b>对输入输出做基础筛查。按量计费，Key 只在你的 Worker 里。<b>仅本设备</b>。</p>'
      + '<div class="ds-kit-sec"><div class="ds-kit-hd">服务端工具</div>'
      + '<label class="ds-kit-row"><input type="checkbox" id="dsReadUrl"><span>读链接 <span style="opacity:.6">— 模型自行抓取消息里的 URL</span></span></label>'
      + '<label class="ds-kit-row"><input type="checkbox" id="dsSafety"><span>安全校验 <span style="opacity:.6">— 输入输出基础筛查，按次计费</span></span></label></div>'
      + '<div id="kitStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><span>联网搜索用「对话」分类的「联网搜索」卡，那里已支持 DeepSeek 搜索，不在这里重复。<b>云端语音</b>在「语音」分类，网页版与访客都能用。</span></div>';
    var css = document.createElement('style');
    css.textContent = [
      '#deepseekKitCard .ds-kit-sec{margin-top:12px;border-top:1px solid var(--border-soft,var(--border,#333));padding-top:10px}',
      '#deepseekKitCard .ds-kit-hd{font-size:12px;color:var(--muted);margin-bottom:4px}',
      '#deepseekKitCard .ds-kit-row{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12.5px;line-height:1.5;margin-top:7px}',
      '#deepseekKitCard .ds-kit-row input{flex:0 0 auto;margin:2px 0 0;accent-color:var(--ac)}'
    ].join('\n');
    card.appendChild(css);
    slot.appendChild(card);
    var readUrl = card.querySelector('#dsReadUrl'), safety = card.querySelector('#dsSafety'), st = card.querySelector('#kitStatus');
    function status(msg) { if (st) st.textContent = msg || ''; }
    if (readUrl) { readUrl.checked = kit.read(KIT.readUrl); readUrl.addEventListener('change', function () { kit.write(KIT.readUrl, readUrl.checked); status(readUrl.checked ? '已开启读链接' : '已关闭读链接'); }); }
    if (safety) { safety.checked = kit.read(KIT.safety); safety.addEventListener('change', function () { kit.write(KIT.safety, safety.checked); status(safety.checked ? '已开启安全校验' : '已关闭安全校验'); }); }
  }

  // ─── §模型API. 模型渠道管理卡（批 E1b：预设组 + 自定义组统一注册表）───
  // 数据层 = window.providersSvc（/js/text/data/providers.js，cfw_providers_v3）；本卡只做 DOM/接线。
  //   · 预设渠道：服务端注册表（GET /api/providers），Key 在 Worker env，UI 只读状态；
  //   · 自定义渠道：本机 endpoint/apiKey，走 /api/custom-endpoint/models 代理拉模型（解 CORS/GFW）；
  //   · 每模型开关：勾选 = 出现在顶栏模型下拉；切走渠道 = 聊天即走它。
  function mountByoCard() {
    var slot = window.slotRegistry.pick('setModelApiSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'byoProviderCard', slotId: 'setModelApiSlot' });
    if (!slot || document.getElementById('byoProviderCard')) return;
    if (!window.providersSvc) return; // providers.js 未加载(旧缓存页兜底):不挂卡,不炸
    var P = window.providersSvc;
    var _guest = false;
    try { _guest = !!(window.authSvc && window.authSvc.getToken && !window.authSvc.getToken()); } catch (e) {}
    var toastFn = (window.feedbackSvc && window.feedbackSvc.toast) || function (m) { try { console.warn('[providers]', m); } catch (e) {} };
    var esc = window.escapeSvc.esc;
    function curMode() { try { return normalizeMode(localStorage.getItem(SETTINGS_PAGE_KEYS.mode)); } catch (e) { return 'free'; } }
    function parseKey(key) {
      var s = String(key || '');
      if (s.indexOf('preset:') === 0) return { kind: 'preset', id: s.slice(7) };
      if (s.indexOf('custom:') === 0) return { kind: 'custom', id: s.slice(7) };
      return null;
    }
    var INP = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
    var LBL = 'font-size:12px;color:var(--muted);display:block;margin-bottom:4px;';
    var BTN = 'cursor:pointer;text-align:left;width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;line-height:1.5;';

    var card = document.createElement('div'); card.className = 'card'; card.id = 'byoProviderCard';
    card.innerHTML = '<h4>聊天模型 · 渠道管理</h4>'
      + '<p>聊天走哪个模型渠道，这里说了算。左侧选渠道（点击即切换），右侧看详情：拉取模型列表、<b>勾选要用的模型</b>（未勾选的不会出现在顶栏下拉里）。'
      + '「预设渠道」的 Key 在服务端 Worker 里（本页只见状态）；「自定义渠道」可接任意 OpenAI 兼容端点（云厂商 / 本地 vLLM、ollama、LM Studio），<b>API Key 随账号同步</b>（存在你自己的 Cloudflare KV，换设备不用重填）。</p>'
      + '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;align-items:flex-start;">'
      +   '<div id="provList" style="flex:0 0 190px;min-width:158px;display:flex;flex-direction:column;gap:4px;"></div>'
      +   '<div id="provDetail" style="flex:1;min-width:230px;border-left:1px solid var(--border,#333);padding-left:12px;"></div>'
      + '</div>';
    // 2026-11-11: 这块面板原来全是内联样式 —— 没法写 hover、间距各写各的，50 个模型一摊就显脏。
    // 改成卡片内一份 scoped 样式表（类名统一 prov- 前缀，不影响别处），下面只写 class。
    var cardCss = document.createElement('style');
    cardCss.textContent = [
      '#byoProviderCard .prov-sec{margin-top:14px}',
      '#byoProviderCard .prov-sec-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '#byoProviderCard .prov-sec-title{font-size:12.5px;font-weight:600}',
      '#byoProviderCard .prov-chip{font-size:11px;line-height:18px;color:var(--muted);border:1px solid var(--border,#333);border-radius:999px;padding:0 8px;white-space:nowrap}',
      '#byoProviderCard .prov-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '#byoProviderCard .prov-hint{font-size:11px;color:var(--muted)}',
      '#byoProviderCard .prov-box{margin-top:8px;border:1px solid var(--border,#333);border-radius:8px;max-height:260px;overflow:auto}',
      '#byoProviderCard .prov-grp{display:flex;justify-content:space-between;gap:8px;padding:8px 10px 3px;font-size:11px;color:var(--muted);border-top:1px solid var(--border-soft,var(--border,#333))}',
      '#byoProviderCard .prov-grp:first-child{border-top:0}',
      '#byoProviderCard .prov-row{display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12.5px;cursor:pointer}',
      '#byoProviderCard .prov-row:hover{background:var(--ac-soft)}',
      '#byoProviderCard .prov-row input{accent-color:var(--ac);margin:0;flex:0 0 auto}',
      '#byoProviderCard .prov-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#byoProviderCard .prov-empty{padding:10px;font-size:12px;color:var(--muted)}',
      '#byoProviderCard .prov-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:8px;font-size:12.5px}',
      '#byoProviderCard .prov-code{font-size:11.5px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
    ].join('\n');
    card.appendChild(cardCss);
    slot.appendChild(card);
    var listEl = card.querySelector('#provList'), detailEl = card.querySelector('#provDetail');
    var selKey = P.effectiveKey(curMode()) || ((P.channels()[0] && P.channels()[0].key) || '');

    function activeKey() { return P.read().activeId; }
    function findChannel(key) {
      var chs = P.channels();
      for (var i = 0; i < chs.length; i++) if (chs[i].key === key) return chs[i];
      return null;
    }
    function keyTag(c) {
      if (c.kind === 'preset') {
        var m = c.detail || {};
        return (m.configured === true ? 'Key 已配置' : m.configured === false ? 'Key 未配置' : '') ;
      }
      var p = c.detail || {};
      return p.model ? ('模型 ' + p.model) : '未选模型';
    }

    function renderList() {
      var chs = P.channels(), act = activeKey(), eff = P.effectiveKey(curMode());
      var html = '';
      if (_guest) html += '<div style="font-size:11px;color:var(--muted);margin:0 0 6px;">访客模式：预设渠道已关闭，请新增自己的自定义渠道。</div>';
      var curKind = '';
      chs.forEach(function (c) {
        if (c.kind !== curKind) {
          curKind = c.kind;
          html += '<div style="font-size:11px;color:var(--muted);margin:' + (html ? '8px' : '0') + ' 0 2px;">' + (c.kind === 'preset' ? '预设渠道（服务端 Key）' : '自定义直连（账号同步）') + '</div>';
        }
        var isAct = act === c.key, isEff = !act && eff === c.key, isSel = selKey === c.key;
        var badge = isAct ? '<span style="color:var(--accent,#7aa2f7);">　● 使用中</span>' : (isEff ? '<span style="color:var(--muted);">　○ 跟随免费/快速</span>' : '');
        html += '<button type="button" data-key="' + esc(c.key) + '" style="' + BTN + (isSel ? 'border-color:var(--accent,#7aa2f7);' : '') + '">'
          + '<b style="font-size:12.5px;">' + esc(c.name) + badge + '</b>'
          + '<small style="color:var(--muted);font-size:11px;display:block;margin-top:1px;word-break:break-all;">' + esc(keyTag(c)) + '</small></button>';
      });
      html += '<button type="button" data-new="1" style="' + BTN + 'border-style:dashed;color:var(--muted);">＋ 新增自定义渠道</button>';
      listEl.innerHTML = html;
    }

    function modelsBlock(key) {
      var all = P.modelsAll(key);
      // 2026-11-11: 免费档放宽到 50 个模型后，平铺一列没法用 —— 按厂商分组 + 批量按钮。
      // 行内只显示短名（"/" 之后那段），完整 id 放 title；厂商在分组标题里，不重复占宽度。
      var groups = [], gi = {};
      all.forEach(function (m) {
        var v = String(m.id).indexOf('/') >= 0 ? String(m.id).split('/')[0] : '';
        if (!gi[v]) { gi[v] = { vendor: v, rows: [] }; groups.push(gi[v]); }
        gi[v].rows.push(m);
      });
      var onCount = all.filter(function (m) { return m.enabled; }).length;
      var body = all.length
        ? groups.map(function (g) {
            var head = '<div class="prov-grp"><span>' + esc(g.vendor || '默认') + '</span><span>' + g.rows.length + '</span></div>';
            return head + g.rows.map(function (m) {
              var id = String(m.id);
              var short = id.indexOf('/') >= 0 ? id.slice(id.indexOf('/') + 1) : id;
              return '<label class="prov-row" title="' + esc(id) + '">'
                + '<input type="checkbox" data-mid="' + esc(id) + '"' + (m.enabled ? ' checked' : '') + '>'
                + '<span>' + esc(short) + '</span></label>';
            }).join('');
          }).join('')
        : '<div class="prov-empty">还没拉取过模型列表 · 点右上「拉取模型列表」（拉不到可手填）</div>';
      var toolbar = all.length
        ? '<div class="prov-toolbar">'
          + '<button class="smallbtn" type="button" id="provSelAll">全选</button>'
          + '<button class="smallbtn" type="button" id="provSelRec">恢复推荐</button>'
          + '<button class="smallbtn" type="button" id="provSelNone">清空</button>'
          + '<span class="prov-hint">勾选 = 出现在顶栏下拉</span>'
          + '</div>'
        : '';
      return '<div class="prov-sec">'
        + '<div class="prov-sec-hd">'
          + '<span class="prov-sec-title">模型列表</span>'
          + (all.length ? '<span class="prov-chip">已启用 ' + onCount + ' / ' + all.length + '</span>' : '')
          + '<span style="flex:1;"></span>'
          + '<button class="smallbtn" type="button" id="provFetch">拉取模型列表</button>'
        + '</div>'
        + toolbar
        + '<div class="prov-box">' + body + '</div>'
        + '<div id="provFetchMsg" class="prov-hint" style="margin-top:6px;"></div>'
        + '</div>';
    }

    function useBtn(key, usable, why) {
      var isAct = activeKey() === key;
      if (isAct) return '<span style="font-size:12px;color:var(--accent,#7aa2f7);">● 当前渠道</span>';
      return '<button class="smallbtn" type="button" id="provUse"' + (usable ? '' : ' disabled title="' + esc(why || '') + '"') + '>使用此渠道</button>';
    }

    function renderDetail() {
      var c = findChannel(selKey);
      if (!c) { var chs = P.channels(); c = chs[0] || null; if (c) selKey = c.key; }
      if (!c) { detailEl.innerHTML = ''; return; }
      if (c.kind === 'preset') {
        var m = c.detail || {};
        var confText = m.configured === true ? '<span style="color:#4caf50;">✓ 已配置</span>'
          : m.configured === false ? '<span style="color:#e57373;">✗ 未配置</span>（部署侧执行 wrangler secret put ' + esc(m.keyEnv || '') + '）'
          : '<span style="color:var(--muted);">状态未知（没连上服务端）</span>';
        detailEl.innerHTML = '<div style="font-weight:600;font-size:14px;">' + esc(c.name) + '<span style="font-size:11px;color:var(--muted);font-weight:400;">　预设渠道 · ' + esc(m.label || '') + '</span></div>'
          + '<div style="font-size:12px;color:var(--muted);margin-top:4px;">服务端渠道：API Key 存在 Worker 环境变量（' + esc(m.keyEnv || '') + '），本页面不见 Key、不能改。</div>'
          + '<div style="margin-top:10px;"><label style="' + LBL + '">Endpoint（只读）</label><input readonly value="' + esc(m.endpoint || '') + '" style="' + INP + 'color:var(--muted);font-size:12px;"></div>'
          // 状态与默认模型原来挤在同一行、长 id 一换行就散架 → 拆成可换行的信息行
          + '<div class="prov-meta">'
            + '<span>' + confText + '</span>'
            + '<span class="prov-hint">默认模型</span>'
            + '<code class="prov-code">' + esc(m.defaultModel || '（无）') + '</code>'
          + '</div>'
          + modelsBlock(selKey)
          + '<div class="btns" style="margin-top:12px;">' + useBtn(selKey, true) + '</div>';
      } else {
        var p = c.detail || {};
        var enabled = P.enabledModels(selKey);
        var selOpts = enabled.map(function (mm) { return '<option value="' + esc(mm.id) + '"' + (p.model === mm.id ? ' selected' : '') + '>' + esc(mm.id) + '</option>'; }).join('');
        detailEl.innerHTML = '<div style="font-weight:600;font-size:14px;">' + esc(p.name || c.id) + '<span style="font-size:11px;color:var(--muted);font-weight:400;">　自定义直连 · Key 随账号同步</span></div>'
          + '<div style="margin-top:10px;"><label style="' + LBL + '">名称</label><input id="provName" value="' + esc(p.name || '') + '" style="' + INP + '"></div>'
          + '<div style="margin-top:8px;"><label style="' + LBL + '">Endpoint（/v1/chat/completions 全路径，或 /v1 base）</label><input id="provEndpoint" value="' + esc(p.endpoint || '') + '" placeholder="https://integrate.api.nvidia.com/v1/chat/completions" style="' + INP + '"></div>'
          + '<div style="margin-top:8px;"><label style="' + LBL + '">API Key（本地 vLLM/ollama/LM Studio 可留空）</label><input id="provKey" type="password" value="' + esc(p.apiKey || '') + '" placeholder="Bearer Token" style="' + INP + '"></div>'
          + '<div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><label style="' + LBL + 'margin:0;min-width:34px;">模型</label><select id="provModelSel" style="' + INP + 'flex:1;min-width:0;">'
          + (selOpts || '<option value="">— 启用模型为空 —</option>') + '</select></div>'
          + '<div style="margin-top:6px;"><input id="provModelText" value="' + esc(p.model || '') + '" placeholder="手填 fallback：gpt-4o / glm-4-plus / qwen-max ..." style="' + INP + '"></div>'
          + '<div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><label style="' + LBL + 'margin:0;min-width:64px;">思考支持</label><select id="provThinkingStyle" style="' + INP + 'flex:1;min-width:0;">'
          + '<option value="none"' + (!p.supportsThinking ? ' selected' : '') + '>不支持思考</option>'
          + '<option value="onoff"' + (p.supportsThinking && p.thinkingStyle === 'vllm' ? ' selected' : '') + '>支持 · vLLM / NIM 接口</option>'
          + '<option value="levels"' + (p.supportsThinking && p.thinkingStyle !== 'vllm' && p.thinkingStyle !== 'effort' ? ' selected' : '') + '>支持 · DeepSeek 接口</option>'
          // 2026-11-13: 第三种方言 —— 只发 reasoning_effort、不发 thinking（AMD Token Factory 这类端点收到 thinking 会 400）
          + '<option value="effort"' + (p.supportsThinking && p.thinkingStyle === 'effort' ? ' selected' : '') + '>支持 · 仅 reasoning_effort（AMD 等）</option>'
          + '</select></div>'
          + modelsBlock(selKey)
          + '<div class="btns" style="margin-top:12px;">' + useBtn(selKey, !!(p.endpoint && p.model), '先保存端点与模型，再启用') + '<button class="smallbtn" type="button" id="provSave">保存此渠道</button><button class="smallbtn danger" type="button" id="provDelete">删除</button></div>';
      }
      renderedKey = selKey; // 记下这次真正渲染的渠道（滚动保持要比对它）
    }

    // 未保存的编辑（草稿）：任何重渲染前先收走、渲染后回填 —— 拉取/事件刷新不会清空正在填的表单。
    // 只回填到同一个渠道（key 一致）；切到别的渠道 = 放弃草稿（有保存按钮有提示，行为可预期）。
    function captureDraft() {
      if (!detailEl) return null;
      var k = parseKey(selKey); if (!k || k.kind !== 'custom') return null;
      var g = function (id) { var el = detailEl.querySelector('#' + id); return el ? el.value : undefined; };
      if (g('provName') === undefined && g('provEndpoint') === undefined) return null;
      return { key: selKey, name: g('provName'), endpoint: g('provEndpoint'), apiKey: g('provKey'), model: g('provModelText'), sel: g('provModelSel'), thinkingStyle: g('provThinkingStyle') };
    }
    function restoreDraft(d) {
      if (!d || d.key !== selKey) return;
      var s = function (id, v) { var el = detailEl.querySelector('#' + id); if (el && v != null) el.value = v; };
      s('provName', d.name); s('provEndpoint', d.endpoint); s('provKey', d.apiKey); s('provModelText', d.model);
      if (d.sel != null) { var selEl = detailEl.querySelector('#provModelSel'); if (selEl) { try { selEl.value = d.sel; } catch (e) {} } }
      s('provThinkingStyle', d.thinkingStyle);
    }
    // 需要数据动作（拉取/启用）前，把当前渠道正在填的草稿落盘 —— 用户不用先记着点保存
    function commitDraftIfCurrent() {
      var d = captureDraft(); if (!d || d.key !== selKey) return;
      var k = parseKey(selKey); if (!k || k.kind !== 'custom') return;
      var _ts = d.thinkingStyle || 'levels';
      P.saveCustom(k.id, {
        name: (d.name || '').trim() || '未命名服务商',
        endpoint: (d.endpoint || '').trim(),
        apiKey: (d.apiKey || '').trim(),
        model: ((d.model || '') || (d.sel || '')).trim(),
        supportsThinking: _ts !== 'none',
        thinkingStyle: _ts === 'onoff' ? 'vllm' : (_ts === 'none' ? 'none' : (_ts === 'effort' ? 'effort' : 'deepseek')),
        needsReasoningHistory: _ts !== 'none',
      });
    }
    // 2026-11-11: 滚动位置保持 —— 勾一个模型会走 toggleModel→write→emit→renderAll，
    // 整块 detail 重建后滚动容器是新 DOM，scrollTop 归零（用户看到的就是"点一下就跳回顶部"）。
    // 关键是比"这次渲染的是不是同一个渠道"（renderedKey），而不是比 selKey ——
    // 切渠道时 selKey 在渲染前就变了，用 selKey 比会把上个渠道的偏移套到新渠道上。
    var renderedKey = '';
    function captureScroll() {
      var b = detailEl.querySelector('.prov-box');
      return { key: renderedKey, top: b ? b.scrollTop : 0 };
    }
    function restoreScroll(c) {
      if (!c || !c.top || c.key !== renderedKey || !c.key) return;
      var b = detailEl.querySelector('.prov-box');
      if (b) b.scrollTop = c.top;
    }
    function renderAll() { var d = captureDraft(); var sc = captureScroll(); renderList(); renderDetail(); restoreDraft(d); restoreScroll(sc); }

    // —— 左栏：点击即切换 ——
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-new')) {
        var id = P.newCustom();
        selKey = 'custom:' + id;
        renderAll();
        toastFn('已新建自定义渠道 · 填好端点与模型后点「保存此渠道」', 3200);
        return;
      }
      var key = b.getAttribute('data-key'); if (!key) return;
      commitDraftIfCurrent(); // 切走前把正在填的（若就是当前渠道）落盘
      selKey = key;
      var k = parseKey(key), c = findChannel(key);
      if (activeKey() !== key) {
        if (k && k.kind === 'custom' && c && (!(c.detail || {}).endpoint || !(c.detail || {}).model)) {
          toastFn('这个渠道还没填端点/模型 · 先在右侧填好，再启用', 3200);
        } else {
          P.setActive(key);
          toastFn('已切到「' + ((c && c.name) || key) + '」后续聊天走它', 2600);
        }
      }
      renderAll();
    });

    // —— 右栏：拉取 / 勾选 / 保存 / 删除 / 启用 ——
    detailEl.addEventListener('click', async function (e) {
      var t = e.target;
      // 2026-11-11(C): 批量勾选。走 setAllModels 一次写盘，不逐条 toggle（否则重渲染 N 次）
      if (t.id === 'provSelAll' || t.id === 'provSelNone' || t.id === 'provSelRec') {
        var pickRec = t.id === 'provSelRec';
        var n = P.setAllModels(selKey, t.id !== 'provSelNone', { onlyRecommended: pickRec });
        toastFn(t.id === 'provSelNone' ? '已全部取消勾选（下拉只剩渠道默认模型）'
          : (pickRec ? '已恢复推荐：勾上 ' + n + ' 个（DeepSeek / Nemotron）'
                     : '已全选 ' + n + ' 个模型'), 2200);
        renderAll();
        return;
      }
      if (t.id === 'provFetch') {
        t.disabled = true;
        var msgEl = detailEl.querySelector('#provFetchMsg');
        if (msgEl) msgEl.textContent = '拉取中…（经 Worker 代理）';
        commitDraftIfCurrent(); // 先落盘，拉取后的重渲染才丢不掉
        var k = parseKey(selKey) || {};
        var opts = {};
        if (k.kind === 'custom') {
          opts.endpoint = (detailEl.querySelector('#provEndpoint') || {}).value || '';
          opts.apiKey = (detailEl.querySelector('#provKey') || {}).value || '';
        }
        var r = await P.fetchModels(selKey, opts);
        if (r.ok) toastFn('拉到 ' + r.count + ' 个模型' + (r.title ? '（' + r.title + '）' : '') + ' · 勾选要用的', 2600);
        else toastFn('没拉到模型：' + (r.error || '未知原因') + ' · 可手填模型名', 4200);
        renderAll();
        return;
      }
      if (t.id === 'provSave') {
        var pid = (parseKey(selKey) || {}).id;
        var nameEl = detailEl.querySelector('#provName'), epEl = detailEl.querySelector('#provEndpoint'), kyEl = detailEl.querySelector('#provKey');
        var selEl = detailEl.querySelector('#provModelSel'), mdEl = detailEl.querySelector('#provModelText'), styleEl = detailEl.querySelector('#provThinkingStyle');
        var model = ((mdEl && mdEl.value) || (selEl && selEl.value) || '').trim();
        var thinkStyle = (styleEl && styleEl.value) || 'deepseek';
        P.saveCustom(pid, {
          name: (nameEl.value || '').trim() || '未命名服务商',
          endpoint: (epEl.value || '').trim(),
          apiKey: (kyEl.value || '').trim(),
          model: model,
          supportsThinking: thinkStyle !== 'none',
          thinkingStyle: thinkStyle === 'onoff' ? 'vllm' : (thinkStyle === 'none' ? 'none' : (thinkStyle === 'effort' ? 'effort' : 'deepseek')),
          needsReasoningHistory: thinkStyle !== 'none',
        });
        toastFn('已保存此渠道', 1800);
        renderAll();
        return;
      }
      if (t.id === 'provDelete') {
        var c2 = findChannel(selKey);
        var okDel = window.feedbackSvc && window.feedbackSvc.confirm
          ? await window.feedbackSvc.confirm({ title: '删除渠道', message: '删除「' + ((c2 && c2.name) || '') + '」？本机保存的 Key 一并删除。', danger: true, okText: '删除' })
          : window.confirm('删除这个渠道？');
        if (!okDel) return;
        P.deleteCustom((parseKey(selKey) || {}).id);
        selKey = P.effectiveKey(curMode());
        renderAll();
        return;
      }
      if (t.id === 'provUse') {
        commitDraftIfCurrent(); // 启用前先落盘草稿
        P.setActive(selKey);
        var c3 = findChannel(selKey);
        toastFn('已切到「' + ((c3 && c3.name) || selKey) + '」', 2200);
        renderAll();
        return;
      }
    });
    detailEl.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-mid')) {
        P.toggleModel(selKey, t.getAttribute('data-mid'), !!t.checked);
        renderAll();
        return;
      }
      if (t && t.id === 'provModelSel') {
        var mdEl = detailEl.querySelector('#provModelText');
        if (mdEl) mdEl.value = t.value;
      }
    });

    P.on(function () { try { renderAll(); } catch (e) {} });
    renderAll();
    // 首屏数据：刷新预设元数据；当前选中的预设渠道「没清单 / 清单过期」时静默拉一次
    P.refreshPresets().then(function () {
      renderAll();
      var k = parseKey(selKey);
      if (k && k.kind === 'preset' && (!P.modelsAll(selKey).length || P.modelsStale(selKey))) {
        P.fetchModels(selKey).then(function () { renderAll(); });
      }
    });
  }

  // ─── §模型API. 自定义模型定价 ───
  // 写 cfw_custom_pricing_v1；app.js calcCost 每次实时合并，因此保存后立即生效。
  // 该 key 已加入 sync.js 主同步白名单，可跨端同步；不含 API Key。
  function mountCustomPricingCard() {
    var slot = window.slotRegistry.pick('setModelApiSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'customPricingCard', slotId: 'setModelApiSlot' });
    if (!slot || document.getElementById('customPricingCard')) return;
    // 2026-11-25 服务层搬迁：定价表的 JSON 守卫与价格校验内聚在
    // services/ui/settings-custom-pricing.ts（window.settingsCustomPricing），与 cost/ledger 读侧对拍同源。
    // localStorage 原样保留作服务缺席时的回落。
    var K = 'cfw_custom_pricing_v1';
    var cp = window.settingsCustomPricing;
    function read() {
      if (cp) return cp.table();
      try { var o = JSON.parse(localStorage.getItem(K) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
    }
    function write(o) {
      if (cp) { try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {} return; }
      try { localStorage.setItem(K, JSON.stringify(o || {})); } catch (e) {}
    }
    var esc = window.escapeSvc.esc;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'customPricingCard';
    card.innerHTML = '<h4>自定义模型定价</h4>'
      + '<p>给自定义直连或候选池里的新模型补价格。单位是 <b>¥ / 百万 token</b>；保存后费用估算立即生效，并随云同步跨端保存。</p>'
      + '<div class="settings-grid-2">'
      + '<label><span>模型 ID</span><input id="cpModel" type="text" placeholder="deepseek-v4-flash / qwen-max / gpt-4o ..."></label>'
      + '<label><span>缓存命中输入价</span><input id="cpCache" type="number" min="0" step="0.001" placeholder="0.02"></label>'
      + '<label><span>普通输入价</span><input id="cpInput" type="number" min="0" step="0.001" placeholder="1.00"></label>'
      + '<label><span>输出价</span><input id="cpOutput" type="number" min="0" step="0.001" placeholder="2.00"></label>'
      + '</div>'
      + '<div class="rowline" style="margin-top:10px;"><div id="cpStatus" style="font-size:11px;color:var(--muted);flex:1;"></div><div class="btns"><button class="smallbtn" id="cpUseCurrent" type="button">填当前模型</button><button class="smallbtn" id="cpSave" type="button">保存定价</button><button class="smallbtn danger" id="cpDelete" type="button">删除此模型</button></div></div>'
      + '<div id="cpList" class="settings-mini-list"></div>';
    slot.appendChild(card);
    var model = card.querySelector('#cpModel'), cache = card.querySelector('#cpCache'), input = card.querySelector('#cpInput'), output = card.querySelector('#cpOutput'), status = card.querySelector('#cpStatus'), list = card.querySelector('#cpList');
    function setMsg(t) { if (status) status.textContent = t || ''; }
    function fill(id) {
      var all = read(), p = all[id] || {};
      model.value = id || '';
      cache.value = p.cache_hit != null ? p.cache_hit : '';
      input.value = p.input != null ? p.input : '';
      output.value = p.output != null ? p.output : '';
    }
    function render() {
      var all = read(), ids = Object.keys(all).sort();
      if (!ids.length) { list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding-top:8px;">暂无自定义定价</div>'; return; }
      list.innerHTML = ids.map(function (id) {
        var p = all[id] || {};
        return '<button type="button" data-id="' + esc(id) + '"><span>' + esc(id) + '</span><small>in ' + esc(p.input) + ' / out ' + esc(p.output) + '</small></button>';
      }).join('');
    }
    list.addEventListener('click', function (e) { var b = e.target.closest('button[data-id]'); if (b) fill(b.getAttribute('data-id')); });
    card.querySelector('#cpUseCurrent').addEventListener('click', function () {
      var id = '';
      try {
        var byo = window.byoProviderSvc && window.byoProviderSvc.get && window.byoProviderSvc.get();
        id = (byo && byo.model) || (document.getElementById('modelSel') && document.getElementById('modelSel').value) || '';
      } catch (e) {}
      fill(id);
      setMsg(id ? '已填入当前模型' : '没有可用的当前模型');
    });
    card.querySelector('#cpSave').addEventListener('click', function () {
      var id = (model.value || '').trim();
      // parsePrice 返回 null 表示非法；转成 NaN 让下面的 >= 0 校验照旧拦下（null>=0 在 JS 里为真）。
      function pr(s) { var v = cp ? cp.parsePrice(s) : parseFloat(s); return v === null ? NaN : v; }
      var p = { cache_hit: pr(cache.value), input: pr(input.value), output: pr(output.value) };
      if (!id) { alert('先填写模型 ID'); return; }
      if (!(p.cache_hit >= 0) || !(p.input >= 0) || !(p.output >= 0)) { alert('三个价格都要填数字，单位是 ¥/百万 token'); return; }
      var all = read(); all[id] = p; write(all); render(); setMsg('已保存 ' + id + ' 的定价');
    });
    card.querySelector('#cpDelete').addEventListener('click', function () {
      var id = (model.value || '').trim();
      if (!id) return;
      var all = read(); delete all[id]; write(all); fill(''); render(); setMsg('已删除 ' + id + ' 的自定义定价');
    });
    render();
  }
