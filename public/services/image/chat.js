(function () {
/**
 * Chat photos: the image side of "send a photo" in a text conversation. Turns a scene description
 * (plus the character card) into a prompt, picks between text-to-image and edit-the-base-image,
 * and hands the result to the shared image pipeline.
 *
 * The pipeline itself is not here. Generation, editing, polling, R2 persistence and the base-image
 * store all live in the classic `imageCommonSvc` module, which arrives as one port; this file owns
 * only the chat-specific semantics:
 *  - the comma-tag art style is appended here, because the other two chains splice it differently;
 *  - edit parameters are pinned to 20 steps / guidance 3.5 with a 2.5s poll — the fast preset loses
 *    gender and identity, and 4 steps was the version that produced men for female characters;
 *  - the prompt names the character (name / age / identity / personality), otherwise the model
 *    drifts back to a generic stranger.
 *
 * Two scenes take different routes on purpose. A `scene` request is plain text-to-image and must
 * not contain the character at all. A selfie edits an existing base image so the face survives;
 * only when no base image exists does it fall back to a one-shot text-to-image, which is faster
 * than creating a base image first and editing it.
 * @module services/image/chat
 */

                                 
                                                   
                                                               
                                               
 

                              
                  
                         
 

                               
                 
            
               
 

                              
                 
                 
                
                   
                     
                   
 

/** The shared pipeline module: primitives plus the two stores it already owns. */
                                  
                        
                                               
                                                
                            
                                                                   
                                                
 

                                
                             
                            
 

                                 
                                                                                   
                      
                                                                         
                                    
                                                       
                 
 

                              
                   
                 
 

                            
                                                  
                                                  
                                              
                                                       
                                                   
 

const EDIT_STEPS = 20;
const EDIT_GUIDANCE = 3.5;
const POLL_INTERVAL = 2500;

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

/** `string` id, or `{ characterId }`; anything missing falls back to the default character. */
function readCharId(args         )         {
  if (typeof args === "string") return args || "default";
  return str(recOf(args).characterId) || "default";
}

/** Append the site-wide style as comma tags — this chain's spelling of it. */
function withStyle(prompt        , suffix        )         {
  return suffix ? prompt + ", " + suffix : prompt;
}

function whoToken(card         )         {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name)).toLowerCase();
  if (/女|girl|female|woman/.test(s)) return "1girl";
  if (/男|boy|male|man/.test(s)) return "1boy";
  return "1person";
}

/**
 * Full prompt for the first base image. Card fields are appended only when present; the name is
 * kept in because the upstream renders "character: <name>" as a weak identity anchor.
 */
function characterPrompt(card         )         {
  const o = recOf(card);
  const t = ["masterpiece", "best quality", "highly detailed", whoToken(card), "solo", "portrait",
    "looking at viewer", "detailed face", "soft natural lighting"];
  if (card) {
    if (o.name) t.push("character: " + String(o.name));
    if (o.age) t.push("age: " + String(o.age));
    if (o.identity) t.push(String(o.identity));
    if (o.personality) t.push(String(o.personality) + " vibe");
  }
  return t.filter(Boolean).join(", ");
}

/** Camera framing inferred from the scene words; the fallback is a phone selfie. */
function pickFraming(scene        )         {
  const t = scene.toLowerCase();
  if (/full body|full-body|head to toe|whole body|全身|站姿|全身照/.test(t))
    return "full-body shot, head to toe visible, natural standing or action pose";
  if (/wide shot|landscape|scenery|far away|street|远景|风景|环境|街道|城市|海边|广角/.test(t))
    return "wide environmental shot, subject placed within a detailed scene, cinematic framing";
  if (/close[- ]?up|特写|脸部|大头|面部/.test(t))
    return "close-up portrait, face and shoulders, shallow depth of field";
  return "natural casual phone-selfie framing, upper body";
}

/**
 * Gender lock for the edit instruction, inferred from gender, name and identity. Empty when the
 * card says nothing either way — inventing a gender here is what produced the wrong one.
 */
function subjectClause(card         )         {
  const o = recOf(card);
  const s = (str(o.gender) + " " + str(o.name) + " " + str(o.identity)).toLowerCase();
  if (/女|girl|female|woman|少女|萝莉|妹|姐|母|娘|她/.test(s))
    return "The subject is a woman; keep her female gender and feminine appearance";
  if (/男|boy|male|man|少年|大叔|哥|弟|父|他/.test(s))
    return "The subject is a man; keep his male gender and masculine appearance";
  return "";
}

/**
 * Scene → edit instruction that keeps the same person. The identity clause comes first and the
 * scene last: an upstream that truncates keeps the face, which is the part that must not drift.
 */
function editInstruction(scenePrompt        , card         )         {
  const s = (scenePrompt || "").trim() || "taking a casual selfie";
  const who = subjectClause(card);
  return "Edit the SOURCE photo while keeping the SAME person: identical face, hairstyle, gender, body type, outfit colors and identity. "
    + (who ? who + ". " : "")
    + "Do NOT replace the person with someone else and do NOT change their gender. Place this same person in the scene: "
    + s + ". " + pickFraming(s) + ", consistent character.";
}

function createChatImage(ports                )            {
  const ic = ports.ic;
  const now = ports.now || function () { return Date.now(); };

  function findCardById(id        )          {
    const ch = ports.character();
    try {
      if (id && id !== "default" && id !== "__none__" && ch) {
        const list = (ch.listAllCards ? ch.listAllCards() : []) || [];
        for (const c of list) {
          if (recOf(c).id === id) return c;
        }
      }
      return ch && ch.getActiveCard ? ch.getActiveCard() : null;
    } catch (e) {
      return null;
    }
  }

  function genZImage(prompt        )                  {
    return ic.genImage({ prompt: withStyle(prompt, ic.styleSuffix()), n: 1, size: "1024x1024" })
      .then(function (arr) { return arr[0]; });
  }

  function genEdit(prompt        , srcUrl        )                       {
    return ic.genEdit({
      prompt: withStyle(prompt, ic.styleSuffix()),
      srcUrl: srcUrl,
      steps: EDIT_STEPS,
      guidance: EDIT_GUIDANCE,
      intervalMs: POLL_INTERVAL,
      filename: "base.png"
    });
  }

  async function getBaseImage(args          )                         {
    return ic.baseImage.get(readCharId(args));
  }

  async function setBaseImage(args          )                {
    const o = recOf(args);
    const imageUrl = str(o.imageUrl);
    if (!imageUrl) return;
    await ic.baseImage.set(readCharId(o), imageUrl);
  }

  async function clearBaseImage(args          )                   {
    return ic.baseImage.clear(readCharId(args));
  }

  async function ensureBase(id        , baseImageUrl        , card         )                         {
    if (baseImageUrl) {
      await ic.baseImage.set(id, baseImageUrl);
      return baseImageUrl;
    }
    const existing = await getBaseImage(id);
    if (existing) return existing;
    const raw = await genZImage(characterPrompt(card));
    await ic.baseImage.set(id, raw);
    return raw;
  }

  async function editImage(args          )                       {
    const o = recOf(args);
    const id = str(o.characterId) || "default";
    const card = findCardById(id);
    const instruction = str(o.instruction) || editInstruction(str(o.scenePrompt), card);
    const base = await ensureBase(id, str(o.baseImageUrl), card);
    const res = await genEdit(instruction, base);
    const imageUrl = await ic.persistToR2(res.fileUrl);
    return { imageUrl: imageUrl, taskId: str(res.taskId) };
  }

  async function genScene(scenePrompt        )                       {
    const raw = await genZImage(scenePrompt || "a quiet scenery, no people");
    const imageUrl = await ic.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: "scene-" + now() };
  }

  async function genSelfieNoBase(args         )                       {
    const o = recOf(args);
    const card = findCardById(str(o.characterId) || "default");
    const scene = str(o.scenePrompt).trim();
    const prompt = characterPrompt(card) + (scene ? ", " + scene : "") + ", natural casual phone selfie, upper body";
    const raw = await genZImage(prompt);
    const imageUrl = await ic.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: "selfie-" + now() };
  }

  async function sendPhoto(args          )                       {
    const o = recOf(args);
    if (str(o.kind) === "scene") return genScene(str(o.scenePrompt));
    const id = str(o.characterId) || "default";
    const base = str(o.baseImageUrl) || await getBaseImage(id);
    if (base) return editImage({ characterId: id, baseImageUrl: base, scenePrompt: str(o.scenePrompt) });
    return genSelfieNoBase({ characterId: id, scenePrompt: str(o.scenePrompt) });
  }

  return {
    sendPhoto: sendPhoto,
    editImage: editImage,
    setBaseImage: setBaseImage,
    getBaseImage: getBaseImage,
    clearBaseImage: clearBaseImage
  };
}

// Browser adapter, appended by l0/emit.mjs. Engine: services/image/chat.ts; this file owns the
// frozen global name and the one load-order dependency on the shared image pipeline.
//
// The pipeline module is captured once, exactly as the classic script did: everything below it in
// the boot list depends on this file having run after `imageCommonSvc`, and reporting that failure
// as a console error (and not defining the global) is what makes the text side fall back to mock
// images instead of throwing on every send.
(function () {
  if (window.chatImageSvc) return;
  if (!window.imageCommonSvc) {
    console.error("[image-chat] 缺少 image-common.js，请确认其在本文件之前加载");
    return;
  }

  var svc = createChatImage({
    ic: window.imageCommonSvc,
    character: function () {
      try { return window.characterSvc || null; } catch (e) { return null; }
    }
  });

  window.chatImageSvc = {
    sendPhoto: svc.sendPhoto,
    editImage: svc.editImage,
    setBaseImage: svc.setBaseImage,
    getBaseImage: svc.getBaseImage,
    clearBaseImage: svc.clearBaseImage
  };
})();

globalThis.readCharId = readCharId;
globalThis.withStyle = withStyle;
globalThis.characterPrompt = characterPrompt;
globalThis.pickFraming = pickFraming;
globalThis.subjectClause = subjectClause;
globalThis.editInstruction = editInstruction;
globalThis.createChatImage = createChatImage;
})();
