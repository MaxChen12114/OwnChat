// agent_local.rs — 桌面端本地能力工具（4.70）
//
// 给 agent 真实的本地能力：列目录、读文件、写文件、跑命令。工作目录由用户在设置里指定。
//
// === 与 agent-workspace.js 的关系 ===
// 那个是浏览器里的**虚拟工作区**(IndexedDB)，文件不落地、只在会话内可见；
// 这里是**真实磁盘**。两者并存，所以工具名必须区分 ——
// registry.define 遇到重名会 throw，而重复定义会让后续工具全部漏注册
// (agent-reach.js 上方那条 Bug4 注释记的就是这个坑)。命名分工：
//   虚拟: list_files / read_file / write_file / edit_file / delete_file / export_file
//   本地: local_list_dir / local_read_file / local_write_file / local_run_command
//
// === 门控覆盖什么、不覆盖什么（这一点必须说清，别误解）===
//   文件类(local_*_file / local_list_dir)：工作目录门控**有效** ——
//     路径解析后必须落在工作目录内，`../` 与符号链接逃逸都会被拒。
//   命令类(local_run_command)：工作目录**只是 cwd** —— 一条命令完全可以
//     `cd` 出去、读写任何它有权访问的文件。所以对命令的真实约束是你已有的
//     **权限确认卡 + 工作模式**(confirm/auto/plan/full)，不是这里的路径检查。
//     把 run_command 说成"被限制在工作目录内"是错的。
//
// === 为什么不做命令白名单 ===
// 通用工具的价值就在于覆盖面(跑构建、跑脚本、git、python…)。白名单会把它退化成
// 只能干几件事的窄工具。代价是每次执行都需要人确认 —— 这个代价由工作模式承担。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// agent_workdir_pick 调 app.dialog(),那是 DialogExt 提供的方法。
// lib.rs 里也有这条 import,但那是它自己的作用域 —— 子模块看不到,必须各自引入。
// (CI 首轮编译报的是 "no method named `dialog` found",原因就是这个。)
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

/// 单次命令的时间上限(毫秒)
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// 输出回传上限(字符)
const MAX_OUTPUT_CHARS: usize = 40_000;
/// 单次写入上限(字符)
const MAX_WRITE_CHARS: usize = 5_000_000;
/// 单次读取上限(字符)
const MAX_READ_CHARS: usize = 200_000;

// ──────────────────────────── 工作目录 ────────────────────────────

/// 工作目录存放在与 tts_dir 同一处 settings 命名空间下(kv 表)。
/// 复用而不是新开存储：用户换机器/换数据目录时会跟着走，与其它设置一致。
const WD_NAMESPACE: &str = "settings";
const WD_KEY: &str = "agent_workdir";

fn workdir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    match crate::kv_read(app, WD_NAMESPACE, WD_KEY)? {
        Some(s) if !s.trim().is_empty() => {
            let p = PathBuf::from(s.trim());
            if !p.is_dir() {
                return Err(format!(
                    "工作目录不可用（{}）。可能被移动或删除，请在设置里重新选择。",
                    p.display()
                ));
            }
            Ok(p)
        }
        _ => Err("还没有设置工作目录。请在 设置 → Agent → 本地能力 里选择。".into()),
    }
}

#[tauri::command]
pub fn agent_workdir_get(app: tauri::AppHandle) -> Result<Option<String>, String> {
    match crate::kv_read(&app, WD_NAMESPACE, WD_KEY)? {
        Some(s) if !s.trim().is_empty() => {
            let p = PathBuf::from(s.trim());
            Ok(Some(p.to_string_lossy().to_string()))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn agent_workdir_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(fp) = picked else { return Ok(None) };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("当前平台不支持选择文件夹".into())
    }
}

#[tauri::command]
pub fn agent_workdir_set(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    let p = PathBuf::from(dir.trim());
    if !p.is_dir() {
        return Err(format!("不是一个有效目录：{}", p.display()));
    }
    // 存**规范化后**的路径：否则用户选的是软链、而门控按 canonicalize 比较,两边口径不一致
    let real = std::fs::canonicalize(&p).map_err(|e| format!("路径不可解析：{e}"))?;
    let s = real.to_string_lossy().to_string();
    crate::kv_write(&app, WD_NAMESPACE, WD_KEY, &s)?;
    Ok(s)
}

// ──────────────────────────── 路径门控 ────────────────────────────

/// 已存在的路径：规范化后必须在 root 内。
/// Path::starts_with 是**组件级**比较 —— 所以 `C:\work` 不会误配 `C:\workspace`。
/// 这里不能用字符串前缀匹配,那是这类门控最经典的漏洞(`C:\work\..\Windows` 能骗过它)。
fn resolve_read(target: &Path, root: &Path) -> Result<PathBuf, String> {
    let real_root = std::fs::canonicalize(root).map_err(|e| format!("工作目录不可达：{e}"))?;
    let real_target =
        std::fs::canonicalize(target).map_err(|e| format!("路径不存在或不可读({})：{e}", target.display()))?;
    if real_target.starts_with(&real_root) {
        Ok(real_target)
    } else {
        Err(format!(
            "拒绝访问：{} 不在工作目录 {} 之内",
            real_target.display(),
            real_root.display()
        ))
    }
}

/// 目标可能还不存在：规范化**父目录**再拼文件名，而不是跳过校验。
/// 父目录必须已存在 —— 不允许 agent 静默造出深层目录树。
fn resolve_write(target: &Path, root: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("路径没有父目录")?;
    let file_name = target.file_name().ok_or("路径没有文件名")?;
    let real_root = std::fs::canonicalize(root).map_err(|e| format!("工作目录不可达：{e}"))?;
    let real_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("父目录不存在({})：{e}", parent.display()))?;
    if !real_parent.starts_with(&real_root) {
        return Err(format!(
            "拒绝写入：{} 不在工作目录 {} 之内",
            real_parent.display(),
            real_root.display()
        ));
    }
    Ok(real_parent.join(file_name))
}

/// 把用户/模型给的路径解析成绝对路径。相对路径按**工作目录**解析(与 cwd 语义一致)。
fn to_abs(path: &str, root: &Path) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

// ──────────────────────────── 文件工具 ────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    pub text: String,
    pub chars: usize,
    pub truncated: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub bytes: usize,
    pub existed: bool,
}

/// 列出工作目录内的一个目录(默认工作目录本身)
#[tauri::command]
pub fn local_list_dir(app: tauri::AppHandle, path: Option<String>) -> Result<Vec<DirEntry>, String> {
    let root = workdir(&app)?;
    let target = match path.as_deref() {
        Some(p) if !p.trim().is_empty() => resolve_read(&to_abs(p, &root), &root)?,
        _ => std::fs::canonicalize(&root).map_err(|e| e.to_string())?,
    };
    if !target.is_dir() {
        return Err(format!("不是目录：{}", target.display()));
    }
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&target).map_err(|e| format!("读取目录失败：{e}"))?;
    for e in rd.flatten() {
        let p = e.path();
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(DirEntry {
            name: p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            kind: if md.is_dir() { "dir".into() } else { "file".into() },
            size: if md.is_file() { md.len() } else { 0 },
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn local_read_file(
    app: tauri::AppHandle,
    path: String,
    max_chars: Option<usize>,
) -> Result<ReadResult, String> {
    let root = workdir(&app)?;
    let file = resolve_read(&to_abs(&path, &root), &root)?;
    let text = std::fs::read_to_string(&file).map_err(|e| format!("读取失败：{e}"))?;
    let cap = max_chars.unwrap_or(MAX_READ_CHARS).min(MAX_READ_CHARS);
    let chars = text.chars().count();
    let truncated = chars > cap;
    Ok(ReadResult {
        path: file.to_string_lossy().to_string(),
        text: if truncated { text.chars().take(cap).collect() } else { text },
        chars,
        truncated,
    })
}

#[tauri::command]
pub fn local_write_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<WriteResult, String> {
    if content.chars().count() > MAX_WRITE_CHARS {
        return Err(format!("内容过长（超过 {MAX_WRITE_CHARS} 字符）"));
    }
    let root = workdir(&app)?;
    let target = resolve_write(&to_abs(&path, &root), &root)?;
    let existed = target.exists();
    let bytes = content.as_bytes().len();
    std::fs::write(&target, content).map_err(|e| format!("写入失败：{e}"))?;
    Ok(WriteResult {
        path: target.to_string_lossy().to_string(),
        bytes,
        existed,
    })
}

// ──────────────────────────── 命令执行 ────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub truncated: bool,
    pub timed_out: bool,
    pub cwd: String,
}

/// 执行一条命令。
///
/// **门控说明(别误解)**：这里的路径检查只决定 **cwd 必须落在工作目录内**，
/// 它**不能**限制命令本身去访问别处 —— 一条 `cd .. && cat /etc/passwd` 照样能跑。
/// 对命令的真实约束是权限确认卡 + 工作模式，那在 agent 内核与 UI 层。
///
/// 参数用 spawn 数组传递，不经 shell —— 所以没有 shell 注入问题，
/// 但也意味着**不支持管道/重定向**。要那些的话请显式跑 `cmd /c ...` 或 `bash -c ...`
/// （那种情况请自己确保安全，因为那就等于开了一个 shell）。
#[tauri::command]
pub fn local_run_command(
    app: tauri::AppHandle,
    cmd: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    // 移动端不提供命令执行。这里显式拦一道,而不是让它走到 spawn 失败 ——
    // 那样用户看到的是"无法启动 node"这种误导性消息,会以为是环境问题而不是平台不支持。
    #[cfg(not(desktop))]
    {
        let _ = (&app, &cmd, &args, &cwd, &timeout_ms);
        return Err("命令执行仅桌面端支持(移动端没有可用的进程执行环境)".into());
    }
    #[cfg(desktop)]
    {
    let root = workdir(&app)?;
    let work_cwd = match cwd.as_deref() {
        Some(c) if !c.trim().is_empty() => resolve_read(&to_abs(c, &root), &root)?,
        _ => std::fs::canonicalize(&root).map_err(|e| e.to_string())?,
    };
    if !work_cwd.is_dir() {
        return Err(format!("cwd 不是目录：{}", work_cwd.display()));
    }
    let argv = args.unwrap_or_default();
    if argv.len() > 128 {
        return Err("参数过多（上限 128 个）".into());
    }
    if cmd.trim().is_empty() {
        return Err("命令为空".into());
    }

    // 2026-10-05(C-1,项目所有者拍板): 原生确认框 —— 最后一道、不可被页面 JS 绕过的闸门。
    // 背景:桌面窗口加载的是远程页面(tauri.conf.json:15),前端确认卡与被确认的操作
    // 处于**同一信任域**(页面被攻破时确认卡可被伪造)。这个框跑在 Rust 侧,
    // 与前端工作模式是两层独立防线 —— full 模式下也会弹,这正是它的意义。
    // API 形状照搬 lib.rs 的更新检查对话框(blocking_show + OkCancelCustom)。
    let args_disp: String = {
        let s: String = argv.join(" ").chars().take(300).collect();
        if argv.join(" ").chars().count() > 300 { format!("{s} …") } else { s }
    };
    let confirmed = {
        use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
        app.dialog()
            .message(format!(
                "Agent 请求执行命令：\n\n{cmd} {args_disp}\n\n目录：{}",
                work_cwd.display()
            ))
            .title("OwnChat · Agent 命令确认")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "允许执行".to_string(),
                "拒绝".to_string(),
            ))
            .blocking_show()
    };
    if !confirmed {
        return Err("用户在原生确认框中拒绝了本次命令执行".into());
    }

    let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);

    let mut c = Command::new(&cmd);
    for a in &argv {
        c.arg(a);
    }
    c.current_dir(&work_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 2026-10-05(DSH subprocess 的做法): 先清洗环境再传给子进程。
    // 为什么:模型选的命令可以把环境打到 stdout(`printenv` / `Get-ChildItem Env:`),
    // 而对话上下文会原样发给模型服务商 —— 不清洗等于把用户环境里的凭据
    // (GH_TOKEN / AWS_SECRET_ACCESS_KEY / *_API_KEY…)随对话上传。
    // 键名含 KEY / PASSWORD / SECRET / TOKEN(大小写不敏感)的一律不传;
    // SystemRoot / PATH / TEMP 等系统必需变量不含这些词,不受影响。
    // 与 DSH 的差异:它还叠加"调用者 env < 受信快照"的合并序,我们只有一层父环境,先保持简单。
    {
        const SENSITIVE: [&str; 4] = ["KEY", "PASSWORD", "SECRET", "TOKEN"];
        c.env_clear();
        for (k, v) in std::env::vars_os() {
            let ks = k.to_string_lossy().to_uppercase();
            if !SENSITIVE.iter().any(|s| ks.contains(s)) {
                c.env(k, v);
            }
        }
    }

    // Windows:CREATE_NO_WINDOW —— 不弹控制台黑窗。
    // 这是"agent 跑命令会不会弹窗"的答案:不会,连子进程的控制台都被抑制了。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }

    let started = Instant::now();
    let mut child = c.spawn().map_err(|e| format!("无法启动 `{cmd}`：{e}"))?;

    // 两个读取线程：必须并发读，否则管道写满会把子进程卡死（经典死锁）
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let ho = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = so.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let he = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = se.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });

    // 带超时的等待（std 没有 wait_timeout，轮询）
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code(),
            Ok(None) => {}
            Err(e) => return Err(format!("等待子进程失败：{e}")),
        }
        if started.elapsed() > Duration::from_millis(timeout) {
            // 2026-10-05(DSH subprocess 的做法): 杀整棵进程树,而不是只杀直接子进程。
            // child.kill() 只杀 cmd 本身 —— 跑 `npm run build` 超时后,node 孙进程全部遗留。
            // Windows 用 taskkill /T /F(树杀,强 制);其他平台保守退化为单进程 kill
            // (POSIX 进程组方案需要 spawn 时 detached:true,先不加,注明局限)。
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt; // 本块自己的作用域,不能借上面那个块的
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .output();
                let _ = child.kill(); // 双保险:taskkill 失败(权限/已退出)时兜底
            }
            #[cfg(not(windows))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let stdout = ho.join().unwrap_or_default();
    let stderr = he.join().unwrap_or_default();
    let duration_ms = started.elapsed().as_millis() as u64;
    let truncated = stdout.chars().count() > MAX_OUTPUT_CHARS;

    Ok(RunResult {
        ok: !timed_out && exit_code == Some(0),
        exit_code,
        stdout: stdout.chars().take(MAX_OUTPUT_CHARS).collect(),
        stderr: if timed_out {
            format!("已超时（{timeout}ms），进程被终止。\n{stderr}")
        } else {
            stderr.chars().take(8000).collect()
        },
        duration_ms,
        truncated,
        timed_out,
        cwd: work_cwd.to_string_lossy().to_string(),
    })
    } // #[cfg(desktop)]
}

// ──────────────────────────── 环境信息 ────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvInfo {
    /// 工作目录；未设置时为 null
    pub workdir: Option<String>,
    /// 工作目录里的文件数（未设置时为 0），给设置页一个"选没选对"的直观反馈
    pub entries: usize,
    /// Node 运行时状态（供将来「下载自带运行时」用；命令执行不依赖它）
    pub node: crate::runtime::RuntimeStatus,
    pub platform: String,
}

#[tauri::command]
pub fn local_env_info(app: tauri::AppHandle) -> Result<LocalEnvInfo, String> {
    let storage = crate::resolve_storage_dir(&app)?;
    let wd = crate::kv_read(&app, WD_NAMESPACE, WD_KEY)?
        .filter(|s| !s.trim().is_empty())
        .map(|s| PathBuf::from(s.trim().to_string()));
    let entries = match &wd {
        Some(p) if p.is_dir() => std::fs::read_dir(p).map(|r| r.count()).unwrap_or(0),
        _ => 0,
    };
    Ok(LocalEnvInfo {
        workdir: wd.as_ref().map(|p| p.to_string_lossy().to_string()),
        entries,
        node: crate::runtime::status(&storage),
        platform: std::env::consts::OS.to_string(),
    })
}
