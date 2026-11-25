/**
 * The remote-desk tool group, minus transport: the sixteen `pc_*` descriptions, parameter tables,
 * argument clamps, result text and the failure map to user-facing guidance. Nothing here reads
 * storage or opens a socket — the wiring injects the gate, the two call ports and the image hooks.
 *
 * Every `run` answers in text instead of throwing. A desk that is locked, switched off or
 * unreachable is a normal outcome the model should read and route around; a rejected tool aborts
 * the whole turn instead, which is why the transport errors come back as guidance strings.
 * @module services/local/pc-tools
 */

/** The five inputs the gate needs: two switches, two tokens and whether a desktop shell is present. */
export interface PcGate {
  unlocked: boolean;
  enabled: boolean;
  hasInvoke: boolean;
  token: string;
  bridgeToken: string;
}

/** Per-call body and verb. `body` is omitted for reads, which turns the request into a GET. */
export interface PcCallOptions {
  body?: unknown;
  method?: string;
}

/** One `/shot` result: the bytes plus the four geometry facts the caller reports to the model. */
export interface PcShot {
  blob: unknown;
  width: unknown;
  height: unknown;
  sourceWidth: unknown;
  sourceHeight: unknown;
}

/** What the host needs to file a screenshot into the conversation. */
export interface PcImageMeta {
  id: string;
  name: string;
  w: unknown;
  h: unknown;
  source: string;
}

/** The injected edges. Everything the service cannot do without a browser or a desktop shell. */
export interface PcToolPorts {
  /** Snapshot of the gate inputs; called once per `defineTools`. */
  gate: () => PcGate;
  /** JSON call. Must reject with the transport error; the service maps it to guidance. */
  call: (op: string, opts?: PcCallOptions) => Promise<unknown>;
  /** Binary call. Same rejection contract as {@link PcToolPorts.call}. */
  callBlob: (op: string) => Promise<PcShot>;
  /** Whether this turn carries vision; the wiring falls back to the process-wide flag. */
  visionOn: (ctx: unknown) => boolean;
  /** Data URL for the vision channel; empty string when the read fails. */
  readDataUrl: (blob: unknown) => Promise<string>;
  /** Persist the blob; false when the host has no attachment store. */
  putBlob: (id: string, blob: unknown) => Promise<boolean>;
  /** Append a stored image to the live conversation; false when the host hook is missing. */
  appendImage: (meta: PcImageMeta, ctx: unknown) => boolean;
  /** Show a throwaway bubble. Owns the object-URL lifetime; false when the hook is missing. */
  showBubble: (blob: unknown, meta: PcImageMeta, ctx: unknown) => boolean;
  /** Hand the image to the model for the next turn; false when the host hook is missing. */
  pushImage: (dataUrl: string, size: { w: unknown; h: unknown }, ctx: unknown) => boolean;
  /** Conversation-unique image id, `pcshot_<base36 time>_<base36 random>`. */
  imageId: () => string;
  /** `HH:MM:SS` for the screenshot name. */
  clockLabel: () => string;
}

interface PcToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive?: boolean | ((args: unknown) => boolean);
  run: (args: unknown, ctx: unknown) => Promise<string>;
}

/** Tool names in registration order; the manifest derives governance from the `pc_` prefix. */
export const PC_TOOL_NAMES = [
  "pc_status",
  "pc_shot",
  "pc_ui",
  "pc_windows",
  "pc_focus",
  "pc_click_control",
  "pc_click",
  "pc_type",
  "pc_key",
  "pc_scroll",
  "pc_clipboard",
  "pc_audit",
  "pc_ls",
  "pc_read",
  "pc_grep",
  "pc_panic",
];

/**
 * Object guard for values that came back from the desk or from storage. Fields are copied one by
 * one: that is how this codebase reads unknown JSON without a cast.
 */
function recOf(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = Object.entries(value);
  for (let i = 0; i < entries.length; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/** Array guard for the same reason as {@link recOf}. */
function arrOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(value[i]);
  return out;
}

function txt(value: unknown): string {
  return String(value);
}

function orText(value: unknown, fallback: string): string {
  return value ? String(value) : fallback;
}

/**
 * Clamp an integer tool argument. Mirrors the original `parseInt(x) || fallback` chain: a missing,
 * non-numeric or zero value falls back, then the range is applied.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = parseInt(txt(value), 10) || fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Whether the tool group may register at all: both switches on, plus a token. A desktop shell
 * accepts its bridge token instead of the unlock token, because the direct path never sees the
 * Worker.
 * @param gate Current gate inputs.
 * @returns True when `defineTools` should register.
 */
export function pcReady(gate: PcGate): boolean {
  if (!gate.unlocked || !gate.enabled) return false;
  if (gate.hasInvoke) return !!(gate.bridgeToken || gate.token);
  return !!gate.token;
}

function messageOf(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const message = Reflect.get(value, "message");
    if (message) return String(message);
  }
  return String(value);
}

/**
 * Map a transport error to the sentence the model should act on. Unmatched errors keep the raw
 * message, so an unexpected shape stays visible instead of being flattened into "failed".
 * @param error Anything the transport rejected with.
 * @returns Guidance text, never empty.
 */
export function pcErrText(error: unknown): string {
  const message = messageOf(error);
  if (/bridge token/i.test(message)) return "桌面直连还没填 bridge token：设置 → 远程电脑 里粘贴一次（电脑上 remote-desk/.pc-token 的内容）。";
  if (/401/.test(message)) return "远程电脑未解锁或 token 失效：先在设置里退出私密模式再重新解锁。";
  if (/503/.test(message)) return "Worker 还没配好 PC_* secrets（见 remote-desk/worker/worker.patch.md）。";
  if (/502|隧道/.test(message)) return "PC 隧道不可达：检查电脑上的 cloudflared 服务和 pc-bridge 是否在跑。";
  return "远程电脑调用失败：" + message;
}

function clip(value: unknown, max: number): string {
  const text = value == null ? "" : String(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * One `pc_status` answer: lock state, screen geometry and the foreground window.
 * @param value The `/status` body.
 * @returns Three lines, `?` for every missing field.
 */
export function pcFmtStatus(value: unknown): string {
  const data = recOf(value);
  const screen = recOf(data.screen);
  const foreground = recOf(data.foreground);
  return [
    "PC 状态：" + (data.locked ? "锁屏" : "未锁屏"),
    "屏幕：" + orText(screen.width, "?") + "x" + orText(screen.height, "?") + "，DPI " + orText(data.dpi, "?") + "，缩放 " + orText(data.scale, "?") + "x",
    "前台：" + orText(foreground.process, "?") + " — " + orText(foreground.title, "(无标题)") + "（hwnd " + orText(foreground.hwnd, "?") + "）",
  ].join("\n");
}

/**
 * One `pc_ui` answer: the UIA control tree of the foreground window, one control per line.
 *
 * The 6000-character cap is checked against the joined text after every push, so the last line
 * that fit is kept and the truncation hint becomes the final line. A caller that hits the cap has
 * to narrow `limit` or focus the target window — the hint says so because the model cannot tell
 * from the count alone.
 * @param value The `/ui` body.
 * @returns Multi-line listing; empty element list yields the two header lines.
 */
export function pcFmtUi(value: unknown): string {
  const data = recOf(value);
  const window = recOf(data.window);
  const lines = [
    "前台窗口：" + orText(window.process, "?") + " — " + orText(window.title, "(无标题)") + "（" + orText(window.w, "?") + "x" + orText(window.h, "?") + "）",
    "控件 " + orText(data.shown, "0") + "/" + orText(data.total, "0") + (data.truncated ? "（截断）" : ""),
  ];
  const elements = arrOf(data.elements);
  for (let i = 0; i < elements.length; i++) {
    const element = recOf(elements[i]);
    let line = "[" + txt(element.i) + "] " + txt(element.type) + " \"" + clip(element.name, 60) + "\" @" + txt(element.x) + "," + txt(element.y) + " " + txt(element.w) + "x" + txt(element.h);
    if (element.value) line += " value=\"" + clip(element.value, 60) + "\"";
    if (!element.enabled) line += " disabled";
    if (element.focused) line += " focused";
    if (!element.name && element.aid) line += " aid=" + clip(element.aid, 30);
    lines.push(line);
    if (lines.join("\n").length > 6000) {
      lines.push("…（输出到 6000 字上限，用 limit 缩小或先聚焦目标窗口）");
      break;
    }
  }
  return lines.join("\n");
}

/**
 * One `pc_windows` answer: every top-level window, the foreground one marked with `*`.
 * @param value The `/windows` body.
 * @returns Header line plus one line per window.
 */
export function pcFmtWindows(value: unknown): string {
  const data = recOf(value);
  const lines = ["窗口 " + orText(data.count, "0") + " 个（* = 前台）:"];
  const windows = arrOf(data.windows);
  for (let i = 0; i < windows.length; i++) {
    const window = recOf(windows[i]);
    lines.push((window.foreground ? "* " : "  ") + "hwnd " + txt(window.hwnd) + " | " + orText(window.process, "?") + " | " + clip(window.title, 70) + " @" + txt(window.x) + "," + txt(window.y) + " " + txt(window.w) + "x" + txt(window.h));
  }
  return lines.join("\n");
}

/**
 * Conversation-unique screenshot id. The random half is 6 base36 chars, so two shots inside the
 * same millisecond still differ.
 * @param milliseconds Epoch milliseconds.
 * @param random Uniform 0..1 sample.
 * @returns `pcshot_<base36 time>_<base36 random>`.
 */
export function pcImageId(milliseconds: number, random: number): string {
  return "pcshot_" + milliseconds.toString(36) + "_" + random.toString(36).slice(2, 8);
}

function buildTools(ports: PcToolPorts): PcToolSpec[] {
  return [
    {
      name: "pc_status",
      description: "看远程电脑状态：是否锁屏、屏幕分辨率/缩放、前台窗口。连电脑后先调它，再决定截图还是读控件。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          return pcFmtStatus(await ports.call("/status"));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_shot",
      description:
        "截一张远程电脑的屏幕，图会显示给用户看。默认缩到 1280 宽。\n" +
        "当前模型支持视觉时（如 deepseek-flash），这张图也会随下一轮请求发给你；不支持时只给用户看。\n" +
        "要精确操作请优先用 pc_ui 读控件树，不要靠截图猜坐标。\n" +
        "如果必须从截图估坐标：pc_ui/pc_click 用物理像素，截图被缩过，先把图上坐标乘 sourceWidth/width（工具结果里有这两个数）。",
      parameters: {
        type: "object",
        properties: { max: { type: "number", description: "最大宽度，320–2560，默认 1280" } },
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        try {
          const max = clampInt(recOf(args).max, 320, 2560, 1280);
          const shot = await ports.callBlob("/shot?max=" + max);
          let visionDataUrl = "";
          if (ports.visionOn(ctx)) visionDataUrl = await ports.readDataUrl(shot.blob);
          const meta: PcImageMeta = {
            id: ports.imageId(),
            name: "PC 截图 " + ports.clockLabel(),
            w: shot.width,
            h: shot.height,
            source: "pc",
          };
          const saved = await ports.putBlob(meta.id, shot.blob);
          const appended = saved ? ports.appendImage(meta, ctx) : false;
          const shown = appended ? false : ports.showBubble(shot.blob, meta, ctx);
          const sentToModel = visionDataUrl ? ports.pushImage(visionDataUrl, { w: shot.width, h: shot.height }, ctx) : false;
          let foreground: Record<string, unknown> = {};
          try {
            foreground = recOf(recOf(await ports.call("/status")).foreground);
          } catch (error) {
            foreground = {};
          }
          return "PC 屏幕已截取：" + orText(shot.width, "?") + "x" + orText(shot.height, "?") +
            "（原 " + orText(shot.sourceWidth, "?") + "x" + orText(shot.sourceHeight, "?") + "）" +
            (foreground.title ? "；前台 " + txt(foreground.process) + " — " + txt(foreground.title) : "") +
            (sentToModel ? "。截图已随下一轮发给模型。" : "") +
            (appended ? "。截图已存进当前会话（刷新/同步后还在；图片二进制只在本机，跨设备只同步消息）。" :
              shown ? "。截图已显示给用户（临时气泡，刷新后会消失）。" :
                "。宿主没有图片钩子，图未保存。") +
            "\n下一步：用 pc_ui 读控件树，或 pc_click_control 按名字点。";
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_ui",
      description:
        "读前台窗口的可操作控件树（UIA）：控件类型/名字/坐标/大小/是否可用。\n" +
        "这是操作电脑的首选“眼睛”，纯文本，任何模型都能读。\n" +
        "坐标是物理像素，可直接传给 pc_click；中文控件名已修正，优先用 pc_click_control 按名字点。\n" +
        "truncated=true 时：先用 pc_focus 聚焦目标窗口，或把 limit 调小；不要凭截图猜。",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "最多返回多少个控件，10–120，默认 40" } },
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          const limit = clampInt(recOf(args).limit, 10, 120, 40);
          return pcFmtUi(await ports.call("/ui?limit=" + limit));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_windows",
      description: "列出远程电脑的顶层窗口（标题/进程/hwnd/位置，坐标是物理像素）。要切到别的应用时，先用它拿 hwnd 或标题，再 pc_focus。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          return pcFmtWindows(await ports.call("/windows"));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_focus",
      description: "把某个窗口切到前台。参数给 hwnd 或标题片段二选一。切完再 pc_ui 看控件。",
      parameters: {
        type: "object",
        properties: {
          hwnd: { type: "number", description: "窗口句柄（pc_windows 返回的 hwnd）" },
          title: { type: "string", description: "窗口标题片段，如 Chrome" },
        },
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/focus", { body: { hwnd: a.hwnd, title: a.title } }));
          return data.ok ? ("已切到前台：hwnd " + txt(data.hwnd) + " — " + orText(data.title, "")) : ("切换失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_click_control",
      description:
        "按控件名点击（UIA）。**优先用这个**，比坐标可靠。先 pc_ui 看名字。中文控件名已修正。\n" +
        "多个同名控件时返回 candidates，换更精确的名字或加 type；只有 UIA 找不到时才用 pc_click 坐标。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "控件名字（pc_ui 里的 name）" },
          type: { type: "string", description: "控件类型，如 Button / Edit / MenuItem" },
          exact: { type: "boolean", description: "默认 true=精确匹配；false=包含匹配" },
          index: { type: "number", description: "多个匹配时选第几个（0 起）" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/click", { body: { name: a.name, type: a.type, exact: a.exact !== false, index: a.index } }));
          if (data.ok) return "已点击：" + txt(data.type) + " \"" + txt(data.name) + "\"（" + txt(data.method) + "，@" + txt(data.x) + "," + txt(data.y) + "）";
          if (data.error === "multiple") {
            const lines = ["匹配到 " + txt(data.count) + " 个控件，先换更精确的名字或加 type："];
            const candidates = arrOf(data.candidates);
            for (let i = 0; i < candidates.length; i++) {
              const candidate = recOf(candidates[i]);
              lines.push("[" + txt(candidate.i) + "] " + txt(candidate.type) + " \"" + txt(candidate.name) + "\" @" + txt(candidate.x) + "," + txt(candidate.y));
            }
            return lines.join("\n");
          }
          return "点击失败：" + orText(data.error, "") + (data.hint ? "\n" + txt(data.hint) : "");
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_click",
      description:
        "按坐标点击（物理像素，和 pc_ui 返回的坐标同一套）。仅在 pc_click_control 找不到控件时用。\n" +
        "pc_ui 的坐标可直接用；如果从 pc_shot 的图估坐标，先把图上坐标乘 sourceWidth/width。点之前最好先 pc_focus 目标窗口。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" },
          button: { type: "string", description: "left | right | middle，默认 left" },
          count: { type: "number", description: "1 或 2，默认 1" },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/click", { body: { x: a.x, y: a.y, button: a.button || "left", count: a.count || 1 } }));
          return data.ok ? ("已点击 @" + txt(data.x) + "," + txt(data.y) + "（" + txt(data.button) + " x" + txt(data.count) + "）") : ("点击失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_type",
      description:
        "向当前焦点输入文本（中文可用，走 Unicode SendInput）。\n" +
        "输入前先用 pc_click_control 点一下输入框，或 pc_focus 切窗口；不要在没聚焦时盲打。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要输入的文本，最多 2000 字" } },
        required: ["text"],
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const data = recOf(await ports.call("/type", { body: { text: recOf(args).text } }));
          return data.ok ? ("已输入 " + txt(data.length) + " 个字符") : ("输入失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_key",
      description: "按一个键或组合键。例：Enter / Tab / Esc / Backspace / Ctrl+C / Ctrl+V / Alt+Tab / Ctrl+Shift+Esc / F5。",
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "键名或组合，如 Ctrl+C" } },
        required: ["key"],
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const data = recOf(await ports.call("/key", { body: { key: recOf(args).key } }));
          return data.ok ? ("已按键：" + txt(data.key)) : ("按键失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_scroll",
      description: "在指定坐标滚动滚轮。dy 正数向上、负数向下；dx 正数向右、负数向左。先用 pc_ui 找目标区域坐标。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" },
          dx: { type: "number", description: "水平，默认 0" },
          dy: { type: "number", description: "垂直，默认 0" },
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      destructive: true,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/scroll", { body: { x: a.x, y: a.y, dx: a.dx || 0, dy: a.dy || 0 } }));
          return data.ok ? ("已滚动 @" + txt(data.x) + "," + txt(data.y) + " dx=" + txt(data.dx) + " dy=" + txt(data.dy)) : ("滚动失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_clipboard",
      description: "读/写远程电脑的剪贴板文本。action=get 读取；action=set 需要 text。适合跨设备搬一段文字。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "get | set" },
          text: { type: "string", description: "action=set 时的文本，最多 8000 字" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      destructive: (args) => recOf(args).action === "set",
      run: async (args) => {
        try {
          const a = recOf(args);
          if (a.action === "set") {
            const written = recOf(await ports.call("/clipboard", { body: { text: a.text || "" } }));
            return written.ok ? ("已写入剪贴板 " + txt(written.length) + " 字") : ("写剪贴板失败：" + orText(written.error, ""));
          }
          const read = recOf(await ports.call("/clipboard"));
          return "剪贴板 " + txt(read.length) + " 字" + (read.truncated ? "（截断）" : "") + "：\n" + orText(read.text, "");
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_audit",
      description: "看最近的远程操作审计（谁在什么时候点了什么/输入了多长）。排查误操作时用。",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "最多几条，1–100，默认 20" } },
        additionalProperties: false,
      },
      run: async (args) => {
        try {
          const limit = clampInt(recOf(args).limit, 1, 100, 20);
          const data = recOf(await ports.call("/audit?limit=" + limit));
          const lines = ["最近 " + txt(data.count) + " 条："];
          const entries = arrOf(data.lines);
          for (let i = 0; i < entries.length; i++) {
            const line = txt(entries[i]);
            let row: unknown = null;
            try {
              row = JSON.parse(line);
            } catch (error) {
              lines.push(line);
              continue;
            }
            const rec = recOf(row);
            lines.push(txt(rec.ts) + " | " + txt(rec.op) + " | " + (rec.ok ? "ok" : "FAIL") + " | " + JSON.stringify(rec.args || {}));
          }
          return lines.join("\n");
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_ls",
      description:
        "列出远程电脑工作区目录（只读，白名单=OwnChat-Workspace 之内）。看目录结构/找文件用。\n" +
        "path 传工作区相对路径（如 remote-desk/pc-bridge）或空=根目录。返回 name/dir/size/mtime。\n例：path 传 OwnChat/src 看主站源码目录。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，空=工作区根" },
          limit: { type: "number", description: "最多返回几条，1–2000，默认 500" },
        },
        additionalProperties: false,
      },
      destructive: false,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/ls", { body: { path: a.path || "", limit: a.limit } }));
          if (!data.ok) return "列目录失败：" + orText(data.error, "");
          const lines = ["目录 " + txt(data.path) + "（" + txt(data.count) + " 项" + (data.truncated ? "，已截断" : "") + "）:"];
          const entries = arrOf(data.entries);
          for (let i = 0; i < entries.length; i++) {
            const entry = recOf(entries[i]);
            lines.push((entry.dir ? "[目录] " : "[文件] ") + txt(entry.name) + (entry.dir ? "" : "（" + txt(entry.size) + "B）"));
          }
          return lines.join("\n");
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_read",
      description:
        "读远程电脑工作区里的文本文件（只读，单次 ≤200KB；二进制文件不回传内容）。读源码/配置/文档用。\n" +
        "大文件会返回 nextOffset —— 把它传给 offset 续读下一段。先 pc_ls / pc_grep 定位；密钥类文件（.pc-token/.dev.vars/*.key 等）在黑名单里读不了。\n例：path 传 OwnChat/src/worker.js 读主站 Worker 源码。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（工作区相对或绝对）" },
          offset: { type: "number", description: "字节偏移，续读上一段时传上一次返回的 nextOffset" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      destructive: false,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/read", { body: { path: a.path, offset: a.offset } }));
          if (!data.ok) return "读文件失败：" + orText(data.error, "");
          if (data.binary) return txt(data.path) + " 是二进制文件（" + txt(data.size) + "B），不回传内容。";
          const tail = data.nextOffset !== undefined && data.nextOffset !== null ? ("\n\n[未读完，共 " + txt(data.totalSize) + "B；续读：pc_read offset=" + txt(data.nextOffset) + "]") : "";
          return "文件 " + txt(data.path) + "（" + txt(data.size) + "B，本段 offset=" + orText(data.offset, "0") + "）:\n" + txt(data.content) + tail;
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_grep",
      description:
        "在工作区里搜文件内容（只读；正则或字面量，glob 过滤如 *.js）。找「某个函数在哪/配置在哪」的首选。\n" +
        "带 context=2~3 可直接看到命中处上下文，常能省一次 pc_read。 \n" +
        "例：pattern 传 handlePcProxy、glob 传 *.js、context 传 2。\n" +
        "默认忽略大小写；跳过 .git/node_modules 与密钥文件；单文件 ≤1MB；最多返回 max 条（默认 60）。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜的内容（字面量或正则）" },
          path: { type: "string", description: "搜索范围（目录或单文件），空=工作区根" },
          regex: { type: "boolean", description: "true=按正则解析，默认按字面量" },
          glob: { type: "string", description: "文件名过滤，如 *.js 或 *.js,*.mjs" },
          ignoreCase: { type: "boolean", description: "默认 true" },
          max: { type: "number", description: "最多几条，1–120，默认 60" },
          context: { type: "number", description: "每条命中附前后 N 行上下文（0–5，默认 0）" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      destructive: false,
      run: async (args) => {
        try {
          const a = recOf(args);
          const data = recOf(await ports.call("/grep", {
            body: {
              pattern: a.pattern, path: a.path, regex: a.regex,
              glob: a.glob, ignoreCase: a.ignoreCase, max: a.max, context: a.context,
            },
          }));
          if (!data.ok) return "搜索失败：" + orText(data.error, "");
          const lines = ["搜索 \"" + txt(data.pattern) + "\" @ " + txt(data.path) + "（扫 " + txt(data.scanned) + " 文件，命中 " + txt(data.matches) + (data.truncated ? "+，已截断" : "") + "）:"];
          const results = arrOf(data.results);
          for (let i = 0; i < results.length; i++) {
            const hit = recOf(results[i]);
            lines.push(txt(hit.file) + ":" + txt(hit.line) + " | " + txt(hit.text));
            if (hit.ctx) lines.push(txt(hit.ctx));
          }
          return lines.join("\n");
        } catch (error) {
          return pcErrText(error);
        }
      },
    },

    {
      name: "pc_panic",
      description: "急停：立刻关闭远程电脑的鼠标键盘输入，之后必须在电脑上重启 pc-bridge 才能恢复。只在用户明确说「急停 / panic」时调用；用户说「停 / 别点了」时不要用它 —— 正常停止由用户点停止键或发插话处理。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        try {
          const data = recOf(await ports.call("/panic", { body: {} }));
          return data.ok ? "已急停：输入通道关闭，重启 pc-bridge 才恢复。" : ("急停失败：" + orText(data.error, ""));
        } catch (error) {
          return pcErrText(error);
        }
      },
    },
  ];
}

/**
 * Register the `pc_*` group on the agent tool registry, but only when the gate is open: a locked or
 * switched-off desk registers nothing at all, so the model never sees a tool it cannot use.
 *
 * @param registry The agent registry. Anything without a callable `define` is ignored.
 * @param ports Injected transport, image hooks and the gate snapshot.
 * @returns How many tools were registered; 0 when the gate is shut or the registry is unusable.
 */
export function definePcTools(registry: unknown, ports: PcToolPorts): number {
  const define = recOf(registry).define;
  if (typeof define !== "function") return 0;
  if (!pcReady(ports.gate())) return 0;
  const tools = buildTools(ports);
  for (let i = 0; i < tools.length; i++) Reflect.apply(define, registry, [tools[i]]);
  return tools.length;
}
