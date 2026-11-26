/**
 * Data-facade tools: character cards, the lore book and prompt presets.
 *
 * These three tools only translate model arguments into calls on stores that already own
 * persistence (`characterSvc`, `lorebookSvc`, `window.presetStore`). Keeping the action dispatch here
 * means the tool bundle carries schemas and one-line forwards, while every CRUD branch, merge rule
 * and error string stays testable without a window. The stores are looked up per call so a tool
 * call made during boot cannot capture a missing facade.
 *
 * @module services/tools/agent/cards
 */

/** One tool result; `ok: false` always carries a human-readable error. */
export interface ToolResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** The `characterSvc` subset these tools use. */
export interface CharacterStore {
  getAllCards(): unknown;
  deleteCard?(id: string): unknown;
  setActiveId?(id: string): unknown;
  saveCard?(card: Record<string, unknown>): unknown;
}

/** The `lorebookSvc` subset these tools use. */
export interface LorebookStore {
  getAll(): unknown;
  getEntry(id: string): unknown;
  deleteEntry?(id: string): unknown;
  saveEntry?(entry: Record<string, unknown>): unknown;
}

/** The `window.presetStore` subset these tools use. */
export interface PresetStore {
  load(): unknown;
  save(next: unknown[]): void;
  uid(): string;
  order(arr: unknown[]): number;
  preview(content: unknown): string;
  toggle(arr: unknown[], id: string, enabled: unknown): unknown[];
}

export interface CardToolDeps {
  character(): CharacterStore | null;
  lorebook(): LorebookStore | null;
  presetStore(): PresetStore | null;
  /** Active character id (`tavern_active_char_id`); the bundle owns the storage try/catch. */
  readActiveCardId(): string;
}

export interface CardToolsApi {
  manageCharacterCard(args: unknown): Promise<ToolResult>;
  manageLorebook(args: unknown): Promise<ToolResult>;
  managePreset(args: unknown): Promise<ToolResult>;
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errText(e: unknown): string {
  const value = e;
  if (value !== null && typeof value === "object") {
    const own = Object.getOwnPropertyDescriptor(value, "message");
    if (own && typeof own.value === "string" && own.value) return own.value;
    const proto = Object.getPrototypeOf(value);
    if (proto) {
      const inherited = Object.getOwnPropertyDescriptor(proto, "message");
      if (inherited && typeof inherited.value === "string" && inherited.value) return inherited.value;
    }
  }
  return String(e);
}

/** Create the three data-facade tools. */
export function createCardTools(deps: CardToolDeps): CardToolsApi {
  async function manageCharacterCard(input: unknown): Promise<ToolResult> {
    const store = deps.character();
    if (!store || typeof store.getAllCards !== "function") {
      return { ok: false, error: "角色卡模块未就绪 (character.js / window.characterSvc)" };
    }
    const args = recOf(input);
    const action = args["action"];
    try {
      if (action === "list") {
        const cards = arrOf(await store.getAllCards());
        const activeId = deps.readActiveCardId();
        return {
          ok: true,
          active_id: activeId,
          count: cards.length,
          cards: cards.map((raw) => {
            const c = recOf(raw);
            return {
              id: c["id"], name: c["name"], gender: c["gender"], age: c["age"],
              identity: c["identity"], icon: c["icon"], personality: c["personality"],
              active: c["id"] === activeId,
            };
          }),
        };
      }
      if (action === "get") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "get 需要 id" };
        const cards = arrOf(await store.getAllCards());
        for (let i = 0; i < cards.length; i++) {
          const c = recOf(cards[i]);
          if (c["id"] === id) return { ok: true, card: cards[i] };
        }
        return { ok: false, error: "未找到角色卡: " + id };
      }
      if (action === "delete") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "delete 需要 id" };
        if (typeof store.deleteCard !== "function") return { ok: false, error: "deleteCard 不可用" };
        await store.deleteCard(id);
        return { ok: true, action: "delete", id: id };
      }
      if (action === "activate") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "activate 需要 id" };
        if (typeof store.setActiveId !== "function") return { ok: false, error: "setActiveId 不可用" };
        store.setActiveId(id);
        return { ok: true, action: "activate", id: id };
      }
      if (action === "create" || action === "update") {
        if (typeof store.saveCard !== "function") return { ok: false, error: "saveCard 不可用" };
        const inputCard = recOf(args["card"]);
        let base: Record<string, unknown> = {};
        if (action === "update") {
          const id = str(args["id"]);
          if (!id) return { ok: false, error: "update 需要 id" };
          const cards = arrOf(await store.getAllCards());
          const found = cards.find((raw) => recOf(raw)["id"] === id);
          base = recOf(found);
          if (!base["id"]) return { ok: false, error: "未找到角色卡: " + id };
        }
        const merged: Record<string, unknown> = Object.assign({}, base, inputCard);
        if (action === "update") merged["id"] = str(args["id"]);
        if (!merged["name"]) return { ok: false, error: "name 不能为空" };
        const saved = await store.saveCard(merged);
        return { ok: true, action: action, card: saved || merged };
      }
      return { ok: false, error: "未知 action: " + String(action) };
    } catch (e) {
      return { ok: false, error: "角色卡操作失败: " + errText(e) };
    }
  }

  async function manageLorebook(input: unknown): Promise<ToolResult> {
    const store = deps.lorebook();
    if (!store || typeof store.getAll !== "function") {
      return { ok: false, error: "世界书模块未就绪 (lorebook.js / window.lorebookSvc)" };
    }
    const args = recOf(input);
    const action = args["action"];
    try {
      if (action === "list") {
        const all = arrOf(store.getAll());
        return {
          ok: true,
          count: all.length,
          entries: all.map((raw) => {
            const e = recOf(raw);
            const content = typeof e["content"] === "string" ? e["content"] : "";
            return {
              id: e["id"], name: e["name"], keywords: e["keywords"], alwaysOn: e["alwaysOn"],
              priority: e["priority"], scope: e["scope"], enabled: e["enabled"],
              preview: content.slice(0, 80),
            };
          }),
        };
      }
      if (action === "get") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "get 需要 id" };
        const entry = store.getEntry(id);
        return entry ? { ok: true, entry: entry } : { ok: false, error: "未找到条目: " + id };
      }
      if (action === "delete") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "delete 需要 id" };
        if (typeof store.deleteEntry !== "function") return { ok: false, error: "deleteEntry 不可用" };
        store.deleteEntry(id);
        return { ok: true, action: "delete", id: id };
      }
      if (action === "create" || action === "update") {
        if (typeof store.saveEntry !== "function") return { ok: false, error: "saveEntry 不可用" };
        const inputEntry = recOf(args["entry"]);
        let base: Record<string, unknown> = {};
        if (action === "update") {
          const id = str(args["id"]);
          if (!id) return { ok: false, error: "update 需要 id" };
          base = recOf(store.getEntry(id));
          if (!base["id"]) return { ok: false, error: "未找到条目: " + id };
        }
        const merged: Record<string, unknown> = Object.assign({}, base, inputEntry);
        if (action === "update") merged["id"] = str(args["id"]);
        const content = typeof merged["content"] === "string" ? merged["content"].trim() : "";
        if (!(merged["name"] || content)) return { ok: false, error: "name 和 content 不能都为空" };
        const saved = store.saveEntry(merged);
        return { ok: true, action: action, entry: saved };
      }
      return { ok: false, error: "未知 action: " + String(action) };
    } catch (e) {
      return { ok: false, error: "世界书操作失败: " + errText(e) };
    }
  }

  async function managePreset(input: unknown): Promise<ToolResult> {
    const store = deps.presetStore();
    if (!store || typeof store.load !== "function") {
      return { ok: false, error: "预设数据层未就绪 (presets.js / window.presetStore)" };
    }
    const args = recOf(input);
    const action = args["action"];
    try {
      const arr = arrOf(store.load());
      if (action === "list") {
        const sorted = arr.slice().sort((a, b) => (Number(recOf(a)["order"]) || 0) - (Number(recOf(b)["order"]) || 0));
        return {
          ok: true,
          count: arr.length,
          presets: sorted.map((raw) => {
            const p = recOf(raw);
            return {
              id: p["id"], name: p["name"], enabled: !!p["enabled"], group: p["group"] || "",
              preview: store.preview(p["content"]),
            };
          }),
        };
      }
      if (action === "get") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "get 需要 id" };
        const found = arr.find((raw) => recOf(raw)["id"] === id);
        return found ? { ok: true, preset: found } : { ok: false, error: "未找到 preset: " + id };
      }
      if (action === "delete") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "delete 需要 id" };
        const next = arr.filter((raw) => recOf(raw)["id"] !== id);
        if (next.length === arr.length) return { ok: false, error: "未找到 preset: " + id };
        store.save(next);
        return { ok: true, action: "delete", id: id };
      }
      if (action === "toggle") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "toggle 需要 id" };
        if (!arr.some((raw) => recOf(raw)["id"] === id)) return { ok: false, error: "未找到 preset: " + id };
        const next = store.toggle(arr, id, args["enabled"]);
        store.save(next);
        const p = recOf(next.find((raw) => recOf(raw)["id"] === id));
        return { ok: true, action: "toggle", id: id, enabled: p["enabled"] };
      }
      if (action === "create") {
        const inputPreset = recOf(args["preset"]);
        if (!inputPreset["name"]) return { ok: false, error: "name 不能为空" };
        const p = {
          id: store.uid(), name: inputPreset["name"], content: inputPreset["content"] || "",
          enabled: !!inputPreset["enabled"], order: store.order(arr), group: inputPreset["group"] || "",
        };
        arr.push(p);
        store.save(arr);
        return { ok: true, action: "create", preset: p };
      }
      if (action === "update") {
        const id = str(args["id"]);
        if (!id) return { ok: false, error: "update 需要 id" };
        const p = arr.find((raw) => recOf(raw)["id"] === id);
        if (!p) return { ok: false, error: "未找到 preset: " + id };
        const inputPreset = recOf(args["preset"]);
        const target = recOf(p);
        if (typeof inputPreset["name"] === "string") target["name"] = inputPreset["name"];
        if (typeof inputPreset["content"] === "string") target["content"] = inputPreset["content"];
        if (typeof inputPreset["enabled"] === "boolean") target["enabled"] = inputPreset["enabled"];
        if (typeof inputPreset["group"] === "string") target["group"] = inputPreset["group"];
        store.save(arr);
        return { ok: true, action: "update", preset: target };
      }
      return { ok: false, error: "未知 action: " + String(action) };
    } catch (e) {
      return { ok: false, error: "preset 操作失败: " + errText(e) };
    }
  }

  return { manageCharacterCard, manageLorebook, managePreset };
}
