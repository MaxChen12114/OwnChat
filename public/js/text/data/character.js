// public/js/text/data/character.js — 角色卡 v3 (Final 三层架构)
// API: window.__character.{getActiveCard,getActiveRelation,getActiveEmotion,decorateAiRow,...}
// 与 worker buildSystemPrompt 配套：POST /api/chat body 传 { characterCard, relation, emotion, ... }
(function(){
"use strict";
const DB="tavern_chars_v2",ST="chars",STA="affections";
const LSA="tavern_active_char_id",LSR="tavern_active_relation",LSE="tavern_active_emotion";
const LSPE="tavern_aff_pending_v1"; // 阶段 4-② 跨阈值待注入事件队列 [{cardId,at,instruction}]
const LSAT_PREFIX="tavern_aff_triggered_"; // 阶段 4-② 已触发阈值 set 前缀（按 cardId）
// 好感度段位（与 worker AFFECTION_STAGES 对齐）+ 初始值
const AFF_STAGES=[{max:15,label:"陌生人"},{max:35,label:"熟人"},{max:60,label:"好友"},{max:80,label:"暧昧"},{max:100,label:"灵魂伴侣"}];
const AFF_INIT=30;
// 简化减负 (2026-05-29): 自定义情绪/好感度阈值事件等高级字段隐藏在开发者模式背后
// 控制台开启: localStorage.setItem("cfw_dev_mode_v1","1");location.reload()
const isDev=()=>localStorage.getItem("cfw_dev_mode_v1")==="1";
function affStage(v){if(typeof v!=="number"||isNaN(v))return null;const x=Math.max(0,Math.min(100,v));return AFF_STAGES.find(s=>x<=s.max);}
const RELS=["default","friendly","loving","hostile","fearful","dom","sub"];
// 4.17: 自由文本关系 -> RELS enum 关键词映射 (兼容 worker enum 入参; worker 端后续改造接 free text 后可删)
function mapRel(s){if(!s)return"default";if(/友好|朋友|哥们|姐妹|同事|搭档/.test(s))return"friendly";if(/爱|喜欢|恋人|暧昧|心动|喜爱|恋|情侣|伴侣/.test(s))return"loving";if(/敌|讨厌|恨|对立|仇|不爽|厌恶/.test(s))return"hostile";if(/怕|畏|惧|恐|害怕/.test(s))return"fearful";if(/主导|支配|强势|dom|主人|支配者/i.test(s))return"dom";if(/服从|被动|顺从|sub|奴|跟随/i.test(s))return"sub";return"default";}
const RLBL={default:"默认",friendly:"友好",loving:"爱慕",hostile:"敌对",fearful:"畏惧",dom:"主导",sub:"被动"};
const EMS=["neutral","happy","angry","sad","surprised"];
const ELBL={neutral:"平静",happy:"开心",angry:"愤怒",sad:"低落",surprised:"惊讶"};

// 2026-10-06 删：内置原型库（starter-roles.json 早已是 0 字节 → 「原型库」页永远空着，每次加载还打一条告警）。
// 想做「模板角色」就用「提示词编辑器 → 角色」新建/导入，或把卡导出成 V2 JSON 当模板。


// IndexedDB
const db=()=>new Promise((r,j)=>{const q=indexedDB.open(DB,2);q.onupgradeneeded=()=>{const d=q.result;if(!d.objectStoreNames.contains(ST))d.createObjectStore(ST,{keyPath:"id"});if(!d.objectStoreNames.contains(STA))d.createObjectStore(STA,{keyPath:"cardId"});};q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
const all=async()=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readonly").objectStore(ST).getAll();t.onsuccess=()=>r(t.result||[]);t.onerror=()=>j(t.error);});};
const put=async(c)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).put(c);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const del=async(id)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(ST,"readwrite");t.objectStore(ST).delete(id);t.oncomplete=r;t.onerror=()=>j(t.error);});};
const affGetDb=async(cardId)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(STA,"readonly").objectStore(STA).get(cardId);t.onsuccess=()=>r(t.result||null);t.onerror=()=>j(t.error);});};
const affPutDb=async(cardId,value)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(STA,"readwrite");t.objectStore(STA).put({cardId,value,updatedAt:Date.now()});t.oncomplete=r;t.onerror=()=>j(t.error);});};
const affDelDb=async(cardId)=>{const d=await db();return new Promise((r,j)=>{const t=d.transaction(STA,"readwrite");t.objectStore(STA).delete(cardId);t.oncomplete=r;t.onerror=()=>j(t.error);});};

// State
let _card=null,_aff=null,_allCards=[];
const notif=()=>window.dispatchEvent(new CustomEvent("character:changed"));
async function refresh(){_allCards=await all();const id=localStorage.getItem(LSA)||"";if(!id){_card=null;_aff=null;return;}_card=_allCards.find(c=>c.id===id)||null;if(!_card){localStorage.removeItem(LSA);_aff=null;return;}const r=await affGetDb(_card.id);_aff=(r&&typeof r.value==="number")?r.value:AFF_INIT;}
const getCard=()=>_card;
const isAffOn=()=>!!(_card&&_card.enableAffection!==false);
const getAff=()=>isAffOn()?_aff:null;
async function setAff(v){
  if(!_card||!isAffOn())return;
  const old=typeof _aff==="number"?_aff:AFF_INIT;
  const x=Math.max(0,Math.min(100,Math.round(Number(v)||0)));
  _aff=x;
  await affPutDb(_card.id,x);try{if(window.__sync&&window.__sync.markCharsDirty)window.__sync.markCharsDirty();}catch(e){}
  // 阶段 4-②：阈值事件检测（仅当卡定义了 affectionThresholds 时）
  if(Array.isArray(_card.affectionThresholds)&&_card.affectionThresholds.length){
    const tk=LSAT_PREFIX+_card.id;
    let triggered;try{triggered=JSON.parse(localStorage.getItem(tk)||"[]");if(!Array.isArray(triggered))triggered=[];}catch{triggered=[];}
    const newEvents=[];
    for(const th of _card.affectionThresholds){
      if(!th||typeof th.at!=="number"||typeof th.instruction!=="string"||!th.instruction.trim())continue;
      if(triggered.includes(th.at))continue;
      const dir=th.dir||"up";
      const upCross=old<th.at&&x>=th.at;
      const downCross=old>th.at&&x<=th.at;
      const crossed=(dir==="up"&&upCross)||(dir==="down"&&downCross)||(dir==="both"&&(upCross||downCross));
      if(crossed){newEvents.push({cardId:_card.id,at:th.at,instruction:th.instruction.trim()});triggered.push(th.at);}
    }
    if(newEvents.length){
      localStorage.setItem(tk,JSON.stringify(triggered));
      let pending;try{pending=JSON.parse(localStorage.getItem(LSPE)||"[]");if(!Array.isArray(pending))pending=[];}catch{pending=[];}
      pending.push(...newEvents);
      localStorage.setItem(LSPE,JSON.stringify(pending));
    }
  }
  notif();
}
function getPendingThresholdEvents(){try{const r=JSON.parse(localStorage.getItem(LSPE)||"[]");return Array.isArray(r)?r:[];}catch{return[];}}
function clearPendingThresholdEvents(){localStorage.removeItem(LSPE);}
function resetThresholdTriggers(cardId){if(cardId)localStorage.removeItem(LSAT_PREFIX+cardId);}
async function adjustAff(delta){if(!_card||!isAffOn())return;const cur=typeof _aff==="number"?_aff:AFF_INIT;await setAff(cur+(Number(delta)||0));}
async function resetAff(){if(!_card||!isAffOn())return;resetThresholdTriggers(_card.id);await setAff(AFF_INIT);}
// 解析 AI 回复末尾的隐藏好感度标签 [好感+N] / [好感-N]（N 1-2 位；多匹配取最后一个；返回剥离后正文）
function parseAffTag(t){if(!t||typeof t!=="string")return{delta:0,stripped:t};const re=/\[\s*好感\s*([+\-])\s*(\d{1,2})\s*\]/g;let m,last=null;while((m=re.exec(t))!==null)last=m;if(!last)return{delta:0,stripped:t};const s=last[1]==="-"?-1:1;const n=Math.min(50,Math.max(0,parseInt(last[2],10)||0));return{delta:s*n,stripped:t.replace(re,"").replace(/\s+$/,"")};}
// 场景成员管理已搬到 multi-agent.js；setActive 仍负责切换当前角色，并通知 multi-agent 自动加入场景
function setActive(id){if(id){localStorage.setItem(LSA,id);if(window.__multi&&window.__multi.addToScene)window.__multi.addToScene(id);}else{localStorage.removeItem(LSA);}refresh().then(notif);}
// 给 multi-agent.js 提供全部卡数据访问（不暴露内部数组引用，返回浅拷贝）
function listAllCards(){return _allCards.slice();}
// 2026-09-14 会话与角色解绑后,关系/情绪必须跟着「角色」走而不是全局 ——
// 否则在同一个会话里换角色,新角色会继承上一张卡的关系/情绪(旧实现是全局单值)。
// 存储改为 { [cardId]: value };读取时兼容旧的裸字符串(当作默认值,首次写入即迁移成 map)。
function _kvMap(lsKey){
  try{ const v=JSON.parse(localStorage.getItem(lsKey)||"null"); if(v&&typeof v==="object"&&!Array.isArray(v)) return v; }catch(e){}
  return null;
}
function _kvLegacy(lsKey){
  const v=localStorage.getItem(lsKey);
  return (v&&v.charAt(0)!=="{")?v:null; // 旧格式是裸字符串;新格式是 JSON 对象
}
function _curCardId(){ return localStorage.getItem(LSA)||""; }
const getRel=()=>{
  const map=_kvMap(LSR), id=_curCardId();
  const v=map?(map[id]||""):(_kvLegacy(LSR)||"");
  return RELS.includes(v)?v:"default";
};
const setRel=(k)=>{
  const val=RELS.includes(k)?k:"default";
  const map=_kvMap(LSR)||{}; map[_curCardId()]=val;
  localStorage.setItem(LSR,JSON.stringify(map)); notif();
};
const getEmo=()=>{
  const map=_kvMap(LSE), id=_curCardId();
  const v=map?(map[id]||""):(_kvLegacy(LSE)||"");
  return v||"neutral";
};
const setEmo=(e)=>{
  const v=(e==null?"neutral":String(e)).trim()||"neutral";
  const map=_kvMap(LSE)||{}; map[_curCardId()]=v;
  localStorage.setItem(LSE,JSON.stringify(map)); notif();
};

// Avatar decoration (app.js 传 .row.ai DOM)
// 4.19 P1 fix: 加 card 参数。鱼缸场景 setActive 是 async (await IndexedDB),fishbowl-engine setActiveId 后立刻 sendOne,
// decorate 读模块级 _card 会拿到上一轮的 card → UI label 偏移一个角色(body speakerName=test1 但气泡 label 显示 test2)。
// sendOne 现在显式传 characterCard (= asCard || getActiveCard()),不再依赖 _card race。
// 4.34 头像对接: window.__avatar 契约 (LS cfw_char_avatar_v1 / 事件 avatar:changed)。有图渲染图片,无图回退 emoji。
function avatarUrlFor(id){if(!id)return null;try{if(window.__avatar&&typeof window.__avatar.get==="function"){const u=window.__avatar.get(id);if(u)return u;}const raw=localStorage.getItem("cfw_char_avatar_v1");if(raw){const m=JSON.parse(raw);if(m&&m[id])return m[id];}}catch(e){}return null;}
function applyAvatarEl(el,c){if(!el||!c)return;const url=avatarUrlFor(c.id);el.title=c.name||"";if(url){el.style.backgroundImage='url("'+url+'")';el.style.backgroundSize="cover";el.style.backgroundPosition="center";el.classList.add("has-avatar-img");el.textContent="";}else{el.style.backgroundImage="";el.classList.remove("has-avatar-img");el.textContent=c.icon||"🙂";}}
window.addEventListener("avatar:changed",(ev)=>{const id=ev&&ev.detail?ev.detail.id:null;const sel=id?'.avatar.bot[data-char-id="'+((window.CSS&&CSS.escape)?CSS.escape(id):id)+'"]':'.avatar.bot[data-char-id]';document.querySelectorAll(sel).forEach(a=>{const cid=a.dataset.charId;if(!cid)return;const card=(_card&&cid===_card.id)?_card:(_allCards.find(x=>x.id===cid)||{id:cid,icon:a.textContent,name:a.title});applyAvatarEl(a,card);});if(mask&&mask.style.display!=="none")render();});
function decorate(row,card){const c=card||_card;if(!c||!row||!row.querySelector)return;const a=row.querySelector(".avatar.bot");if(a){a.textContent=c.icon||"\u{1F642}";a.title=c.name||"";}if(a){a.dataset.charId=c.id||"";applyAvatarEl(a,c);}const m=row.querySelector(".meta");if(m&&c.name)m.textContent=c.name;}

// UI
let mask=null,P=null,tab="mine";
function ensure(){if(mask)return;mask=document.createElement("div");mask.className="char-panel-mask";P=document.createElement("div");P.className="char-panel";mask.appendChild(P);document.body.appendChild(mask);let downOnMask=false;mask.addEventListener("mousedown",(e)=>{downOnMask=(e.target===mask);});mask.addEventListener("click",(e)=>{const ok=downOnMask&&e.target===mask;downOnMask=false;if(ok)close();});}
const open=()=>{ensure();mask.style.display="flex";render();};
const close=()=>{if(mask)mask.style.display="none";};
const esc=(s)=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function render(){
  const h=[];
  h.push(`<div class="char-panel-header"><h3>角色卡</h3><button class="iconbtn char-close-btn" data-close>✕</button></div>`);
  h.push(`<div class="char-relation-row" style="margin-bottom:6px;">`);
  for(const[k,l]of[["mine","我的"],["new","新建"]])h.push(`<button class="char-rel-btn ${tab===k?"active":""}" data-tab="${k}">${l}</button>`);
  h.push(`</div>`);
  h.push(curSec());
  h.push(`<div data-body></div>`);
  P.innerHTML=h.join("");
  const b=P.querySelector("[data-body]");
  if(tab==="mine")mine(b);else editor(b,null);
  P.querySelector("[data-close]")?.addEventListener("click",close);
  P.querySelectorAll("[data-tab]").forEach(x=>x.addEventListener("click",()=>{tab=x.dataset.tab;render();}));
  P.querySelectorAll("[data-rel]").forEach(x=>x.addEventListener("click",()=>{setRel(x.dataset.rel);render();}));
  P.querySelectorAll("[data-emo]").forEach(x=>x.addEventListener("click",()=>{setEmo(x.dataset.emo);render();}));
  // 4.17: 自由文本输入 -> 写 LS free text + 同步 mapRel 兼容 enum
  const relT=P.querySelector("[data-rel-text]");
  if(relT)relT.addEventListener("change",()=>{const v=relT.value.trim();localStorage.setItem("cfw_relation_text_v1",v);setRel(mapRel(v));});
  const emoT=P.querySelector("[data-emo-text]");
  if(emoT)emoT.addEventListener("change",()=>{const v=emoT.value.trim();localStorage.setItem("cfw_emotion_text_v1",v);setEmo(v||"neutral");});
  P.querySelector("[data-clear]")?.addEventListener("click",()=>{setActive("");setTimeout(render,30);});
  P.querySelector("[data-reset-aff]")?.addEventListener("click",async()=>{await resetAff();render();});
  P.querySelectorAll("[data-aff-step]").forEach(x=>x.addEventListener("click",async()=>{await adjustAff(parseInt(x.dataset.affStep,10)||0);render();}));
  const _affSet=P.querySelector("[data-aff-set]");if(_affSet)_affSet.addEventListener("change",async()=>{await setAff(parseInt(_affSet.value,10)||0);render();});
  P.querySelectorAll("[data-pick-scene]").forEach(x=>x.addEventListener("click",(ev)=>{if(ev.target.closest("[data-rmscene]"))return;setActive(x.dataset.pickScene);setTimeout(render,30);}));
  P.querySelectorAll("[data-rmscene]").forEach(x=>x.addEventListener("click",(ev)=>{ev.stopPropagation();if(window.__multi&&window.__multi.removeFromScene)window.__multi.removeFromScene(x.dataset.rmscene);setTimeout(render,30);}));
  const _la=P.querySelector(".char-avatar-large");if(_la&&_card)applyAvatarEl(_la,_card);
}

function curSec(){
  const c=_card,r=getRel(),e=getEmo(),bi=EMS.includes(e);
  const M=window.__multi;
  const isMultiOn=!!(M&&M.isMulti&&M.isMulti());
  const sceneCards=isMultiOn&&M.getSceneCards?M.getSceneCards():[];
  const h=[];
  if(isMultiOn){h.push(`<div class="char-section-title">场景成员（共 ${sceneCards.length}）${sceneCards.length<=1?` <span style="font-weight:normal;color:#888;font-size:11px;">· 去「我的」点卡的「+场景」加成员</span>`:""}</div>`);h.push(`<div class="char-scene-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">`);for(const s of sceneCards){const act=s.id===(c?c.id:"");h.push(`<button class="char-rel-btn ${act?"active":""}" data-pick-scene="${esc(s.id)}" style="display:flex;align-items:center;gap:4px;padding:3px 8px;${act?"font-weight:600;":""}"><span>${esc(s.icon||"\u{1F642}")}</span><span>${esc(s.name)}</span><span data-rmscene="${esc(s.id)}" style="margin-left:2px;opacity:.6;padding:0 2px;">×</span></button>`);}h.push(`</div>`);}
  h.push(`<div class="char-section-title">当前角色</div>`);
  h.push(c?`<div class="char-current-info"><span class="char-avatar-large">${esc(c.icon||"\u{1F642}")}</span><span class="char-current-name">${esc(c.name)}</span><button class="char-rel-btn" data-clear>清除</button></div>`:`<div class="char-current-info" style="color:#888;">未选择角色卡（将以非角色模式发送）</div>`);
  // 4.17: 好感度进度条只在开发者模式可见(普通用户角色卡极简)
  if(isDev()&&c&&isAffOn()){const v=typeof _aff==="number"?_aff:AFF_INIT;const st=affStage(v);h.push(`<div class="char-aff-row" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:6px 0 8px;padding:6px 10px;border-radius:8px;border:1px solid;font-size:13px;"><span class="char-aff-stage" style="padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;">${esc(st?st.label:"")}</span><span class="char-aff-value" style="font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">${v}/100</span><div class="char-aff-bar" style="flex:1;height:6px;border-radius:3px;overflow:hidden;min-width:60px;"><div class="char-aff-fill" style="height:100%;width:${v}%;background:linear-gradient(90deg,#7d4fcc,#cc4f7d);transition:width .3s;"></div></div><button class="char-rel-btn" type="button" data-aff-step="-10" style="font-size:12px;padding:2px 8px;">-10</button><button class="char-rel-btn" type="button" data-aff-step="-1" style="font-size:12px;padding:2px 8px;">-1</button><button class="char-rel-btn" type="button" data-aff-step="1" style="font-size:12px;padding:2px 8px;">+1</button><button class="char-rel-btn" type="button" data-aff-step="10" style="font-size:12px;padding:2px 8px;">+10</button><input class="char-input" data-aff-set type="number" min="0" max="100" value="${v}" style="width:62px;font-size:12px;" title="直接输入好感度(0-100),回车生效"><button class="char-rel-btn" data-reset-aff style="font-size:12px;padding:2px 8px;">重置</button></div>`);}
  // 4.17: 关系/情绪按钮组废弃 -> 自由文本输入 (用户述求: "按钮太限制了")。
  // 兼容 worker: 关系自由文本通过 mapRel 关键词映射回 RELS enum; 情绪 setEmo 直接接受任意 string。
  const relText=localStorage.getItem("cfw_relation_text_v1")||"";
  const emoText=localStorage.getItem("cfw_emotion_text_v1")||"";
  h.push(`<div class="char-section-title">关系（可选）</div><input type="text" class="char-input" data-rel-text placeholder="如: 朋友 / 亦师亦友 / 暧昧不清 (留空 = 不约定关系)" value="${esc(relText)}">`);
  h.push(`<div class="char-section-title" style="margin-top:6px;">情绪（可选）</div><input type="text" class="char-input" data-emo-text placeholder="如: 平静 / 紧张到颤抖 / 强忍泪水 (留空 = 平静)" value="${esc(emoText)}">`);
  // 4.17 修正 v2: 情绪 enum 按钮完全删除; 关系 dev 模式仅保留 dom/sub 两个特殊倾向(其他 friendly/loving/hostile/fearful/default 靠 mapRel 自动映射)。
  if(isDev()){
    h.push(`<div class="char-section-title" style="margin-top:10px;">特殊关系倾向（开发者 · 当前: ${esc(r)}）</div><div class="char-relation-row">`);
    h.push(`<button class="char-rel-btn ${r==="dom"?"active":""}" data-rel="dom">${RLBL.dom}</button>`);
    h.push(`<button class="char-rel-btn ${r==="sub"?"active":""}" data-rel="sub">${RLBL.sub}</button>`);
    h.push(`<button class="char-rel-btn ${["dom","sub"].includes(r)?"":"active"}" data-rel="default">清除</button>`);
    h.push(`</div>`);
  }
  return h.join("");
}

async function mine(b){
  b.innerHTML=`<div class="char-section-title">我的角色卡</div><div class="char-grid" data-g></div>`;
  const g=b.querySelector("[data-g]");
  const a=await all();
  if(!a.length){g.outerHTML=`<div style="font-size:12px;color:#888;padding:6px 0;">还没有角色卡。切到「新建」自己写一张；或到设置里的「提示词编辑器 → 角色」导入现成的卡。</div>`;return;}
  const ai=localStorage.getItem(LSA)||"";
  const M=window.__multi;
  const isMultiOn=!!(M&&M.isMulti&&M.isMulti());
  const sids=new Set(isMultiOn?M.getSceneIds():[]);
  g.innerHTML=a.map(c=>`<div class="char-item ${c.id===ai?"active":""}" data-u="${esc(c.id)}"><div class="char-item-avatar">${esc(c.icon||"\u{1F642}")}</div><div class="char-item-name">${esc(c.name)}</div><div class="char-item-actions">${isMultiOn?`<button class="char-item-btn" data-s="${esc(c.id)}">${sids.has(c.id)?"−场景":"+场景"}</button>`:""}<button class="char-item-btn" data-e="${esc(c.id)}">改</button><button class="char-item-btn" data-d="${esc(c.id)}">删</button></div></div>`).join("");
  // 4.60 头像图:有图角色(cfw_char_avatar_v1)在卡网格也显示成图片,无图回退 emoji icon
  g.querySelectorAll("[data-u]").forEach(el=>{const _c=a.find(x=>x.id===el.dataset.u);const _av=el.querySelector(".char-item-avatar");if(_c&&_av)applyAvatarEl(_av,_c);});
  g.querySelectorAll("[data-u]").forEach(el=>el.addEventListener("click",(ev)=>{if(ev.target.closest("[data-e]")||ev.target.closest("[data-d]")||ev.target.closest("[data-s]"))return;setActive(el.dataset.u);setTimeout(render,30);}));
  g.querySelectorAll("[data-s]").forEach(x=>x.addEventListener("click",(ev)=>{ev.stopPropagation();if(!M)return;const id=x.dataset.s;if(sids.has(id))M.removeFromScene(id);else M.addToScene(id);setTimeout(render,30);}));
  g.querySelectorAll("[data-e]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();const ar=await all();const c=ar.find(y=>y.id===x.dataset.e);if(c){tab="new";render();editor(P.querySelector("[data-body]"),c);}}));
  g.querySelectorAll("[data-d]").forEach(x=>x.addEventListener("click",async(ev)=>{ev.stopPropagation();if(!confirm("删除这张角色卡？(将清除其好感度记录；绑定的设定集条目会转为全局保留)"))return;await del(x.dataset.d);try{if(window.__sync&&window.__sync.tombChar)window.__sync.tombChar(x.dataset.d);}catch(e){}await cascadeCleanupCard(x.dataset.d);if((localStorage.getItem(LSA)||"")===x.dataset.d)setActive("");setTimeout(render,30);}));
}



function thresholdRowHtml(th,i){
  const at=(th&&typeof th.at==="number")?th.at:60;
  const ins=th&&th.instruction?th.instruction:"";
  const dir=th&&th.dir?th.dir:"up";
  const escIns=String(ins).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  return `<div class="char-threshold-row" data-tr="${i}" style="display:flex;flex-direction:column;gap:4px;padding:6px 8px;margin-bottom:6px;border:1px solid;border-radius:6px;"><div style="display:flex;gap:6px;align-items:center;"><span style="font-size:11px;color:#888;">好感跨过</span><input class="char-input" data-tf="at" data-i="${i}" type="number" min="0" max="100" value="${at}" style="width:70px;"><select class="char-input" data-tf="dir" data-i="${i}" style="width:100px;"><option value="up" ${dir==="up"?"selected":""}>上升</option><option value="down" ${dir==="down"?"selected":""}>下降</option><option value="both" ${dir==="both"?"selected":""}>双向</option></select><button class="char-rel-btn" type="button" data-rm-threshold="${i}" style="font-size:11px;padding:2px 8px;margin-left:auto;">删除</button></div><textarea class="char-input" data-tf="instruction" data-i="${i}" rows="2" placeholder="跨阈值时一次性注入的指令。例：你第一次意识到对他的感情已超出朋友范围，但暂时不会主动说破。">${escIns}</textarea></div>`;
}

function editor(b,card){
  const isN=!card||!card.id;
  const c=card||{id:"",name:"",gender:"female",age:"",identity:"",enableAffection:true,icon:"\u{1F642}",personality:"",speakingStyle:"",rules:["","",""],openingLine:"",exampleQA:[{user:"",character:""},{user:"",character:""}],affectionThresholds:[]};
  while(c.rules.length<3)c.rules.push("");
  while(c.exampleQA.length<2)c.exampleQA.push({user:"",character:""});
  b.innerHTML=`<div class="char-edit-form">
    <label class="char-label">角色名</label><input class="char-input" data-f="name" value="${esc(c.name)}" placeholder="角色名称">
    <label class="char-label">性别</label><input class="char-input" data-f="gender" value="${esc(c.gender||"")}" placeholder="女 / 男 / 双性 / 无性别 / 自定义">
    <label class="char-label">年龄</label><input class="char-input" data-f="age" value="${esc(c.age||"")}" placeholder="如：18 / 二十出头 / 外貌16实际数百岁（影响立绘，建议填）">
    <label class="char-label">身份/背景</label><input class="char-input" data-f="identity" value="${esc(c.identity||"")}" placeholder="如：高中生 / 都市白领 / 古风修仙者（可空）">
    <label class="char-label">场景</label><input class="char-input" data-f="scenario" value="${esc(c.scenario||"")}" placeholder="如：雨夜的旧书店（对应 SillyTavern 的 scenario；可空）">
    <label class="char-label">头像（emoji）</label><input class="char-input" data-f="icon" value="${esc(c.icon)}" placeholder="\u{1F642}" maxlength="4" style="width:80px;">
    <label class="char-label">发图基准图</label>
    ${isN?`<div style="font-size:12px;color:#888;padding:4px 0;">保存角色后可在此设置发图基准图（用作微信发图/自拍的样貌锚点）。</div>`:`<div class="char-baseimg-row" style="display:flex;align-items:center;gap:10px;padding:4px 0;"><div data-baseimg-thumb style="width:64px;height:64px;border-radius:8px;border:1px solid;background-size:cover;background-position:center;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#888;">无</div><input type="file" accept="image/*" data-baseimg-file style="display:none;"><button class="char-rel-btn" type="button" data-baseimg-pick style="font-size:12px;padding:3px 10px;">上传/更换</button><button class="char-rel-btn" type="button" data-baseimg-clear style="font-size:12px;padding:3px 10px;">清除</button></div>`}
    ${isDev()?`<label class="char-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"><input type="checkbox" data-f="enableAff" ${c.enableAffection===false?"":"checked"}><span>启用好感度系统(开发者 · AI 用 [好感±N] 调整,初始 ${AFF_INIT})</span></label>`:""}
    ${isDev()?`<label class="char-label">好感度阈值事件（开发者模式 · 跨过分值时一次性触发剧情指令，重置好感度会清空触发记录）</label><br>    <div data-thresholds-wrap>${(c.affectionThresholds||[]).map((th,i)=>thresholdRowHtml(th,i)).join("")}</div><br>    <button class="char-rel-btn" type="button" data-add-threshold style="font-size:11px;padding:3px 10px;align-self:flex-start;">+ 添加阈值事件</button>`:""}
    <label class="char-label">性格关键词</label><input class="char-input" data-f="personality" value="${esc(c.personality)}" placeholder="如：包容、耐心">
    <label class="char-label">说话方式</label><input class="char-input" data-f="speakingStyle" value="${esc(c.speakingStyle)}" placeholder="如：轻声细语">
    <label class="char-label">行为铁则（3 条）</label>
    <input class="char-input" data-f="r0" value="${esc(c.rules[0])}" placeholder="铁则 1">
    <input class="char-input" data-f="r1" value="${esc(c.rules[1])}" placeholder="铁则 2">
    <input class="char-input" data-f="r2" value="${esc(c.rules[2])}" placeholder="铁则 3">
    <label class="char-label">开场白</label><input class="char-input" data-f="opening" value="${esc(c.openingLine)}" placeholder="第一句话">
    <label class="char-label">示例对话 1</label>
    <input class="char-input" data-f="q0u" value="${esc(c.exampleQA[0].user)}" placeholder="用户说">
    <input class="char-input" data-f="q0c" value="${esc(c.exampleQA[0].character)}" placeholder="角色回">
    <label class="char-label">示例对话 2</label>
    <input class="char-input" data-f="q1u" value="${esc(c.exampleQA[1].user)}" placeholder="用户说">
    <input class="char-input" data-f="q1c" value="${esc(c.exampleQA[1].character)}" placeholder="角色回">
    <div class="char-btn-row"><button class="char-rel-btn active" data-save>${isN?"新建":"保存修改"}</button><button class="char-rel-btn" data-back>返回</button></div>
  </div>`;
  // 4.17: 性别改自由文本输入(data-f="gender"),不再需要 enum 按钮 wire。
  // 阶段 4-②：阈值事件 add/delete 实时渲染
  let thrs=Array.isArray(c.affectionThresholds)?[...c.affectionThresholds]:[];
  function readThrInputs(){const w=b.querySelector("[data-thresholds-wrap]");if(!w)return;w.querySelectorAll("[data-tr]").forEach(rowEl=>{const i=parseInt(rowEl.dataset.tr,10);if(isNaN(i)||!thrs[i])return;const at=rowEl.querySelector('[data-tf="at"]');const dir=rowEl.querySelector('[data-tf="dir"]');const ins=rowEl.querySelector('[data-tf="instruction"]');if(at)thrs[i].at=Math.max(0,Math.min(100,parseInt(at.value,10)||0));if(dir)thrs[i].dir=dir.value||"up";if(ins)thrs[i].instruction=ins.value||"";});}
  function rerenderThr(){readThrInputs();const w=b.querySelector("[data-thresholds-wrap]");if(!w)return;w.innerHTML=thrs.map((t,i)=>thresholdRowHtml(t,i)).join("");wireThr();}
  function wireThr(){b.querySelectorAll("[data-rm-threshold]").forEach(x=>x.addEventListener("click",()=>{const i=parseInt(x.dataset.rmThreshold,10);if(!isNaN(i)){thrs.splice(i,1);rerenderThr();}}));}
  b.querySelector("[data-add-threshold]")?.addEventListener("click",()=>{thrs.push({at:60,instruction:"",dir:"up"});rerenderThr();});
  wireThr();
  // Bug① 角色卡内联发图基准图：缩略图 + 上传/更换/清除（复用 window.__chatImage 基准图契约 cfw_chat_base_v1）
  if(!isN&&c.id){
    const _biThumb=b.querySelector("[data-baseimg-thumb]");
    const _biFile=b.querySelector("[data-baseimg-file]");
    const _biRefresh=async()=>{try{const ci=window.__chatImage||window.__chatImageText;const url=(ci&&ci.getBaseImage)?await ci.getBaseImage({characterId:c.id}):null;if(_biThumb){if(url){_biThumb.style.backgroundImage='url("'+url+'")';_biThumb.textContent="";}else{_biThumb.style.backgroundImage="";_biThumb.textContent="无";}}}catch(e){}};
    b.querySelector("[data-baseimg-pick]")?.addEventListener("click",()=>{if(_biFile)_biFile.click();});
    _biFile?.addEventListener("change",()=>{const f=_biFile.files&&_biFile.files[0];if(!f)return;const rd=new FileReader();rd.onload=async()=>{try{const ci=window.__chatImage;if(ci&&ci.setBaseImage){await ci.setBaseImage({characterId:c.id,imageUrl:rd.result});await _biRefresh();}else{alert("发图模块未就绪，无法保存基准图");}}catch(e){alert("基准图保存失败："+((e&&e.message)||e));}};rd.readAsDataURL(f);});
    b.querySelector("[data-baseimg-clear]")?.addEventListener("click",async()=>{try{const ci=window.__chatImage;if(ci&&ci.clearBaseImage){await ci.clearBaseImage({characterId:c.id});await _biRefresh();}}catch(e){}});
    _biRefresh();
  }
  b.querySelector("[data-save]").addEventListener("click",async()=>{
    const g=(f)=>b.querySelector(`[data-f="${f}"]`).value.trim();
    const name=g("name");if(!name){alert("角色名不能为空");return;}
    readThrInputs();
    const cleanThr=thrs.filter(t=>t&&typeof t.at==="number"&&typeof t.instruction==="string"&&t.instruction.trim()).map(t=>({at:Math.max(0,Math.min(100,Math.round(t.at))),instruction:t.instruction.trim(),dir:["up","down","both"].includes(t.dir)?t.dir:"up"}));
    const s={id:c.id||"u_"+Date.now().toString(36),name,gender:g("gender"),age:g("age"),identity:g("identity"),scenario:g("scenario"),icon:g("icon")||"\u{1F642}",enableAffection:isDev()?!!b.querySelector('[data-f="enableAff"]')?.checked:(c.enableAffection!==false),personality:g("personality"),speakingStyle:g("speakingStyle"),rules:[g("r0"),g("r1"),g("r2")].filter(r=>r),openingLine:g("opening"),exampleQA:[{user:g("q0u"),character:g("q0c")},{user:g("q1u"),character:g("q1c")}].filter(q=>q.user||q.character),affectionThresholds:cleanThr,avatar:c.avatar||"",spec:c.spec||null};
    while(s.rules.length<3)s.rules.push("");
    while(s.exampleQA.length<2)s.exampleQA.push({user:"",character:""});
    await put(s);try{if(window.__sync&&window.__sync.bumpCharMeta)window.__sync.bumpCharMeta(s.id);}catch(e){}setActive(s.id);tab="mine";setTimeout(render,30);
  });
  b.querySelector("[data-back]").addEventListener("click",()=>{tab="mine";render();});
}

// 4.48: 给提示词编辑器「角色」页暴露 CRUD（共享同一 IDB tavern_chars_v2,单一数据源;增删改后 refresh+notif 触发 character:changed,与左栏实时一致）
async function getAllCards(){return await all();}
// 2026-10-06（角色卡格式固化）: 这里是**唯一**的写入口，四个写入方（左栏面板 / 编辑器 / agent 工具 / studio）都应该走它。
// 字段契约见 AGENTS.md「角色卡格式」；与 SillyTavern Card V2 的对应关系也写在那儿。
// 本次修掉三处老毛病：① gender 缺省被强写成 "female" —— 导入的卡全都会在 prompt 里输出「性别：女」；
//   ② description 与 scenario 被揉成一段 identity，两者语义不同（后者是"当前场景"）；
//   ③ 导入时被丢掉的字段（alternate_greetings/system_prompt/…）现在按原样存进 spec，导出时能还回去。
// spec = 导入时"用不上但也不能丢"的 SillyTavern 字段原样保存（导出时按 V2 还回去）。
// 只认白名单键，值做长度上限：这是从网上拿来的不可信 JSON，别把任意结构塞进 IDB。
function normalizeSpec(x){
  if(!x||typeof x!=="object")return null;
  const str=(v,n)=>typeof v==="string"?v.slice(0,n):"";
  const arr=(v,n)=>Array.isArray(v)?v.filter(t=>typeof t==="string").slice(0,n):[];
  const out={
    specVersion:str(x.specVersion,16),
    creator:str(x.creator,200),creatorNotes:str(x.creatorNotes,4000),characterVersion:str(x.characterVersion,60),
    systemPrompt:str(x.systemPrompt,20000),postHistoryInstructions:str(x.postHistoryInstructions,20000),
    alternateGreetings:arr(x.alternateGreetings,20),tags:arr(x.tags,40),
    extensions:(x.extensions&&typeof x.extensions==="object"&&!Array.isArray(x.extensions))?x.extensions:{},
  };
  const any=Object.keys(out).some(k=>k==="extensions"?Object.keys(out.extensions).length:Array.isArray(out[k])?out[k].length:String(out[k]||"").length);
  return any?out:null;
}
async function saveCard(c){
  if(!c||typeof c!=="object")throw new Error("invalid card");
  const name=(c.name||"").trim();if(!name)throw new Error("角色名不能为空");
  const card={id:c.id||("u_"+Date.now().toString(36)),name,gender:c.gender||"",age:c.age||"",identity:c.identity||"",scenario:c.scenario||"",icon:c.icon||"🙂",enableAffection:c.enableAffection!==false,personality:c.personality||"",speakingStyle:c.speakingStyle||"",rules:Array.isArray(c.rules)?c.rules.slice(0,3):["","",""],openingLine:c.openingLine||"",exampleQA:Array.isArray(c.exampleQA)?c.exampleQA.slice(0,2).map(q=>({user:(q&&q.user)||"",character:(q&&q.character)||""})):[],affectionThresholds:Array.isArray(c.affectionThresholds)?c.affectionThresholds:[],avatar:c.avatar||"",spec:normalizeSpec(c.spec)};
  while(card.rules.length<3)card.rules.push("");
  while(card.exampleQA.length<2)card.exampleQA.push({user:"",character:""});
  await put(card);try{if(window.__sync&&window.__sync.bumpCharMeta)window.__sync.bumpCharMeta(card.id);}catch(e){}await refresh();notif();return card;
}
// 4.51 P5 联调: 删角色卡时级联清理其残留数据(避免孤儿)——好感度记录/阈值触发/待注入事件/场景成员；绑定的 perCard 世界书条目改为「解绑」(转回 global 保留,不删除)
async function cascadeCleanupCard(id){
  if(!id)return;
  try{await affDelDb(id);}catch(e){}
  try{localStorage.removeItem(LSAT_PREFIX+id);}catch(e){}
  try{const pend=JSON.parse(localStorage.getItem(LSPE)||"[]");if(Array.isArray(pend)){const left=pend.filter(ev=>!ev||ev.cardId!==id);if(left.length)localStorage.setItem(LSPE,JSON.stringify(left));else localStorage.removeItem(LSPE);}}catch(e){}
  try{if(window.__multi&&typeof window.__multi.removeFromScene==="function")window.__multi.removeFromScene(id);}catch(e){}
  try{if(window.__lorebook&&typeof window.__lorebook.getAll==="function"&&typeof window.__lorebook.saveEntry==="function"){const list=window.__lorebook.getAll();if(Array.isArray(list))list.forEach(en=>{if(en&&en.scope==="perCard"&&en.boundCardId===id)window.__lorebook.saveEntry({...en,scope:"global",boundCardId:null});});}}catch(e){}
}
async function deleteCard(id){
  if(!id)return;
  await del(id);
  try{if(window.__sync&&window.__sync.tombChar)window.__sync.tombChar(id);}catch(e){}
  await cascadeCleanupCard(id);
  if((localStorage.getItem(LSA)||"")===id){setActive("");}else{await refresh();notif();}
}
window.__character={open,close,getActiveCard:getCard,setActiveId:setActive,getActiveRelation:getRel,setActiveRelation:setRel,getActiveEmotion:getEmo,setActiveEmotion:setEmo,getActiveAffection:getAff,setActiveAffection:setAff,adjustActiveAffection:adjustAff,resetActiveAffection:resetAff,parseAffectionTag:parseAffTag,decorateAiRow:decorate,listAllCards,getAllCards,saveCard,deleteCard,getPendingThresholdEvents,clearPendingThresholdEvents,resetThresholdTriggers,relations:RELS,builtinEmotions:EMS,reload:async()=>{await refresh();notif();try{if(mask&&mask.style.display!=="none")render();}catch(e){}}};
// 2026-10-06: 这里原来是 await loadArchetypes() 再 refresh()（等原型库加载完，避免 arch_* 的卡被误清）。
// 原型库已删（见上方注释），启动直接 refresh。
refresh();
// 4.17: 角色卡按钮仅短按打开。dev mode easter-egg(长按 GitHub) + 🛠 角标 + Prompt 调试面板已全部搬到 dev.js。
document.addEventListener("DOMContentLoaded",()=>{const b=document.getElementById("characterBtn");if(b)b.addEventListener("click",open);});
})();

// 2026-09-14: 移除 4.55 的设置页「当前角色」快切卡 —— 单角色扮演时代的产物,与多分支/多智能体方向过时;
// 角色切换统一走左栏「角色卡」面板(window.__character.setActiveId 能力保留未动)。