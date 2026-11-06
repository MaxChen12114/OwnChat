// public/studio/app.js — 创作工坊（写故事抽角色 + 角色卡一键配图）
// 纯前端：① 写故事 → 一键解析为角色卡(IDB tavern_chars_v2) + 世界书(LS tavern_lorebook_v1)；② 角色卡一键配图（z-image 立绘 → 写入卡片 avatar 字段）。
// 复用 /api/chat（文本·服务端持密钥·流式）与 /img/v1/*（图像·需「图像工坊」标签内填入的 API Key）；模型下拉从 /config.js 下发的 window.APP_MODELS_* 动态生成，与聊天页一致。
(function(){
"use strict";
var $=function(s){return document.querySelector(s);};
var el=function(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;};
var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});};
var SVG_USER='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
var SVG_GLOBE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 2.6 15.3 0 18c-2.6-2.7-2.6-15.3 0-18z"/></svg>';
var SVG_IMG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.2"/><circle cx="8.5" cy="10" r="1.7"/><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4"/></svg>';

var toastT=null;
// 2026-09-14 UI第一轮:统一反馈组件代理 —— __feedback 在则转发,缺失回退 #toast 原实现
function toast(msg){if(window.__feedback&&window.__feedback.toast)return window.__feedback.toast(msg,{ms:2800});var t=$("#toast");t.textContent=msg;t.hidden=false;clearTimeout(toastT);toastT=setTimeout(function(){t.hidden=true;},2800);}

// ====== 模型下拉（与聊天页一致，可任选） ======
// /config.js 会下发 window.APP_MODELS_FREE / window.APP_MODELS_FAST；若未加载则用内置同步名单。
var FALLBACK_FREE=[{id:"deepseek-ai/deepseek-v4-pro",label:"deepseek-v4-pro"},{id:"z-ai/glm-5.1",label:"glm-5.1"},{id:"openai/gpt-oss-120b",label:"gpt-oss-120b"}];
var FALLBACK_FAST=[{id:"deepseek-v4-flash",label:"DeepSeek V4-Flash"},{id:"deepseek-v4-pro",label:"DeepSeek V4-Pro"}];
var LS_MODEL="cfw_studio_model_v1";
function modelList(which){
  var g=(which==="free")?window.APP_MODELS_FREE:window.APP_MODELS_FAST;
  // 2026-09-14:/config.js 总会注入一条"请在设置里拉取"的**占位模型**,不过滤的话它会成为下拉里
  // 可选的假模型(选中发出去必然失败)。过滤后为空才回落到本页内置名单。
  if(Array.isArray(g))g=g.filter(function(m){return m&&m.id&&m.id.indexOf("__")!==0;});
  if(g&&g.length)return g;
  return which==="free"?FALLBACK_FREE:FALLBACK_FAST;
}
function addGroup(sel,label,which){
  var og=document.createElement("optgroup");og.label=label;
  modelList(which).forEach(function(m){
    var o=document.createElement("option");
    o.value=which+"::"+m.id;
    o.textContent=m.label||m.id;
    o.setAttribute("data-mode",which);
    o.setAttribute("data-model",m.id);
    og.appendChild(o);
  });
  sel.appendChild(og);
}
function buildModels(){
  var sel=$("#model");if(!sel)return;
  sel.innerHTML="";
  addGroup(sel,"免费模式 · NVIDIA NIM","free");
  addGroup(sel,"高速模式 · DeepSeek 官方","fast");
  var saved=localStorage.getItem(LS_MODEL);
  if(saved){for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===saved){sel.selectedIndex=i;break;}}}
  sel.addEventListener("change",function(){localStorage.setItem(LS_MODEL,sel.value);});
}
function selModel(){
  var sel=$("#model");var o=sel&&sel.options[sel.selectedIndex];
  if(o&&o.getAttribute("data-mode"))return {mode:o.getAttribute("data-mode"),model:o.getAttribute("data-model")};
  return {mode:"free",model:undefined};
}


// ---- /api/chat 流式调用 ----
async function callChat(opts){
  var body={ mode:opts.mode||"free", model:opts.model, promptProfile:"rp", use_builtin_persona:true, custom_system_prompt:opts.system, thinking:"disabled", messages:[{role:"user",content:opts.user}] };
  try{var _bid=localStorage.getItem("cfw_base_id_v1")||"";if(_bid)body.baseId=_bid;}catch(e){}
  
  var r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:opts.signal});
  if(!r.ok){var t="";try{t=await r.text();}catch(e){}throw new Error("服务返回 "+r.status+(t?(" · "+t.slice(0,160)):""));}
  var reader=r.body.getReader(),dec=new TextDecoder(),buf="",full="";
  while(true){
    var rd=await reader.read();if(rd.done)break;
    buf+=dec.decode(rd.value,{stream:true});
    var i;
    while((i=buf.indexOf("\n"))>=0){
      var line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line||line.charAt(0)===":")continue;
      if(line.indexOf("data:")!==0)continue;
      var data=line.slice(5).trim();
      if(data==="[DONE]")continue;
      try{var j=JSON.parse(data);var d=j&&j.choices&&j.choices[0]&&j.choices[0].delta&&j.choices[0].delta.content;if(d){full+=d;if(opts.onDelta)opts.onDelta(full);}}catch(e){}
    }
  }
  return full;
}

// ====== 提示词（默认值 + 可编辑持久化） ======
var DEF_STORY="你是一位擅长人物塑造的中文小说作者。根据用户给的种子设定，写一段完整、有画面感的故事或设定稿，重点把出场人物的性格、说话方式、彼此关系和所处世界观写清楚，方便后续抽取成可聊天的角色卡。800-1500 字，可包含对话。直接输出正文，不要标题、不要解释。";
var DEF_EXTRACT=[
"你是一个「角色卡 + 世界书」抽取器。读用户给的故事，抽取其中适合做成可聊天角色的人物，以及适合长期记忆的世界观设定。",
"只输出一个 JSON 对象，禁止任何解释、前后缀或代码围栏。结构：",
'{"characters":[{"name":"","gender":"女/男/其他","age":"","identity":"一句话身份背景","personality":"性格关键词，逗号分隔","speakingStyle":"说话风格","rules":["铁则1","铁则2","铁则3"],"openingLine":"符合人设的开场白","exampleQA":[{"user":"","character":""},{"user":"","character":""}]}],"lorebook":[{"name":"设定名","keywords":["触发词"],"content":"设定内容","alwaysOn":false}]}',
"要求：",
"- 主要角色最多 4 个，信息尽量贴合故事，缺失之处合理补全；",
"- 世界书 3-8 条（地点/阵营/专有名词/世界规则等），核心世界观设 alwaysOn:true，其余给准确的 keywords；",
"- 每个角色 rules 给 2-3 条，exampleQA 给 1-2 组真实可用的对话；",
"- 全部用中文（专有名词可保留原文）。只返回 JSON。"
].join("\n");
function loadPrompts(){
  if($("#sysStory"))$("#sysStory").value=localStorage.getItem(LS_STORY)||DEF_STORY;
  if($("#sysExtract"))$("#sysExtract").value=localStorage.getItem(LS_EXTRACT)||DEF_EXTRACT;
}
function wirePrompts(){
  var map=[["#sysStory",LS_STORY],["#sysExtract",LS_EXTRACT]];
  map.forEach(function(p){var e=$(p[0]);if(e)e.addEventListener("input",function(){localStorage.setItem(p[1],e.value);});});
  var rb=$("#promptReset");
  if(rb)rb.addEventListener("click",function(){localStorage.removeItem(LS_STORY);localStorage.removeItem(LS_EXTRACT);loadPrompts();if($("#promptHint"))$("#promptHint").textContent="已恢复默认提示词";});
}
function storySys(){return ($("#sysStory")&&$("#sysStory").value.trim())||DEF_STORY;}
function extractSys(){return ($("#sysExtract")&&$("#sysExtract").value.trim())||DEF_EXTRACT;}

// ====== Step 1: 写故事 ======
var genAbort=null;
async function doGen(){
  var seed=$("#seed").value.trim();
  var sys=storySys();
  var user=seed?("种子设定：\n"+seed):"自由发挥，写一个有记忆点的人物群像故事。";
  var m=selModel();
  var storyEl=$("#story");storyEl.value="";
  $("#gen").disabled=true;$("#stop").hidden=false;
  genAbort=new AbortController();
  try{
    await callChat({mode:m.mode,model:m.model,system:sys,user:user,signal:genAbort.signal,onDelta:function(full){storyEl.value=full;storyEl.scrollTop=storyEl.scrollHeight;}});
  }catch(e){ if(e.name!=="AbortError")toast("生成失败："+e.message); }
  finally{ $("#gen").disabled=false;$("#stop").hidden=true;genAbort=null; }
}

// ====== Step 2: 解析 ======
function parseJSON(txt){
  if(!txt)return null;
  var s=txt.split(String.fromCharCode(96)).join("").trim();
  var a=s.indexOf("{"),b=s.lastIndexOf("}");
  if(a<0||b<0||b<a)return null;
  try{return JSON.parse(s.slice(a,b+1));}catch(e){return null;}
}

var lastData={characters:[],lorebook:[]};
async function doExtract(){
  var story=$("#story").value.trim();
  if(!story){toast("先写点故事再解析");return;}
  var m=selModel();
  $("#extract").disabled=true;$("#exhint").textContent="解析中……";
  $("#result").innerHTML="";$("#savePanel").hidden=true;
  try{
    var raw=await callChat({mode:m.mode,model:m.model,system:extractSys(),user:"故事原文：\n\n"+story});
    var data=parseJSON(raw);
    if(!data||(!Array.isArray(data.characters)&&!Array.isArray(data.lorebook)))throw new Error("没解析出结构化结果，可重试或换高速模式");
    lastData={characters:Array.isArray(data.characters)?data.characters:[],lorebook:Array.isArray(data.lorebook)?data.lorebook:[]};
    renderResult();
    $("#exhint").textContent="解析完成，勾选要保存的项";
  }catch(e){ $("#exhint").textContent="";toast("解析失败："+e.message); }
  finally{ $("#extract").disabled=false; }
}

function field(label,val,key,idx,multiline){
  if(multiline)return '<div class="fld"><label>'+esc(label)+'</label><textarea data-k="'+key+'" data-i="'+idx+'" rows="2">'+esc(val)+'</textarea></div>';
  return '<div class="fld"><label>'+esc(label)+'</label><input data-k="'+key+'" data-i="'+idx+'" value="'+esc(val)+'" /></div>';
}

function renderResult(){
  var R=$("#result");R.innerHTML="";
  if(lastData.characters.length){
    R.appendChild(el("div","grp-title",SVG_USER+"<span>角色（"+lastData.characters.length+"）</span>"));
    lastData.characters.forEach(function(c,idx){
      var rules=Array.isArray(c.rules)?c.rules.join("｜"):(c.rules||"");
      var qa=Array.isArray(c.exampleQA)?c.exampleQA:[];
      var q0=qa[0]||{},q1=qa[1]||{};
      var box=el("div","item char");
      box.innerHTML=
        '<div class="item-head"><input type="checkbox" class="inc-c" data-i="'+idx+'" checked /><span class="nm">'+esc(c.name||"未命名角色")+'</span></div>'+
        '<div class="fld two"><div>'+field("角色名",c.name||"","name",idx)+'</div><div>'+field("性别",c.gender||"","gender",idx)+'</div></div>'+
        field("年龄",c.age||"","age",idx)+
        field("身份/背景",c.identity||"","identity",idx)+
        field("性格关键词",c.personality||"","personality",idx)+
        field("说话方式",c.speakingStyle||"","speakingStyle",idx)+
        field("行为铁则（｜ 分隔）",rules,"rules",idx)+
        field("开场白",c.openingLine||"","openingLine",idx,true)+
        '<div class="fld two"><div>'+field("示例·用户说",q0.user||"","q0u",idx)+'</div><div>'+field("示例·角色回",q0.character||"","q0c",idx)+'</div></div>'+
        '<div class="fld two"><div>'+field("示例2·用户说",q1.user||"","q1u",idx)+'</div><div>'+field("示例2·角色回",q1.character||"","q1c",idx)+'</div></div>'+
        '<div class="portrait-row"><button type="button" class="gen-portrait" data-i="'+idx+'">'+SVG_IMG+'<span>一键配图</span></button><span class="portrait-hint" data-i="'+idx+'"></span></div>'+
        '<div class="portrait-preview" data-i="'+idx+'"'+(c._portrait?"":" hidden")+'>'+(c._portrait?('<img alt="角色立绘" src="'+esc(c._portrait)+'" /><div class="portrait-actions"><button type="button" class="portrait-dl">下载</button><button type="button" class="portrait-regen" data-i="'+idx+'">重新生成</button></div>'):"")+'</div>';
      R.appendChild(box);
    });
  }
  if(lastData.lorebook.length){
    R.appendChild(el("div","grp-title",SVG_GLOBE+"<span>世界书（"+lastData.lorebook.length+"）</span>"));
    lastData.lorebook.forEach(function(w,idx){
      var kw=Array.isArray(w.keywords)?w.keywords.join("，"):(w.keywords||"");
      var box=el("div","item lore");
      box.innerHTML=
        '<div class="item-head"><input type="checkbox" class="inc-w" data-i="'+idx+'" checked /><span class="nm">'+esc(w.name||"设定")+'</span><label class="chk"><input type="checkbox" class="lore-always" data-i="'+idx+'" '+(w.alwaysOn?"checked":"")+' /> 常驻</label></div>'+
        field("设定名",w.name||"","lname",idx)+
        field("触发词（，分隔；常驻可空）",kw,"lkw",idx)+
        field("设定内容",w.content||"","lcontent",idx,true);
      R.appendChild(box);
    });
  }
  R.querySelectorAll(".inc-c,.inc-w").forEach(function(cb){
    var box=cb.closest(".item");
    cb.addEventListener("change",function(){box.classList.toggle("off",!cb.checked);});
  });
  $("#savePanel").hidden=!(lastData.characters.length||lastData.lorebook.length);
}

function readField(idx,key){var e=$('#result [data-k="'+key+'"][data-i="'+idx+'"]');return e?e.value.trim():"";}

// ====== Step 3: 落地 ======
function openDB(){return new Promise(function(res,rej){var q=indexedDB.open("tavern_chars_v2",2);q.onupgradeneeded=function(){var d=q.result;if(!d.objectStoreNames.contains("chars"))d.createObjectStore("chars",{keyPath:"id"});if(!d.objectStoreNames.contains("affections"))d.createObjectStore("affections",{keyPath:"cardId"});};q.onsuccess=function(){res(q.result);};q.onerror=function(){rej(q.error);};});}
function putCard(card){return openDB().then(function(d){return new Promise(function(res,rej){var t=d.transaction("chars","readwrite");t.objectStore("chars").put(card);t.oncomplete=function(){res();};t.onerror=function(){rej(t.error);};});});}

function iconFor(gender){var g=String(gender||"");if(/男|male|boy/i.test(g))return "\ud83e\uddd1";if(/女|female|girl/i.test(g))return "\ud83d\udc69";return "\ud83d\ude42";}

function buildCard(idx){
  var name=readField(idx,"name");if(!name)return null;
  var rules=readField(idx,"rules").split(/[｜|]/).map(function(s){return s.trim();}).filter(Boolean).slice(0,3);
  while(rules.length<3)rules.push("");
  var qa=[{user:readField(idx,"q0u"),character:readField(idx,"q0c")},{user:readField(idx,"q1u"),character:readField(idx,"q1c")}];
  var gender=readField(idx,"gender");   // 2026-10-06: 不再强写 female —— 字段缺失就该是空的（参见 AGENTS.md 角色卡格式）
  var portrait=(lastData.characters[idx]&&lastData.characters[idx]._portrait)||"";
  return {
    id:"u_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
    // 字段契约见 AGENTS.md「角色卡格式」：本页是独立页面（不加载 character.js），写卡字段必须与
    // character.js 的 saveCard 白名单保持一致 —— 改一处就得改两处。
    name:name, gender:gender, age:readField(idx,"age"), identity:readField(idx,"identity"),
    scenario:"", spec:null,
    icon:iconFor(gender), avatar:portrait, enableAffection:true,
    personality:readField(idx,"personality"), speakingStyle:readField(idx,"speakingStyle"),
    rules:rules, openingLine:readField(idx,"openingLine"),
    exampleQA:qa, affectionThresholds:[]
  };
}

function buildLore(idx){
  var content=readField(idx,"lcontent");if(!content)return null;
  var always=!!$('#result .lore-always[data-i="'+idx+'"]:checked');
  var kws=readField(idx,"lkw").split(/[,，;；\n]/).map(function(s){return s.trim();}).filter(Boolean);
  return {
    id:"lb_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    name:readField(idx,"lname"), keywords:kws, content:content,
    alwaysOn:always, priority:0, scope:"global", boundCardId:"", enabled:true, source:"studio"
  };
}

function saveLore(entries){
  if(!entries.length)return;
  var raw=[];try{raw=JSON.parse(localStorage.getItem("tavern_lorebook_v1")||"[]");if(!Array.isArray(raw))raw=[];}catch(e){raw=[];}
  raw=raw.concat(entries);
  localStorage.setItem("tavern_lorebook_v1",JSON.stringify(raw));
  try{window.dispatchEvent(new Event("lorebook:changed"));}catch(e){}
}

async function doSave(){
  var R=$("#result");if(!R)return;
  var cards=[],lores=[];
  Array.prototype.forEach.call(R.querySelectorAll(".inc-c"),function(cb){if(cb.checked){var card=buildCard(parseInt(cb.dataset.i,10));if(card)cards.push(card);}});
  Array.prototype.forEach.call(R.querySelectorAll(".inc-w"),function(cb){if(cb.checked){var w=buildLore(parseInt(cb.dataset.i,10));if(w)lores.push(w);}});
  if(!cards.length&&!lores.length){toast("没有勾选任何项");return;}
  $("#save").disabled=true;$("#savehint").textContent="保存中……";
  try{
    var nC=0;
    for(var i=0;i<cards.length;i++){await putCard(cards[i]);nC++;}
    saveLore(lores);
    var nW=lores.length;
    $("#savehint").textContent="已保存 "+nC+" 个角色、"+nW+" 条世界书 —— 回酒馆即可使用";
    toast("已保存 "+nC+" 个角色 / "+nW+" 条世界书");
  }catch(e){ $("#savehint").textContent="";toast("保存失败："+e.message); }
  finally{ $("#save").disabled=false; }
}

// ====== 角色一键配图（z-image 立绘 -> 写入角色卡 avatar）======
function portraitPrompt(idx){
  var gender=readField(idx,"gender"),age=readField(idx,"age"),identity=readField(idx,"identity"),personality=readField(idx,"personality");
  var who=[];if(gender)who.push(gender);if(age)who.push(age+"岁");
  var parts=[];if(who.length)parts.push(who.join(""));if(identity)parts.push(identity);if(personality)parts.push("性格气质："+personality);
  return parts.filter(Boolean).join("，");
}
async function expandPortraitPrompt(idx){
  var base=portraitPrompt(idx);
  try{
    var sys="你是文生图提示词师。根据角色信息写一段「半身立绘」提示词，聚焦外貌、发型、服饰、神态、光影、画风，单人、看向镜头、干净背景。只输出提示词本身，60-120 字，不分点、不解释。";
    var out=await callChat({mode:"free",model:undefined,system:sys,user:"角色信息："+base});
    out=(out||"").trim();
    if(out.length>=10)return out+"，single character, half-body portrait, looking at viewer, clean background, masterpiece, best quality, ultra detailed";
  }catch(e){}
  return base+"，半身立绘，单人，看向镜头，干净背景，masterpiece, best quality";
}
function imgKey(){try{if(window.__imageCommon&&window.__imageCommon.getKey)return window.__imageCommon.getKey();}catch(e){}return (localStorage.getItem("moark_api_key")||"").trim();}
function blobToDataUrl(blob){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result);};fr.onerror=function(){rej(fr.error);};fr.readAsDataURL(blob);});}
function shrinkDataUrl(dataUrl,maxPx,quality){
  return new Promise(function(res){
    var img=new Image();
    img.onload=function(){
      var w=img.naturalWidth||img.width,h=img.naturalHeight||img.height,scale=Math.min(1,maxPx/Math.max(w,h));
      var cw=Math.max(1,Math.round(w*scale)),ch=Math.max(1,Math.round(h*scale));
      var cv=document.createElement("canvas");cv.width=cw;cv.height=ch;
      try{cv.getContext("2d").drawImage(img,0,0,cw,ch);res(cv.toDataURL("image/jpeg",quality||0.85));}catch(e){res(dataUrl);}
    };
    img.onerror=function(){res(dataUrl);};
    img.src=dataUrl;
  });
}
async function genPortrait(prompt){
  var key=imgKey();
  if(!key)throw new Error("缺少图像 API Key：先到「图像工坊」标签填入并勾「记住」");
  var res=await fetch("/img/v1/images/generations",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt,model:"z-image-turbo",n:1,size:"768x1024"})});
  var txt="";try{txt=await res.text();}catch(e){}
  var j=null;try{j=JSON.parse(txt);}catch(e){}
  if(!res.ok)throw new Error("出图失败 "+res.status+(txt?(" · "+txt.slice(0,120)):""));
  var data=(j&&Array.isArray(j.data))?j.data:[];
  if(!data.length)throw new Error("接口未返回图片");
  var it=data[0]||{};
  var full;
  if(it.b64_json)full="data:image/png;base64,"+it.b64_json;
  else if(it.url){var r=await fetch("/img/dl?url="+encodeURIComponent(it.url));if(!r.ok)throw new Error("图片下载失败 "+r.status);full=await blobToDataUrl(await r.blob());}
  else throw new Error("返回数据里没有图片");
  return await shrinkDataUrl(full,768,0.85);
}
function dlDataUrl(dataUrl,filename){var a=document.createElement("a");a.href=dataUrl;a.download=filename;document.body.appendChild(a);a.click();a.remove();}
async function runPortrait(idx,box){
  if(!box)return;
  var btn=box.querySelector(".gen-portrait"),hint=box.querySelector(".portrait-hint"),prev=box.querySelector(".portrait-preview");
  if(btn)btn.disabled=true;
  try{
    if(hint)hint.textContent="构思画面…";
    var p=await expandPortraitPrompt(idx);
    if(hint)hint.textContent="出图中（约 10-30 秒）…";
    var dataUrl=await genPortrait(p);
    if(lastData.characters[idx])lastData.characters[idx]._portrait=dataUrl;
    if(prev){prev.hidden=false;prev.innerHTML='<img alt="角色立绘" src="'+dataUrl+'" /><div class="portrait-actions"><button type="button" class="portrait-dl">下载</button><button type="button" class="portrait-regen" data-i="'+idx+'">重新生成</button></div>';}
    if(hint)hint.textContent="已生成 · 保存角色时会一并写入";
  }catch(e){ if(hint)hint.textContent=""; toast("配图失败："+e.message); }
  finally{ if(btn)btn.disabled=false; }
}
function wirePortrait(){
  var R=$("#result");if(!R)return;
  R.addEventListener("click",function(e){
    var g=e.target.closest&&e.target.closest(".gen-portrait");
    if(g){runPortrait(parseInt(g.getAttribute("data-i"),10),g.closest(".item"));return;}
    var re=e.target.closest&&e.target.closest(".portrait-regen");
    if(re){runPortrait(parseInt(re.getAttribute("data-i"),10),re.closest(".item"));return;}
    var dl=e.target.closest&&e.target.closest(".portrait-dl");
    if(dl){var img=dl.closest(".item").querySelector(".portrait-preview img");if(img)dlDataUrl(img.getAttribute("src"),"portrait_"+Date.now()+".jpg");return;}
  });
}
function injectPortraitStyle(){
  var css=".portrait-row{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}.gen-portrait{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.08);color:inherit;cursor:pointer;font-size:13px}.gen-portrait:hover{background:rgba(127,127,127,.16)}.gen-portrait:disabled{opacity:.5;cursor:default}.gen-portrait svg{width:15px;height:15px}.portrait-hint{font-size:12px;opacity:.72}.portrait-preview{margin-top:8px}.portrait-preview img{max-width:220px;border-radius:10px;display:block;border:1px solid rgba(127,127,127,.25)}.portrait-actions{display:flex;gap:8px;margin-top:6px}.portrait-actions button{font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}.portrait-actions button:hover{background:rgba(127,127,127,.12)}";
  var s=document.createElement("style");s.textContent=css;document.head.appendChild(s);
}

// ====== 图文融合（按段落手动配图：每段旁边点「配图」，图插在该段下方）======
var fuseState=[]; // [{text,img}]
function splitParas(txt){return String(txt||"").split(/\n\s*\n/).map(function(s){return s.trim();}).filter(Boolean);}
function renderFuse(){
  var V=$("#fuseView");if(!V)return;
  V.innerHTML="";
  if(!fuseState.length){V.innerHTML='<div class="fuse-empty">先在上面写好故事，再点「排版配图」。</div>';return;}
  fuseState.forEach(function(p,idx){
    var block=el("div","fuse-para");
    var imgHtml=p.img?('<div class="fuse-img"><img alt="配图" src="'+esc(p.img)+'" /><div class="fuse-img-actions"><button type="button" class="fuse-regen" data-i="'+idx+'">重配</button><button type="button" class="fuse-dl" data-i="'+idx+'">下载</button><button type="button" class="fuse-rm" data-i="'+idx+'">移除图</button></div></div>'):"";
    block.innerHTML=
      '<div class="fuse-txt">'+esc(p.text).split("\n").join("<br>")+'</div>'+
      '<div class="fuse-ctrl"><button type="button" class="fuse-gen" data-i="'+idx+'">'+SVG_IMG+'<span>'+(p.img?"换张图":"为这段配图")+'</span></button><span class="fuse-phint" data-i="'+idx+'"></span></div>'+
      imgHtml;
    V.appendChild(block);
  });
}
function enterFuse(){
  var story=$("#story").value.trim();
  if(!story){toast("先写点故事再排版");return;}
  var paras=splitParas(story);
  if(!paras.length){toast("没识别到段落");return;}
  var prev={};fuseState.forEach(function(p){if(p.img)prev[p.text]=p.img;});
  fuseState=paras.map(function(t){return {text:t,img:prev[t]||""};});
  renderFuse();
  if($("#fuseCopy"))$("#fuseCopy").hidden=false;
  if($("#fuseExport"))$("#fuseExport").hidden=false;
  if($("#fuseHint"))$("#fuseHint").textContent="共 "+paras.length+" 段 · 给想配图的段落点「为这段配图」";
}
async function fuseScenePrompt(text){
  try{
    var sys="你是文生图提示词师。根据给定的小说段落，提炼最适合作为这段配图的画面，写一段文生图提示词，聚焦场景、人物动作神态、光影氛围、画风。只输出提示词本身，60-120 字，不分点、不解释。";
    var out=await callChat({mode:"free",model:undefined,system:sys,user:"段落：\n"+text.slice(0,600)});
    out=(out||"").trim();
    if(out.length>=10)return out+"，cinematic, detailed background, masterpiece, best quality, ultra detailed";
  }catch(e){}
  return text.slice(0,120)+"，场景插画，cinematic, masterpiece, best quality";
}
async function genSceneImage(prompt){
  var key=imgKey();
  if(!key)throw new Error("缺少图像 API Key：先到「图像工坊」标签填入并勾「记住」");
  var res=await fetch("/img/v1/images/generations",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt,model:"z-image-turbo",n:1,size:"1024x768"})});
  var txt="";try{txt=await res.text();}catch(e){}
  var j=null;try{j=JSON.parse(txt);}catch(e){}
  if(!res.ok)throw new Error("出图失败 "+res.status+(txt?(" · "+txt.slice(0,120)):""));
  var data=(j&&Array.isArray(j.data))?j.data:[];
  if(!data.length)throw new Error("接口未返回图片");
  var it=data[0]||{};var full;
  if(it.b64_json)full="data:image/png;base64,"+it.b64_json;
  else if(it.url){var r=await fetch("/img/dl?url="+encodeURIComponent(it.url));if(!r.ok)throw new Error("图片下载失败 "+r.status);full=await blobToDataUrl(await r.blob());}
  else throw new Error("返回数据里没有图片");
  return await shrinkDataUrl(full,1024,0.85);
}
async function runFusePara(idx){
  var p=fuseState[idx];if(!p)return;
  var hint=$('#fuseView .fuse-phint[data-i="'+idx+'"]');
  var btn=$('#fuseView .fuse-gen[data-i="'+idx+'"]');
  if(btn)btn.disabled=true;
  try{
    if(hint)hint.textContent="构思画面…";
    var prompt=await fuseScenePrompt(p.text);
    if(hint)hint.textContent="出图中（约 10-30 秒）…";
    var img=await genSceneImage(prompt);
    fuseState[idx].img=img;
    renderFuse();
  }catch(e){ if(hint)hint.textContent=""; toast("配图失败："+e.message); }
  finally{ if(btn)btn.disabled=false; }
}
function fuseToHtml(){
  return '<article>'+fuseState.map(function(p){
    var t='<p>'+esc(p.text).split("\n").join("<br>")+'</p>';
    var im=p.img?('<p><img src="'+esc(p.img)+'" style="max-width:100%;border-radius:10px" /></p>'):"";
    return t+im;
  }).join("\n")+'</article>';
}
function wireFuse(){
  var fb=$("#fuse");if(fb)fb.addEventListener("click",enterFuse);
  var V=$("#fuseView");
  if(V)V.addEventListener("click",function(e){
    var g=e.target.closest&&e.target.closest(".fuse-gen");if(g){runFusePara(parseInt(g.getAttribute("data-i"),10));return;}
    var rg=e.target.closest&&e.target.closest(".fuse-regen");if(rg){runFusePara(parseInt(rg.getAttribute("data-i"),10));return;}
    var dl=e.target.closest&&e.target.closest(".fuse-dl");if(dl){var i=parseInt(dl.getAttribute("data-i"),10);if(fuseState[i]&&fuseState[i].img)dlDataUrl(fuseState[i].img,"scene_"+i+"_"+Date.now()+".jpg");return;}
    var rm=e.target.closest&&e.target.closest(".fuse-rm");if(rm){var k=parseInt(rm.getAttribute("data-i"),10);if(fuseState[k]){fuseState[k].img="";renderFuse();}return;}
  });
  var cp=$("#fuseCopy");
  if(cp)cp.addEventListener("click",function(){
    var hasImg=fuseState.some(function(p){return p.img;});
    var text=fuseState.map(function(p){return p.text+(p.img?"\n[配图]":"");}).join("\n\n");
    try{navigator.clipboard.writeText(text);toast(hasImg?"已复制文字（图片请用「导出 HTML」保留）":"已复制文字");}catch(e){toast("复制失败，请手动选择");}
  });
  var ex=$("#fuseExport");
  if(ex)ex.addEventListener("click",function(){
    var html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>图文融合稿</title><style>body{max-width:760px;margin:32px auto;padding:0 18px;font-family:system-ui,sans-serif;line-height:1.8;color:#1a1a1a}img{display:block;margin:14px 0}p{margin:0 0 14px}</style></head><body>'+fuseToHtml()+'</body></html>';
    var blob=new Blob([html],{type:"text/html;charset=utf-8"});
    var url=URL.createObjectURL(blob);
    var a=document.createElement("a");a.href=url;a.download="图文融合_"+Date.now()+".html";document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},2000);
    toast("已导出 HTML（含图）");
  });
}
function injectFuseStyle(){
  var css=".fuse-view{margin-top:10px;display:flex;flex-direction:column;gap:14px}.fuse-empty{opacity:.6;font-size:13px;padding:10px 0}.fuse-para{border:1px solid rgba(127,127,127,.22);border-radius:12px;padding:12px 14px;background:rgba(127,127,127,.04)}.fuse-txt{font-size:14px;line-height:1.75}.fuse-ctrl{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}.fuse-gen{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:8px;border:1px solid rgba(88,122,157,.45);background:rgba(88,122,157,.10);color:inherit;cursor:pointer;font-size:13px}.fuse-gen:hover{background:rgba(88,122,157,.18)}.fuse-gen:disabled{opacity:.5;cursor:default}.fuse-gen svg{width:15px;height:15px}.fuse-phint{font-size:12px;opacity:.72}.fuse-img{margin-top:10px}.fuse-img img{max-width:340px;width:100%;border-radius:10px;display:block;border:1px solid rgba(127,127,127,.25)}.fuse-img-actions{display:flex;gap:8px;margin-top:6px}.fuse-img-actions button{font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}.fuse-img-actions button:hover{background:rgba(127,127,127,.12)}";
  var s=document.createElement("style");s.textContent=css;document.head.appendChild(s);
}

// ---- wire ----
buildModels();
loadPrompts();
wirePrompts();
$("#gen").addEventListener("click",doGen);
$("#stop").addEventListener("click",function(){if(genAbort)genAbort.abort();});
$("#extract").addEventListener("click",doExtract);
$("#save").addEventListener("click",doSave);
injectPortraitStyle();
wirePortrait();
injectFuseStyle();
wireFuse();


})();