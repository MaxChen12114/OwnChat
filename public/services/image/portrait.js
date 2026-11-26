(function () {
/**
 * Character portrait: turns the active character card into a half-body illustration prompt, gets
 * one image back, and can promote that image to the messaging flow's base image. The same module
 * owns the site-wide art-style preference every auto-generation path appends to.
 *
 * Two things are deliberately kept apart here. Prompt composition is pure and lives below; the
 * image call and the base-image hand-off are ports, because both need modules that are classic
 * scripts (`imageStudioSvc` / `chatImageSvc`) and neither can be reached from a realm-neutral service.
 * The style preference is a port too, so the storage key stays with the wiring that owns
 * localStorage and the change event.
 *
 * The style tag is prepended *and* re-stated per prompt: non-photographic styles must also
 * declare what they are not, otherwise the upstream model drifts back to photorealism.
 * @module services/image/portrait
 */

                            
                
               
 

const PORTRAIT_STYLES                            = {
  none: { label: "默认（不指定）", tags: "" },
  real: { label: "写实", tags: "写实风格 / photorealistic" },
  anime: { label: "动漫（现代日系）", tags: "现代日系动漫 / anime 插画风格" },
  soft: { label: "日系厚涂", tags: "日系厚涂 / Japanese semi-realistic painterly" },
  webtoon: { label: "韩漫（网漫）", tags: "韩漫 / Korean webtoon manhwa" },
  uscomic: { label: "美漫（美式）", tags: "美漫 / American comic" },
  gufeng: { label: "中式（国风）", tags: "中式国风插画 / Chinese gufeng ink painting" },
  fantasy: { label: "欧美奇幻厚涂", tags: "欧美奇幻厚涂 / Western fantasy concept art" },
  oil: { label: "古典油画", tags: "古典油画 / classical oil painting" },
  water: { label: "水彩", tags: "水彩插画 / watercolor painting" },
  render3d: { label: "3D（皮克斯渲染）", tags: "3D 渲染 / Pixar Disney 3D render" },
  chibi: { label: "Q版（萌系）", tags: "Q 版萝系 / chibi" },
  inkmanga: { label: "黑白漫画", tags: "日式默白漫画 / black-and-white manga" },
  cyber: { label: "赛博朋克", tags: "赛博朋克插画 / cyberpunk" }
};

/** One picker row; `key` is the stored value, `label` is the user-facing text. */
                              
                       
                         
 

/** The picker rows in table order. The settings cards render this, never a local copy. */
function styleOptions()                {
  const out                = [];
  const keys = Object.keys(PORTRAIT_STYLES);
  for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], label: PORTRAIT_STYLES[keys[i]].label });
  return out;
}

const DEFAULT_STYLE = "none";
const ILLUSTRATION_WARNING = "这是一幅二维插画/手绘作品（绝对不是真人照片）。";
const NON_PHOTO_CLOSING = "整幅作品务必是上述画风的插画,绝不画成真人写实照片";
const STYLE_OPENER = "画风务必严格遵循：";

                                  
                                      
                                            
 

                                
              
                      
               
 

                               
                      
                   
 

                                
                           
                                                                                
                              
                                                                                           
                        
                                                                                                   
                                                   
                                                                                                  
                                                    
 

                           
                                              
                                                                        
                                      
                     
                             
                         
                                       
                                                                                         
                          
 

function recOf(v         )                          {
  const out                          = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out[k] = x;
  }
  return out;
}

function str(v         )         {
  return typeof v === "string" ? v : "";
}

/**
 * Style tags for one style key, or "" for `none`. Photographic styles stand alone; everything
 * else gets the "this is an illustration" warning first, because a bare style tag is regularly
 * beaten by the subject description in the same prompt.
 */
function styleTagsFor(key        )         {
  const s = PORTRAIT_STYLES[key];
  if (!s || !s.tags) return "";
  if (key === "real") return s.tags;
  return ILLUSTRATION_WARNING + s.tags;
}

/** Gender is inferred from the card's own words; anything unrecognised stays neutral. */
function subjectPhrase(card         )         {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name)).toLowerCase();
  if (/女|girl|female|woman|少女|萝莉/.test(s)) return "一位女性角色";
  if (/男|boy|male|man|少年/.test(s)) return "一位男性角色";
  return "一位角色";
}

/**
 * Full prompt for one card. Card fields are appended only when present, so a half-filled card
 * still produces a usable prompt instead of a sentence with dangling labels.
 */
function buildPromptFor(card         , styleKey        )         {
  const st = styleTagsFor(styleKey);
  const o = recOf(card);
  const parts           = [];
  if (st && styleKey !== "real") parts.push(STYLE_OPENER + st);
  parts.push("画面内容：半身肖像，" + subjectPhrase(card) + "，单人，正面面向镜头");
  if (card) {
    if (o.age) parts.push("角色年龄：" + String(o.age).trim());
    if (o.identity) parts.push("身份与背景：" + String(o.identity));
    if (o.personality) parts.push("气质性格：" + String(o.personality));
  }
  parts.push("柔和自然的打光，干净简洁的背景，构图均衡，细节丰富、构图完整、杰作级完成度");
  if (st && styleKey === "real") parts.push(STYLE_OPENER + st);
  else if (st) parts.push(NON_PHOTO_CLOSING);
  return parts.filter(Boolean).join("，") + "。";
}

/**
 * The portrait bridge. `lastImage` is per-session state: it is what `setAsBase()` falls back to
 * when the caller passes neither a URL nor a character id.
 */
function createPortrait(ports               )           {
  let lastImage                       = null;

  function getStyle()         {
    try {
      return ports.storage.getItem("cfw_image_style_v1") || DEFAULT_STYLE;
    } catch (e) {
      return DEFAULT_STYLE;
    }
  }

  function setStyle(s         )       {
    try {
      ports.storage.setItem("cfw_image_style_v1", str(s) || DEFAULT_STYLE);
    } catch (e) {
      /* storage is best effort: a private-mode failure must not stop the picker */
    }
    ports.notify(getStyle());
  }

  function buildPrompt(card          )         {
    return buildPromptFor(card, getStyle());
  }

  async function generateForActive()                         {
    const card = ports.activeCard();
    if (!card) throw new Error("请先在「角色卡」里选择一个角色");
    const img = await ports.generate(buildPrompt(card));
    if (!img) throw new Error("未取到图片");
    const o = recOf(card);
    lastImage = { url: img, characterId: str(o.id) || "default", name: str(o.name) };
    return lastImage;
  }

  async function setAsBase(imageUrl          , characterId          )                  {
    const card = recOf(ports.activeCard());
    const id =
      str(characterId) ||
      (lastImage ? lastImage.characterId : "") ||
      str(card.id) ||
      "default";
    const url = str(imageUrl) || (lastImage ? lastImage.url : "");
    if (!url) throw new Error("还没有可用的立绘");
    const ok = await ports.setBaseImage({ characterId: id, imageUrl: url });
    if (!ok) throw new Error("发图模块未就绪");
    return id;
  }

  return {
    generateForActive,
    setAsBase,
    buildPrompt,
    getStyle,
    setStyle,
    getStyleTags: function () {
      return styleTagsFor(getStyle());
    },
    getLastImage: function () {
      return lastImage;
    },
    styles: styleOptions
  };
}

// Browser adapter, appended by tooling/l0/emit.mjs. Engine: services/image/portrait.ts; this file owns the
// frozen global name, the localStorage key, the style change event and the two image-module calls.
//
// The generation fallback (direct provider call when the workshop module is absent) lives here on
// purpose: it reads the channel key, the auth token and the endpoint, none of which a
// realm-neutral service should know about.
(function () {
  if (window.portraitSvc) return;

  function readLS(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function directGenerate(prompt) {
    var key = readLS("cfw_image_key_v1") || readLS("moark_api_key") || "";
    if (!key) return Promise.reject(new Error("请先在设置 → 模型 API → 图像渠道填写当前渠道的 Key"));
    var headers = { "Authorization": "Bearer " + key, "Content-Type": "application/json" };
    try {
      var token = (window.authSvc && window.authSvc.getToken && window.authSvc.getToken()) || readLS("cfw_auth_token_v1") || "";
      if (token) headers["X-Sync-Token"] = token;
    } catch (e) {}
    return window.fetch("/img/v1/images/generations", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ prompt: prompt, model: "z-image-turbo", n: 1, size: "768x1024" })
    }).then(function (r) {
      if (!r.ok) throw new Error("生成失败 " + r.status);
      return r.json().then(function (j) {
        var first = (j && j.data && j.data[0]) || null;
        if (!first) throw new Error("无返回");
        return first.url || (first.b64_json ? "data:image/png;base64," + first.b64_json : null);
      });
    });
  }

  var portrait = createPortrait({
    storage: {
      getItem: function (k) { return readLS(k); },
      setItem: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
    },
    notify: function (style) {
      try { window.dispatchEvent(new window.CustomEvent("imagestyle:changed", { detail: { style: style } })); } catch (e) {}
    },
    activeCard: function () {
      try { return (window.characterSvc && window.characterSvc.getActiveCard) ? window.characterSvc.getActiveCard() : null; } catch (e) { return null; }
    },
    generate: function (prompt) {
      if (window.imageStudioSvc && typeof window.imageStudioSvc.generate === "function") {
        return window.imageStudioSvc.generate({ prompt: prompt, n: 1, size: "768x1024" }).then(function (data) {
          var d = (data && data[0]) || null;
          if (!d) return null;
          return d.url || (d.b64_json ? "data:image/png;base64," + d.b64_json : null);
        });
      }
      return directGenerate(prompt);
    },
    setBaseImage: function (arg) {
      if (!window.chatImageSvc || typeof window.chatImageSvc.setBaseImage !== "function") return Promise.resolve(false);
      return Promise.resolve(window.chatImageSvc.setBaseImage(arg)).then(function () { return true; });
    }
  });

  window.portraitSvc = {
    generateForActive: portrait.generateForActive, setAsBase: portrait.setAsBase,
    buildPrompt: portrait.buildPrompt, getStyle: portrait.getStyle, setStyle: portrait.setStyle,
    getStyleTags: portrait.getStyleTags, getLastImage: portrait.getLastImage, styles: portrait.styles
  };
})();

globalThis.PORTRAIT_STYLES = PORTRAIT_STYLES;
globalThis.styleOptions = styleOptions;
globalThis.styleTagsFor = styleTagsFor;
globalThis.subjectPhrase = subjectPhrase;
globalThis.buildPromptFor = buildPromptFor;
globalThis.createPortrait = createPortrait;
})();
