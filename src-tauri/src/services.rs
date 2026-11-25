// services.rs — 本地服务管家（4.72）
// ─────────────────────────────────────────────────────────────
// 设计（4.72 定稿）：服务脚本**随 App 打包**（src-tauri/resources/services/），
// 设置页只做「启用 / 启动 / 停止」，不需要用户填路径或命令行。
//   · 服务列表是固定目录（pc-bridge、源码检索），不读外部配置
//   · 根目录取「Agent 工作目录」：pc-bridge 若存在 <工作目录>/remote-desk 就用它（令牌/审计与旧行为一致）
//   · Node 运行时复用 runtime::locate（自包含优先，系统 PATH 回退）
//   · Windows 下 CREATE_NO_WINDOW 启动，停止时杀进程树；退出 App 时统一收掉
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const NS: &str = "services";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub port: u16,
    pub running: bool,
    pub pid: Option<u32>,
    /// 随 App 启动（默认开）
    pub enabled: bool,
    /// 脚本 + Node 是否就绪
    pub available: bool,
    pub reason: String,
}

#[derive(Default)]
pub struct ServiceManager {
    children: Mutex<HashMap<String, Child>>,
}

struct Entry {
    id: &'static str,
    name: &'static str,
    desc: &'static str,
    port: u16,
    script: &'static str,
}

const ENTRIES: &[Entry] = &[
    Entry {
        id: "pc-bridge",
        name: "远程电脑",
        desc: "手机 agent 截屏 / 点击 / 读写文件（8802）",
        port: 8802,
        script: "services/pc-bridge/server.mjs",
    },
    Entry {
        id: "source-server",
        name: "源码检索",
        desc: "list_source / search_source / read_source 的后端（8797）",
        port: 8797,
        script: "services/source-server.mjs",
    },
];

fn entry(id: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.id == id)
}

fn script_path(app: &AppHandle, e: &Entry) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(e.script);
        if p.is_file() {
            return Some(p);
        }
    }
    // 开发期（cargo tauri dev）resource_dir 指向 target/…，回退到源码目录
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(e.script);
    if dev.is_file() {
        return Some(dev);
    }
    None
}

fn service_root(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let wd = crate::agent_local::workdir(app)?;
    if id == "pc-bridge" {
        let rd = wd.join("remote-desk");
        if rd.is_dir() {
            return Ok(rd);
        }
    }
    Ok(wd)
}

fn enabled_key(id: &str) -> String {
    format!("{id}_enabled")
}

fn is_enabled(app: &AppHandle, id: &str) -> bool {
    match crate::kv_read(app, NS, &enabled_key(id)) {
        Ok(Some(v)) => v.trim() != "0",
        _ => true, // 默认随 App 启动
    }
}

#[cfg(target_os = "android")]
fn spawn_service(_program: &str, _args: &[String], _cwd: &Path) -> Result<Child, String> {
    Err("手机端不支持托管本机服务".to_string())
}

#[cfg(not(target_os = "android"))]
fn spawn_service(program: &str, args: &[String], cwd: &Path) -> Result<Child, String> {
    let mut c = Command::new(program);
    c.args(args);
    c.current_dir(cwd);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.spawn().map_err(|e| format!("启动失败：{e}"))
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

fn status_of(child: &mut Child) -> Option<u32> {
    match child.try_wait() {
        Ok(None) => Some(child.id()),
        _ => None,
    }
}

/// 解析出「脚本 + Node + 根目录」，不可用时给出人话原因
fn prepare(app: &AppHandle, e: &Entry) -> Result<(String, Vec<String>, PathBuf), String> {
    let script = script_path(app, e).ok_or_else(|| "服务脚本缺失（安装包不完整）".to_string())?;
    let storage = crate::resolve_storage_dir(app)?;
    let rt = crate::runtime::locate(&storage)?;
    let root = service_root(app, e.id)?;
    let mut args = vec![
        script.to_string_lossy().to_string(),
        "--root".to_string(),
        root.to_string_lossy().to_string(),
        "--port".to_string(),
        e.port.to_string(),
    ];
    if e.id == "pc-bridge" {
        args.push("--ttl-min".to_string());
        args.push("0".to_string());
    }
    Ok((rt.program, args, root))
}

fn start_inner(
    app: &AppHandle,
    map: &Mutex<HashMap<String, Child>>,
    id: &str,
) -> Result<u32, String> {
    let e = entry(id).ok_or_else(|| "未知服务".to_string())?;
    let mut children = map.lock().map_err(|e| e.to_string())?;
    if let Some(c) = children.get_mut(id) {
        if let Some(pid) = status_of(c) {
            return Ok(pid);
        }
    }
    let (program, args, cwd) = prepare(app, e)?;
    let child = spawn_service(&program, &args, &cwd)?;
    let pid = child.id();
    children.insert(id.to_string(), child);
    Ok(pid)
}

fn stop_inner(map: &Mutex<HashMap<String, Child>>, id: &str) -> Result<(), String> {
    let mut children = map.lock().map_err(|e| e.to_string())?;
    if let Some(mut c) = children.remove(id) {
        kill_tree(c.id());
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn svc_list(app: AppHandle, mgr: tauri::State<'_, ServiceManager>) -> Vec<ServiceView> {
    let mut children = match mgr.children.lock() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    children.retain(|_, c| matches!(c.try_wait(), Ok(None)));
    let mut out = Vec::new();
    for e in ENTRIES {
        let pid = children.get_mut(e.id).and_then(status_of);
        let (available, reason) = match prepare(&app, e) {
            Ok(_) => (true, String::new()),
            Err(r) => (false, r),
        };
        out.push(ServiceView {
            id: e.id.to_string(),
            name: e.name.to_string(),
            desc: e.desc.to_string(),
            port: e.port,
            running: pid.is_some(),
            pid,
            enabled: is_enabled(&app, e.id),
            available,
            reason,
        });
    }
    out
}

#[tauri::command]
pub fn svc_start(
    app: AppHandle,
    mgr: tauri::State<'_, ServiceManager>,
    id: String,
) -> Result<u32, String> {
    start_inner(&app, &mgr.children, &id)
}

#[tauri::command]
pub fn svc_stop(mgr: tauri::State<'_, ServiceManager>, id: String) -> Result<(), String> {
    stop_inner(&mgr.children, &id)
}

#[tauri::command]
pub fn svc_restart(
    app: AppHandle,
    mgr: tauri::State<'_, ServiceManager>,
    id: String,
) -> Result<u32, String> {
    stop_inner(&mgr.children, &id)?;
    start_inner(&app, &mgr.children, &id)
}

#[tauri::command]
pub fn svc_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    if entry(&id).is_none() {
        return Err("未知服务".to_string());
    }
    crate::kv_write(&app, NS, &enabled_key(&id), if enabled { "1" } else { "0" })
}

/// App 启动时拉起「启用」的服务（失败静默，设置页会显示原因）
pub fn autostart(app: &AppHandle) {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return;
    }
    #[cfg(not(target_os = "android"))]
    {
        let mgr = app.state::<ServiceManager>();
        for e in ENTRIES {
            if is_enabled(app, e.id) {
                let _ = start_inner(app, &mgr.children, e.id);
            }
        }
    }
}

/// App 退出时收掉所有由本 App 启动的服务
pub fn shutdown_all(app: &AppHandle) {
    let mgr = app.state::<ServiceManager>();
    let ids: Vec<String> = match mgr.children.lock() {
        Ok(c) => c.keys().cloned().collect(),
        Err(_) => Vec::new(),
    };
    for id in ids {
        let _ = stop_inner(&mgr.children, &id);
    }
}
