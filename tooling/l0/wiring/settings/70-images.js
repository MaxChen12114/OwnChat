// 70-images.js — 图像与语音卡：槽位 / 画风 / Key / 额度 / 立绘 / 缓存 / 画廊 / 本地与云端语音。
// 由 settings.js 宿主的 init()/mountStaticSettingsCards() 调用；函数声明在同一 IIFE 内提升。
  // ─── 10. 图像模块设置卡挂载 ───
  function getSlot() {
    return window.slotRegistry.pick('settingsImageSlot');
  }

  // 4.71: 语音 tab slot
  function getVoiceSlot() {
    return window.slotRegistry.pick('settingsVoiceSlot') || null;
  }

  function mountImageCards() {
    if (_imgCardsMounted) return;
    if (!getSlot()) return;
    mountImgStyleCard();
    mountImgKeyCard();
    mountImgQuotaCard();
    // 2026-11-06: 发图扩写器卡已移除 —— 画面描述直接用主模型的结构化信号，不再多调一次免费模型。
    // ── 角色立绘 ──
    (function(){
      var s=getSlot(); if(s&&!document.getElementById('imgSecTitle1')){
        var d=document.createElement('div'); d.id='imgSecTitle1';
        d.style.cssText='font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;padding:14px 0 4px;border-top:1px solid rgba(127,127,127,.12);margin-top:4px;';
        d.textContent='角色立绘'; s.appendChild(d);
      }
    })();
    mountImgPortraitCard();
    // ── 画廊·缓存 ──
    (function(){
      var s=getSlot(); if(s&&!document.getElementById('imgSecTitle2')){
        var d=document.createElement('div'); d.id='imgSecTitle2';
        d.style.cssText='font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;padding:14px 0 4px;border-top:1px solid rgba(127,127,127,.12);margin-top:4px;';
        d.textContent='画廊·缓存'; s.appendChild(d);
      }
    })();
    mountImgAlbumCard();
    mountImgCacheCard();
    _imgCardsMounted = true;
  }

  function mountVoiceCards() {
    if (_voiceCardsMounted) return;
    if (!getVoiceSlot()) return;
    mountCloudTtsCard(); // 云端语音：网页版/访客也能用，语音 tab 因它而对非壳内可见
    mountTtsCard();      // 本地 GPT-SoVITS：仅桌面壳
    _voiceCardsMounted = true;
  }

  // 2026-11-25 C4：画风表归 services/image/portrait.ts（portraitSvc.styles()），卡面不再抄一份；
  // 新增一档只改服务，两个下拉自动出现。
  function styleOpts(pt) {
    var rows = (pt && pt.styles) ? pt.styles() : [];
    return rows.map(function (p) { return '<option value="' + p.key + '">' + p.label + '</option>'; }).join('');
  }

  function mountImgStyleCard() {
    var pt=window.portraitSvc; if(!pt)return;
    window.slotRegistry.declareCard({
      id: 'imgStyleCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgStyleCard',
          title: '全局画风',
          desc: '统一控制<b>所有自动出图</b>的画风，工坊手动文生图不受影响，仅本设备。',
          extra: '<div class="rowline" style="align-items:center;gap:10px;margin-top:6px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgStyleSelect" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+styleOpts(pt)+'</select></div>'
        });
        var card=shell.card;
        if(slot.firstChild)slot.insertBefore(card,slot.firstChild); else slot.appendChild(card);
        // Bind primitive: the select's reflect/listen/write collapses into bindText (service path
        // only — portraitSvc is guaranteed past the guard above); the cross-card repaint keeps
        // riding the imagestyle:changed event as before.
        var bound=window.bindEl.bindText(card,'#imgStyleSelect',{
          key: 'imgStyleSelect',
          read: function(){return pt.getStyle();},
          write: function(raw){pt.setStyle(raw);return raw;},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var sel=bound?bound.el:null;
        if(sel){window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
        return card;
      }
    });
  }

  function mountImgKeyCard() {
    // 2026-06-24: 图像 API Key 归「模型 API」分类(setModelApiSlot),原在「发图」settingsImageSlot
    // 2026-11-06: 升级为「图像渠道」卡(渠道=数据, Gitee 只是内置预设)，由 image-channels-ui.js 挂载；
    // 旧版单 Key 卡仅在新 UI 未加载时兜底。
    if (document.documentElement.dataset.imageChannelsUi === "1") {
      try { document.dispatchEvent(new CustomEvent("cfw:mount-image-channels")); } catch (e) {}
      return;
    }
    var slot=window.slotRegistry.pick('setModelApiSlot')||getSlot(); if(!slot||document.getElementById('imgKeyCard'))return; if (slot) window.slotRegistry.claim({ cardId: 'imgKeyCard', slotId: 'setModelApiSlot' });
    var K='cfw_image_key_v1';
    var card=document.createElement('div'); card.className='card'; card.id='imgKeyCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>图像 API Key</h4><p>图像工坊（生图/改图）调用 <code>ai.gitee.com</code>，需要单独的 Gitee API Key，不进云同步。</p><div class="rowline"><input type="password" id="imgKeyInput" placeholder="Bearer Token" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn" id="imgKeySave">保存</button><button class="smallbtn danger" id="imgKeyClear">清除</button></div></div><div id="imgKeyStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var inp=document.getElementById('imgKeyInput'),sts=document.getElementById('imgKeyStatus');
    try{inp.value=localStorage.getItem(K)||'';}catch(e){}
    function setMsg(){try{sts.textContent=localStorage.getItem(K)?'已保存 Key':'未设置 Key';}catch(e){}}
    setMsg();
    document.getElementById('imgKeySave').addEventListener('click',function(){try{localStorage.setItem(K,(inp.value||'').trim());}catch(e){}setMsg();});
    document.getElementById('imgKeyClear').addEventListener('click',function(){try{localStorage.removeItem(K);}catch(e){}inp.value='';setMsg();});
  }

  function mountImgQuotaCard() {
    // 2026-11-28 card-shell batch 2: shell + declareCard. The __imageQuota guard stays ahead of the
    // declaration (old code skipped silently when the quota engine was absent); the wiring below is
    // unchanged hand-written code — the limit input has no mount-time reflect (renderCard paints
    // it), which is not the bindNumber shape.
    var q=window.__imageQuota; if(!q)return;
    window.slotRegistry.declareCard({
      id: 'imgQuotaCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgQuotaCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 16v-4M12 16V8M17 16v-6"/></svg>图像额度计数',
          desc: 'Gitee 免费图像额度每天约 <b>100 次</b>。本站发图成功时按图片张数累加，<b>仅本设备本地统计</b>；直连渠道与本地 ComfyUI 不计入。',
          extra: '<div id="imgQuotaDisplay" style="margin:6px 0 8px;"></div><div style="height:6px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin-bottom:12px;"><div id="imgQuotaBar" style="height:100%;width:0;transition:width .25s;"></div></div><div class="rowline" style="align-items:center;gap:10px;"><label style="font-size:12px;color:var(--muted);">每日额度</label><input type="number" id="imgQuotaLimit" min="1" max="9999" style="width:90px;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;"><div class="btns"><button class="smallbtn" id="imgQuotaMinus">-1</button><button class="smallbtn" id="imgQuotaPlus">+1</button><button class="smallbtn danger" id="imgQuotaReset">今日归零</button></div></div>'
        });
        var card=shell.card;
        slot.appendChild(card);
        var lim=document.getElementById('imgQuotaLimit'); if(lim)lim.addEventListener('change',function(){q.setLimit(lim.value);});
        var qp=document.getElementById('imgQuotaPlus'); if(qp)qp.addEventListener('click',function(){q.add(1);});
        var qm=document.getElementById('imgQuotaMinus'); if(qm)qm.addEventListener('click',function(){q.add(-1);});
        var qr=document.getElementById('imgQuotaReset'); if(qr)qr.addEventListener('click',function(){q.reset();});
        if(q.renderCard)q.renderCard();
        return card;
      }
    });
  }

  function mountImgPortraitCard(){
    // 2026-11-28 card-shell batch 2: shell + declareCard. The portraitSvc guard stays ahead of the
    // declaration (old code skipped silently when the service was absent). Bind primitive: the
    // style select collapses into bindText with the cross-card repaint on imagestyle:changed — the
    // exact shape mountImgStyleCard already uses (batch-1 precedent); the generate/set/clear wiring
    // stays hand-written.
    var pt=window.portraitSvc; if(!pt)return;
    window.slotRegistry.declareCard({
      id: 'imgPortraitCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var opts=styleOpts(pt);
        var shell=window.cardShell.createCardShell({
          id: 'imgPortraitCard',
          title: '角色立绘 → 发图基准图',
          desc: '用当前选中<b>角色卡</b>自动拼提示词，z-image 出一张半身立绘，一键设为<b>微信发图基准图</b>。消耗 1 次图像额度，<b>仅本设备</b>。',
          extra: '<div id="imgPortraitWho" style="font-size:13px;margin:4px 0;"></div><div class="rowline" style="align-items:center;gap:10px;margin-top:8px;"><label style="font-size:12px;opacity:.6;">画风</label><select id="imgPortraitStyle" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;">'+opts+'</select></div><div class="rowline" style="margin-top:10px;"><div></div><div class="btns"><button class="smallbtn" id="imgPortraitGen">生成立绘</button><button class="smallbtn" id="imgPortraitSet" disabled>设为基准图</button><button class="smallbtn danger" id="imgPortraitClear">清除基准图</button></div></div><div id="imgPortraitStatus" style="font-size:11px;opacity:.6;margin-top:8px;"></div><div id="imgPortraitPreview" style="margin-top:10px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;"></div>'
        });
        var card=shell.card;
        slot.appendChild(card);
        var genBtn=document.getElementById('imgPortraitGen'),setBtn=document.getElementById('imgPortraitSet'),delBtn=document.getElementById('imgPortraitClear'),status=document.getElementById('imgPortraitStatus'),preview=document.getElementById('imgPortraitPreview');
        var esc = window.escapeSvc.esc; // merge 修: refreshWho 用 esc 但本函数未定义（aee803f 收口漏了这处）
        // Bind primitive (imgStyleCard precedent): reflect/listen/write for the style select; the
        // imagestyle:changed repaint rides the bound handle's element as before.
        var bound=window.bindEl.bindText(card,'#imgPortraitStyle',{
          key: 'imgPortraitStyle',
          read: function(){return pt.getStyle();},
          write: function(raw){pt.setStyle(raw);return raw;},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var sel=bound?bound.el:null;
        if(sel){window.addEventListener('imagestyle:changed',function(e){var v=(e&&e.detail&&e.detail.style)||pt.getStyle();if(sel.value!==v)sel.value=v;});}
        function setMsg(t){if(status)status.textContent=t||'';}
        function activeCard(){try{return window.characterSvc&&window.characterSvc.getActiveCard&&window.characterSvc.getActiveCard();}catch(e){return null;}}
        function refreshWho(){var who=document.getElementById('imgPortraitWho'),c=activeCard();if(who)who.innerHTML=c?'当前角色：<b>'+esc(((c.icon?c.icon+' ':'')+(c.name||'(未命名)')))+'</b>':'<span style="color:#e5484d;">未选择角色卡 — 先去左侧「角色卡」选一个</span>';try{if(window.chatImageSvc&&window.chatImageSvc.getBaseImage&&c){Promise.resolve(window.chatImageSvc.getBaseImage({characterId:c.id||'default'})).then(function(b){if(b&&preview&&!preview.querySelector('[data-gen]'))preview.innerHTML='<div style="text-align:center;"><img src="'+b+'" style="max-width:140px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">当前基准图</div></div>';}).catch(function(){});}}catch(e){}}
        if(genBtn)genBtn.addEventListener('click',async function(){genBtn.disabled=true;setMsg('生成中…（约 10-30 秒）');try{var r=await pt.generateForActive();if(preview)preview.innerHTML='<div style="text-align:center;"><img data-gen="1" src="'+r.url+'" style="max-width:160px;border-radius:8px;display:block;"><div style="font-size:11px;opacity:.6;margin-top:4px;">新立绘：'+(r.name||'')+'</div></div>';if(setBtn)setBtn.disabled=false;setMsg('生成完成，点「设为基准图」锁定。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}genBtn.disabled=false;});
        if(setBtn)setBtn.addEventListener('click',async function(){setBtn.disabled=true;setMsg('保存基准图中…');try{await pt.setAsBase();setMsg('已设为当前角色的发图基准图。');}catch(e){setMsg('错误：'+((e&&e.message)||e));setBtn.disabled=false;}});
        if(delBtn)delBtn.addEventListener('click',async function(){if(!(window.chatImageSvc&&window.chatImageSvc.clearBaseImage)){setMsg('发图模块未就绪');return;}if(!(await uiConfirm('清除当前角色的发图基准图？', { title: '清除基准图', okText: '清除', danger: true })))return;var c=activeCard();delBtn.disabled=true;setMsg('清除中…');try{await window.chatImageSvc.clearBaseImage({characterId:(c&&c.id)||'default'});if(preview)preview.innerHTML='';if(setBtn)setBtn.disabled=true;setMsg('已清除。');}catch(e){setMsg('错误：'+((e&&e.message)||e));}delBtn.disabled=false;});
        refreshWho(); window.addEventListener('character:changed',refreshWho);
        return card;
      }
    });
  }

  function mountImgCacheCard(){
    var cache=window.__imageCache; if(!cache)return;
    window.slotRegistry.declareCard({
      id: 'imgCacheCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgCacheCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>提示词缓存去重',
          desc: '相同提示词在短期内再次生成时，直接复用上次的图，<b>不再消耗当日额度</b>。仅文生图，缓存 6 小时，<b>仅本设备</b>。',
          extra: '<label class="rowline" style="align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="imgCacheToggle"><span>启用缓存去重</span></label><div id="imgCacheStats" style="font-size:12px;opacity:.75;margin-top:8px;"></div><div class="rowline" style="margin-top:8px;"><div></div><div class="btns"><button class="smallbtn danger" id="imgCacheClear">清空缓存</button></div></div>'
        });
        var card=shell.card, q=shell.q;
        slot.appendChild(card);
        // Bind primitive: the toggle's reflect/listen/write collapses into bindToggle; the
        // imagecache:changed repaint goes through the handle's refresh(), which re-reads the same
        // cache.isEnabled() the old hand-written refresh set into .checked.
        var tog=window.bindEl.bindToggle(card,'#imgCacheToggle',{
          key: 'imgCacheToggle',
          read: function(){return cache.isEnabled();},
          write: function(on){cache.setEnabled(on);},
          fallbackGet: null,
          fallbackSet: null,
          onChange: null,
        });
        var clr=q('imgCacheClear'),st=q('imgCacheStats');
        function refresh(){if(tog)tog.refresh();if(st){var s=cache.stats();st.textContent='已缓存 '+s.count+' 条，累计省下 '+s.saved+' 次生成';}}
        if(clr)clr.addEventListener('click',function(){cache.clear();});
        window.addEventListener('imagecache:changed',refresh); refresh();
        return card;
      }
    });
  }

  function mountImgAlbumCard(){
    var album=window.imageAlbumSvc; if(!album)return;
    window.slotRegistry.declareCard({
      id: 'imgAlbumCard',
      slotId: 'settingsImageSlot',
      build: function (slot) {
        var shell=window.cardShell.createCardShell({
          id: 'imgAlbumCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M4 17.5l5-5 3.2 3.2 3.2-3.8 4.1 5"/></svg>本地画廊',
          desc: '工坊/立绘/发图生成的图会自动收进本地相册（浏览器 IndexedDB，最多 60 张）。每张可一键：设为基准图 / 插入对话 / 再改一张 / 下载 / 删除，<b>仅本设备</b>。',
          extra: '<div id="imgAlbumStat" style="font-size:12px;opacity:.75;margin:6px 0;"></div><div class="rowline"><div></div><div class="btns"><button class="smallbtn" id="imgAlbumOpen">打开画廊</button><button class="smallbtn danger" id="imgAlbumClear">清空</button></div></div>'
        });
        var q=shell.q;
        slot.appendChild(shell.card);
        var stat=q('imgAlbumStat');
        function refresh(){album.list().then(function(a){if(stat)stat.textContent='已收藏 '+a.length+' 张';});}
        var ob=q('imgAlbumOpen'); if(ob)ob.addEventListener('click',function(){album.open();});
        var cb=q('imgAlbumClear'); if(cb)cb.addEventListener('click',async function(){ if(await uiConfirm('清空本地画廊？', { title:'清空画廊', okText:'清空', danger:true })) album.clear(); });
        window.addEventListener('imagealbum:changed',refresh); refresh();
        return shell.card;
      }
    });
  }

  function mountTtsCard(){
    if(!window.tauriSvc || !window.tauriSvc.has())return;
    var slot=getVoiceSlot(); if(!slot||document.getElementById('omniTtsCard'))return; // 语音 slot(本地 GPT-SoVITS 是本机服务、非外接 API,留「语音」tab)
    var tts=window.omniTtsSvc; if(!tts)return;
    var c=tts.cfg();
    var LR='cfw_tts_ref_audio_v1',LP='cfw_tts_prompt_text_v1',LA='cfw_tts_autoplay_v1',LSPD='cfw_tts_speed_v1';
    function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
    var card=document.createElement('div'); card.className='card'; card.id='omniTtsCard';
    card.innerHTML='<h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>本地语音</h4><p>用本机 GPT-SoVITS 把 AI 回复读出来，仅桌面版可用。先在托盘「语音启动服务」，再填参考音频。<b>仅本设备</b>。</p><div style="margin-top:8px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频完整路径 (.wav)</label><div style="display:flex;gap:6px;"><input id="omniTtsRef" type="text" style="flex:1;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"><button class="smallbtn" id="omniTtsRefPick" type="button">选择…</button></div></div><div style="margin-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">参考音频对应文字 (可留空)</label><input id="omniTtsPrompt" type="text" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:13px;"></div><div style="margin-top:10px;"><label for="omniTtsSpeed" style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;"><span>语速</span><span id="omniTtsSpeedLabel" style="font-variant-numeric:tabular-nums;">1.00×</span></label><input id="omniTtsSpeed" type="range" min="0.5" max="1.5" step="0.05" value="1" style="width:100%;"><div style="font-size:11px;color:var(--muted);margin-top:4px;">向左变慢、向右变快(1.00× 为模型原速)。觉得太快就拉到 0.85～0.9。</div></div><div class="rowline" style="margin-top:10px;"><div class="toggle"><input type="checkbox" id="omniTtsAuto"><label for="omniTtsAuto">自动朗读每条 AI 回复(默认关)</label></div><div class="btns"><button class="smallbtn" id="omniTtsTest" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4.9v14.2L19.5 12z"/></svg>试听</button></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">音色模型（底模，扫描热切，免重启）</label><div class="rowline" style="margin-top:10px;align-items:center;gap:8px;"><select id="omniTtsScanSovits" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">SoVITS(.pth) — 点扫描列出</option></select><select id="omniTtsScanGpt" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><option value="">GPT(.ckpt) — 可选</option></select></div><div class="rowline" style="margin-top:6px;"><div style="font-size:11px;color:var(--muted);flex:1;">扫 GPT-SoVITS 目录下 GPT_weights*/SoVITS_weights*,仿 WebUI 列出全部已装底模,免手敲路径</div><div class="btns"><button class="smallbtn" id="omniTtsScan" type="button">扫描已装</button><button class="smallbtn" id="omniTtsScanApply" type="button">应用所选</button></div></div></div><div style="margin-top:12px;border-top:1px solid rgba(127,127,127,.12);padding-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">稳定音色 / 多参考（可选）</label><div id="omniTtsAuxList" style="display:flex;flex-direction:column;gap:6px;"></div><div class="rowline" style="margin-top:8px;gap:6px;"><input id="omniTtsAuxInput" type="text" placeholder="手填 .wav 路径,可一次多条(用 ; 或 | 分隔);或点「选择文件」多选" style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;"><div class="btns"><button class="smallbtn" id="omniTtsAuxPick" type="button">选择文件(可多选)</button><button class="smallbtn" id="omniTtsAuxAdd" type="button">＋ 添加</button><button class="smallbtn danger" id="omniTtsAuxClear" type="button">清空全部</button></div></div><div style="font-size:11px;color:var(--muted);margin-top:6px;">多丢几条同一个人的干净 .wav,api_v2 融合多条参考、音色更稳不漂。留空=只用单条主参考。<br>「选择文件」可按住 Ctrl/Shift 一次多选;「添加」是把上面输入框里手填/粘贴的路径入列(选文件已自动入列,不用再点添加)。</div></div><div id="omniTtsStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>';
    slot.appendChild(card);
    var refEl=card.querySelector('#omniTtsRef'),promptEl=card.querySelector('#omniTtsPrompt'),autoEl=card.querySelector('#omniTtsAuto');
    refEl.value=c.refAudioPath; promptEl.value=c.promptText; autoEl.checked=c.autoplay;
    var speedEl=card.querySelector('#omniTtsSpeed'),speedLb=card.querySelector('#omniTtsSpeedLabel');
    if(speedEl){var sv=parseFloat(localStorage.getItem(LSPD)||'1');if(!(sv>=0.5&&sv<=1.5))sv=1;speedEl.value=String(sv);if(speedLb)speedLb.textContent=sv.toFixed(2)+'×';speedEl.addEventListener('input',function(){var v=parseFloat(speedEl.value)||1;if(speedLb)speedLb.textContent=v.toFixed(2)+'×';lsSet(LSPD,String(v));});}
    async function renderStatus(){
      var s=card.querySelector('#omniTtsStatus'); if(!s)return;
      var cc=tts.cfg();
      // 据实测端口判定:不管是 App 托盘启的、还是你自己双击 .bat 启的,只要 9880 在听就算「运行中」。
      var alive=(tts.probeService)?(await tts.probeService()):(cc.serviceRunning===true);
      s.textContent=alive?('✓ 语音服务运行中（端口 '+cc.port+(cc.ttsDir?'，'+cc.ttsDir:'')):'● 语音服务未启动 — 双击你的启动 .bat 或托盘「语音启动服务」,等控制台出现 Uvicorn running';}
    renderStatus();
    refEl.addEventListener('change',function(){lsSet(LR,refEl.value.trim());});
    promptEl.addEventListener('change',function(){lsSet(LP,promptEl.value.trim());});
    autoEl.addEventListener('change',function(){lsSet(LA,autoEl.checked?'1':'0');});
    // 主参考音「选择…」:调原生 tts_pick_file 弹系统文件框选 .wav,免手敲路径;旧版 .exe 无此命令时提示更新并回退手填
    var refPick=card.querySelector('#omniTtsRefPick');
    if(refPick)refPick.addEventListener('click',async function(){
      if(typeof tts.pickFile!=='function'){alert('当前运行的桌面版较旧,没有文件选择框命令(tts_pick_file)— 强刷页面并更新到新版后即可;暂时请直接粘贴 .wav 完整路径');return;}
      var p=await tts.pickFile();
      if(p){refEl.value=p;lsSet(LR,p);var s=card.querySelector('#omniTtsStatus');if(s)s.textContent='已选参考音频:'+p;}
    });
    card.querySelector('#omniTtsTest').addEventListener('click',async function(){
      lsSet(LR,refEl.value.trim()); lsSet(LP,promptEl.value.trim());
      var s=card.querySelector('#omniTtsStatus');
      if(!refEl.value.trim()){alert('先填(或用「选择…」选)参考音频 .wav 完整路径,再点试听。');return;}
      await tts.refreshNativeCfg(); renderStatus();
      // 直接合成一发:不再靠「是不是 App 自己启的服务」判断 —— 你双击 .bat 启的服务 App 看不到子进程,
      // 但端口在听就能合成。真打一发 9880,据实结果提示,无论谁启的都能试听。
      if(s)s.textContent='合成中…(首次要加载模型,十几秒~一两分钟)';
      tts.stop();
      var blob=null,synthErr=null;
      try{ blob=await tts.synthWith({text:'你好呀，现在能听到我说话了吗？'}); }catch(e){synthErr=e;}
      if(!blob){
        var port=tts.cfg().port;
        if(s)s.textContent='';
        if(synthErr&&/返回\s*4\d\d/.test(String((synthErr&&synthErr.message)||''))){
          // 服务在跑、但 api_v2 把合成请求拒了(最常见:所选底模与你的 GPT-SoVITS 版本不兼容)。原样亮出 api_v2 的报错,免得你去翻控制台。
          alert('GPT-SoVITS 收到请求但合成失败了 —— 多半是当前所选底模和你的 GPT-SoVITS 核心版本不兼容(换回匹配的 .pth + .ckpt,或升级 GPT-SoVITS 核心再试)。\n\napi_v2 原始报错:\n'+String(synthErr.message)+'\n\n(同样的红字也会打印在你的 api_v2 控制台窗口里)');
        }else{
          alert('试听没出声 —— 八成是 GPT-SoVITS 服务还没起来(端口 '+port+' 连不上),或参考音频路径不对。\n\n1) 确认你的 api_v2 窗口里已经出现 Uvicorn running on http://127.0.0.1:'+port+'(双击你的 .bat 或托盘「语音启动服务」都行),起来之后再点试听;\n2) 若服务已在跑还是没声:多半是「参考音频」填的路径不对(必须是真实存在的 .wav 完整路径),或所选底模没加载成功。');
        }
        return;
      }
      // 合成拿到音频 ≠ 一定出声:真去播并等结果。playBlob 会在 <audio> 播不出时自动回落 Web Audio 解码播,
      // 两路都失败才如实报错 —— 不再像以前那样一拿到字节就显示「成功」、其实没声还蒙在鼓里。
      if(s)s.textContent='✓ 合成成功，播放中…';
      try{
        await tts.enqueuePlay(blob);
        if(s)s.textContent='✓ 合成并播放完成(若没听到:检查系统音量/输出设备,或换底模/参考音再试)';
      }catch(e){
        if(s)s.textContent='';
        alert('音频已经合成出来了,但这台设备的网页层没把它播出来(WebView 播放被拒或解码失败)。\n\n排查:\n1) 系统没静音、输出设备正常;\n2) Ctrl+Shift+R 强刷页面后重试(已加 Web Audio 兜底播放);\n3) 仍无声:把 F12 控制台里 [TTS] 开头的红字发我。\n\n('+((e&&e.message)||e)+')');
      }
    });
    // ── 稳定音色·多参考:管理辅助参考音列表(omniTtsSvc.getAuxRefs/setAuxRefs),synthWith 自动带 aux_ref_audio_paths ──
    var auxListEl=card.querySelector('#omniTtsAuxList'),auxInput=card.querySelector('#omniTtsAuxInput'),auxAdd=card.querySelector('#omniTtsAuxAdd'),auxPick=card.querySelector('#omniTtsAuxPick'),auxClear=card.querySelector('#omniTtsAuxClear');
    function renderAux(){
      if(!auxListEl)return;
      var list=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      if(!list.length){auxListEl.innerHTML='<div style="font-size:11px;color:var(--muted);">（未加辅助参考，只用单条主参考）</div>';return;}
      auxListEl.innerHTML='';
      list.forEach(function(p,idx){
        var row=document.createElement('div');
        row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;';
        var span=document.createElement('span');span.style.cssText='flex:1;word-break:break-all;color:var(--muted);';span.textContent=p;
        var del=document.createElement('button');del.className='smallbtn danger';del.type='button';del.textContent='删除';
        del.addEventListener('click',function(){var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];l.splice(idx,1);tts.setAuxRefs(l);renderAux();});
        row.appendChild(span);row.appendChild(del);auxListEl.appendChild(row);
      });
    }
    renderAux();
    // 辅助参考入列(单一入口):校验 .wav + 去重 → 存 LS → 重画列表。选文件/手填/「添加」都走它。
    // 入列(单一入口·支持一次多条):传数组(多选文件)或字符串(手填,用 ; | 换行分隔)都行。
    // 逐条校验 .wav + 去重,有几条加几条,末尾汇总提示加了几条/跳过几条。
    function addAux(v){
      var raw=Array.isArray(v)?v:String(v==null?'':v).split(/[\r\n;|]+/);
      var cands=raw.map(function(x){return (x||'').trim();}).filter(function(x){return x;});
      if(!cands.length){alert('先用「选择文件」选(可多选),或在输入框手填 .wav 路径(多条用 ; 或 | 分隔),再点添加');return false;}
      var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      var added=0,dup=0,bad=0;
      cands.forEach(function(p){
        if(!/\.wav$/i.test(p)){bad++;return;}
        if(l.indexOf(p)>=0){dup++;return;}
        l.push(p);added++;
      });
      if(added){tts.setAuxRefs(l);renderAux();}
      var s=card.querySelector('#omniTtsStatus');
      if(s)s.textContent='已加 '+added+' 条辅助参考'+(dup?('，跳过 '+dup+' 条重复'):'')+(bad?('，忽略 '+bad+' 条非 .wav'):'')+(added?' — 合成时与主参考一起融合稳定音色':'');
      if(!added&&bad&&!dup)alert('辅助参考必须是具体的 .wav 文件路径(不能是文件夹)');
      return added>0;
    }
    // 「选择文件」:弹系统框选 .wav,选中即直接入列(不用再点「添加」);旧版 .exe 无 tts_pick_file 时提示更新并回退手填
    if(auxPick)auxPick.addEventListener('click',async function(){
      if(typeof tts.pickFiles!=='function'&&typeof tts.pickFile!=='function'){alert('当前运行的桌面版较旧,没有文件选择框命令 — 强刷页面并更新到新版后即可;暂时请直接粘贴 .wav 完整路径');return;}
      // 多选:tts.pickFiles 一次返回多条;旧版 .exe 无 tts_pick_files 时 pickFiles 内部已回落单选。再兜底老 tts.js 只有 pickFile 的情况。
      var ps=(typeof tts.pickFiles==='function')?(await tts.pickFiles()):(await tts.pickFile().then(function(p){return p?[p]:[];}));
      if(ps&&ps.length&&addAux(ps))auxInput.value='';
    });
    // 「添加」:把输入框里手填/粘贴的路径入列(选文件已自动入列,这个留给手敲路径用)
    if(auxAdd)auxAdd.addEventListener('click',function(){ if(addAux(auxInput.value))auxInput.value=''; });
    // 「清空全部」:一键删掉所有辅助参考(主参考音不动);加了几千条时不用一条条点删除
    if(auxClear)auxClear.addEventListener('click',function(){
      var l=(tts.getAuxRefs&&tts.getAuxRefs())||[];
      var s=card.querySelector('#omniTtsStatus');
      if(!l.length){if(s)s.textContent='辅助参考本来就是空的,无需清空';return;}
      if(!confirm('确定清空全部 '+l.length+' 条辅助参考吗?\n\n只清辅助参考列表,主参考音不受影响\n纯本地操作,清错了重新添加即可'))return;
      tts.setAuxRefs([]);renderAux();
      if(s)s.textContent='已清空全部辅助参考(原 '+l.length+' 条)';
    });
    // ── 扫描已安装底模(仿 WebUI 自动列表):原生 tts_list_models 扫 GPT_weights*/SoVITS_weights* ──
    var scanSovits=card.querySelector('#omniTtsScanSovits'),scanGpt=card.querySelector('#omniTtsScanGpt');
    var scanBtn=card.querySelector('#omniTtsScan'),scanApply=card.querySelector('#omniTtsScanApply');
    function fillScan(sel,arr,label){if(!sel)return;var h='<option value="">'+label+'</option>';for(var i=0;i<(arr||[]).length;i++){var v=arr[i];h+='<option value="'+v+'">'+v+'</option>';}sel.innerHTML=h;}
    // 回显上次选定的底模(switchWeights 成功会存 cfw_tts_weights_current_v1):即便还没点「扫描已装」,
    // 也把上次选的塞进下拉并选中,让人看到「记住了」;扫描后再对齐选中。运行期自动切回由 tts.js ensureSavedWeights 负责。
    function preselect(sel,val){
      if(!sel||!val)return;
      var has=false;for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===val){has=true;break;}}
      if(!has){var o=document.createElement('option');o.value=val;o.textContent=val;sel.appendChild(o);}
      sel.value=val;
    }
    var savedW=(tts.getCurrentWeights&&tts.getCurrentWeights())||{sovits:'',gpt:''};
    preselect(scanSovits,savedW.sovits); preselect(scanGpt,savedW.gpt);
    if(savedW.sovits){var _ss=card.querySelector('#omniTtsStatus');if(_ss&&!_ss.textContent)_ss.textContent='上次已切底模:'+savedW.sovits+(savedW.gpt?(' + '+savedW.gpt):'')+'(重启后首次合成会自动切回)';}
    if(scanBtn)scanBtn.addEventListener('click',async function(){
      var s=card.querySelector('#omniTtsStatus');if(s)s.textContent='扫描中…';
      var r=(tts.listInstalledModels&&await tts.listInstalledModels())||{gpt:[],sovits:[]};
      if(r.error){if(s)s.textContent='扫描失败:'+r.error+'(先在托盘设好并启动 GPT-SoVITS 文件夹)';return;}
      fillScan(scanSovits,r.sovits,'SoVITS(.pth)，共 '+((r.sovits||[]).length)+' 个,选一个');
      fillScan(scanGpt,r.gpt,'GPT(.ckpt)（可选），共 '+((r.gpt||[]).length)+' 个');
      var sw=(tts.getCurrentWeights&&tts.getCurrentWeights())||{sovits:'',gpt:''}; preselect(scanSovits,sw.sovits); preselect(scanGpt,sw.gpt);
      if(s)s.textContent='扫到 SoVITS '+((r.sovits||[]).length)+' 个 / GPT '+((r.gpt||[]).length)+' 个 — 选好点「应用所选」热切'+(sw.sovits?'(已自动选回上次:'+sw.sovits+')':'');
    });
    if(scanApply)scanApply.addEventListener('click',async function(){
      var sovits=scanSovits&&scanSovits.value,gpt=scanGpt&&scanGpt.value,s=card.querySelector('#omniTtsStatus');
      if(!sovits&&!gpt){alert('先点「扫描已装」再选一个 SoVITS(.pth)(GPT 可选)');return;}
      if(s)s.textContent='切换中…';
      var r=await tts.switchWeights({sovits:sovits,gpt:gpt});
      if(s)s.textContent=(r&&r.ok)?('✓ 已切到所选权重，热生效,无需重启'):('切换失败:'+((r&&r.reason)||'未知'));
    });
  }

  // ─── §语音. 云端语音卡（2026-11-25 访客/网页可见）───
  // 云端语音走 Worker /api/tts（key 只在 env），网页版与访客也能用，所以挂在「语音」分类而不是
  // 藏在模型 API 里。语音 tab 此前仅在壳内显示——云端服务一加载就把门控打开（见 settings-cat-nav）。
  function mountCloudTtsCard() {
    var cloud = window.cloudTtsSvc; if (!cloud) return;
    window.slotRegistry.declareCard({
      id: 'cloudTtsCard',
      slotId: 'settingsVoiceSlot',
      build: function (slot) {
        var ready = false;
        try {
          var P = window.providersSvc;
          var ch = P && typeof P.channels === 'function' ? P.channels() : [];
          for (var i = 0; i < ch.length; i++) {
            if (ch[i].kind === 'preset' && ch[i].key === 'preset:deepseek') { ready = ch[i].detail && ch[i].detail.configured === true; break; }
          }
        } catch (e) {}
        var c = cloud.cfg();
        // The card's former inline <style> moved to styles.css under the [data-card="cloudTtsCard"]
        // scope (the W2 per-card stylesheet precedent); the six rules are unchanged apart from the
        // selector prefix. The bare tip (no info glyph) rides in extra verbatim — the shell's
        // standard tip block always carries the glyph.
        var shell = window.cardShell.createCardShell({
          id: 'cloudTtsCard',
          title: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>云端语音',
          desc: '用服务端 DeepSeek 语音合成把 AI 回复读出来，<b>无需本机启动语音服务</b>，网页版和访客也能用。按量计费（约 ¥0.01/千字符），Key 只在你的 Worker 里。<b>仅本设备</b>。',
          extra: (ready ? ''
            : '<div class="settings-warn"><span>服务端未配置 <code>DEEPSEEK_API_KEY</code>，云端语音不可用。部署侧执行 <code>wrangler secret put DEEPSEEK_API_KEY</code> 后刷新本页。</span></div>')
            + '<div class="ds-kit-sec"><div class="ds-kit-hd">朗读引擎'
            + '<div class="ds-kit-seg"><button type="button" data-engine="off">不朗读</button><button type="button" data-engine="cloud">云端</button><button type="button" data-engine="local">本地</button></div></div>'
            + '<div id="dsKitTtsOpts" style="margin-top:8px;"><div class="rowline"><div class="toggle"><input type="checkbox" id="cloudTtsAuto"><label for="cloudTtsAuto">自动朗读每条 AI 回复</label></div>'
            + '<div class="btns"><select id="cloudTtsVoice" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:inherit;font-size:12px;">'
            + '<option value="stella">stella · 女声</option><option value="tide">tide · 男声</option></select>'
            + '<button class="smallbtn" id="cloudTtsTest" type="button">试听</button></div></div></div></div>'
            + '<div id="cloudTtsStatus" style="font-size:11px;color:var(--muted);margin-top:8px;"></div>'
            + '<div class="settings-tip"><span>本地引擎=同分类的 GPT-SoVITS（仅桌面版），云端引擎网页版可用，两者同一句只走一种。朗读按钮在每条 AI 回复左下角。</span></div>'
        });
        var card = shell.card;
        slot.appendChild(card);
        var auto = card.querySelector('#cloudTtsAuto'), voice = card.querySelector('#cloudTtsVoice'), test = card.querySelector('#cloudTtsTest'), st = card.querySelector('#cloudTtsStatus');
        function status(msg) { if (st) st.textContent = msg || ''; }
        function localOn() { try { return normalizeAutoplay(localStorage.getItem(SETTINGS_PAGE_KEYS.autoplay)); } catch (e) { return false; } }
        function localSet(on) { try { localStorage.setItem(SETTINGS_PAGE_KEYS.autoplay, on ? '1' : '0'); } catch (e) {} }
        function currentEngine() { return c.enabled ? 'cloud' : (localOn() ? 'local' : 'off'); }
        function paintEngine() {
          var eng = currentEngine();
          var btns = card.querySelectorAll('.ds-kit-seg button');
          for (var j = 0; j < btns.length; j++) {
            var b = btns[j];
            b.setAttribute('data-on', b.getAttribute('data-engine') === eng ? '1' : '0');
            if (!ready && b.getAttribute('data-engine') === 'cloud') { b.disabled = true; b.style.opacity = '.4'; b.style.cursor = 'not-allowed'; }
          }
          var opts = card.querySelector('#dsKitTtsOpts');
          if (opts) opts.style.display = eng === 'cloud' ? '' : 'none';
          if (auto) auto.checked = c.enabled;
        }
        var segs = card.querySelectorAll('.ds-kit-seg button');
        for (var k = 0; k < segs.length; k++) {
          segs[k].addEventListener('click', function () {
            if (this.disabled) return;
            var eng = this.getAttribute('data-engine');
            cloud.setEnabled(eng === 'cloud');
            localSet(eng === 'local');
            c = cloud.cfg();
            paintEngine();
            status(eng === 'cloud' ? '已切到云端语音' : eng === 'local' ? '已切到本地语音（桌面版需启动 GPT-SoVITS）' : '朗读已关闭');
          });
        }
        paintEngine();
        if (!ready) return card;
        if (auto) auto.addEventListener('change', function () { cloud.setEnabled(auto.checked); if (auto.checked) localSet(false); c = cloud.cfg(); paintEngine(); status(auto.checked ? '已开启云端朗读' : '已关闭'); });
        if (voice) voice.addEventListener('change', function () { cloud.setVoice(voice.value); status('音色已切换为 ' + (voice.value === 'tide' ? 'tide · 男声' : 'stella · 女声')); });
        if (test) test.addEventListener('click', function () {
          status('合成中…');
          cloud.stop();
          cloud.speak('你好，这是 DeepSeek 云端语音的试听。');
          var wait = setInterval(function () { if (!cloud.isPlaying()) { clearInterval(wait); status(cloud.lastError() ? ('失败：' + cloud.lastError()) : '试听完成'); } }, 300);
        });
        return card;
      }
    });
  }
