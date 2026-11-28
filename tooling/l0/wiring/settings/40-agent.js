// 40-agent.js — Agent 与开发：多智能体 / 开发工具 / 工具集档位 / 生成参数读取。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 多智能体编排（2026-10-08 从「Agent 工作模式」卡拆出）───
  // 用户口径：编排玩法与工作能力是两件事，各占一张卡。工具是否注册由 tools.js 的 MA_GATED
  // 三重条件共同决定：① 侧栏「多智能体」模式开着 ② 本卡对应开关开着 ③ 当前不是子 agent 档。
  function mountMultiAgentCard() {
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tip skeleton into cardShell.createCardShell. The bindEl calls below are byte-for-byte
    // the ones batch 2 landed — only the shell around them changed.
    window.slotRegistry.declareCard({
      id: 'multiAgentCard',
      slotId: 'setAgentSlot',
      build: function (slot) {
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'multiAgentCard',
          title: '多智能体编排',
          // 本段刻意写成"整句单文本节点"（不带 <b> 内联标签）：双语引擎按文本节点整串匹配，
          // 带标签的句子会被切成碎片、字典键难对（这是上一批翻译踩过的坑）。
          desc: '先在侧栏打开「多智能体」模式，再按下面开关逐个放行；模式关闭时 = 单 agent，不挂任何编排工具。平级 agent = 你配置好的角色卡（各有独立上下文）；子 agent = 主 agent 现造的临时工（最小权限、任务完成即回收，不进聊天记录）。',
          extra: '<div class="rowline"><div class="toggle"><input type="checkbox" id="maDelegate"><label for="maDelegate">主子分派（允许派子 agent 干活）</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maMeeting"><label for="maMeeting">私下小会（向角色私下征询，结论不进时间线）</label></div></div>'
            + '<div class="rowline"><div class="toggle"><input type="checkbox" id="maInvite"><label for="maInvite">请角色上台（角色可直接在时间线回答）</label></div></div>'
            + '<div class="rowline" style="align-items:center;gap:8px;flex-wrap:wrap;"><label style="font-size:12px;color:var(--muted);min-width:52px;">小会</label>'
            + '<input id="maMeetMax" type="number" min="1" max="6" step="1" style="' + SS + 'max-width:76px;" title="每次小会最多几位角色（每位都是一次独立计费调用）"> <span style="font-size:11px;color:var(--muted);">人数上限</span>'
            + '<input id="maMeetRounds" type="number" min="1" max="2" step="1" style="' + SS + 'max-width:76px;" title="2 = 第二轮参与者能看到彼此答案、互相补充或反驳（成本约翻倍）"> <span style="font-size:11px;color:var(--muted);">轮数</span>'
            + '<input id="maCtxMsgs" type="number" min="0" max="400" step="10" style="' + SS + 'max-width:88px;" title="每位角色带多少条自己的上下文（0 = 全带；条数越多越贵）"> <span style="font-size:11px;color:var(--muted);">上下文条数</span></div>',
          tip: '成本提示：小会里每位角色都是一次独立计费调用，轮数 2 约等于翻倍；子 agent 继承最小权限，不碰你的数据与时间线。'
        });
        var card = shell.card;
        slot.appendChild(card);

        // 2026-11-25 服务层搬迁：六键的默认值与 clamp 内聚在 services/ui/settings-multi-agent.ts
        //（window.settingsMultiAgent），读侧 peer-calls.cfg() 用同一套口径——修掉「卡片默认 3、引擎默认 6」
        // 的漂移。localStorage 原样保留作服务缺席时的回落（旧缓存页行为不丢）。
        // 2026-11-27 绑定微原语：六控件的手写五步（查元素/回显/监听/写/回落）收敛为 bindToggle/bindNumber
        // 调用（window.bindEl）。键名、默认值、clamp 区间与「键没值=开/默认」口径原样保留；服务/LS 双路径
        // 由 opts 的两条函数对表达——ma 在场传 read/write，缺席传 null 走 fallback（bind 原语负责选路）。
        var ma = window.settingsMultiAgent;
        // 开关与上限（tools.js 的 MA_GATED / app.js 的 _maCfg 读这些键；键"没值"= 开/默认，
        // 这样老用户不用先来这里点一遍）
        function swBind(sel, key) {
          return window.bindEl.bindToggle(card, sel, {
            key: key,
            read: ma ? function () { return ma.readSwitch(key); } : null,
            write: ma ? function (on) { ma.writeSwitch(key, on); } : null,
            fallbackGet: function () { try { var v = localStorage.getItem(key); return v == null ? true : v === '1'; } catch (e) { return true; } },
            fallbackSet: function (on) { try { localStorage.setItem(key, on ? '1' : '0'); } catch (e) {} },
          });
        }
        swBind('#maDelegate', 'cfw_ma_delegate_v1');
        swBind('#maMeeting', 'cfw_ma_meeting_v1');
        swBind('#maInvite', 'cfw_ma_invite_v1');
        function capBind(sel, key, def, lo, hi) {
          return window.bindEl.bindNumber(card, sel, {
            key: key, min: lo, max: hi, default: def, parse: null,
            read: ma ? function () { return ma.readCap(key, def, lo, hi); } : null,
            write: ma ? function (raw) { return ma.writeCap(key, raw, def, lo, hi); } : null,
            fallbackGet: function () { try { return localStorage.getItem(key); } catch (e) { return null; } },
            fallbackSet: function (text) { try { localStorage.setItem(key, text); } catch (e) {} },
          });
        }
        capBind('#maMeetMax', 'cfw_ma_meeting_max_v1', 3, 1, 6);
        capBind('#maMeetRounds', 'cfw_ma_meeting_rounds_v1', 1, 1, 2);
        capBind('#maCtxMsgs', 'cfw_ma_ctx_msgs_v1', 60, 0, 400);
        return card;
      }
    });
  }

  // ─── 2026-11-06：开发工具卡（源码/产物检索；本地 source-server） ───
  function mountDevToolsCard() {
    // 2026-11-28 card-shell batch 3: shell + declareCard. The old mount never claimed its card id
    // (plain pick + guard); declareCard records the claim on a successful mount — a ledger-only
    // difference, the DOM path is unchanged. The card has no settings-tip: its tail (rows + test
    // button + status line) rides in `extra` verbatim.
    window.slotRegistry.declareCard({
      id: 'sourceToolsCard',
      slotId: 'setCostSlot',
      build: function (slot) {
        // 2026-11-08 修(审查 P0/P1): ① id 改名 sourceToolsCard —— 旧 id 与 dev.js 的开发者工具卡
        // 冲突(同名 id 静默互吞,本卡永不出现); ② 补本地 SS(旧版引用未定义变量,潜伏 ReferenceError)
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'sourceToolsCard',
          title: '开发工具 · 源码/产物检索',
          desc: '给 agent 的 <code>list_source / search_source / read_source / list_artifacts / read_artifact</code> 提供本地只读服务。先在本机运行：<code>node tooling/scripts/dev/source-server.mjs --root .</code>（可选 <code>--artifacts 目录</code>）。服务只绑 127.0.0.1，不上传数据。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:72px;">源码服务</label><input id="devSrcUrl" type="text" placeholder="http://127.0.0.1:8797" style="' + SS + '"></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;color:var(--muted);min-width:72px;">产物 URL</label><input id="devArtUrl" type="text" placeholder="http://127.0.0.1:8796/artifacts" style="' + SS + '"></div>'
            + '<div class="rowline" style="margin-top:8px;"><div class="toggle"><input type="checkbox" id="devToolsOn"><label for="devToolsOn">启用（下次开 Agent 生效）</label></div></div>'
            + '<div class="btns" style="margin-top:6px;"><button class="smallbtn" id="devToolsTest">测试连接</button></div>'
            + '<div id="devToolsStatus" style="font-size:11px;color:var(--muted);margin-top:6px;"></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var u = card.querySelector('#devSrcUrl'), a = card.querySelector('#devArtUrl'), on = card.querySelector('#devToolsOn'), st = card.querySelector('#devToolsStatus');
        // 2026-11-25 服务层搬迁：三键读写与归一化内聚在 services/ui/settings-dev-tools.ts
        //（window.settingsDevTools），读侧 source-tools.ts 用同一套 normalizeSourceToolsOn。
        var dst = window.settingsDevTools;
        function read() {
          // 服务返回 sourceToolsOn 布尔（已按 hostname 归一）；回落路径保留原始三态字符串 '1'/'0'/''。
          if (dst) { var s = dst.read(); return { u: s.sourceUrl, a: s.artifactUrl, on: s.sourceToolsState === '' ? '' : (s.sourceToolsOn ? '1' : '0') }; }
          try { return { u: localStorage.getItem('cfw_source_url_v1') || '', a: localStorage.getItem('cfw_artifact_url_v1') || '', on: localStorage.getItem('cfw_source_tools_on_v1') || '' }; } catch (e) { return { u: '', a: '', on: '' }; }
        }
        function paint() {
          var c = read(); u.value = c.u; a.value = c.a; on.checked = c.on === '1';
          st.textContent = c.on === '1' ? '已启用（服务未启动时工具会报不可达）。' : (c.on === '0' ? '已关闭。' : '未设置：localhost 默认开、线上默认关。');
        }
        function save() {
          if (dst) dst.write({ sourceUrl: u.value, artifactUrl: a.value, sourceToolsOn: on.checked });
          else try {
            localStorage.setItem('cfw_source_url_v1', u.value.trim());
            localStorage.setItem('cfw_artifact_url_v1', a.value.trim());
            localStorage.setItem('cfw_source_tools_on_v1', on.checked ? '1' : '0');
          } catch (e) {}
          paint();
        }
        u.addEventListener('change', save); a.addEventListener('change', save); on.addEventListener('change', save);
        card.querySelector('#devToolsTest').addEventListener('click', async function () {
          var url = (u.value.trim() || 'http://127.0.0.1:8797').replace(/\/+$/, '');
          st.textContent = '测试中…';
          try {
            var r = await fetch(url + '/health', { cache: 'no-store' });
            var j = await r.json();
            st.textContent = j && j.ok ? ('连接成功：roots=' + (j.roots || []).join(', ')) : '返回异常';
          } catch (e) { st.textContent = '连不上：' + String((e && e.message) || e); }
        });
        paint();
        return card;
      }
    });
  }

  // ─── Agent 工具集档位(对应 shared/agent/tools.js 里的 CORE_TOOLS 门控 · LS cfw_agent_tools_v1) ───
  // 两档: core(常用) / full(全量,自检时才开)。档位数在卡内动态点数（作者会持续加工具）。
  function mountAgentToolsCard() {
    // 2026-09-14:Agent 配置独立成分类(工具档位 / 轮数 / 工作模式);旧页面回落 #setChatSlot
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tip skeleton into cardShell.createCardShell; the wiring body below is untouched.
    window.slotRegistry.declareCard({
      id: 'agentToolsCard',
      slotId: 'setAgentSlot',
      build: function (slot) {
        // 工具档位/工作模式/轮数的读写规则已下沉 services/ui/settings-agent-tools.ts
        //（window.settingsAgentTools），与 services/agent/registry.ts 读侧共用同一口径。
        var _at = window.settingsAgentTools;
        var SS = 'flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;';
        var shell = window.cardShell.createCardShell({
          id: 'agentToolsCard',
          title: 'Agent 工作模式',
          desc: '决定 Agent 执行动作时的放行尺度。<b>仅本设备</b>。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">模式</label><select id="agentWorkMode" style="' + SS + '">'
            + '<option value="confirm">变更前确认：有副作用的操作先问我</option>'
            + '<option value="auto">自动编辑：文件类操作直接做，其余仍问</option>'
            + '<option value="plan">计划模式：先出计划，不动手</option>'
            + '<option value="full">完全访问：不再确认</option>'
            + '</select></div>'
            + '<div id="agentWorkDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工具</label>'
            + '<select id="agentToolsSel" style="' + SS + '"></select></div>'
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">轮数</label>'
            + '<input id="agentMaxRounds" type="number" min="0" max="1000" step="1" style="' + SS + '" placeholder="不限" title="一次回复里模型最多可以「思考→调工具」多少个来回；留空/0 = 不限（实务上限 1000）">'
            + '</div>'
            + '<div id="agentRoundsDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;">留空 = 不限；填 1~1000 可自设一次回复的最大工具轮数。改完下一次开 Agent 生效。</div>'
            // 4.70 本地能力:工作目录。**并进这张卡**而不是另开一张 ——
            // index.html 的注释写明 Agent 分类由本卡注入主要配置；多智能体编排 2026-10-08 起已拆走
            // （mountMultiAgentCard），因为"工作能力"与"编排玩法"是两件事，混在一张卡里互相干扰阅读。
            + '<div class="rowline" style="align-items:center;gap:10px;margin-top:12px;"><label style="font-size:12px;color:var(--muted);min-width:42px;">工作目录</label>'
            + '<input id="agentWorkdirPath" type="text" readonly style="' + SS + 'cursor:default;" placeholder="尚未设置">'
            + '<button id="agentWorkdirPick" style="padding:7px 12px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap;">选择…</button></div>'
            + '<div id="agentLocalStatus" style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6;"></div>'
            + '<div id="agentToolsDesc" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;"></div>',
          tip: '文件工具(list/search/read/write/edit/delete/export)与联网工具(搜索 / 抓网页)由各自模块单独注册,<b>两档都有</b>,不受这里影响：先 search_file 定位、read_file 按行分页读(大文件不怕截断)、长文 fetch_page 可续读 —— 由模型按需灵活组合。改完<b>下一次开 Agent 生效</b>(当前正在跑的不变)。<br>轮数决定一次回复能跑多少来回:读写多个文件、多轮检索这类任务要调大;<b>现在默认不限</b>(留空即可)——只有手填了具体数,才会在中途被"已达最大轮数"截断。'
        });
        var card = shell.card;
        slot.appendChild(card);
        var sel = card.querySelector('#agentToolsSel'), desc = card.querySelector('#agentToolsDesc');
        // 档位标签**不带工具条数**（origin/main 2026-11-27）：注册表随版本增减，界面上写死的数字只会过期。
        sel.innerHTML = '<option value="core">常用</option><option value="full">全量</option>';
        var TXT = {
          core: '给选项 / 载技能 / 角色卡增删改 / 发图 / 好感度 / 朗读，外加多智能体编排（分派 / 小会 / 请角色上台，见「多智能体编排」卡）。文件与联网工具两档都有。',
          full: '在常用基础上再加：设定集 / 指令模块 / 换主题 / 换模型 / 改设置 / 开编辑器 / 查费用 / 生成视频故事。其中视频故事一跑就是一两小时且不能关页 —— 只建议临时开。'
        };
        function render() { if (desc) desc.textContent = TXT[sel.value] || ''; }
        sel.value = _at.readTools(); render();
        sel.addEventListener('change', function () { _at.writeTools(sel.value); render(); });
        // 2026-09-14:工作模式(放行尺度)—— 与工具档位、轮数同属 Agent 分类
        var wmEl = card.querySelector('#agentWorkMode'), wdEl = card.querySelector('#agentWorkDesc');
        var WORK_TXT = {
          confirm: '有副作用的工具(写文件、改角色卡/设定集/指令模块、改设置、换主题换模型等)执行前会弹确认,由你放行或拒绝。最安全,但会打断节奏。',
          auto: '文件类工具(写文件等)直接执行不打断;改设置/换模型这类影响全局的仍然确认。适合"我只想让它干活、别问太多"。',
          plan: 'Agent 只做只读调查(抓网页/搜索/读文件),**不会真的动手改**;先给你一份计划,你确认后再切到别的模式执行。',
          full: '所有工具直接执行、完全不确认。快,但写错就是写错了 —— 只在你完全信任当前任务时用。'
        };
        function renderWork() { if (wdEl) wdEl.textContent = WORK_TXT[wmEl.value] || ''; }
        if (wmEl) {
          wmEl.value = _at.readMode(); renderWork();
          wmEl.addEventListener('change', function () { _at.writeMode(wmEl.value); renderWork(); });
        }

        // 2026-09-14:最大工具轮数(原来写死 8)—— 复杂任务会被中途截断,这里放开可调
        var roundsEl = card.querySelector('#agentMaxRounds');
        if (roundsEl) {
          var _curR = _at.readRounds();
          roundsEl.value = (_curR == null) ? '' : String(_curR);
          roundsEl.addEventListener('change', function () {
            // 留空/0/非法 = 不限 → 服务删键；有效值夹到 1000 后回写输入框
            var next = _at.writeRounds(roundsEl.value);
            roundsEl.value = (next == null) ? '' : String(next);
          });
        }

        // 多智能体编排的开关与上限 → 2026-10-08 已拆到独立卡（mountMultiAgentCard），见下方。
        // 这里保留一句提示：编排类工具是否注册由「多智能体模式 + 那张卡的开关」共同决定。

        // 4.70 本地能力:工作目录 + Node 运行时状态。同卡内的一块,不另开卡片。
        // 文案必须说清:命令类工具**不受工作目录限制**,工作目录只是 cwd ——
        // 否则用户会以为"选了目录 = 命令被关在里面"。
        var wdEl = card.querySelector('#agentWorkdirPath');
        var wdBtn = card.querySelector('#agentWorkdirPick');
        var wdSt = card.querySelector('#agentLocalStatus');
        var inv = window.tauriSvc ? window.tauriSvc.invokeOrNull() : null;
        if (!inv) {
          if (wdEl) wdEl.placeholder = '仅桌面端可用';
          if (wdBtn) { wdBtn.disabled = true; wdBtn.style.opacity = '0.5'; wdBtn.style.cursor = 'default'; }
          if (wdSt) wdSt.textContent = '网页版没有本地文件/命令能力,这部分在桌面 App 里生效。';
        } else {
          var refreshWd = function () {
            inv('local_env_info').then(function (i) {
              // 移动端(Tauri for Android/iOS)同样走 tauriSvc,所以不能只看它 ——
              // 用命令回传的真实平台判断,否则手机上会亮一个"能点但一点就报错"的按钮。
              var desktopOS = (i.platform === 'windows' || i.platform === 'macos' || i.platform === 'linux');
              if (!desktopOS) {
                if (wdEl) wdEl.placeholder = '移动端不支持';
                if (wdBtn) { wdBtn.disabled = true; wdBtn.style.opacity = '0.5'; wdBtn.style.cursor = 'default'; }
                if (wdSt) wdSt.textContent = '本地文件与命令能力仅桌面端提供;移动端 Agent 走虚拟工作区与联网工具。';
                return;
              }
              if (wdEl) wdEl.value = i.workdir || '';
              var parts = [];
              parts.push(i.workdir ? ('目录内 ' + (i.entries || 0) + ' 个条目。') : '未设置 —— 本地文件工具会拒绝所有操作。');
              if (i.node) {
                parts.push(i.node.ready
                  ? ('Node ' + (i.node.source === 'system' ? '系统安装 ' : '自带 ') + (i.node.version || '') + '。')
                  : 'Node 未找到(不影响已安装命令的执行)。');
              }
              parts.push('文件类工具限定在此目录内;命令类只以此为起始目录,不受限。');
              if (wdSt) wdSt.textContent = parts.join(' ');
            }).catch(function (e) {
              // 部署顺序会产生一个中间态:前端已 deploy、但用户的 exe 还是旧版。
              // 旧 exe 里没有这些命令,invoke 会报 "command not found" —— 那是版本问题,
              // 不是故障。照原样抛出去会让用户以为是 bug,所以识别一下给出可行动的提示。
              var msg = String((e && e.message) || e);
              var stale = /not found|not allowed|unknown command|command .* not/i.test(msg);
              if (wdSt) wdSt.textContent = stale
                ? '当前 App 版本还没有本地能力(需要 4.70+)。更新 App 后这里就能用。'
                : '读取状态失败: ' + msg;
            });
          };
          refreshWd();
          if (wdBtn) {
            wdBtn.addEventListener('click', function () {
              inv('agent_workdir_pick').then(function (dir) {
                if (!dir) return null;
                return inv('agent_workdir_set', { dir: dir });
              }).then(function () { refreshWd(); }).catch(function (e) {
                if (wdSt) wdSt.textContent = '设置失败: ' + ((e && e.message) || e);
              });
            });
          }
        }

        // 2026-11-19 B2 C-4：工具目录模式（full/directory）行 → services/ui/tool-mode-card.ts
        //（window.settingsToolMode）；directory 仅在 toolModeSvc 就位时可选，行内显示生效模式。
        try { if (window.settingsToolMode && typeof window.settingsToolMode.attach === 'function') window.settingsToolMode.attach(card); } catch (e) {}
        return card;
      }
    });
  }

  // ─── 4.83: 生成参数（temperature / max_tokens）───
  // 归「模型 API」分类。核心设计:**留空 = 不干预** —— 未填的字段根本不发给模型，
  // 由上游用自己的默认值。这样既不会因我们猜错默认值而让输出质量退化，
  // 也不会覆盖上游针对模型做的调校。
  // 落库 key 与 app.js 的 LS_GEN_PARAMS 一致；app.js 通过 genParamPayload() 展开进 /api/chat body
  // （worker 侧早就支持 temperature/top_p/max_tokens 透传，只是此前没有正式 UI 入口）。
  // 2026-11-17 服务层搬迁：读写/夹取/预设进 services/ui/settings-gen-params.ts（window.settingsGenParams）。
  // 存储键与 app.js 的 LS_GEN_PARAMS 相同——两侧必须同步，键本身只在该服务里定义。
  function readGenParams() { return window.settingsGenParams.read(); }
  function writeGenParams(o) { window.settingsGenParams.write(o || {}); }
  function mountGenParamsCard() {
    // 2026-11-28 card-shell batch 3: the pick/claim/getElementById boilerplate moved into
    // slotRegistry.declareCard (the guard id already sat on the card element) and the card/h4/p/
    // rows/tips skeleton into cardShell.createCardShell. This card carries TWO sibling
    // settings-tip blocks: the first rides in `extra` verbatim (nested tip, the same escape hatch
    // panelToolsCard uses), the trailing one goes through the shell's standard `tip` field — the
    // assembled bytes are identical either way.
    window.slotRegistry.declareCard({
      id: 'genParamsCard',
      slotId: 'setModelApiSlot',
      build: function (slot) {
        var inp = 'style="width:110px;padding:6px 8px;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:rgba(127,127,127,.08);color:inherit;font-size:13px;"';
        var row = 'style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"';
        var shell = window.cardShell.createCardShell({
          id: 'genParamsCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h8M16 7h4M4 12h2M10 12h10M4 17h6M14 17h6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="12" cy="17" r="2"/></svg>生成参数',
          desc: '微调模型的发挥风格。<b>留空 = 不干预</b>：该字段不会发给模型，由模型用自己的默认值 —— 不确定就别填。',
          extra: '<div class="rowline" ' + row + '><label for="genTemp" style="font-size:12.5px;min-width:152px;">温度（temperature）</label><input id="genTemp" type="number" min="0" max="2" step="0.1" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">越高越有创意，越低越稳</span></div>'
            + '<div class="rowline" ' + row + '><label for="genMax" style="font-size:12.5px;min-width:152px;">最长输出（max_tokens）</label><input id="genMax" type="number" min="1" step="256" placeholder="默认" ' + inp + '><span style="font-size:11px;color:var(--muted);">写长文 / 开思考时要留足</span></div>'
            + '<div class="rowline" ' + row + '><span style="font-size:12px;color:var(--muted);">快速预设：</span><button class="smallbtn" data-genpreset="rp" type="button">角色扮演</button><button class="smallbtn" data-genpreset="write" type="button">长文写作</button><button class="smallbtn" data-genpreset="code" type="button">编程 / 工具</button><button class="smallbtn danger" data-genpreset="reset" type="button">全部恢复默认</button></div>'
            + '<div class="settings-tip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/></svg><span>留空是推荐状态。开思考时 max_tokens 会被推理内容占用，设小了会出现正文被截断或空白 —— 写长文建议 8192。温度设 0 不等于更准，长对话会明显重复；若换模型后服务商报错，回来清空或调低。</span></div>',
          tip: '<b>默认基准（"恢复默认"回到的就是这些）：</b>温度 1.0（0~2）；max_tokens 不传时 非思考 8K / 思考 64K（DeepSeek 官方文档；免费档 NIM 为 vLLM 系，温度默认同为 1.0）。注意：<b>思考模式下温度参数无效</b>，思考中的风格由模型自己决定。'
        });
        var card = shell.card;
        slot.appendChild(card);

        var tEl = card.querySelector('#genTemp');
        var mEl = card.querySelector('#genMax');
        function sync() {
          var g = readGenParams();
          tEl.value = (typeof g.temperature === 'number') ? g.temperature : '';
          mEl.value = (typeof g.maxTokens === 'number') ? g.maxTokens : '';
        }
        function save(syncBack) {
          // 夹取与「空值 = 删键」的语义在服务里（mergeGenInputs）；这里只负责把输入框原样交出去。
          window.settingsGenParams.applyInputs(tEl.value, mEl.value);
          if (syncBack) sync();
        }
        // input:即时落库 —— 用户清空输入框就立刻回到"默认",不依赖失焦。
        //   (实测 number 输入框的 change 在清空/全选删除时不一定触发,靠它会让"恢复默认"时灵时不灵)
        //   此时**不回写输入框**,否则会打断正在输入的内容与光标位置。
        // change:失焦时补一次并回写规范化后的值,让越界输入(如温度填 5)被 clamp 后能看到真实生效值。
        tEl.addEventListener('input', function () { save(false); });
        mEl.addEventListener('input', function () { save(false); });
        tEl.addEventListener('change', function () { save(true); });
        mEl.addEventListener('change', function () { save(true); });
        // 预设值也在服务里（GEN_PRESETS）：角色扮演偏创意 / 长文写作留足输出 / 编程求稳。
        card.querySelectorAll('[data-genpreset]').forEach(function (b) {
          b.addEventListener('click', function () {
            var k = b.dataset.genpreset;
            if (k === 'reset') { window.settingsGenParams.reset(); sync(); return; }
            window.settingsGenParams.applyPreset(k); sync();
          });
        });
        sync();
        return card;
      }
    });
  }
