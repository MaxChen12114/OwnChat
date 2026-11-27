// 20-base.js — 基座与内容：行为准则 / 解限底座 / 基座目录 / 联网 / 人物模板 / 静态卡总装。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §基座. 基础行为准则卡（2026-10-05 新增）───
  // 锁定态注入 src/prompts/bases/locked/ 里那套准则；解锁后本卡隐藏（data-locked-only + index.html 的反向 CSS 规则），
  // 槽位由「解限底座」卡顶上 —— 两张卡都 prepend 进 #setChatSlot，隐藏的那张不占位，
  // 所以视觉上永远是「该状态的那一张」在首卡位置（对应服务端的两套注册表）。
  // 文案纪律：本卡**只在锁定态可见**，所以字面上一律不提「解锁 / 解限 / 私人模式」——
  // 锁定态是伪装态，任何"存在一个隐藏开关"的暗示都属于泄底（与 data-nsfw 那套隐藏同一理由）。
  // 反过来，两边互斥这件事写在「解限底座」卡的提示里（那张卡只有解锁后才看得到）。
  function mountNeutralCard() {
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'neutralCard', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('neutralCard')) return;
    var esc = window.escapeSvc.esc;
    var card = document.createElement('div');
    card.className = 'card'; card.id = 'neutralCard'; card.setAttribute('data-locked-only', '');
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>基础行为准则</h4><p>给助手定的 system 行为准则——语言口吻、事实与诚实、扮演与创作、代码与技术、排版格式。</p><div style="margin-top:10px;"><select id="neutralIdSel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></select></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>文件放在 <code>src/prompts/bases/locked/</code>（规则与 <code>bases/unlocked/</code> 一致：任意 <code>.md</code>/<code>.txt</code>/子目录，id = 文件名）。<b>默认</b> = 排序第一份。切换后<b>下一轮</b>生效。往那里放一个新文件、部署，这里自动多一项。</span></div>`;
    slot.prepend(card);
    var bs = document.getElementById('neutralIdSel');
    if (!bs) return;
    // 2026-11-25 C2：选择键与默认值归 services/ui/settings-base-id.ts（与 prompt-profile 读侧对拍）
    var sel = window.settingsBaseId;
    var KB = sel.NEUTRAL_ID_KEY;
    var ids = Array.isArray(window.APP_NEUTRAL_IDS) ? window.APP_NEUTRAL_IDS : [];
    bs.innerHTML = '<option value="">默认</option>' + ids.map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
    }).join('');
    try { bs.value = sel.readSelection(KB); } catch (e) {}
    bs.addEventListener('change', function () {
      try { sel.writeSelection(KB, bs.value); } catch (e) {}
    });
  }

  // ─── §基座. 解限底座版本卡(2026-10-05 从「聊天模型·自定义直连」卡里拆出,独立成卡)───
  // 为什么独立:底座是 system 提示词的第一段,对全部聊天生效(内置模型与自定义直连都吃),
  // 本身与"直连"毫无关系 —— 塞在直连卡最底部、隔一条分割线时,没人能找到它。
  // 为什么放「对话」类目首卡:基座影响一切,理应排在该分类最上面(prepend 保证位置,不依赖挂载顺序)。
  // 锁定态整卡不显示:卡上带 data-nsfw,由 html:not(.unlocked) [data-nsfw]{display:none} 隐藏
  // —— 与 NSFW 主题同一套机制(未解锁=不渲染,而不是置灰)。
  function mountBaseIdCard() {
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'baseIdCard', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('baseIdCard')) return;
    var esc = window.escapeSvc.esc;
    var card = document.createElement('div');
    card.className = 'card'; card.id = 'baseIdCard'; card.setAttribute('data-nsfw', '');
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>解限底座</h4><p>底座是 system 提示词的第一段，所有聊天都吃它——内置模型与自定义直连一样。这里选的是它的版本。</p><div style="margin-top:10px;"><select id="baseIdSel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></select></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>选项就是 <code>src/prompts/bases/unlocked/</code> 里的文件名（<b>默认</b> = 排序第一份；想让某份当默认，就在它名字最前面加个数字）。切换后<b>下一轮</b>生效（上游缓存前缀会重算一次）。往那里放一个新 <code>.md</code>，部署后这里自动多一项。锁定态走的是另一套「基础行为准则」（<code>bases/locked/</code>），与本卡互斥显示。</span></div>`;
    slot.prepend(card);
    // 候选项来自 /config.js 的 APP_BASE_IDS(worker 侧 bases/index.js 自动发现的产物)。
    // 只存 id、不存文本;真正的取舍在服务端 resolveBaseId 白名单,前端这里只负责挑。
    var bs = document.getElementById('baseIdSel');
    if (!bs) return;
    // 2026-11-25 C2：cfw_base_id_v1 与 neutral/custom 同源归一化（services/ui/settings-base-id.ts）
    var sel = window.settingsBaseId;
    var KB = sel.BASE_ID_KEY;
    var ids = Array.isArray(window.APP_BASE_IDS) ? window.APP_BASE_IDS : [];
    // 2026-10-05: 下拉里**不加任何注释** —— 文件名本身就是标签(用户按名字分辨效果),
    // 旧版那张 HINTS 短注表(base-1=Pyrite / base-2=GLM…)已删,免得改名后表里说法变假。
    bs.innerHTML = '<option value="">默认</option>' + ids.map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
    }).join('');
    // 存了个已不存在的 id(文件被删/改名)时,浏览器会把 select 落回空 → 界面自动显示「默认」,
    // 与 worker 的白名单回落一致(那边也会回落到默认档)。
    try { bs.value = sel.readSelection(KB); } catch (e) {}
    bs.addEventListener('change', function () {
      try { sel.writeSelection(KB, bs.value); } catch (e) {}
    });
    // 2026-10-09 公开渠道（__baseSwitchMode）：第二套目录 —— 自定义（src/prompts/custom/）也来一个下拉。
    // 顶栏按钮只管在两套目录间切换，具体档位在这里各自选；私有版不置位，这段不执行。
    if (window.__baseSwitchMode) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:12px;';
      var lab = document.createElement('div');
      lab.style.cssText = 'font-size:12px;opacity:.65;margin-bottom:5px;';
      lab.textContent = '自定义目录（src/prompts/custom/）';
      wrap.appendChild(lab);
      var cs = document.createElement('select');
      cs.id = 'customBaseIdSel';
      cs.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
      var cids = Array.isArray(window.APP_CUSTOM_IDS) ? window.APP_CUSTOM_IDS : [];
      if (!cids.length) {
        cs.innerHTML = '<option value="">（目录为空 —— 把 .md / .txt 放进去并部署）</option>';
        cs.disabled = true;
      } else {
        cs.innerHTML = '<option value="">默认</option>' + cids.map(function (id) {
          return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
        }).join('');
        // 2026-11-25 服务层搬迁：cfw_custom_id_v1 读写内聚在 services/ui/settings-base-id.ts
        //（window.settingsBaseId），与 prompt-profile.currentCustomId 读侧同源。
        var bid = window.settingsBaseId;
        try { cs.value = bid ? bid.read() : (localStorage.getItem('cfw_custom_id_v1') || ''); } catch (e) {}
        cs.addEventListener('change', function () {
          if (bid) bid.write(cs.value);
          else try { if (cs.value) localStorage.setItem('cfw_custom_id_v1', cs.value); else localStorage.removeItem('cfw_custom_id_v1'); } catch (e) {}
        });
      }
      wrap.appendChild(cs);
      var host = bs.parentNode && bs.parentNode.parentNode;
      if (host) host.insertBefore(wrap, bs.parentNode.nextSibling);
    }
  }

  // ─── §基座目录. 内置 / 自定义 两套目录的切换（2026-11-14 从顶栏按钮降级到这里）───
  // 为什么搬：顶栏 #personaToggle 原来同时承担「切目录」（内置 bases/ ↔ 自定义 custom/）
  // 与「切档位」两种语义，在用户认知里又长期和 unlock.js 的私人解锁混为一谈。
  // 2026-11-14 该按钮改为「工作 / 角色扮演」，目录切换就只剩这一个入口 ——
  // 写 cfw_base_registry_v1，prompt-profile 的 baseIdPayload 每次装配请求现读，不用重绘。
  // 只在公开渠道构建（window.__baseSwitchMode）出现：私有版只有一套目录，给了也是空下拉。
  // 与 mountBaseIdCard 同样带 data-nsfw：未解锁态整卡不渲染，避免「切了目录却看不到档位」。
  function mountBaseRegistryCard() {
    if (!window.__baseSwitchMode) return;
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'baseRegistryCard', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('baseRegistryCard')) return;
    var card = document.createElement('div');
    card.className = 'card'; card.id = 'baseRegistryCard'; card.setAttribute('data-nsfw', '');
    card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5h6l1.6 2h9.4v9a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 18.5v-11z"/><path d="M3.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h4"/></svg>基座目录</h4><p>两套目录，二选一：<b>内置</b>读 <code>src/prompts/bases/</code>，<b>自定义</b>读 <code>src/prompts/custom/</code>。选定目录后再到下面「解限底座」卡里挑具体哪一份。</p><div style="margin-top:10px;"><select id="baseRegistrySel" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><option value="">内置（src/prompts/bases/）</option><option value="custom">自定义（src/prompts/custom/）</option></select></div><div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>切换后<b>下一轮</b>生效。两套目录各自记住自己的档位（<code>cfw_base_id_v1</code> / <code>cfw_custom_id_v1</code>），来回切不会丢选择；某套目录为空时 worker 回落到默认档。这里原来在顶栏那个「内置 / 自定义」按钮上，与私人解锁无关。</span></div>`;
    slot.prepend(card);
    var sel = document.getElementById('baseRegistrySel');
    if (!sel) return;
    // 2026-11-25 C2：目录开关只有 custom / 内置两态，归一化归 services/ui/settings-base-id.ts
    var svc = window.settingsBaseId;
    try { sel.value = svc.readRegistry(); } catch (e) {}
    sel.addEventListener('change', function () {
      try { svc.writeRegistry(sel.value); } catch (e) {}
    });
  }

  // ─── §联网搜索卡（2026-10-07 新增）───
  // 背景：联网由本项目的 Worker 代查：免费 DuckDuckGo/Bing 兜底；勾「深度搜索」时优先 DeepSeek
  // 搜索 API（2026-10-17 上线，/v1/tools/search），未配 key 再用 Exa。
  // 开关默认关（不静默把查询外发）；只对普通聊天生效，Agent 模式本来就有 web_search 工具。
  function mountWebSearchCard() {
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'webSearchCard', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('webSearchCard')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'webSearchCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>联网搜索</h4>'
      + '<p>开启后，普通聊天遇到需要实时信息的问题（新闻、价格、版本、赛事…）时会自己搜索再回答，并在引用处附来源链接。搜索由<b>你自己的 Worker</b> 执行 —— 官方 API 里没有内置搜索，这里是把搜索工具挂在聊天请求上、由 Worker 侧跑。</p>'
      + '<div class="rowline"><div class="toggle"><input type="checkbox" id="webSearchToggle"><label for="webSearchToggle">启用联网搜索</label></div>'
      + '<div class="toggle" style="margin-top:6px;"><input type="checkbox" id="webSearchDeepToggle"><label for="webSearchDeepToggle">深度搜索（DeepSeek / Exa，按次计费；DeepSeek ≈¥0.005/次）</label></div></div>'
      + '<div id="webSearchStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>默认走免费的 DuckDuckGo,它不通时自动改用 <b>Bing</b>(同样免费);勾了「深度搜索」且 Worker 侧配了 <code>DEEPSEEK_SEARCH_API_KEY</code>（或复用 <code>DEEPSEEK_API_KEY</code>）时优先走 DeepSeek 搜索（<code>wrangler secret put DEEPSEEK_SEARCH_API_KEY</code>）；否则配了 <code>EXA_API_KEY</code> 走 Exa；都没配或调用失败则自动降级。开了联网的回复会比平时慢一些——要多 1~2 轮「搜索 + 复述结果」。查询词会发到你自己的 Worker 再转给搜索服务;Agent 模式的 <code>web_search</code> 工具不受此开关影响。</span></div>';
    slot.appendChild(card);
    var t = card.querySelector('#webSearchToggle');
    var d = card.querySelector('#webSearchDeepToggle');
    var st = card.querySelector('#webSearchStatus');
    // 2026-11-25 服务层搬迁：读写口径（两键 === '1'、关主开关清深搜）内聚在
    // services/ui/settings-web-search.ts（window.settingsWebSearch），与 prompt-profile 读侧同源。
    var ws = window.settingsWebSearch;
    function paint() {
      var s = ws ? ws.read() : { enabled: localStorage.getItem('cfw_web_search_v1') === '1', deep: localStorage.getItem('cfw_web_search_deep_v1') === '1' };
      t.checked = s.enabled; d.checked = s.deep;
      d.disabled = !s.enabled;
      if (st) st.textContent = !s.enabled ? '未启用（聊天只靠模型自身知识）' : (s.deep ? '已启用：深搜(DeepSeek/Exa)优先，未配 key 自动降级' : '已启用：免费搜索(DuckDuckGo)');
    }
    t.addEventListener('change', function () {
      if (ws) ws.writeEnabled(t.checked);
      else { localStorage.setItem('cfw_web_search_v1', t.checked ? '1' : '0'); if (!t.checked) localStorage.setItem('cfw_web_search_deep_v1', '0'); }
      paint();
    });
    d.addEventListener('change', function () {
      if (ws) ws.writeDeep(d.checked);
      else localStorage.setItem('cfw_web_search_deep_v1', d.checked ? '1' : '0');
      paint();
    });
    paint();
  }

  // ─── M1: 网页自定义人物模板卡(#customPrompt) ───
  // 保存逻辑由 app.js 按 ID 接线；settings.js 仅在 openPanel 时回填 LS 值(见 initPanelToggle)。
  // 2026-11-14：卡里补一个「注入内置角色提示词」开关（#useBuiltinToggle / cfw_use_builtin）——
  // 这个能力原来只在顶栏 #personaToggle 上（私有版构建点一下切内置/自定义），
  // 该按钮改为「工作 / 角色扮演」后，这里是它唯一的入口。文案里原来说的
  // 「仅在顶栏切到自定义」已不成立，一并改掉。
  function mountPersonaCard() {
    var slot = window.slotRegistry.pick('setChatSlot');
    if (slot) window.slotRegistry.claim({ cardId: 'customPrompt', slotId: 'setChatSlot' });
    if (!slot || document.getElementById('customPrompt')) return;
    var card = document.createElement('div'); card.className = 'card'; card.id = 'personaTemplateCard';
    card.innerHTML = '<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>网页自定义人物模板</h4>'
      + '<div class="rowline" style="margin-bottom:8px;"><div class="toggle"><input type="checkbox" id="useBuiltinToggle"><label for="useBuiltinToggle">注入内置角色提示词</label></div></div>'
      + '<p>关掉上面的开关 = 不发送内置的角色提示词，只发下面这段（当前会话有角色卡时，角色卡仍然优先）。适合你想完全接管人设的场合。仅本设备。</p>'
      + '<textarea id="customPrompt" rows="5" placeholder="输入自定义人物设定或全局指令…" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;resize:vertical;"></textarea>'
      + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>「追加自定义提示词」开关控制本段是否实际发送。留空 = 不追加任何内容。</span></div>';
    slot.appendChild(card);
    var ub = document.getElementById('useBuiltinToggle');
    if (!ub) return;
    // 2026-11-25 C5：缺省=开的归一化归 services/ui/settings-persona.ts，与 app.js 读侧同源。
    var persona = window.settingsPersona;
    ub.checked = persona.readUseBuiltin();
    ub.addEventListener('change', function () {
      persona.writeUseBuiltin(ub.checked);
      // app.js 把 useBuiltin 缓存在模块变量里（请求装配要用），靠这个广播让它重读。
      try { window.dispatchEvent(new CustomEvent('cfw:external-settings')); } catch (e) {}
    });
  }

  function mountStaticSettingsCards() {
    // 2026-11-18 服务层搬迁：挂载顺序表在 services/ui/settings-card-order.ts（每步带理由、可被锁
    // 审计），这里只做「按 plan 查映射表调函数」。未知/缺失的 id 由 plan 过滤，不占位。
    const MOUNTS = {
      mountConvAutonameCard: mountConvAutonameCard,
      mountContextCard: mountContextCard,
      mountMemoryCard: mountMemoryCard,
      mountAuthCard: mountAuthCard,
      mountLocalHistoryCard: mountLocalHistoryCard,
      mountSyncCard: mountSyncCard,
      mountTopbarCostCard: mountTopbarCostCard,
      mountDeployCard: mountDeployCard,
      mountThemeCard: mountThemeCard,
      mountAmbientCard: mountAmbientCard,
      mountBackgroundCard: mountBackgroundCard,
      mountDisplayCard: mountDisplayCard,
      mountAppFxCard: mountAppFxCard,
      mountI18nCard: mountI18nCard,
      mountPanelToolsCard: mountPanelToolsCard,
      mountNeutralCard: mountNeutralCard,
      mountStateLayerCard: mountStateLayerCard,
      mountWebSearchCard: mountWebSearchCard,
      mountBaseIdCard: mountBaseIdCard,
      mountBaseRegistryCard: mountBaseRegistryCard,
      mountChatModeCard: mountChatModeCard,
      mountAutopilotCard: mountAutopilotCard,
      mountAgentToolsCard: mountAgentToolsCard,
      mountMultiAgentCard: mountMultiAgentCard,
      mountDevToolsCard: mountDevToolsCard,
      mountPersonaCard: mountPersonaCard,
      mountPersonalizeCard: mountPersonalizeCard,
      mountByoCard: mountByoCard,
      mountDeepSeekKitCard: mountDeepSeekKitCard,
      mountCustomPricingCard: mountCustomPricingCard,
      mountGenParamsCard: mountGenParamsCard,
      mountDataBackupCard: mountDataBackupCard,
    };
    const plan = window.planCardMounts(Object.keys(MOUNTS));
    for (let i = 0; i < plan.length; i++) {
      const fn = MOUNTS[plan[i]];
      if (typeof fn === "function") fn();
    }
  }
