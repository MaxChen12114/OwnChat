// image-chat.js —— 微信发图 · 图像侧契约实现（统一管线版）
// 暴露 window.__chatImage = { sendPhoto, editImage, setBaseImage, getBaseImage, clearBaseImage }
// 文本侧(chat-image.js / window.__chatImageText)检测到本对象后自动从 mock 切真图。
// 底层出图/改图/鉴权/转存/基准图存储统一走 window.__imageCommon（image-common.js，必须先加载）。
// 本文件只保留「微信发图」特有语义：角色 prompt 构建、机位选择、保人编辑指令、
// 改图参数(steps=20/guidance=3.5)、轮询 2.5s、画风逗号 tag 追加。
(function () {
  if (window.__chatImage) return;
  var IC = window.__imageCommon;
  if (!IC) { console.error('[image-chat] 缺少 image-common.js，请确认其在本文件之前加载'); return; }

  // 改图参数（本链特有；4.54: steps=4/guidance=1.0 极易丢性别/身份 → 提到 20/3.5）
  var EDIT_STEPS = 20, EDIT_GUIDANCE = 3.5;
  // Bug⑧ 提速：轮询间隔 6s→2.5s（出图任务通常 10-30s 完成,更密轮询显著缩短感知等待;仍远低于接口限频）
  var POLL_INTERVAL = 2500;

  function readCharId(args) {
    if (typeof args === 'string') return args || 'default';
    return (args && args.characterId) || 'default';
  }

  // ── 全局画风：读 image-portrait 托管的 cfw_image_style_v1，逗号 tag 追加（本链语义）──
  function withStyle(p) { var st = IC.styleSuffix(); return st ? ((p || '') + ', ' + st) : (p || ''); }

  // ── 出图/改图原语（委托 image-common，套本链画风拼接与改图参数）──
  async function genZImage(prompt) {
    var arr = await IC.genImage({ prompt: withStyle(prompt), n: 1, size: '1024x1024' });
    return arr[0];
  }
  async function genEdit(prompt, srcUrl) {
    return IC.genEdit({ prompt: withStyle(prompt), srcUrl: srcUrl, steps: EDIT_STEPS, guidance: EDIT_GUIDANCE, intervalMs: POLL_INTERVAL, filename: 'base.png' });
  }

  // ── 首次造基准图的角色 prompt(尽量取角色卡)──
  // 4.26 fix「不对应角色」: 按 characterId 精确取卡(多角色场景不再误用 active card);
  // 性别从自由文本(女/男/female...)或角色名映射;prompt 带上角色名/身份/性格,避免退化成通用路人。
  function findCardById(id) {
    var ch = window.__character;
    try {
      if (id && id !== 'default' && id !== '__none__' && ch) {
        var list = (ch.listAllCards ? ch.listAllCards() : []) || [];
        var hit = list.filter(function (c) { return c && c.id === id; })[0];
        if (hit) return hit;
        var arch = ch.archetypes || [];
        var ah = arch.filter(function (c) { return c && c.id === id; })[0];
        if (ah) return ah;
      }
      return (ch && ch.getActiveCard) ? ch.getActiveCard() : null;
    } catch (e) { return null; }
  }
  function mapWho(card) {
    var s = (((card && card.gender) || '') + ' ' + ((card && card.name) || '')).toLowerCase();
    if (/女|girl|female|woman/.test(s)) return '1girl';
    if (/男|boy|male|man/.test(s)) return '1boy';
    return '1person';
  }
  function characterPrompt(card) {
    var c = card || null;
    var t = ['masterpiece', 'best quality', 'highly detailed', mapWho(c), 'solo', 'portrait', 'looking at viewer', 'detailed face', 'soft natural lighting'];
    if (c) {
      if (c.name) t.push('character: ' + c.name);
      if (c.age) t.push('age: ' + c.age);  // 4.65 #2 修:角色卡 age 带入出图提示词,影响立绘年龄外观
      if (c.identity) t.push(c.identity);
      if (c.personality) t.push(c.personality + ' vibe');
    }
    return t.filter(Boolean).join(', ');
  }
  // 场景 → 「保持同一人」的编辑指令；按场景词智能选机位:全身/远景/特写/默认自拍
  function pickFraming(s) {
    var t = (s || '').toLowerCase();
    if (/full body|full-body|head to toe|whole body|全身|站姿|全身照/.test(t))
      return 'full-body shot, head to toe visible, natural standing or action pose';
    if (/wide shot|landscape|scenery|far away|street|远景|风景|环境|街道|城市|海边|广角/.test(t))
      return 'wide environmental shot, subject placed within a detailed scene, cinematic framing';
    if (/close[- ]?up|特写|脸部|大头|面部/.test(t))
      return 'close-up portrait, face and shoulders, shallow depth of field';
    return 'natural casual phone-selfie framing, upper body';
  }
  // 4.54 修「女角色发男图」: 极速档改图极易丢性别/身份 → 编辑指令显式锁性别 + 禁止换人/改性别,并从角色卡(gender/名字/身份,中英+称谓)推断性别。
  function subjectClause(card) {
    var s = ((((card && card.gender) || '') + ' ' + ((card && card.name) || '') + ' ' + ((card && card.identity) || '')).toLowerCase());
    if (/女|girl|female|woman|少女|萝莉|妹|姐|母|娘|她/.test(s)) return 'The subject is a woman; keep her female gender and feminine appearance';
    if (/男|boy|male|man|少年|大叔|哥|弟|父|他/.test(s)) return 'The subject is a man; keep his male gender and masculine appearance';
    return '';
  }
  function editInstruction(scenePrompt, card) {
    var s = (scenePrompt || '').trim() || 'taking a casual selfie';
    var who = subjectClause(card);
    return 'Edit the SOURCE photo while keeping the SAME person: identical face, hairstyle, gender, body type, outfit colors and identity. ' + (who ? who + '. ' : '') + 'Do NOT replace the person with someone else and do NOT change their gender. Place this same person in the scene: ' + s + '. ' + pickFraming(s) + ', consistent character.';
  }

  // ── 契约（基准图读写委托 common.baseImage，保留 args 对象外部契约）──
  async function getBaseImage(args) { return IC.baseImage.get(readCharId(args)); }
  async function setBaseImage(args) {
    var imageUrl = args && args.imageUrl;
    if (!imageUrl) return;
    await IC.baseImage.set(readCharId(args), imageUrl);
  }
  // 清除某角色的发图基准图(下次发图会按角色卡重新造一张)
  async function clearBaseImage(args) { return IC.baseImage.clear(readCharId(args)); }
  async function ensureBase(id, baseImageUrl, card) {
    if (baseImageUrl) return IC.baseImage.set(id, baseImageUrl);
    var existing = await getBaseImage(id);
    if (existing) return existing;
    var raw = await genZImage(characterPrompt(card));
    return IC.baseImage.set(id, raw);
  }
  async function editImage(args) {
    args = args || {};
    var id = args.characterId || 'default';
    var card = findCardById(id);
    var instruction = args.instruction || editInstruction(args.scenePrompt, card);
    var base = await ensureBase(id, args.baseImageUrl, card);
    var res = await genEdit(instruction, base);
    var imageUrl = await IC.persistToR2(res.fileUrl);
    return { imageUrl: imageUrl, taskId: res.taskId };
  }
  // 双管齐下: kind==='scene' 走直接文生图(风景/场景,不保人);否则自拍走改图(保人)
  async function genScene(scenePrompt) {
    var raw = await genZImage(scenePrompt || 'a quiet scenery, no people');
    var imageUrl = await IC.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: 'scene-' + Date.now() };
  }
  // 无基准图的自拍: 不走"造基准图→Qwen改图"双链(慢且易超时),直接一次性文生图直出角色(画风跟随全局)
  async function genSelfieNoBase(args) {
    var id = (args && args.characterId) || 'default';
    var card = findCardById(id);
    var scene = ((args && args.scenePrompt) || '').trim();
    var prompt = characterPrompt(card) + (scene ? ', ' + scene : '') + ', natural casual phone selfie, upper body';
    var raw = await genZImage(prompt);
    var imageUrl = await IC.persistToR2(raw);
    return { imageUrl: imageUrl, taskId: 'selfie-' + Date.now() };
  }
  async function sendPhoto(args) {
    args = args || {};
    // 场景图(游戏截图/风景/物品…): 直接文生图,画面不出现角色本人
    if (args.kind === 'scene') return genScene(args.scenePrompt);
    // 自拍: 有基准图(入参或已存) → Qwen 改图保持同一人; 无基准图 → 一次性文生图直出角色
    var id = args.characterId || 'default';
    var base = args.baseImageUrl || await getBaseImage(id);
    if (base) return editImage({ characterId: id, baseImageUrl: base, scenePrompt: args.scenePrompt });
    return genSelfieNoBase({ characterId: id, scenePrompt: args.scenePrompt });
  }

  window.__chatImage = { sendPhoto: sendPhoto, editImage: editImage, setBaseImage: setBaseImage, getBaseImage: getBaseImage, clearBaseImage: clearBaseImage };
})();