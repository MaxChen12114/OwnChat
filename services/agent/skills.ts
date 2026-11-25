/**
 * Skill store and catalogue — three-level progressive disclosure for agent skills.
 *
 * Level 1 is a one-line-per-skill catalogue that lives in the system prompt, level 2 is the body,
 * fetched on demand by the `load_skill` tool, and level 3 (references) is not injected at all: the
 * browser shell has no host filesystem, so "read the attachment when needed" is not implementable
 * here. Only the catalogue is resident, which is the whole point — the earlier design pasted every
 * enabled skill's body into `extraSystemPrompts` on every round, which made skills a duplicate of the
 * prompt modules and burned tokens per turn.
 *
 * Community skills are untrusted input (they can carry prompt injection), so an import is always
 * created with `enabled: false` and stays out of the catalogue until a human reads it and ticks the
 * box. That default is a security boundary, not a UX preference.
 *
 * Storage and network arrive through {@link SkillsEnv}: `localStorage` in the page, a stub in tests.
 * The settings card itself is not here — it is DOM, so it lives in `l0/wiring/skills.js` and reaches
 * back through `onChange`.
 *
 * Lock: `scripts/test-skills-import.mjs` (imports through the real store) and `test/slot-runtime.test.mjs`.
 * @module services/agent/skills
 */

const SKILLS_LS_KEY = "cfw_skills_v1";
const SKILLS_LS_ENABLED_KEY = "cfw_skills_enabled_v1";
/**
 * Body length warning line. The kernel truncates tool results to 8000 chars (head 6000 + tail 1500),
 * so anything past 6000 loses its tail on load — both the import message and the list say so.
 */
const SKILLS_BODY_WARN = 6000;
/** Per-description cap, aligned with the 500-char limit the harness uses. */
const SKILLS_DESC_MAX = 500;
/**
 * Whole-catalogue cap. Deliberate: if the catalogue gets pushed out of the prompt, every skill becomes
 * unreachable at once, so over budget it degrades to bare names and then says how many were dropped.
 */
const SKILLS_CATALOG_MAX = 4000;

/** A stored skill. Everything is optional because the store is user-editable JSON. */
export interface Skill {
  [key: string]: unknown;
}

export interface SkillParsed {
  name: string;
  description: string;
  references: string[];
  content: string;
}

export interface SkillsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SkillsEnv {
  storage: SkillsStorage;
  /** Used by {@link SkillsApi.importFromUrl} and {@link SkillsApi.importStarterLibrary}. */
  fetch?: (url: string, init?: unknown) => Promise<SkillsResponse>;
  /** Called after any mutation that changes what the card should show. */
  onChange?(): void;
}

export interface SkillsResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SkillsApi {
  getAll(): Skill[];
  save(skill: unknown): void;
  remove(id: unknown): void;
  setEnabled(id: unknown, on: unknown): void;
  list(): Skill[];
  isGlobalEnabled(): boolean;
  setGlobalEnabled(on: unknown): void;
  buildCatalogPrompt(onlyNames?: unknown): string;
  getByName(name: unknown): Skill | null;
  parseSkillMd(text: unknown): SkillParsed;
  importFromText(text: unknown, source?: unknown): Skill;
  importFromUrl(url: unknown): Promise<Skill>;
  importStarterLibrary(): Promise<number>;
  sizeHint(skill: unknown): string;
  /** Exposed so the card can render the same threshold it enforces. */
  bodyWarn: number;
}

function text(value: unknown): string {
  return value == null ? "" : typeof value === "string" ? value : String(value);
}

function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) out[k] = v;
  }
  return out;
}

export function createSkills(env: SkillsEnv): SkillsApi {
  const storage = env.storage;
  const doFetch = typeof env.fetch === "function" ? env.fetch : null;
  const onChange = typeof env.onChange === "function" ? env.onChange : () => undefined;

  function getAll(): Skill[] {
    try {
      const raw = storage.getItem(SKILLS_LS_KEY);
      if (!raw) return [];
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveAll(arr: unknown): void {
    try {
      storage.setItem(SKILLS_LS_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
    } catch (e) {
      // Quota or a locked-down store: the in-memory list stays usable, persistence is best effort.
    }
  }

  function isGlobalEnabled(): boolean {
    return (storage.getItem(SKILLS_LS_ENABLED_KEY) ?? "1") !== "0";
  }

  function setGlobalEnabled(on: unknown): void {
    try {
      storage.setItem(SKILLS_LS_ENABLED_KEY, on ? "1" : "0");
    } catch (e) {
      // Same as saveAll.
    }
    onChange();
  }

  function uid(): string {
    return "sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function sizeHint(skill: unknown): string {
    const n = text(recOf(skill).content).length;
    return (
      "（正文 " +
      n +
      " 字" +
      (n > SKILLS_BODY_WARN ? "，超过 " + SKILLS_BODY_WARN + "：加载时会被工具结果裁剪，建议精简" : "") +
      "）"
    );
  }

  /**
   * Builds the resident catalogue block.
   * @param onlyNames when the active role card names its skills, only those are listed; an empty or
   * non-array value means "every enabled skill", which is the old behaviour.
   * @returns the block to append to the system prompt, or "" when the master switch is off or nothing
   * is enabled — callers must treat "" as "append nothing", not as "append an empty header".
   */
  function buildCatalogPrompt(onlyNames?: unknown): string {
    try {
      if (!isGlobalEnabled()) return "";
      const allow =
        Array.isArray(onlyNames) && onlyNames.length
          ? new Set(onlyNames.map((n) => text(n).trim()).filter(Boolean))
          : null;
      const arr = getAll()
        .filter((s) => s && s.enabled && text(s.name).trim())
        .filter((s) => !allow || allow.has(text(s.name).trim()))
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
      if (!arr.length) return "";
      const lines: string[] = [];
      let used = 0;
      let dropped = 0;
      for (const s of arr) {
        const name = text(s.name).trim();
        let desc = text(s.description).replace(/\s+/g, " ").trim();
        if (!desc) desc = "（未写 description —— 不确定是否匹配时先 load_skill 看正文）";
        if (desc.length > SKILLS_DESC_MAX) desc = desc.slice(0, SKILLS_DESC_MAX) + "…";
        let line = "- `" + name + "`: " + desc;
        if (used + line.length > SKILLS_CATALOG_MAX) {
          const bare = "- `" + name + "`";
          if (used + bare.length > SKILLS_CATALOG_MAX) {
            dropped = arr.length - lines.length;
            break;
          }
          line = bare;
        }
        used += line.length;
        lines.push(line);
      }
      if (dropped > 0) lines.push("- （目录过长，其余 " + dropped + " 条未列出：可按名直接试 load_skill）");
      return (
        "\n\n【可用技能目录】每个技能都是「摘要 + 正文」两段式：想用某个技能，先按名调 `load_skill` 取全文再行动，" +
        "不要凭这里的摘要臆测内容。\n" +
        lines.join("\n")
      );
    } catch (e) {
      return "";
    }
  }

  /** Exact name first, then case-insensitive — `load_skill` addresses skills by name, never by id. */
  function getByName(name: unknown): Skill | null {
    const want = text(name).trim();
    if (!want) return null;
    const arr = getAll();
    const nm = (s: Skill) => text(s.name).trim();
    return (
      arr.find((s) => nm(s) === want) || arr.find((s) => nm(s).toLowerCase() === want.toLowerCase()) || null
    );
  }

  function stripQuotes(s: unknown): string {
    const v = text(s).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  }

  /**
   * Parses a `SKILL.md`: optional YAML frontmatter (`name` / `description` / `references`, the latter
   * as a comma list or a `- item` block) followed by the body.
   * @returns the body as `content`; without frontmatter the first `# heading` becomes the name and the
   * whole text becomes the body. A file with neither still gets a name, so it is importable.
   */
  function parseSkillMd(text0: unknown): SkillParsed {
    const src = text(text0).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let name = "";
    let description = "";
    let references: string[] = [];
    let body = src.trim();
    const fm = src.match(/^\uFEFF?---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fm) {
      const meta = fm[1];
      body = (fm[2] || "").trim();
      let curKey: string | null = null;
      for (const ln of meta.split("\n")) {
        const listM = ln.match(/^\s*-\s+(.*)$/);
        if (listM && curKey === "references") {
          const v = stripQuotes(listM[1].trim());
          if (v) references.push(v);
          continue;
        }
        const kv = ln.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        curKey = key;
        if (key === "name") name = stripQuotes(val);
        else if (key === "description") description = stripQuotes(val);
        else if (key === "references" || key === "resources") {
          if (val) references = val.split(",").map((x) => stripQuotes(x.trim())).filter(Boolean);
        }
      }
    }
    if (!name) {
      const h = body.match(/^#\s+(.+)$/m);
      if (h) name = h[1].trim();
    }
    if (!name) name = "未命名技能";
    return { name: name, description: description, references: references, content: body };
  }

  /**
   * Imports a SKILL.md body.
   * @returns the stored skill. It is created with `enabled: false` on purpose: imported skills are
   * untrusted and must not reach the catalogue until a human ticks them.
   * @throws when the text parses to nothing — a silent no-op would look like a successful import.
   */
  function importFromText(text0: unknown, source?: unknown): Skill {
    const parsed = parseSkillMd(text0);
    if (!parsed.content && !parsed.name) throw new Error("解析为空：不是有效的 SKILL.md");
    const arr = getAll();
    const order = arr.reduce((m, s) => Math.max(m, Number(s.order ?? 0)), 0) + 1;
    const skill: Skill = {
      id: uid(),
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      references: parsed.references || [],
      enabled: false,
      order: order,
      source: source || "import",
      createdAt: Date.now(),
    };
    arr.push(skill);
    saveAll(arr);
    return skill;
  }

  async function importFromUrl(url: unknown): Promise<Skill> {
    const u = text(url).trim();
    if (!u) throw new Error("请填链接");
    if (!/^https?:\/\//i.test(u)) throw new Error("链接需以 http(s):// 开头");
    if (!doFetch) throw new Error("当前环境不支持拉取链接");
    const r = await doFetch(u);
    if (!r.ok) throw new Error("拉取失败: " + r.status);
    const body = await r.text();
    return importFromText(body, u);
  }

  function save(skill: unknown): void {
    const patch = recOf(skill);
    if (!skill || !patch.id) return;
    const arr = getAll();
    const i = arr.findIndex((s) => s && s.id === patch.id);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], patch);
    else arr.push(patch);
    saveAll(arr);
  }

  function remove(id: unknown): void {
    saveAll(getAll().filter((s) => s && s.id !== id));
  }

  function setEnabled(id: unknown, on: unknown): void {
    const arr = getAll();
    const s = arr.find((x) => x && x.id === id);
    if (s) {
      s.enabled = !!on;
      saveAll(arr);
    }
  }

  function list(): Skill[] {
    return getAll();
  }

  /**
   * Pulls the starter library from `POST /api/presets`, the same unlock-gated endpoint the prompt
   * modules use — the old static JSON was readable by anyone, including locked-out visitors.
   * Deduplicates by **name**: library ids are `lib-*` while imported ids are `sk_*`, so ids never match.
   * @returns how many skills were added.
   * @throws when there is no unlock token, the request fails, or the library is empty.
   */
  async function importStarterLibrary(): Promise<number> {
    let tok = "";
    try {
      tok = storage.getItem("cfw_unlock_token_v1") || "";
    } catch (e) {
      // Treated as "not unlocked" below.
    }
    if (!tok) throw new Error("需先解锁（技能库与指令模块库同走解锁门禁）");
    if (!doFetch) throw new Error("当前环境不支持拉取技能库");
    const r = await doFetch("/api/presets", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unlockToken: tok }),
    });
    if (!r.ok) throw new Error("拉取技能库失败: " + r.status);
    const data = recOf(await r.json());
    const skills = Array.isArray(data.skills) ? data.skills : [];
    if (!skills.length) throw new Error("技能库为空");
    const existing = new Set(getAll().map((s) => text(s.name).trim()));
    let added = 0;
    for (const item of skills) {
      const it = recOf(item);
      const content = typeof it.content === "string" ? it.content : typeof item === "string" ? item : "";
      if (!content.trim()) continue;
      const nm = text(it.name).trim();
      if (!nm || existing.has(nm)) continue;
      const arr = getAll();
      const order = arr.reduce((m, s) => Math.max(m, Number(s.order || 0)), 0) + 1;
      arr.push({
        id: uid(),
        name: nm,
        description: it.description || "",
        content: content.trim(),
        references: [],
        enabled: false,
        order: order,
        source: it.source || "library",
        license: it.license || "",
        createdAt: Date.now(),
      });
      saveAll(arr);
      existing.add(nm);
      added++;
    }
    return added;
  }

  return {
    getAll: getAll,
    save: save,
    remove: remove,
    setEnabled: setEnabled,
    list: list,
    isGlobalEnabled: isGlobalEnabled,
    setGlobalEnabled: setGlobalEnabled,
    buildCatalogPrompt: buildCatalogPrompt,
    getByName: getByName,
    parseSkillMd: parseSkillMd,
    importFromText: importFromText,
    importFromUrl: importFromUrl,
    importStarterLibrary: importStarterLibrary,
    sizeHint: sizeHint,
    bodyWarn: SKILLS_BODY_WARN,
  };
}
