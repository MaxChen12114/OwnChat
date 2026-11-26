// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the frozen window contract name.
// The data layer lives in services/data/character.ts; every browser-side duty is here — the SQL
// card store over window.dbSvc, the one-time copy of the legacy IndexedDB cards, the localStorage
// trio, change-event dispatch, the uid clock, and the whole card panel. The panel ships with the
// wiring because it has exactly one consumer, itself: no second caller ever renders these controls.
// Sibling-domain callbacks (scene / character memory / lorebook) are all best-effort: a failure is
// swallowed so one broken neighbour cannot abort a save.
(function () {
  var LEGACY_DB = "tavern_chars_v2", ST_CARD = "chars", ST_AFF = "affections";
  var LSA = "tavern_active_char_id";

  // ── legacy IndexedDB (migration source only) ────────────────────────────────
  // Read exactly once, before the first SQL read; afterwards the database is dropped and the
  // marker stops a second attempt. The reader stays in the wiring because IndexedDB is
  // browser-only; the row mapping itself lives in the service so it can be tested against SQLite.
  function openLegacyDb() {
    return new Promise(function (res, rej) {
      var q = window.indexedDB.open(LEGACY_DB, 2);
      q.onupgradeneeded = function () {
        var d = q.result;
        if (!d.objectStoreNames.contains(ST_CARD)) d.createObjectStore(ST_CARD, { keyPath: "id" });
        if (!d.objectStoreNames.contains(ST_AFF)) d.createObjectStore(ST_AFF, { keyPath: "cardId" });
      };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }

  function getAllFrom(db, name) {
    return new Promise(function (res, rej) {
      var t = db.transaction(name, "readonly").objectStore(name).getAll();
      t.onsuccess = function () { res(t.result || []); };
      t.onerror = function () { rej(t.error); };
    });
  }

  function readLegacyCards() {
    return openLegacyDb().then(function (db) {
      return getAllFrom(db, ST_CARD).then(function (cards) {
        return getAllFrom(db, ST_AFF).then(function (affections) {
          db.close();
          return { cards: cards, affections: affections };
        });
      });
    });
  }

  function dropLegacyDb() {
    return new Promise(function (res) {
      var req = window.indexedDB.deleteDatabase(LEGACY_DB);
      req.onsuccess = req.onerror = function () { res(); };
      // A second tab still holding the database blocks deletion until it closes. The migration
      // marker is what stops a re-run, so the leftover copy is reported and left behind, not
      // retried forever.
      req.onblocked = function () {
        try { console.warn("[character] 旧角色库被其他标签页占用，删除被跳过（迁移已完成，不再重试）"); } catch (e) {}
        res();
      };
    });
  }

  var storage = {
    getItem: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    setItem: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {}
    },
    removeItem: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {}
    },
  };

  // ── SQL card store ─────────────────────────────────────────────────────────
  // `chars(id, name, data)` through the DbPort facade; the affection score rides in the row's
  // reserved bag. The port is resolved per call because the facade may switch adapters under us
  // (tauri vs d1) without this closure being rebuilt.
  var cards = createSqlCardStore({
    exec: function (sql, params) {
      var svc = window.dbSvc;
      if (!svc || typeof svc.exec !== "function") throw new Error("角色卡存储未接线：dbSvc 缺失（db.js 未加载）");
      return svc.exec(sql, params);
    },
  }, {
    now: function () { return Date.now(); },
    onCorruptRow: function (id, e) {
      try { console.warn("[character] 角色卡行损坏，已跳过：" + id, e); } catch (x) {}
    },
  });

  /**
   * One-time legacy copy. Resolves the number of cards that landed in SQL (0 when there was nothing
   * to do, the marker is present, or the copy failed). It writes the marker and drops the old
   * database only after every card and score read back; a failure keeps the database and leaves the
   * marker absent so the next boot retries. The active-card id lives in localStorage and keeps
   * pointing at the same `u_<base36>` ids, so nothing has to be rewritten.
   */
  function migrateLegacyCards() {
    if (storage.getItem(CHARS_IDB_MIGRATED_KEY)) return Promise.resolve(0);
    if (!window.indexedDB) return Promise.resolve(0);
    return readLegacyCards()
      .then(function (dump) {
        var plan = planCharsMigration(dump);
        return applyCharsMigration(cards, plan).then(function (counts) {
          return dropLegacyDb().then(function () {
            storage.setItem(CHARS_IDB_MIGRATED_KEY, JSON.stringify({
              at: Date.now(),
              cards: counts.cards,
              affections: counts.affections,
              skippedCards: plan.skippedCards,
              skippedAffections: plan.skippedAffections,
            }));
            return counts.cards;
          });
        });
      })
      .catch(function (e) {
        // Loud on purpose: at this point the old database is still the only complete copy.
        try {
          console.error("[character] 角色卡迁移到 SQL 失败，旧 IndexedDB 保留待下次重试：", e);
          window.dispatchEvent(new CustomEvent("character:migration-error", {
            detail: { message: String((e && e.message) || e) },
          }));
        } catch (x) {}
        return 0;
      });
  }

  var api = createCharacter({
    storage: storage,
    cards: cards,
    notify: function () {
      try {
        window.dispatchEvent(new CustomEvent("character:changed"));
      } catch (e) {}
    },
    now: function () {
      return Date.now();
    },
    // Cards live in D1 now, which *is* the sync; the legacy /sync/chars KV channel only carries
    // the pre-SQL IndexedDB stores and is kept for old clients. Driving it from this client would
    // publish an empty card set (the local database is migrated and dropped), so the three hooks
    // stay deliberate no-ops until the channel retires. See services/data/sync.ts.
    onCharsDirty: function () {},
    onCardMetaBump: function () {},
    onCardTombstone: function () {},
    // Scene membership lives in engine/multi-agent.js; this only forwards.
    onSceneAdd: function (id) {
      try { if (window.multiSvc && window.multiSvc.addToScene) window.multiSvc.addToScene(id); } catch (e) {}
    },
    onSceneRemove: function (id) {
      try { if (window.multiSvc && typeof window.multiSvc.removeFromScene === "function") window.multiSvc.removeFromScene(id); } catch (e) {}
    },
    onCardMemoryRemove: function (id) {
      try {
        if (window.__charMemory && typeof window.__charMemory.removeCard === "function") return window.__charMemory.removeCard(id);
      } catch (e) {}
      return Promise.resolve();
    },
    // A lorebook entry bound to a card is *unbound*, not deleted: the text usually still matters, so
    // it becomes a global entry instead of disappearing with the card.
    onLorebookUnbind: function (id) {
      try {
        if (!window.lorebookSvc || typeof window.lorebookSvc.getAll !== "function" || typeof window.lorebookSvc.saveEntry !== "function") return;
        var list = window.lorebookSvc.getAll();
        if (!Array.isArray(list)) return;
        for (var i = 0; i < list.length; i++) {
          var en = list[i];
          if (en && en.scope === "perCard" && en.boundCardId === id) {
            window.lorebookSvc.saveEntry(Object.assign({}, en, { scope: "global", boundCardId: null }));
          }
        }
      } catch (e) {}
    },
  });

  // ── UI ──────────────────────────────────────────────────────────────────────
  var REL_LABELS = { default: "默认", friendly: "友好", loving: "爱慕", hostile: "敌对", fearful: "畏惧", dom: "主导", sub: "被动" };

  // Advanced fields — custom emotions, affection thresholds — sit behind developer mode.
  function isDev() {
    try { return window.localStorage.getItem("cfw_dev_mode_v1") === "1"; } catch (e) { return false; }
  }

  function avatarUrlFor(id) {
    if (!id) return null;
    try {
      if (window.__avatar && typeof window.__avatar.get === "function") {
        var u = window.__avatar.get(id);
        if (u) return u;
      }
      var raw = window.localStorage.getItem("cfw_char_avatar_v1");
      if (raw) {
        var m = JSON.parse(raw);
        if (m && m[id]) return m[id];
      }
    } catch (e) {}
    return null;
  }

  function applyAvatarEl(el, c) {
    if (!el || !c) return;
    var url = avatarUrlFor(c.id);
    el.title = c.name || "";
    if (url) {
      el.style.backgroundImage = 'url("' + url + '")';
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.classList.add("has-avatar-img");
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("has-avatar-img");
      el.textContent = c.icon || "🙂";
    }
  }

  var mask = null, P = null, tab = "mine";

  function ensure() {
    if (mask) return;
    mask = document.createElement("div");
    mask.className = "char-panel-mask";
    P = document.createElement("div");
    P.className = "char-panel";
    mask.appendChild(P);
    document.body.appendChild(mask);
    var downOnMask = false;
    mask.addEventListener("mousedown", function (e) { downOnMask = e.target === mask; });
    mask.addEventListener("click", function (e) {
      var ok = downOnMask && e.target === mask;
      downOnMask = false;
      if (ok) close();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function decorate(row, card) {
    var c = card || api.getActiveCard();
    if (!c || !row || !row.querySelector) return;
    var a = row.querySelector(".avatar.bot");
    if (a) {
      a.textContent = c.icon || "🙂";
      a.title = c.name || "";
    }
    if (a) {
      a.dataset.charId = c.id || "";
      applyAvatarEl(a, c);
    }
    var m = row.querySelector(".meta");
    if (m && c.name) m.textContent = c.name;
  }

  function thresholdRowHtml(th, i) {
    var at = th && typeof th.at === "number" ? th.at : 60;
    var ins = th && th.instruction ? th.instruction : "";
    var dir = th && th.dir ? th.dir : "up";
    var escIns = String(ins).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return '<div class="char-threshold-row" data-tr="' + i + '" style="display:flex;flex-direction:column;gap:4px;padding:6px 8px;margin-bottom:6px;border:1px solid;border-radius:6px;"><div style="display:flex;gap:6px;align-items:center;"><span style="font-size:11px;color:#888;">好感跨过</span><input class="char-input" data-tf="at" data-i="' + i + '" type="number" min="0" max="100" value="' + at + '" style="width:70px;"><select class="char-input" data-tf="dir" data-i="' + i + '" style="width:100px;"><option value="up" ' + (dir === "up" ? "selected" : "") + '>上升</option><option value="down" ' + (dir === "down" ? "selected" : "") + '>下降</option><option value="both" ' + (dir === "both" ? "selected" : "") + '>双向</option></select><button class="char-rel-btn" type="button" data-rm-threshold="' + i + '" style="font-size:11px;padding:2px 8px;margin-left:auto;">删除</button></div><textarea class="char-input" data-tf="instruction" data-i="' + i + '" rows="2" placeholder="跨阈值时一次性注入的指令。例：你第一次意识到对他的感情已超出朋友范围，但暂时不会主动说破。">' + escIns + "</textarea></div>";
  }

  function curSec() {
    var c = api.getActiveCard();
    var r = api.getActiveRelation();
    var e = api.getActiveEmotion();
    var M = window.multiSvc;
    var isMultiOn = !!(M && M.isMulti && M.isMulti());
    var sceneCards = isMultiOn && M.getSceneCards ? M.getSceneCards() : [];
    var h = [];
    if (isMultiOn) {
      h.push('<div class="char-section-title">场景成员（共 ' + sceneCards.length + '）' + (sceneCards.length <= 1 ? ' <span style="font-weight:normal;color:#888;font-size:11px;">· 去「我的」点卡的「+场景」加成员</span>' : "") + "</div>");
      h.push('<div class="char-scene-roster" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">');
      for (var i = 0; i < sceneCards.length; i++) {
        var s = sceneCards[i];
        var act = s.id === (c ? c.id : "");
        h.push('<button class="char-rel-btn ' + (act ? "active" : "") + '" data-pick-scene="' + esc(s.id) + '" style="display:flex;align-items:center;gap:4px;padding:3px 8px;' + (act ? "font-weight:600;" : "") + '"><span>' + esc(s.icon || "🙂") + "</span><span>" + esc(s.name) + '</span><span data-rmscene="' + esc(s.id) + '" style="margin-left:2px;opacity:.6;padding:0 2px;">×</span></button>');
      }
      h.push("</div>");
    }
    h.push('<div class="char-section-title">当前角色</div>');
    h.push(
      c
        ? '<div class="char-current-info"><span class="char-avatar-large">' + esc(c.icon || "🙂") + '</span><span class="char-current-name">' + esc(c.name) + '</span><button class="char-rel-btn" data-clear>清除</button></div>'
        : '<div class="char-current-info" style="color:#888;">未选择角色卡（将以非角色模式发送）</div>'
    );
    // The affection bar is a developer-mode affordance; the ordinary card stays minimal.
    if (isDev() && c && c.enableAffection !== false) {
      var v = api.getActiveAffection();
      if (typeof v !== "number") v = api.affectionInit;
      var st = affectionStageFor(v);
      h.push('<div class="char-aff-row" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:6px 0 8px;padding:6px 10px;border-radius:8px;border:1px solid;font-size:13px;"><span class="char-aff-stage" style="padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;">' + esc(st ? st.label : "") + '</span><span class="char-aff-value" style="font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">' + v + '/100</span><div class="char-aff-bar" style="flex:1;height:6px;border-radius:3px;overflow:hidden;min-width:60px;"><div class="char-aff-fill" style="height:100%;width:' + v + '%;background:linear-gradient(90deg,#7fa4c9,#cc4f7d);transition:width .3s;"></div></div><button class="char-rel-btn" type="button" data-aff-step="-10" style="font-size:12px;padding:2px 8px;">-10</button><button class="char-rel-btn" type="button" data-aff-step="-1" style="font-size:12px;padding:2px 8px;">-1</button><button class="char-rel-btn" type="button" data-aff-step="1" style="font-size:12px;padding:2px 8px;">+1</button><button class="char-rel-btn" type="button" data-aff-step="10" style="font-size:12px;padding:2px 8px;">+10</button><input class="char-input" data-aff-set type="number" min="0" max="100" value="' + v + '" style="width:62px;font-size:12px;" title="直接输入好感度(0-100),回车生效"><button class="char-rel-btn" data-reset-aff style="font-size:12px;padding:2px 8px;">重置</button></div>');
    }
    // Relation and emotion are free text; the relation also goes through `relationFromText` to the
    // enum the worker understands.
    var relText = "";
    var emoText = "";
    try {
      relText = window.localStorage.getItem("cfw_relation_text_v1") || "";
      emoText = window.localStorage.getItem("cfw_emotion_text_v1") || "";
    } catch (err) {}
    h.push('<div class="char-section-title">关系（可选）</div><input type="text" class="char-input" data-rel-text placeholder="如: 朋友 / 亦师亦友 / 暧昧不清 (留空 = 不约定关系)" value="' + esc(relText) + '">');
    h.push('<div class="char-section-title" style="margin-top:6px;">情绪（可选）</div><input type="text" class="char-input" data-emo-text placeholder="如: 平静 / 紧张到颤抖 / 强忍泪水 (留空 = 平静)" value="' + esc(emoText) + '">');
    // Only the two special leanings (dom / sub) get a button; everything else is inferred from the
    // free-text keywords.
    if (isDev()) {
      h.push('<div class="char-section-title" style="margin-top:10px;">特殊关系倾向（开发者 · 当前: ' + esc(r) + '）</div><div class="char-relation-row">');
      h.push('<button class="char-rel-btn ' + (r === "dom" ? "active" : "") + '" data-rel="dom">' + REL_LABELS.dom + "</button>");
      h.push('<button class="char-rel-btn ' + (r === "sub" ? "active" : "") + '" data-rel="sub">' + REL_LABELS.sub + "</button>");
      h.push('<button class="char-rel-btn ' + (["dom", "sub"].indexOf(r) < 0 ? "active" : "") + '" data-rel="default">清除</button>');
      h.push("</div>");
    }
    return h.join("");
  }

  function mine(b) {
    b.innerHTML = '<div class="char-section-title">我的角色卡</div><div class="char-grid" data-g></div>';
    var g = b.querySelector("[data-g]");
    return api.getAllCards().then(function (a) {
      if (!a.length) {
        g.outerHTML = '<div style="font-size:12px;color:#888;padding:6px 0;">还没有角色卡。切到「新建」自己写一张；或到设置里的「提示词编辑器 → 角色」导入现成的卡。</div>';
        return;
      }
      var ai = "";
      try { ai = window.localStorage.getItem(LSA) || ""; } catch (e) {}
      var M = window.multiSvc;
      var isMultiOn = !!(M && M.isMulti && M.isMulti());
      var sceneIds = new Set(isMultiOn ? M.getSceneIds() : []);
      g.innerHTML = a
        .map(function (c) {
          return (
            '<div class="char-item ' + (c.id === ai ? "active" : "") + '" data-u="' + esc(c.id) + '"><div class="char-item-avatar">' + esc(c.icon || "🙂") + '</div><div class="char-item-name">' + esc(c.name) + '</div><div class="char-item-actions">' +
            (isMultiOn ? '<button class="char-item-btn" data-s="' + esc(c.id) + '">' + (sceneIds.has(c.id) ? "−场景" : "+场景") + "</button>" : "") +
            '<button class="char-item-btn" data-e="' + esc(c.id) + '">改</button><button class="char-item-btn" data-d="' + esc(c.id) + '">删</button></div></div>'
          );
        })
        .join("");
      // Characters with an avatar file show the image in the grid; the rest fall back to an emoji.
      g.querySelectorAll("[data-u]").forEach(function (el) {
        var c = null;
        for (var i = 0; i < a.length; i++) if (a[i].id === el.dataset.u) c = a[i];
        var av = el.querySelector(".char-item-avatar");
        if (c && av) applyAvatarEl(av, c);
      });
      g.querySelectorAll("[data-u]").forEach(function (el) {
        el.addEventListener("click", function (ev) {
          if (ev.target.closest("[data-e]") || ev.target.closest("[data-d]") || ev.target.closest("[data-s]")) return;
          api.setActiveId(el.dataset.u);
          setTimeout(render, 30);
        });
      });
      g.querySelectorAll("[data-s]").forEach(function (x) {
        x.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (!M) return;
          var id = x.dataset.s;
          if (sceneIds.has(id)) M.removeFromScene(id);
          else M.addToScene(id);
          setTimeout(render, 30);
        });
      });
      g.querySelectorAll("[data-e]").forEach(function (x) {
        x.addEventListener("click", function (ev) {
          ev.stopPropagation();
          api.getAllCards().then(function (ar) {
            var c = null;
            for (var i = 0; i < ar.length; i++) if (ar[i].id === x.dataset.e) c = ar[i];
            if (!c) return;
            tab = "new";
            render();
            editor(P.querySelector("[data-body]"), c);
          });
        });
      });
      g.querySelectorAll("[data-d]").forEach(function (x) {
        x.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var ask = window.feedbackSvc && window.feedbackSvc.confirm
            ? window.feedbackSvc.confirm({ title: "删除角色卡", message: "删除这张角色卡？(将清除其好感度记录；绑定的设定集条目会转为全局保留)", okText: "删除", danger: true })
            : Promise.resolve(confirm("删除这张角色卡？(将清除其好感度记录；绑定的设定集条目会转为全局保留)"));
          Promise.resolve(ask).then(function (ok) {
            if (!ok) return;
            return api.deleteCard(x.dataset.d).then(function () { setTimeout(render, 30); })
              .catch(function (e) { alert("删除角色卡失败：" + ((e && e.message) || e)); });
          });
        });
      });
    });
  }

  function editor(b, card) {
    var isN = !card || !card.id;
    var c = card || {
      id: "", name: "", gender: "female", age: "", identity: "", enableAffection: true, icon: "🙂",
      personality: "", speakingStyle: "", rules: ["", "", ""], openingLine: "",
      exampleQA: [{ user: "", character: "" }, { user: "", character: "" }], affectionThresholds: [],
    };
    while (c.rules.length < 3) c.rules.push("");
    while (c.exampleQA.length < 2) c.exampleQA.push({ user: "", character: "" });
    b.innerHTML =
      '<div class="char-edit-form">' +
      '<label class="char-label">角色名</label><input class="char-input" data-f="name" value="' + esc(c.name) + '" placeholder="角色名称">' +
      '<label class="char-label">性别</label><input class="char-input" data-f="gender" value="' + esc(c.gender || "") + '" placeholder="女 / 男 / 双性 / 无性别 / 自定义">' +
      '<label class="char-label">年龄</label><input class="char-input" data-f="age" value="' + esc(c.age || "") + '" placeholder="如：18 / 二十出头 / 外貌16实际数百岁（影响立绘，建议填）">' +
      '<label class="char-label">身份/背景</label><input class="char-input" data-f="identity" value="' + esc(c.identity || "") + '" placeholder="如：高中生 / 都市白领 / 古风修仙者（可空）">' +
      '<label class="char-label">场景</label><input class="char-input" data-f="scenario" value="' + esc(c.scenario || "") + '" placeholder="如：雨夜的旧书店（对应 SillyTavern 的 scenario；可空）">' +
      '<label class="char-label">头像（emoji）</label><input class="char-input" data-f="icon" value="' + esc(c.icon) + '" placeholder="🙂" maxlength="4" style="width:80px;">' +
      '<label class="char-label">发图基准图</label>' +
      (isN
        ? '<div style="font-size:12px;color:#888;padding:4px 0;">保存角色后可在此设置发图基准图（用作微信发图/自拍的样貌锚点）。</div>'
        : '<div class="char-baseimg-row" style="display:flex;align-items:center;gap:10px;padding:4px 0;"><div data-baseimg-thumb style="width:64px;height:64px;border-radius:8px;border:1px solid;background-size:cover;background-position:center;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#888;">无</div><input type="file" accept="image/*" data-baseimg-file style="display:none;"><button class="char-rel-btn" type="button" data-baseimg-pick style="font-size:12px;padding:3px 10px;">上传/更换</button><button class="char-rel-btn" type="button" data-baseimg-clear style="font-size:12px;padding:3px 10px;">清除</button></div>') +
      (isDev()
        ? '<label class="char-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"><input type="checkbox" data-f="enableAff" ' + (c.enableAffection === false ? "" : "checked") + '><span>启用好感度系统(开发者 · AI 用 [好感±N] 调整,初始 ' + api.affectionInit + ')</span></label>'
        : "") +
      (isDev()
        ? '<label class="char-label">好感度阈值事件（开发者模式 · 跨过分值时一次性触发剧情指令，重置好感度会清空触发记录）</label><br>    <div data-thresholds-wrap>' + (c.affectionThresholds || []).map(function (th, i) { return thresholdRowHtml(th, i); }).join("") + '</div><br>    <button class="char-rel-btn" type="button" data-add-threshold style="font-size:11px;padding:3px 10px;align-self:flex-start;">+ 添加阈值事件</button>'
        : "") +
      '<label class="char-label">性格关键词</label><input class="char-input" data-f="personality" value="' + esc(c.personality) + '" placeholder="如：包容、耐心">' +
      '<label class="char-label">说话方式</label><input class="char-input" data-f="speakingStyle" value="' + esc(c.speakingStyle) + '" placeholder="如：轻声细语">' +
      '<label class="char-label">行为铁则（3 条）</label>' +
      '<input class="char-input" data-f="r0" value="' + esc(c.rules[0]) + '" placeholder="铁则 1">' +
      '<input class="char-input" data-f="r1" value="' + esc(c.rules[1]) + '" placeholder="铁则 2">' +
      '<input class="char-input" data-f="r2" value="' + esc(c.rules[2]) + '" placeholder="铁则 3">' +
      '<label class="char-label">开场白</label><input class="char-input" data-f="opening" value="' + esc(c.openingLine) + '" placeholder="第一句话">' +
      '<label class="char-label">示例对话 1</label>' +
      '<input class="char-input" data-f="q0u" value="' + esc(c.exampleQA[0].user) + '" placeholder="用户说">' +
      '<input class="char-input" data-f="q0c" value="' + esc(c.exampleQA[0].character) + '" placeholder="角色回">' +
      '<label class="char-label">示例对话 2</label>' +
      '<input class="char-input" data-f="q1u" value="' + esc(c.exampleQA[1].user) + '" placeholder="用户说">' +
      '<input class="char-input" data-f="q1c" value="' + esc(c.exampleQA[1].character) + '" placeholder="角色回">' +
      '<div class="char-btn-row"><button class="char-rel-btn active" data-save>' + (isN ? "新建" : "保存修改") + '</button><button class="char-rel-btn" data-back>返回</button></div>' +
      "</div>";

    var thrs = Array.isArray(c.affectionThresholds) ? c.affectionThresholds.slice() : [];
    function readThrInputs() {
      var w = b.querySelector("[data-thresholds-wrap]");
      if (!w) return;
      w.querySelectorAll("[data-tr]").forEach(function (rowEl) {
        var i = parseInt(rowEl.dataset.tr, 10);
        if (isNaN(i) || !thrs[i]) return;
        var at = rowEl.querySelector('[data-tf="at"]');
        var dir = rowEl.querySelector('[data-tf="dir"]');
        var ins = rowEl.querySelector('[data-tf="instruction"]');
        if (at) thrs[i].at = Math.max(0, Math.min(100, parseInt(at.value, 10) || 0));
        if (dir) thrs[i].dir = dir.value || "up";
        if (ins) thrs[i].instruction = ins.value || "";
      });
    }
    function rerenderThr() {
      readThrInputs();
      var w = b.querySelector("[data-thresholds-wrap]");
      if (!w) return;
      w.innerHTML = thrs.map(function (t, i) { return thresholdRowHtml(t, i); }).join("");
      wireThr();
    }
    function wireThr() {
      b.querySelectorAll("[data-rm-threshold]").forEach(function (x) {
        x.addEventListener("click", function () {
          var i = parseInt(x.dataset.rmThreshold, 10);
          if (!isNaN(i)) {
            thrs.splice(i, 1);
            rerenderThr();
          }
        });
      });
    }
    var addThr = b.querySelector("[data-add-threshold]");
    if (addThr) addThr.addEventListener("click", function () { thrs.push({ at: 60, instruction: "", dir: "up" }); rerenderThr(); });
    wireThr();

    // Inline chat-image base picture: thumbnail plus upload / replace / clear, reusing the base-image
    // contract exposed by `chatImageSvc`.
    if (!isN && c.id) {
      var thumb = b.querySelector("[data-baseimg-thumb]");
      var file = b.querySelector("[data-baseimg-file]");
      var refreshThumb = function () {
        var ci = window.chatImageSvc || window.chatImageTextSvc;
        var p = ci && ci.getBaseImage ? Promise.resolve(ci.getBaseImage({ characterId: c.id })) : Promise.resolve(null);
        return p.then(function (url) {
          if (!thumb) return;
          if (url) {
            thumb.style.backgroundImage = 'url("' + url + '")';
            thumb.textContent = "";
          } else {
            thumb.style.backgroundImage = "";
            thumb.textContent = "无";
          }
        }).catch(function () {});
      };
      var pick = b.querySelector("[data-baseimg-pick]");
      if (pick) pick.addEventListener("click", function () { if (file) file.click(); });
      if (file) {
        file.addEventListener("change", function () {
          var f = file.files && file.files[0];
          if (!f) return;
          var rd = new FileReader();
          rd.onload = function () {
            var ci = window.chatImageSvc;
            var p = ci && ci.setBaseImage ? Promise.resolve(ci.setBaseImage({ characterId: c.id, imageUrl: rd.result })) : Promise.reject(new Error("nobase"));
            p.then(refreshThumb).catch(function (e) {
              alert(e && e.message === "nobase" ? "发图模块未就绪，无法保存基准图" : "基准图保存失败：" + ((e && e.message) || e));
            });
          };
          rd.readAsDataURL(f);
        });
      }
      var clear = b.querySelector("[data-baseimg-clear]");
      if (clear) {
        clear.addEventListener("click", function () {
          var ci = window.chatImageSvc;
          if (!ci || !ci.clearBaseImage) return;
          Promise.resolve(ci.clearBaseImage({ characterId: c.id })).then(refreshThumb).catch(function () {});
        });
      }
      refreshThumb();
    }

    b.querySelector("[data-save]").addEventListener("click", function () {
      var g = function (f) { return b.querySelector('[data-f="' + f + '"]').value.trim(); };
      var name = g("name");
      if (!name) {
        alert("角色名不能为空");
        return;
      }
      readThrInputs();
      var cleanThr = thrs
        .filter(function (t) { return t && typeof t.at === "number" && typeof t.instruction === "string" && t.instruction.trim(); })
        .map(function (t) {
          return { at: Math.max(0, Math.min(100, Math.round(t.at))), instruction: t.instruction.trim(), dir: ["up", "down", "both"].indexOf(t.dir) >= 0 ? t.dir : "up" };
        });
      var enableEl = b.querySelector('[data-f="enableAff"]');
      var s = {
        id: c.id || "u_" + Date.now().toString(36),
        name: name,
        gender: g("gender"),
        age: g("age"),
        identity: g("identity"),
        scenario: g("scenario"),
        icon: g("icon") || "🙂",
        enableAffection: isDev() ? !!(enableEl && enableEl.checked) : c.enableAffection !== false,
        personality: g("personality"),
        speakingStyle: g("speakingStyle"),
        rules: [g("r0"), g("r1"), g("r2")].filter(function (r) { return r; }),
        openingLine: g("opening"),
        exampleQA: [{ user: g("q0u"), character: g("q0c") }, { user: g("q1u"), character: g("q1c") }].filter(function (q) { return q.user || q.character; }),
        affectionThresholds: cleanThr,
        avatar: c.avatar || "",
        spec: c.spec || null,
      };
      while (s.rules.length < 3) s.rules.push("");
      while (s.exampleQA.length < 2) s.exampleQA.push({ user: "", character: "" });
      // The store is remote now (D1 / sidecar), so a save can fail where IndexedDB almost never
      // did — a swallowed rejection would look like "the button does nothing".
      api.saveCard(s).then(function (saved) {
        api.setActiveId(saved.id);
        tab = "mine";
        setTimeout(render, 30);
      }).catch(function (e) {
        alert("角色卡保存失败：" + ((e && e.message) || e));
      });
    });
    b.querySelector("[data-back]").addEventListener("click", function () { tab = "mine"; render(); });
  }

  function render() {
    var h = [];
    h.push('<div class="char-panel-header"><h3>角色卡</h3><button class="iconbtn char-close-btn" data-close>✕</button></div>');
    h.push('<div class="char-relation-row" style="margin-bottom:6px;">');
    var tabs = [["mine", "我的"], ["new", "新建"]];
    for (var i = 0; i < tabs.length; i++) {
      h.push('<button class="char-rel-btn ' + (tab === tabs[i][0] ? "active" : "") + '" data-tab="' + tabs[i][0] + '">' + tabs[i][1] + "</button>");
    }
    h.push("</div>");
    h.push(curSec());
    h.push('<div data-body></div>');
    P.innerHTML = h.join("");
    var body = P.querySelector("[data-body]");
    if (tab === "mine") mine(body);
    else editor(body, null);
    var closer = P.querySelector("[data-close]");
    if (closer) closer.addEventListener("click", close);
    P.querySelectorAll("[data-tab]").forEach(function (x) {
      x.addEventListener("click", function () { tab = x.dataset.tab; render(); });
    });
    P.querySelectorAll("[data-rel]").forEach(function (x) {
      x.addEventListener("click", function () { api.setActiveRelation(x.dataset.rel); render(); });
    });
    P.querySelectorAll("[data-emo]").forEach(function (x) {
      x.addEventListener("click", function () { api.setActiveEmotion(x.dataset.emo); render(); });
    });
    // The free-text box is persisted so it comes back next time, and the relation is mapped to the
    // worker's enum on the way out.
    var relT = P.querySelector("[data-rel-text]");
    if (relT) {
      relT.addEventListener("change", function () {
        var v = relT.value.trim();
        try { window.localStorage.setItem("cfw_relation_text_v1", v); } catch (e) {}
        api.setActiveRelation(relationFromText(v));
      });
    }
    var emoT = P.querySelector("[data-emo-text]");
    if (emoT) {
      emoT.addEventListener("change", function () {
        var v = emoT.value.trim();
        try { window.localStorage.setItem("cfw_emotion_text_v1", v); } catch (e) {}
        api.setActiveEmotion(v || "neutral");
      });
    }
    var clearBtn = P.querySelector("[data-clear]");
    if (clearBtn) clearBtn.addEventListener("click", function () { api.setActiveId(""); setTimeout(render, 30); });
    var resetAffBtn = P.querySelector("[data-reset-aff]");
    if (resetAffBtn) resetAffBtn.addEventListener("click", function () { api.resetActiveAffection().then(function () { render(); }); });
    P.querySelectorAll("[data-aff-step]").forEach(function (x) {
      x.addEventListener("click", function () {
        api.adjustActiveAffection(parseInt(x.dataset.affStep, 10) || 0).then(function () { render(); });
      });
    });
    var affSet = P.querySelector("[data-aff-set]");
    if (affSet) {
      affSet.addEventListener("change", function () {
        api.setActiveAffection(parseInt(affSet.value, 10) || 0).then(function () { render(); });
      });
    }
    P.querySelectorAll("[data-pick-scene]").forEach(function (x) {
      x.addEventListener("click", function (ev) {
        if (ev.target.closest("[data-rmscene]")) return;
        api.setActiveId(x.dataset.pickScene);
        setTimeout(render, 30);
      });
    });
    P.querySelectorAll("[data-rmscene]").forEach(function (x) {
      x.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (window.multiSvc && window.multiSvc.removeFromScene) window.multiSvc.removeFromScene(x.dataset.rmscene);
        setTimeout(render, 30);
      });
    });
    var large = P.querySelector(".char-avatar-large");
    var cur = api.getActiveCard();
    if (large && cur) applyAvatarEl(large, cur);
  }

  function open() {
    ensure();
    mask.style.display = "flex";
    render();
  }

  function close() {
    if (mask) mask.style.display = "none";
  }

  window.addEventListener("avatar:changed", function (ev) {
    var id = ev && ev.detail ? ev.detail.id : null;
    var sel = id ? '.avatar.bot[data-char-id="' + ((window.CSS && CSS.escape) ? CSS.escape(id) : id) + '"]' : ".avatar.bot[data-char-id]";
    document.querySelectorAll(sel).forEach(function (a) {
      var cid = a.dataset.charId;
      if (!cid) return;
      var cur = api.getActiveCard();
      var card = cur && cid === cur.id ? cur : null;
      if (!card) {
        var list = api.listAllCards();
        for (var i = 0; i < list.length; i++) if (list[i].id === cid) card = list[i];
      }
      applyAvatarEl(a, card || { id: cid, icon: a.textContent, name: a.title });
    });
    if (mask && mask.style.display !== "none") render();
  });

  window.characterSvc = {
    open: open,
    close: close,
    getActiveCard: api.getActiveCard,
    setActiveId: api.setActiveId,
    getActiveRelation: api.getActiveRelation,
    setActiveRelation: api.setActiveRelation,
    getActiveEmotion: api.getActiveEmotion,
    setActiveEmotion: api.setActiveEmotion,
    getActiveAffection: api.getActiveAffection,
    setActiveAffection: api.setActiveAffection,
    adjustActiveAffection: api.adjustActiveAffection,
    resetActiveAffection: api.resetActiveAffection,
    parseAffectionTag: api.parseAffectionTag,
    decorateAiRow: decorate,
    listAllCards: api.listAllCards,
    getAllCards: api.getAllCards,
    saveCard: api.saveCard,
    deleteCard: api.deleteCard,
    getPendingThresholdEvents: api.getPendingThresholdEvents,
    clearPendingThresholdEvents: api.clearPendingThresholdEvents,
    resetThresholdTriggers: api.resetThresholdTriggers,
    relations: api.relations,
    builtinEmotions: api.builtinEmotions,
    // Repaint only while the panel is open; when it is closed this is a data refresh alone.
    reload: function () {
      return api.reload().then(function () {
        try { if (mask && mask.style.display !== "none") render(); } catch (e) {}
      });
    },
  };

  // Read once at startup so the sidebar and the send path see the right active card before anyone
  // clicks anything. The legacy copy lands first: a fresh install has nothing to move, an upgraded
  // one must see its cards on the very first read. A failed migration still refreshes whatever SQL
  // already holds, and the error above is the loud part. A completed copy notifies once, because
  // panels that read before it finished would otherwise keep showing the empty state.
  migrateLegacyCards()
    .then(function (moved) {
      return api.refresh().then(function () {
        if (moved > 0) return api.reload();
      });
    })
    .catch(function (e) {
      try { console.error("[character] 角色卡读取失败（存储不可用？）：", e); } catch (x) {}
    });

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("characterBtn");
    if (b) b.addEventListener("click", open);
  });
})();
