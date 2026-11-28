// 30-chat.js — 对话与账号：状态层 / 对话模式 / 显示 / 账号 / 同步卡 / 对话数据 / 个性化 / 自驱叙事。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── §对话. 角色状态层开关（2026-10-05 新增）───
  // 回答「为什么默认就是 RP」:判定只有一条 —— 有角色卡就注入 Layer2 的【当前状态】那一段
  // (关系/情绪/好感/场景/摘要)。这个开关就是那个手动把手:关掉后角色卡照旧,只是不再注入状态。
  // 为什么单独成卡而不是塞进「回复风格」卡:那卡只管排版取材,这个名字也对不上(旧账就是乱放被挑过)。
  function mountStateLayerCard() {
    // 2026-11-28 card-shell batch 2 (B-group): the old guard id sat on the inner toggle
    // (stateLayerToggle, read by the prompt layer at request time) and the card element had no id
    // at all. The card-level id stateLayerCard is new; the toggle keeps its id and wiring, so the
    // two ids coexist — same shape as the topbarCostCard precedent in 10-appearance.js.
    window.slotRegistry.declareCard({
      id: 'stateLayerCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'stateLayerCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20V10"/><path d="M6 20v-6"/><path d="M18 20V4"/></svg>角色状态层',
          desc: '有角色卡时，服务端会把「【当前状态】」那一段（关系 / 情绪 / 好感度 / 场景 / 剧情摘要）接在 system 末尾。<b>关掉后角色卡照旧生效，只是不再注入这些状态</b>——想让它纯按角色卡演、不吃好感度与场景提示时用。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="stateLayerToggle"><label for="stateLayerToggle">注入角色状态层（【当前状态】/ 场景 / 摘要）</label></div></div>',
          tip: '切换后<b>下一轮</b>生效。默认开 —— 不是按模型判的，就一条规则：有角色卡就注入。工具/Agent 那条路径本来就不吃状态层。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // 2026-10-05: 标题由「互动模式(Roleplay Mode)」改成「回复风格」,并交出了两个显示 toggle
  // (隐藏小按钮/隐藏统计小字 → 搬进「外观·显示设置」卡)。卡名与内容对齐:它现在只管回复风格。
  // 守卫 ID 随之从 hideMsgActionsToggle 换成本卡仍有的 replyStyleSel —— 否则 toggle 搬走后守卫失效,会反复重挂。
  // 2026-10-05: 标题由「互动模式(Roleplay Mode)」改成「回复风格」,并交出了两个显示 toggle
  // (隐藏小按钮/隐藏统计小字 → 搬进「外观·显示设置」卡)。卡名与内容对齐:它现在只管回复风格。
  // 守卫 ID 随之从 hideMsgActionsToggle 换成本卡仍有的 replyStyleSel —— 否则 toggle 搬走后守卫失效,会反复重挂。
  function mountChatModeCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id chatModeCard is new; the select keeps
    // its replyStyleSel id (the mount guard used to sit on it) and the settings host still reads it
    // by ID. Double-id shape, topbarCostCard precedent.
    window.slotRegistry.declareCard({
      id: 'chatModeCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'chatModeCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19l8.5-8.5"/><path d="M15 4.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/><path d="M6.5 4.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>回复风格',
          desc: '控制 AI 回复的取材与排版。<span data-nsfw>内容尺度已改为跟随私人模式:解锁即固定拉满,锁定即关闭,不再有等级或开关(退出按钮在设置面板底部)。</span>',
          extra: '<div style="margin-top:10px;"><div style="font-size:12px;color:var(--muted);margin-bottom:8px;">回复风格</div><select id="replyStyleSel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="default">默认（交由角色卡决定）</option><option value="wechat">微信连发（1-2 句一条，多气泡连发）</option><option value="verbose">长段叙事（小说式丰满段落，写小说）</option></select></div>',
          tip: '单人普通对话<b>没有字数限制</b>,写小说请选 <b>长段叙事</b> 档。字数限制(150-250 字)只存在于鱼缸接龙/讨论模式,保持多人轮转节奏。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // 显示设置卡 = 聊天区呈现的唯一去处(字号 / 字体 / 内容里的显示开关)。
  // 2026-10-05: 「隐藏小按钮」「隐藏统计小字」两个 toggle 从「互动模式」卡搬来 ——
  // 显示类开关原本被拆在两个类目里(字号字体在外观、两个 toggle 在对话),现在收拢到一处。
  // 接线不受影响:它们由 ID 查元素(见本文件 initPanelToggle 区),不依赖父节点。
  function mountDisplayCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id chatDisplayCard is new (the card
    // element had no id; the mount guard sat on the chatFontSizeRange slider). Every control id is
    // unchanged — the initPanelToggle wiring and 60-sync.js read them by ID. Double-id shape,
    // topbarCostCard precedent. Named chatDisplayCard, not displayCard: 60-sync.js already uses a
    // local "displayCard" variable for this very card's element.
    window.slotRegistry.declareCard({
      id: 'chatDisplayCard',
      slotId: 'setAppearanceThemeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'chatDisplayCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>显示设置',
          desc: '调整聊天区字号、字体，以及聊天内容里的显示开关。<b>仅本设备生效</b>(不进云同步)，刷新页面也会保留。',
          extra: `<div style="margin-top:8px;"><label for="chatFontSizeRange" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px;"><span>聊天字号</span><span id="chatFontSizeLabel" style="font-variant-numeric:tabular-nums;">13px</span></label><input type="range" id="chatFontSizeRange" min="12" max="22" step="1" value="13" style="width:100%;"></div><div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">聊天字体</div><select id="chatFontFamilySel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="">系统默认（苹方/微软雅黑）</option><option value='"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'>圆体（PingFang）</option><option value='"Noto Serif SC", "Source Han Serif SC", "SimSun", serif'>宋体（Noto Serif）</option><option value='"Kaiti SC", "STKaiti", KaiTi, serif'>楷体（Kaiti）</option><option value='FangSong, STFangsong, serif'>仿宋（FangSong）</option><option value='ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'>等宽（Monospace）</option><option value="__custom__">自定义字体…</option></select></div><div class="rowline" style="margin-top:8px;align-items:center;gap:8px;"><input type="text" id="chatFontCustom" maxlength="200" placeholder="自定义字体名，如 LXGW WenKai, serif" style="flex:1;min-width:0;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><button class="smallbtn" id="chatFontCustomApply" type="button">应用</button><button class="smallbtn" id="chatFontCustomClear" type="button">清除</button></div><div class="font-preview" id="chatFontPreview" data-text-fx="off"><div class="font-preview-label">字体与出字效果</div><div class="font-preview-line" id="chatFontPreviewLine">落霞与孤鹜齐飞，秋水共长天一色。</div><div class="font-preview-foot"><span class="font-preview-text">改字体或换效果，这句话会重新演示一遍</span><button type="button" class="font-preview-replay" id="chatFontPreviewReplay">再看一遍</button></div></div><div style="margin-top:14px;"><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">文字特效</div><select id="chatTextFxSel" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border, #333);background:transparent;color:inherit;font-size:13px;"><option value="off">无（默认）</option><option value="soft">轻（柔和投影）</option><option value="strong">强（更清晰的文字层次）</option></select></div><div class="rowline" style="margin-top:14px;"><div class="toggle"><input type="checkbox" id="hideMsgActionsToggle"><label for="hideMsgActionsToggle">隐藏消息行下方的小按钮(重试/删除/复制)</label></div></div><div class="rowline"><div class="toggle"><input type="checkbox" id="hideStatsToggle"><label for="hideStatsToggle">隐藏统计小字(token / 速度 / 累计费用)</label></div></div>`,
          tip: '字体预览与文字特效<b>仅本设备生效</b>，特效只作用于聊天正文，不影响设置/按钮；主题请到「外观风格」卡切换。wechat 连发模式会自动隐藏小按钮(同时被上面的 toggle 接管)。'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // Pilot card for declareCard (2026-11-27): the three-line boilerplate — pick / claim /
  // getElementById guard — moved into the registry, which also stamps data-card="authCard" and
  // fences a build() failure into a visible placeholder instead of a silent vanish. authCard is
  // the cleanest migration sample: its guard id sits on the card element itself, and the two
  // buttons are bound in 60-sync.js by ID lookup, so the mount entry stays decoupled from wiring.
  function mountAuthCard() {
    window.slotRegistry.declareCard({
      id: 'authCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var card = document.createElement('div');
        card.className = 'card';
        card.id = 'authCard';
        card.innerHTML = `<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>访问码</h4><p>云同步需要访问码。登录后请求自动带访问码；退出后以访客身份使用你自己的模型渠道与 API Key。</p><div class="rowline"><div class="btns"><button class="smallbtn" id="authLoginBtn" type="button">输入访问码</button><button class="smallbtn danger" id="authLogoutBtn" title="清除本地保存的访问码">退出登录</button></div></div><div id="authStatus"></div>`;
        slot.appendChild(card);
        return card;
      }
    });
  }

  function mountSyncCard() {
    // 2026-11-28 card-shell batch 2 (B-group): card-level id syncCard is new (the card element had
    // no id; the mount guard sat on the syncEnableToggle). The toggle and every button/status id
    // are unchanged — 60-sync.js wires them by ID. No trailing tip on this card: the hint line and
    // the exclude details block ride in extra verbatim. Double-id shape, topbarCostCard precedent.
    window.slotRegistry.declareCard({
      id: 'syncCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'syncCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 18.5a4.5 4.5 0 0 1-.7-8.95A5.5 5.5 0 0 1 17 9.1 3.7 3.7 0 0 1 16.8 18.5z"/></svg>云同步',
          desc: '同步到 Cloudflare KV，换浏览器或设备都能自动看到角色卡、指令模块、亲密度、费用与对话。<b>打开即全同步</b>：改动 30 秒内自动上传，其他设备自动跟进；「强制刷新」只在怀疑不一致时用。<b>不同步：</b>访问码与同步状态。渠道（聊天/图像）与 API Key 也随账号同步，换设备不用重填。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="syncEnableToggle"><label for="syncEnableToggle">启用云同步（聊天、角色卡、设置全部跟随）</label></div></div><div class="btns"><button class="smallbtn" id="syncNowBtn" title="立即把本机改动推上云（平时 30 秒内会自动推）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v3.5h-3.5"/></svg>立即上传</button><button class="smallbtn" id="syncPullBtn" title="诊断用：重新对齐本机与云端（平时不需要点，改动会自动同步）">强制刷新</button><button class="smallbtn" id="syncExportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V5"/><path d="M8 8.5L12 4.5l4 4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导出备份</button><button class="smallbtn" id="syncImportBtn" data-dev-only><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5V15"/><path d="M8 11l4 4 4-4"/><path d="M5 14.5v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-3.5"/></svg>导入备份</button><input type="file" id="syncImportFile" accept=".json" style="display:none"><button class="smallbtn danger" id="syncWipeBtn" title="用本机数据覆盖云端：先清空云端副本，再把本机数据完整上传。其他设备重新打开后自动跟上；本机数据不受影响。"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15"/><path d="M9 6.5V5.2A1.7 1.7 0 0 1 10.7 3.5h2.6A1.7 1.7 0 0 1 15 5.2V6.5"/><path d="M6.8 6.5l.7 12.2a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.7-12.2"/></svg>覆盖云端</button></div></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">角色卡已随统一存储同步（D1 即同步）——「立即上传 / 强制刷新」只搬运设置与对话，不再推送/拉取角色卡。</div><div id="syncStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div><div id="syncRealtimeStatus" style="font-size:11px;color:var(--muted);margin-top:4px;"></div><div id="syncQuotaWarn" style="font-size:11px;color:#f80;margin-top:4px;display:none;"></div><details id="cloudExcludeSection" style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 16.5a4.2 4.2 0 0 1-.6-8.35A5.2 5.2 0 0 1 16.5 8"/><path d="M14.5 14l5 5M19.5 14l-5 5"/></svg>按角色/会话 只清云端（保留本地）</summary><div style="font-size:11px;color:var(--muted);margin:6px 0;line-height:1.5;">只把选中项从云端 KV 抹掉,本地保留且本设备不再上传(tombstone)。<b>会话</b>的云端副本随云同步自动维护。<b>跨设备注意:</b>排除清单仅本设备生效,其他仍持有该数据且未排除的设备改动后可能把它推回。</div><div id="cloudExcludeList" style="display:flex;flex-direction:column;gap:6px;"></div></details>'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // ─── 部署卡（T4-C）：宿主级操作，排在云同步/费用之后 ───
  // 卡体、部署包执行与首连三选一在 services/ui/settings-deploy.ts + tooling/l0/wiring/settings-deploy.js；
  // 这里只提供 mountXxx 入口，让它进 MOUNTS 与挂载顺序表。
  function mountDeployCard() {
    if (!window.settingsDeploy || typeof window.settingsDeploy.mountCard !== "function") return;
    window.settingsDeploy.mountCard();
  }

  // ─── 对话数据卡(#clearHistory) ───
  // 2026-11-27（所有者）：旧「保留本机历史」开关已退役 —— 关掉后对话不落盘、刷新即失忆，
  // 与现在的会话存储/云同步语义冲突，且没有正常使用场景。历史恒为开；这张卡只保留
  // 「清空全部会话」这一个危险操作入口，并说清记录是自动保存、跟随云同步的。
  // 旧的 #promptKeep「追加自定义提示词」同样是死开关：它只 gate 早已没有保存按钮的 #customPrompt，
  // 2026-11-27 连同接线一并删除。
  function mountLocalHistoryCard() {
    // 2026-11-28: card-shell batch 2 (B-group) merged with origin/main's "对话数据" rework.
    // The two dead toggles are gone for good (owner, 2026-11-27): 保留本机历史 关掉=刷新失忆,
    // 与现在的会话存储/云同步语义冲突; 追加自定义提示词 只 gate 一个早已没有保存按钮的输入框。
    // History is always on, the prompt is always sent — this card now only owns the destructive
    // "clear everything" entry, and says plainly that records are saved and synced automatically.
    // declareCard moves the mount probe onto the card element; the clear button keeps its id
    // (app.js wires #clearHistory by ID). Origin's tip sits above the warning, so both ride in
    // extra verbatim to keep that order — the shell's tip field would emit after extra.
    window.slotRegistry.declareCard({
      id: 'localHistoryCard',
      slotId: 'setAccountSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'localHistoryCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/></svg>对话数据',
          desc: '对话会自动保存在本机，并随「云同步」同步；刷新或重开会自动恢复。',
          extra: '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>想清掉个别会话，到左栏「对话」里删；这里只保留清空全部会话的入口。</span></div>'
            + '<div class="settings-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><span>清空全部会话会删除本设备所有会话的对话记录与剧情摘要，并同步删除云端备份，不可撤销。</span></div>'
            + '<div class="rowline" style="margin-top:8px;justify-content:flex-end;"><div class="btns"><button class="smallbtn danger" id="clearHistory">清空全部会话</button></div></div>'
        });
        slot.appendChild(shell.card);
        return shell.card;
      }
    });
  }

  // ─── 数据备份卡（T3-E）：全量 ZIP 导出 / 导入 ───
  // 卡体与两个平台出口在 tooling/l0/wiring/backup.js（window.backupCard / window.backupSvc）；
  // 这里只提供 mountXxx 入口，让它进 MOUNTS 与挂载顺序表（与 T4-C 的部署卡同一种接法）。
  function mountDataBackupCard() {
    if (!window.backupCard || typeof window.backupCard.mount !== 'function') return;
    window.backupCard.mount();
  }

  // ─── 2026-11-11: Agent 个性化（对齐 ZCode 设置 → 个性化）───
  // 独立于「网页自定义人物模板」：只作用于 Agent 模式的后续会话，不受顶栏「内置/自定义」和角色卡影响。
  // 字节预算/trim 空删除 + 读侧判定已下沉 services/ui/settings-personalize.ts（window.settingsPersonalize），
  // 与 engine/app.js 的请求注入共用同一套语义；本卡只留 textarea、计数标签与事件。
  function mountPersonalizeCard() {
    // 2026-11-28 card-shell batch 2 (B-group): the card element already carried id
    // agentPersonalizeCard; the mount guard sat on the inner agentPersonalize textarea. The probe
    // moves onto the card and the textarea keeps its id (the settings host reads card
    // .__agentPersonalizeReset and app-side code wires the textarea by ID). Double-id shape.
    window.slotRegistry.declareCard({
      id: 'agentPersonalizeCard',
      slotId: 'setPersonalizeSlot',
      build: function (slot) {
        var shell = window.cardShell.createCardShell({
          id: 'agentPersonalizeCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/><path d="M18.6 5.1l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>个性化',
          desc: '添加自定义指令来个性化 Agent 的回复，指令会应用到你本机 Agent 的后续会话；远程设备需单独配置。仅本设备。',
          extra: '<textarea id="agentPersonalize" rows="10" spellcheck="false" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.65;resize:vertical;min-height:220px;"></textarea>'
            + '<div class="rowline" style="justify-content:space-between;align-items:center;margin-top:6px;gap:12px;"><span id="agentPersonalizeCount" style="font-size:11px;color:var(--muted);white-space:nowrap;">0 B / 100 KB</span><div class="btns"><button class="smallbtn" id="agentPersonalizeSave" type="button">保存</button><button class="smallbtn" id="agentPersonalizeCancel" type="button">取消</button></div></div>',
          tip: '保存后从下一条消息开始生效；清空并保存 = 关闭。指令只存本机，不上云。'
        });
        var card = shell.card;
        slot.appendChild(card);
        var ta = card.querySelector('#agentPersonalize');
        var countEl = card.querySelector('#agentPersonalizeCount');
        var saveBtn = card.querySelector('#agentPersonalizeSave');
        var cancelBtn = card.querySelector('#agentPersonalizeCancel');
        var _pers = window.settingsPersonalize;
        var saved = "";
        function renderCount() {
          var n = _pers.byteLen(ta.value);
          var over = _pers.isOverLimit(ta.value);
          if (countEl) {
            countEl.textContent = _pers.fmtBytes(n) + ' / 100 KB';
            countEl.style.color = over ? 'var(--danger, #e8607d)' : 'var(--muted)';
          }
          if (saveBtn) saveBtn.disabled = over;
        }
        // 每次打开设置都回读已保存值，同时把「取消」的基准线同步成 LS —— 否则上次的未保存文本会被当成基准。
        function resetFromLS() {
          saved = _pers.readRaw();
          ta.value = saved;
          renderCount();
        }
        card.__agentPersonalizeReset = resetFromLS;
        ta.addEventListener('input', renderCount);
        if (saveBtn) saveBtn.addEventListener('click', function () {
          var v = ta.value;
          var result = _pers.save(v);
          if (!result.stored) return;
          saved = v;
          try { if (window.feedbackSvc && window.feedbackSvc.toast) window.feedbackSvc.toast(result.trimmed ? '个性化指令已保存' : '个性化指令已清空', 1800); } catch (e) {}
        });
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
          ta.value = saved;
          renderCount();
        });
        resetFromLS();
        return card;
      }
    });
  }

  // ─── 自驱叙事控制卡(autopilot.js 的入口 UI · 决策 O 默认半自动) ───
  // 写 cfw_autopilot_* + cfw_address_mode_v1 + cfw_choices_freq_v1;开始/停止直接调 window.autopilotSvc。仅本设备。挂 #setChatSlot。
  function mountAutopilotCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; the guard id already sat on the card
    // element, so the declaration is direct. The six-key wiring below is unchanged hand-written
    // code (mode migration + start/stop are not single-control bind shapes).
    window.slotRegistry.declareCard({
      id: 'autopilotCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        // 2026-11-25 C3：六个键与全部 default/clamp 归 services/agent/autopilot.ts
        //（window.autopilotCfg），卡片不再抄一份 key 表与夹取规则。
        var apCfg = window.autopilotCfg;
        var K = apCfg.LS;
        function g(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
        function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
        // 字段材质归 .field-input 共享类（styles-controls.css）；SS/LB 内联串与类值逐字节相同，仅
        // flex:1 / min-width 留作变体类，渲染逐位不变。
        var shell = window.cardShell.createCardShell({
          id: 'autopilotCard',
          title: '自驱叙事',
          desc: '让 AI 自己一段段往下写,不用每次催。<b>半自动</b>每段停下给「继续 / 选项 / 自己写」,<b>全自动</b>按节拍连演。「一句话把活干完」的工作模式不在这,走 Agent。随时 <b>Shift+Esc</b> 全停。<b>仅本设备</b>。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">模式</label><select id="apMode" class="field-input field-input--grow"><option value="">关</option><option value="novel">小说叙事</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">推进</label><select id="apAuto" class="field-input field-input--grow"><option value="half">半自动（每段停一下）</option><option value="full">全自动（连续演）</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">视角</label><select id="apAddress" class="field-input field-input--grow"><option value="dialogue">对话（只对你说话）</option><option value="immersive">沉浸（带动作旁白）</option><option value="narration">小说（第三人称）</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">选项</label><select id="apChoices" class="field-input field-input--grow"><option value="off">不给选项</option><option value="fork">岔路口才给(默认)</option><option value="every">每段都给</option></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w56">最多段</label><input type="number" id="apMaxSeg" min="1" max="1000" class="field-input field-input--num" style="width:90px;"></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="apGateTts"><label for="apGateTts">读完一段再演下一段(仅桌面 TTS)</label></div></div>'
            + '<div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="apStart" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>开始自驱</button><button class="smallbtn danger" id="apStop" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/></svg>停止</button></div></div>'
            + '<div id="apStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>',
          tip: '半自动暂停时直接在输入框打字发送会自动接管。需 index.html 已引入 autopilot.js。'
        });
        var card = shell.card;
        slot.appendChild(card);
        function q(id) { return card.querySelector(id); }
        var mode = q('#apMode'), auto = q('#apAuto'), address = q('#apAddress'), choices = q('#apChoices'), maxSeg = q('#apMaxSeg'), gateTts = q('#apGateTts'), statusEl = q('#apStatus');
        // 2026-09-10: 老 LS 里存的 'rp' 下拉里已没这个 option,不归一的话 select 会变成空值(看着像「设置丢了」)
        var _mr = g(K.mode, '');
        if (apCfg.needsModeMigration(_mr)) set(K.mode, apCfg.modeOf(_mr));
        mode.value = apCfg.modeOf(_mr);
        auto.value = apCfg.autoOf(g(K.auto, null));
        address.value = apCfg.addressOf(g(K.address, null));
        choices.value = apCfg.choicesOf(g(K.choices, null));
        maxSeg.value = String(apCfg.maxSegments(g(K.maxSeg, null)));
        gateTts.checked = apCfg.gateTts(g(K.gateTts, null));
        mode.addEventListener('change', function () { set(K.mode, mode.value); });
        auto.addEventListener('change', function () { set(K.auto, auto.value); });
        address.addEventListener('change', function () { set(K.address, address.value); });
        choices.addEventListener('change', function () { set(K.choices, choices.value); });
        maxSeg.addEventListener('change', function () { var n = apCfg.maxSegments(maxSeg.value); maxSeg.value = String(n); set(K.maxSeg, String(n)); });
        gateTts.addEventListener('change', function () { set(K.gateTts, gateTts.checked ? '1' : '0'); });
        function setMsg(t) { if (statusEl) statusEl.textContent = t || ''; }
        q('#apStart').addEventListener('click', function () {
          if (!window.autopilotSvc) { setMsg('自驱引擎未加载(检查 index.html 是否引了 autopilot.js)'); return; }
          var r = window.autopilotSvc.start({ mode: mode.value });
          if (r && r.ok) setMsg('已开始：小说叙事 / ' + (auto.value === 'full' ? '全自动' : '半自动'));
          else setMsg('没开起来:' + ((r && r.reason) || '未知'));
        });
        q('#apStop').addEventListener('click', function () { if (window.autopilotSvc) window.autopilotSvc.stop('user-stop'); setMsg('已停止'); });
        try { if (window.autopilotSvc && window.autopilotSvc.onTick) window.autopilotSvc.onTick(function (st) { setMsg('状态:' + st.state + '，第 ' + st.seg + ' 段'); }); } catch (e) {}
        return card;
      }
    });
  }

  // ─── 2026-11-26 i18n v2：记忆/压缩卡的文案全部走 catalog（public/locales/<lang>.json）。
  // 卡片在 DOMContentLoaded 挂载，此时 catalog 通常已就位；copyReady 只是把「极端慢盘」这一种
  // 情况变成延后挂载，而不是把 key 画到页面上。key 的语义见 docs/i18n/rules.md。
  function copyReady(fn) {
    try {
      if (window.__i18n && typeof window.__i18n.whenReady === "function") { window.__i18n.whenReady(fn); return; }
    } catch (e) { /* 引擎缺席时照旧直画（legacy 字典兜底） */ }
    fn();
  }
  function T(key, params) {
    try { return window.__i18n.t(key, params); } catch (e) { return key; }
  }

  // ─── 2026-11-25：上下文压缩参数（触发条数 / 保留条数 / token 水位比例）───
  // 键、默认值、夹取范围都在 services/chat/context.ts 的 COMPACT_* 表；这里只画卡与写回。
  // 卡片取一个只用于配置的 context 实例（compactConfig 不读会话/DOM）。
  function mountContextCard() {
    copyReady(mountContextCardNow);
  }

  function mountContextCardNow() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The __context guard stays ahead of the
    // declaration: the old code warned and skipped silently when the engine was absent, and a
    // build() inside declareCard would instead fence an error card.
    if (!window.__context) { console.warn('[settings] 缺少 __context，上下文压缩卡未挂载'); return; }
    window.slotRegistry.declareCard({
      id: 'contextCompactCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var ctxApi = window.__context.create({});
        var cfg = ctxApi.compactConfig();
        var shell = window.cardShell.createCardShell({
          id: 'contextCompactCard',
          title: T('settings.compact.title'),
          desc: T('settings.compact.intro'),
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="ctxCompactEnabled"><label for="ctxCompactEnabled">' + T('settings.compact.enabled') + '</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.trigger') + '</label><input type="number" id="ctxTrigger" min="10" max="200" step="1" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.triggerHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.keep') + '</label><input type="number" id="ctxKeep" min="2" max="50" step="1" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.keepHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.compact.ratio') + '</label><input type="number" id="ctxRatio" min="0.3" max="0.95" step="0.05" class="field-input field-input--num field-input--w96"><span style="font-size:11px;color:var(--muted);">' + T('settings.compact.ratioHint') + '</span></div>',
          tip: T('settings.compact.tip')
        });
        var card = shell.card;
        slot.appendChild(card);
        var enabled = card.querySelector('#ctxCompactEnabled');
        var trigger = card.querySelector('#ctxTrigger');
        var keep = card.querySelector('#ctxKeep');
        var ratio = card.querySelector('#ctxRatio');
        function paint(c) {
          enabled.checked = c.enabled;
          trigger.value = String(c.trigger);
          keep.value = String(c.keep);
          ratio.value = String(c.ratio);
        }
        paint(cfg);
        enabled.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ enabled: enabled.checked })); });
        trigger.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ trigger: trigger.value })); });
        keep.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ keep: keep.value })); });
        ratio.addEventListener('change', function () { paint(ctxApi.setCompactConfig({ ratio: ratio.value })); });
        return card;
      }
    });
  }

  // ─── 2026-11-25：角色记忆参数（总开关 / 向量腿 / 召回与注入上限 / 自动写入）───
  // 默认值与夹取在 services/memory/config.ts；卡片通过 __memCore.config 读写，读侧同一张表。
  function mountMemoryCard() {
    copyReady(mountMemoryCardNow);
  }

  function mountMemoryCardNow() {
    // 2026-11-28 card-shell batch 2: shell + declareCard; the __memCore guard stays ahead of the
    // declaration (old code warned and skipped silently — see mountContextCardNow).
    var mem = window.__memCore;
    if (!mem || !mem.config) { console.warn('[settings] 缺少 __memCore.config，角色记忆卡未挂载'); return; }
    window.slotRegistry.declareCard({
      id: 'memorySettingsCard',
      slotId: 'setChatSlot',
      build: function (slot) {
        var api = mem.config;
        var c = api.read();
        var lim = api.limits;
        var shell = window.cardShell.createCardShell({
          id: 'memorySettingsCard',
          title: T('settings.memory.title'),
          desc: T('settings.memory.intro'),
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="memEnabledToggle"><label for="memEnabledToggle">' + T('settings.memory.enabled') + '</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="memVecToggle"><label for="memVecToggle">' + T('settings.memory.vecEnabled') + '</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.recallK') + '</label><input type="number" id="memRecallK" min="' + lim.recallK.min + '" max="' + lim.recallK.max + '" step="1" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.recallKHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.injectChunks') + '</label><input type="number" id="memInjectChunks" min="' + lim.injectMaxChunks.min + '" max="' + lim.injectMaxChunks.max + '" step="1" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.injectChunksHint') + '</span></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;"><label class="field-label field-label--w72">' + T('settings.memory.injectChars') + '</label><input type="number" id="memInjectChars" min="' + lim.injectMaxChars.min + '" max="' + lim.injectMaxChars.max + '" step="50" class="field-input field-input--num field-input--w88"><span style="font-size:11px;color:var(--muted);">' + T('settings.memory.injectCharsHint') + '</span></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="memAutoWrite"><label for="memAutoWrite">' + T('settings.memory.autoWrite') + '</label></div></div>',
          tip: T('settings.memory.tip')
        });
        var card = shell.card;
        slot.appendChild(card);
        var enabled = card.querySelector('#memEnabledToggle');
        var vec = card.querySelector('#memVecToggle');
        var recallK = card.querySelector('#memRecallK');
        var chunks = card.querySelector('#memInjectChunks');
        var chars = card.querySelector('#memInjectChars');
        var auto = card.querySelector('#memAutoWrite');
        function paint(next) {
          enabled.checked = next.enabled;
          vec.checked = next.vecEnabled;
          recallK.value = String(next.recallK);
          chunks.value = String(next.injectMaxChunks);
          chars.value = String(next.injectMaxChars);
          auto.checked = next.autoWrite;
        }
        paint(c);
        enabled.addEventListener('change', function () { paint(api.write({ enabled: enabled.checked })); });
        vec.addEventListener('change', function () { paint(api.write({ vecEnabled: vec.checked })); });
        recallK.addEventListener('change', function () { paint(api.write({ recallK: recallK.value })); });
        chunks.addEventListener('change', function () { paint(api.write({ injectMaxChunks: chunks.value })); });
        chars.addEventListener('change', function () { paint(api.write({ injectMaxChars: chars.value })); });
        auto.addEventListener('change', function () { paint(api.write({ autoWrite: auto.checked })); });
        return card;
      }
    });
  }
