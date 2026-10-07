#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{webview::PageLoadEvent, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use base64::Engine;

mod http_stream;
mod runtime;       // 4.70 测试扩展:Node 运行时定位(自包含优先 / 系统回退)
mod agent_local;   // 4.70 本地能力:工作目录内的文件读写 + 通用命令执行

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

// 在系统默认浏览器里打开外部链接（GitHub / 下载页等跨站 _blank 链接）。
// 由下面的注入脚本在点击外链时调用；桌面 webview 自身无法打开 _blank 外链。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// === 本地文件导入 / 导出 ===
// 桌面 App 直连本地文件系统（网页版受浏览器沙箱限制做不到）。
// 供前端 invoke 调用：导入角色卡 / 聊天存档，导出备份等。
#[derive(Clone, serde::Serialize)]
struct ImportedFile {
    name: String,
    path: String,
    content: String,
}

// 读取指定路径的文本文件（用于拖拽进来的文件，或前端已拿到的路径）
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// 弹出系统「打开文件」对话框，选中后读出文本内容返回；取消返回 null
#[tauri::command]
async fn import_text_file(app: tauri::AppHandle) -> Result<Option<ImportedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("文本 / 数据", &["txt", "md", "json", "csv"])
        .blocking_pick_file();
    let Some(fp) = picked else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(Some(ImportedFile {
        name,
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

// 弹出系统「保存文件」对话框，把内容写入用户选定位置；返回写入路径，取消返回 null
#[tauri::command]
async fn export_text_file(
    app: tauri::AppHandle,
    suggested_name: String,
    content: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .blocking_save_file();
    let Some(fp) = picked else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// === 数据存储位置（可在设置面板更改；默认放「文档/OwnChat」，不深埋在 AppData，好找好删好备份） ===
// 思路：用户选定的目录记录在 config 目录下一个小指针文件里；实际数据库 ownchat.db 落在指针指向的目录。
// 没设置过就用默认目录「文档/OwnChat」。
fn storage_pointer_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let cfg = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(cfg.join("storage_location.txt"))
}

// 2026-10-07 改名 OwnChat:把旧布局一次性迁过来。只在「旧存在且新不存在」时动手,
// 失败一律静默 —— 宁可让用户手动搬,也不能因为一次 rename 把数据弄丢。
fn migrate_legacy_layout(docs: &std::path::Path, new_dir: &std::path::Path) {
    let old_dir = docs.join("Omnigent");
    if old_dir.exists() && !new_dir.exists() {
        if std::fs::rename(&old_dir, new_dir).is_err() {
            // 跨盘 / 被占用:退化为建目录 + 复制数据库
            let _ = std::fs::create_dir_all(new_dir);
            let old_db = old_dir.join("omnigent.db");
            if old_db.exists() {
                let _ = std::fs::copy(&old_db, new_dir.join("ownchat.db"));
            }
        }
    }
    migrate_legacy_db(new_dir);
}

// 旧库文件名 -> 新库文件名(用户自选目录里也可能还是旧名;同盘改名,不行就复制)
fn migrate_legacy_db(dir: &std::path::Path) {
    let old = dir.join("omnigent.db");
    let new = dir.join("ownchat.db");
    if old.exists() && !new.exists() {
        if std::fs::rename(&old, &new).is_err() {
            let _ = std::fs::copy(&old, &new);
        }
    }
}

// 默认数据目录：用户「文档」下的 OwnChat 文件夹（可见、可删、可备份）
fn default_storage_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    let dir = docs.join("OwnChat");
    migrate_legacy_layout(&docs, &dir);
    Ok(dir)
}

// 当前生效的数据目录：优先用户指定，否则默认「文档/OwnChat」
// 4.70: 提为 pub(crate) 供 agent_local 复用(取 Node 运行时状态用),保证与 ownchat.db 同处一地
pub(crate) fn resolve_storage_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(pointer) = storage_pointer_path(app) {
        if let Ok(s) = std::fs::read_to_string(&pointer) {
            let s = s.trim();
            if !s.is_empty() {
                let dir = std::path::PathBuf::from(s);
                migrate_legacy_db(&dir); // 用户自选目录里也可能还是旧库名
                return Ok(dir);
            }
        }
    }
    default_storage_dir(app)
}

// 切换数据目录：在新目录建好文件夹，把已有 ownchat.db 迁移过去（同盘 rename / 跨盘复制），并记录指针
fn apply_storage_dir(
    app: &tauri::AppHandle,
    new_dir: std::path::PathBuf,
) -> Result<String, String> {
    let old_dir = resolve_storage_dir(app)?;
    std::fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;

    if old_dir != new_dir {
        let old_db = old_dir.join("ownchat.db");
        let new_db = new_dir.join("ownchat.db");
        if old_db.exists() && !new_db.exists() {
            // 同盘直接改名；跨盘 rename 会失败，退回「复制后删除」
            if std::fs::rename(&old_db, &new_db).is_err() {
                std::fs::copy(&old_db, &new_db).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&old_db);
            }
        }
    }

    let pointer = storage_pointer_path(app)?;
    if let Some(parent) = pointer.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&pointer, new_dir.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(new_dir.to_string_lossy().to_string())
}

// 在系统文件管理器里打开当前数据目录
fn reveal_storage_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_storage_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// 取当前数据目录（设置面板展示用）
#[tauri::command]
fn get_storage_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(resolve_storage_dir(&app)?.to_string_lossy().to_string())
}

// 设为指定目录（前端把 pick_storage_dir 选到的路径传进来），返回最终生效路径
#[tauri::command]
fn set_storage_dir(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    apply_storage_dir(&app, std::path::PathBuf::from(dir))
}

// 弹系统「选择文件夹」对话框，返回选中目录；取消返回 null（不改设置，由前端再调 set_storage_dir 确认）
#[tauri::command]
async fn pick_storage_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(fp) = picked else {
            return Ok(None);
        };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("当前平台暂不支持选择文件夹（移动端可在文件管理器中手动管理数据）".to_string())
    }
}

// 在文件管理器里打开数据目录（设置面板「打开文件夹」按钮）
#[tauri::command]
fn open_storage_dir(app: tauri::AppHandle) -> Result<(), String> {
    reveal_storage_dir(&app)
}

// === 本地 SQLite 存储层（通用 key-value，用 namespace 分类：chat 存聊天存档 / settings 存偏好 ...） ===
// 桌面 App 把数据落在本地 SQLite，不依赖浏览器存储，可备份 / 恢复。
// 先做最小通用层；以后要细分（如角色卡）再加表即可。
#[derive(Clone, serde::Serialize)]
struct KvEntry {
    key: String,
    value: String,
    updated_at: String,
}

// 打开（不存在则创建）数据目录下的 ownchat.db，并确保 kv 表存在
fn open_db(app: &tauri::AppHandle) -> Result<rusqlite::Connection, String> {
    let dir = resolve_storage_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = rusqlite::Connection::open(dir.join("ownchat.db")).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kv (
            namespace  TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (namespace, key)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

// 内部读取一条 kv 值（rs 侧自用，如语音服务读取设置）；不存在返回 None
fn kv_read(app: &tauri::AppHandle, namespace: &str, key: &str) -> Result<Option<String>, String> {
    let conn = open_db(app)?;
    match conn.query_row(
        "SELECT value FROM kv WHERE namespace = ?1 AND key = ?2",
        rusqlite::params![namespace, key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// 内部写入一条 kv 值（rs 侧自用，如托盘里设置语音目录 / 切换自启动）
fn kv_write(app: &tauri::AppHandle, namespace: &str, key: &str, value: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO kv (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(namespace, key) DO UPDATE SET value = ?3, updated_at = datetime('now')",
        rusqlite::params![namespace, key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// 写入 / 更新一条记录（同 namespace+key 覆盖）
#[tauri::command]
fn kv_set(
    app: tauri::AppHandle,
    namespace: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO kv (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(namespace, key) DO UPDATE SET value = ?3, updated_at = datetime('now')",
        rusqlite::params![namespace, key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// 读取一条记录；不存在返回 null
#[tauri::command]
fn kv_get(app: tauri::AppHandle, namespace: String, key: String) -> Result<Option<String>, String> {
    let conn = open_db(&app)?;
    match conn.query_row(
        "SELECT value FROM kv WHERE namespace = ?1 AND key = ?2",
        rusqlite::params![namespace, key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// 列出某 namespace 下所有记录（按更新时间倒序），用于聊天存档列表等
#[tauri::command]
fn kv_list(app: tauri::AppHandle, namespace: String) -> Result<Vec<KvEntry>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT key, value, updated_at FROM kv WHERE namespace = ?1 ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![namespace], |row| {
            Ok(KvEntry {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// 删除一条记录
#[tauri::command]
fn kv_delete(app: tauri::AppHandle, namespace: String, key: String) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "DELETE FROM kv WHERE namespace = ?1 AND key = ?2",
        rusqlite::params![namespace, key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// === 通用 HTTP 代理（绕过浏览器 CORS / 混合内容限制） ===
// 网页内核从 https://your-domain.example 直接 fetch 本地 Ollama（http://localhost:11434）会被
// 「混合内容 + 跨域」双重拦截；调外部 API（如 Boson Higgs TTS）也常被 CORS 挡。
// 桌面 App 把请求放到原生层发出，天然没有这些限制。
// 返回体统一用 base64 编码，文本(JSON)与二进制(音频)都能安全传回前端。
// 注：暂为一次性返回完整响应（非流式）；流式（如 Ollama 逐字输出）后续再用事件推送。
#[derive(Clone, serde::Serialize)]
struct HttpResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    content_type: Option<String>,
    body_base64: String,
}

#[tauri::command]
async fn http_request(
    method: Option<String>,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let method = method.unwrap_or_else(|| "GET".to_string());
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("非法 HTTP 方法: {e}"))?;
    let client = reqwest::Client::new();
    let mut req = client.request(m, &url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let mut resp_headers = std::collections::HashMap::new();
    let mut content_type = None;
    for (k, v) in resp.headers().iter() {
        let key = k.as_str().to_string();
        let val = v.to_str().unwrap_or("").to_string();
        if key.eq_ignore_ascii_case("content-type") {
            content_type = Some(val.clone());
        }
        resp_headers.insert(key, val);
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(HttpResponse {
        status,
        headers: resp_headers,
        content_type,
        body_base64,
    })
}

// === 本地语音服务（GPT-SoVITS）后台进程管理 ===
// 数字人语音用用户本机的 GPT-SoVITS（api_v2.py，默认 127.0.0.1:9880）。
// 这里只在「原生层」管理它的生命周期（和「更改数据位置」一样走托盘菜单 + 原生对话框），
// 不向网页暴露命令；网页要发声时照旧用 http_request 代理去 POST /tts。
//   · 设置目录：托盘弹原生选文件夹框 → 存进 settings.tts_dir
//   · 启动：读 settings.tts_dir，后台静默拉起 runtime\\python.exe api_v2.py（Windows 无黑窗）
//   · 停止：结束子进程
//   · 开机自启动：settings.tts_autostart = true/false
struct TtsProcess(std::sync::Mutex<Option<std::process::Child>>);

// 读取语音端口（设置缺省则 9880）
fn tts_port(app: &tauri::AppHandle) -> String {
    kv_read(app, "settings", "tts_port")
        .ok()
        .flatten()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "9880".to_string())
}

// 探一下端口有没有人在听:能 TCP 连上 127.0.0.1:port 就算服务已在跑(可能是你自己双击 .bat 起的)。
// 用途:启动前先探一下,已经在听就别再拉第二个去抢同一端口(后启的会绑定失败、静默崩),直接当作已启动。
fn port_alive(port: &str) -> bool {
    use std::net::ToSocketAddrs;
    use std::time::Duration;
    let addr = format!("127.0.0.1:{port}");
    if let Ok(mut iter) = addr.to_socket_addrs() {
        if let Some(sa) = iter.next() {
            return std::net::TcpStream::connect_timeout(&sa, Duration::from_millis(300)).is_ok();
        }
    }
    false
}

// 在指定 GPT-SoVITS 目录后台拉起 api_v2.py：优先用整合包自带的 runtime\\python.exe，没有则退回系统 python
fn spawn_tts(dir: &str, port: &str) -> Result<std::process::Child, String> {
    let dir_path = std::path::PathBuf::from(dir);
    if !dir_path.exists() {
        return Err(format!("GPT-SoVITS 目录不存在：{dir}"));
    }
    let bundled_py = dir_path.join("runtime").join("python.exe");
    let program: std::path::PathBuf = if bundled_py.exists() {
        bundled_py
    } else {
        std::path::PathBuf::from("python")
    };
    let mut cmd = std::process::Command::new(program);
    cmd.current_dir(&dir_path)
        .arg("api_v2.py")
        .arg("-a")
        .arg("127.0.0.1")
        .arg("-p")
        .arg(port)
        .arg("-c")
        .arg("GPT_SoVITS/configs/tts_infer.yaml");
    // Windows 下隐藏控制台黑窗，纯后台运行(用户确认静默后台即可;排错用自己的 .bat 看日志)
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("启动语音服务失败：{e}"))
}

// 启动语音服务（已在跑则直接返回端口）；返回生效端口供提示
fn start_tts_service(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = match kv_read(app, "settings", "tts_dir")? {
        Some(d) if !d.trim().is_empty() => d,
        _ => return Err("尚未设置 GPT-SoVITS 文件夹".to_string()),
    };
    let port = tts_port(app);
    // 已经有人在听这个端口(你自己的 .bat / 上次残留)→ 当作在跑,别再拉第二个抢端口。
    if port_alive(&port) {
        return Ok(port);
    }
    let state = app.state::<TtsProcess>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(port);
        }
    }
    let mut child = spawn_tts(&dir, &port)?;
    // 拉起后稍等回看:进程要是立刻就退了(模型/参考路径/依赖报错),如实报错,别再骗用户「已启动」。
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if let Ok(Some(status)) = child.try_wait() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "未知".to_string());
        return Err(format!(
            "语音服务进程刚启动就退出了(退出码 {code})。多半是模型/参考路径/依赖报错 —— 请在 GPT-SoVITS 目录里双击你的启动 .bat,看控制台里的红字报错。"
        ));
    }
    *guard = Some(child);
    Ok(port)
}

// 停止语音服务
fn stop_tts_service(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<TtsProcess>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// === 语音服务设置：暴露给前端「设置 · 语音」面板的命令 ===
// 之前 TTS 的设目录 / 启停 / 自启动只在系统托盘菜单里；这里把它们包成命令，
// 让 App 内的设置面板统一管理，并和前端共享同一份配置（都落在 settings 命名空间，单一可信源）。
#[derive(Clone, serde::Serialize)]
struct TtsConfig {
    dir: Option<String>,
    port: String,
    autostart: bool,
    running: bool,
}

// 读取当前语音配置（目录 / 端口 / 自启动 / 是否在跑），供面板打开时回填
#[tauri::command]
fn tts_get_config(app: tauri::AppHandle) -> Result<TtsConfig, String> {
    let dir = kv_read(&app, "settings", "tts_dir")?.filter(|d| !d.trim().is_empty());
    let port = tts_port(&app);
    let autostart = matches!(
        kv_read(&app, "settings", "tts_autostart")?.as_deref(),
        Some("true") | Some("1")
    );
    let running = {
        let state = app.state::<TtsProcess>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    };
    Ok(TtsConfig {
        dir,
        port,
        autostart,
        running,
    })
}

// 写入语音配置（只更新传入的字段）。端口空串忽略；自启动写 "true"/"false"
#[tauri::command]
fn tts_set_config(
    app: tauri::AppHandle,
    dir: Option<String>,
    port: Option<String>,
    autostart: Option<bool>,
) -> Result<(), String> {
    if let Some(d) = dir {
        kv_write(&app, "settings", "tts_dir", &d)?;
    }
    if let Some(p) = port {
        let p = p.trim();
        if !p.is_empty() {
            kv_write(&app, "settings", "tts_port", p)?;
        }
    }
    if let Some(a) = autostart {
        kv_write(
            &app,
            "settings",
            "tts_autostart",
            if a { "true" } else { "false" },
        )?;
    }
    Ok(())
}

// 启动语音服务（包装托盘那套逻辑）；返回生效端口
#[tauri::command]
fn tts_start(app: tauri::AppHandle) -> Result<String, String> {
    start_tts_service(&app)
}

// 停止语音服务
#[tauri::command]
fn tts_stop(app: tauri::AppHandle) -> Result<(), String> {
    stop_tts_service(&app)
}

// 弹系统「选择文件夹」对话框选 GPT-SoVITS 目录；取消返回 null（由前端再调 tts_set_config 确认）
#[tauri::command]
async fn tts_pick_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(fp) = picked else {
            return Ok(None);
        };
        let path = fp.into_path().map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("当前平台暂不支持选择文件夹（本地语音服务仅桌面端可用）".to_string())
    }
}

// 弹系统「选择文件」对话框选参考音频（.wav 等），返回绝对路径；取消返回 null。
// 设置面板「参考音频 / 辅助参考(多参考)」旁的「选择…」按钮调它，免手敲完整路径。
// 和 import_text_file 同一套 dialog 插件，区别是这里只回路径、不读文件内容（参考音由 api_v2 自己按路径读）。
#[tauri::command]
async fn tts_pick_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("音频", &["wav", "mp3", "flac", "m4a", "ogg", "aac"])
        .blocking_pick_file();
    let Some(fp) = picked else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// 弹系统「选择文件」对话框,允许一次多选参考音频(.wav 等),返回绝对路径数组;取消/空返回空数组。
// 设置面板「稳定音色 · 多参考」的「选择文件」按钮调它 —— 按住 Ctrl/Shift 一次多选若干条,免得一条条加。
#[tauri::command]
async fn tts_pick_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("音频", &["wav", "mp3", "flac", "m4a", "ogg", "aac"])
        .blocking_pick_files();
    let Some(fps) = picked else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for fp in fps {
        if let Ok(path) = fp.into_path() {
            out.push(path.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

// 列出 GPT-SoVITS 目录下可用的权重文件，供前端「音色模型」下拉自动填充（仿 WebUI 的扫描行为）。
// 扫 tts_dir 下常见的 GPT/SoVITS 权重目录，按扩展名分类返回「相对 tts_dir」的路径
// （api_v2 的工作目录就是 tts_dir，set_*_weights 接受这种相对路径）。
//   GPT(.ckpt):  GPT_weights / GPT_weights_v2 / GPT_weights_v2Pro / GPT_weights_v2ProPlus / GPT_weights_v3 / GPT_weights_v4
//   SoVITS(.pth): SoVITS_weights / SoVITS_weights_v2 / SoVITS_weights_v2Pro / SoVITS_weights_v2ProPlus / SoVITS_weights_v3 / SoVITS_weights_v4
#[derive(Clone, serde::Serialize)]
struct TtsWeights {
    gpt: Vec<String>,
    sovits: Vec<String>,
}

#[tauri::command]
fn tts_list_models(app: tauri::AppHandle) -> Result<TtsWeights, String> {
    let dir = match kv_read(&app, "settings", "tts_dir")? {
        Some(d) if !d.trim().is_empty() => d,
        _ => return Err("尚未设置 GPT-SoVITS 文件夹".to_string()),
    };
    let root = std::path::PathBuf::from(&dir);
    // 扫某子目录里指定扩展名的文件，输出「子目录/文件名」正斜杠相对路径
    fn scan(root: &std::path::Path, sub: &str, ext: &str, out: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(root.join(sub)) {
            for e in entries.flatten() {
                let p = e.path();
                let hit = p
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.eq_ignore_ascii_case(ext))
                    .unwrap_or(false);
                if hit {
                    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                        out.push(format!("{sub}/{name}"));
                    }
                }
            }
        }
    }
    let mut gpt: Vec<String> = Vec::new();
    let mut sovits: Vec<String> = Vec::new();
    for sub in [
        "GPT_weights",
        "GPT_weights_v2",
        "GPT_weights_v2Pro",
        "GPT_weights_v2ProPlus",
        "GPT_weights_v3",
        "GPT_weights_v4",
    ] {
        scan(&root, sub, "ckpt", &mut gpt);
    }
    for sub in [
        "SoVITS_weights",
        "SoVITS_weights_v2",
        "SoVITS_weights_v2Pro",
        "SoVITS_weights_v2ProPlus",
        "SoVITS_weights_v3",
        "SoVITS_weights_v4",
    ] {
        scan(&root, sub, "pth", &mut sovits);
    }
    gpt.sort();
    sovits.sort();
    Ok(TtsWeights { gpt, sovits })
}

// 站内「新标签页」链接（target=_blank）在桌面 App 里：
//   · 同源 → 当前窗口内跳转（子页面进得去）
//   · 跨站外链 → 调用 open_external 用系统默认浏览器打开
// 桌面 webview 没有标签页系统，默认会忽略 target=_blank，导致这些入口点了没反应。
// 另提供 鼠标侧键「后退」/ Alt+← 返回聊天页。
const NAV_PATCH_JS: &str = r#"
(function () {
  if (window.__ownchatNavPatch) return;
  window.__ownchatNavPatch = 1;
  document.addEventListener('click', function (e) {
    var a = (e.target && e.target.closest) ? e.target.closest('a[target="_blank"]') : null;
    if (!a || !a.href) return;
    var dest;
    try { dest = new URL(a.href, location.href); } catch (err) { return; }
    if (dest.origin === location.origin) {
      e.preventDefault();
      window.location.assign(dest.href);
    } else {
      e.preventDefault();
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('open_external', { url: dest.href });
      }
    }
  }, true);
  window.addEventListener('mouseup', function (e) {
    if (e.button === 3) { e.preventDefault(); history.back(); }
  });
  window.addEventListener('keydown', function (e) {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); history.back(); }
  });
})();
"#;

// 自动更新：启动时检查 GitHub Releases 上的 latest.json，有新版本就询问用户并安装
#[cfg(desktop)]
async fn check_for_updates(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    if let Some(update) = app.updater()?.check().await? {
        let do_update = app
            .dialog()
            .message(format!(
                "发现新版本 {}，是否现在下载并更新？",
                update.version
            ))
            .title("OwnChat 有新版本")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "现在更新".to_string(),
                "稍后".to_string(),
            ))
            .blocking_show();

        if do_update {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await?;
            app.restart();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 单实例：第二次启动时聚焦已有窗口，而不是再开一个
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(TtsProcess(std::sync::Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ping, open_external, read_text_file, import_text_file, export_text_file, get_storage_dir, set_storage_dir, pick_storage_dir, open_storage_dir, kv_set, kv_get, kv_list, kv_delete, http_request, http_stream::http_request_stream, tts_get_config, tts_set_config, tts_start, tts_stop, tts_pick_dir, tts_list_models, tts_pick_file, tts_pick_files, agent_local::agent_workdir_get, agent_local::agent_workdir_pick, agent_local::agent_workdir_set, agent_local::local_list_dir, agent_local::local_read_file, agent_local::local_write_file, agent_local::local_run_command, agent_local::local_env_info])
        // 每次页面加载完成后注入导航补丁：站内 _blank 子页面同窗口打开 + 外链走系统浏览器
        .on_page_load(|webview, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                let _ = webview.eval(NAV_PATCH_JS);
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
            // 系统托盘：菜单 + 左键点击切换显隐
            let show_i = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let open_data_i =
                MenuItem::with_id(app, "open_data_dir", "打开数据文件夹", true, None::<&str>)?;
            let change_data_i =
                MenuItem::with_id(app, "change_data_dir", "更改数据位置…", true, None::<&str>)?;
            let tts_dir_i =
                MenuItem::with_id(app, "tts_set_dir", "语音 · 设置 GPT-SoVITS 文件夹…", true, None::<&str>)?;
            let tts_start_i =
                MenuItem::with_id(app, "tts_start", "语音 · 启动服务", true, None::<&str>)?;
            let tts_stop_i =
                MenuItem::with_id(app, "tts_stop", "语音 · 停止服务", true, None::<&str>)?;
            let tts_auto_i =
                MenuItem::with_id(app, "tts_autostart", "语音 · 开机自启动（开/关）", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出 OwnChat", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_i,
                    &open_data_i,
                    &change_data_i,
                    &tts_dir_i,
                    &tts_start_i,
                    &tts_stop_i,
                    &tts_auto_i,
                    &quit_i,
                ],
            )?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OwnChat")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "open_data_dir" => {
                        let _ = reveal_storage_dir(app);
                    }
                    "change_data_dir" => {
                        let app2 = app.clone();
                        app.dialog().file().pick_folder(move |folder| {
                            if let Some(fp) = folder {
                                if let Ok(path) = fp.into_path() {
                                    match apply_storage_dir(&app2, path) {
                                        Ok(p) => {
                                            app2.dialog()
                                                .message(format!(
                                                    "数据位置已更改为：\n{}\n\n已有存档已一并迁移过去。",
                                                    p
                                                ))
                                                .title("OwnChat 数据位置")
                                                .show(|_| {});
                                        }
                                        Err(e) => {
                                            app2.dialog()
                                                .message(format!("更改失败：{}", e))
                                                .title("OwnChat")
                                                .show(|_| {});
                                        }
                                    }
                                }
                            }
                        });
                    }
                    "tts_set_dir" => {
                        let app2 = app.clone();
                        app.dialog().file().pick_folder(move |folder| {
                            if let Some(fp) = folder {
                                if let Ok(path) = fp.into_path() {
                                    let p = path.to_string_lossy().to_string();
                                    match kv_write(&app2, "settings", "tts_dir", &p) {
                                        Ok(_) => {
                                            app2.dialog()
                                                .message(format!(
                                                    "GPT-SoVITS 文件夹已设置为：\n{}\n\n之后点托盘「语音 · 启动服务」即可，或开启「开机自启动」。",
                                                    p
                                                ))
                                                .title("OwnChat 语音")
                                                .show(|_| {});
                                        }
                                        Err(e) => {
                                            app2.dialog()
                                                .message(format!("设置失败：{}", e))
                                                .title("OwnChat 语音")
                                                .show(|_| {});
                                        }
                                    }
                                }
                            }
                        });
                    }
                    "tts_start" => match start_tts_service(app) {
                        Ok(port) => {
                            app.dialog()
                                .message(format!(
                                    "语音服务已启动：\nhttp://127.0.0.1:{}/tts\n\n首次启动要加载模型，可能需要十几秒到一两分钟，请稍候。",
                                    port
                                ))
                                .title("OwnChat 语音")
                                .show(|_| {});
                        }
                        Err(e) => {
                            app.dialog()
                                .message(format!(
                                    "启动失败：{}\n\n请先用「语音 · 设置 GPT-SoVITS 文件夹…」选择安装目录。",
                                    e
                                ))
                                .title("OwnChat 语音")
                                .show(|_| {});
                        }
                    },
                    "tts_stop" => match stop_tts_service(app) {
                        Ok(_) => {
                            app.dialog()
                                .message("语音服务已停止。")
                                .title("OwnChat 语音")
                                .show(|_| {});
                        }
                        Err(e) => {
                            app.dialog()
                                .message(format!("停止失败：{}", e))
                                .title("OwnChat 语音")
                                .show(|_| {});
                        }
                    },
                    "tts_autostart" => {
                        let cur = kv_read(app, "settings", "tts_autostart").ok().flatten();
                        let now_on = matches!(cur.as_deref(), Some("true") | Some("1"));
                        let next = if now_on { "false" } else { "true" };
                        match kv_write(app, "settings", "tts_autostart", next) {
                            Ok(_) => {
                                let msg = if now_on {
                                    "已关闭：开机不再自动启动语音服务。"
                                } else {
                                    "已开启：下次打开 OwnChat 会自动在后台启动语音服务（需已设置 GPT-SoVITS 文件夹）。"
                                };
                                app.dialog().message(msg).title("OwnChat 语音").show(|_| {});
                            }
                            Err(e) => {
                                app.dialog()
                                    .message(format!("设置失败：{}", e))
                                    .title("OwnChat 语音")
                                    .show(|_| {});
                            }
                        }
                    }
                    "quit" => {
                        // 2026-10-07 退出前冲刷：聊天推送是 30s 防抖，直接 exit(0) 会丢掉最近半分钟的会话
                        // （手机端看不到刚聊完的那段）。先 emit 让前端立刻 pushChatNow/pushNow，
                        // 留 1.2s 窗口再退（同步推送通常 300ms 内完成）。
                        let _ = app.emit("app-flush-now", ());
                        let app_for_exit = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(1200));
                            // 退出前顺手结束后台语音服务，避免留孤儿进程
                            if let Some(state) = app_for_exit.try_state::<TtsProcess>() {
                                if let Ok(mut g) = state.0.lock() {
                                    if let Some(mut child) = g.take() {
                                        let _ = child.kill();
                                    }
                                }
                            }
                            app_for_exit.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            }

            // 启动时异步检查更新（不阻塞界面）
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = check_for_updates(handle).await {
                        eprintln!("更新检查失败: {e}");
                    }
                });
            }

            // 若用户在设置里开启了「随应用启动语音服务」，后台静默拉起 GPT-SoVITS
            {
                let handle = app.handle().clone();
                let on = kv_read(&handle, "settings", "tts_autostart").ok().flatten();
                if matches!(on.as_deref(), Some("true") | Some("1")) {
                    if let Ok(Some(dir)) = kv_read(&handle, "settings", "tts_dir") {
                        if !dir.trim().is_empty() {
                            let port = tts_port(&handle);
                            // 已有人在听(用户自己的 .bat 已起)就别重复拉起,免得抢端口
                            if !port_alive(&port) {
                                match spawn_tts(&dir, &port) {
                                    Ok(child) => {
                                        if let Some(state) = handle.try_state::<TtsProcess>() {
                                            if let Ok(mut g) = state.0.lock() {
                                                *g = Some(child);
                                            }
                                        }
                                    }
                                    Err(e) => eprintln!("语音服务自启动失败: {e}"),
                                }
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 点窗口关闭 = 收进托盘，不退出进程（托盘菜单「退出」才真正退出）
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // 2026-10-07: 收托盘前也冲一次 —— 窗口被隐藏时页面的 visibilitychange 未必触发，
                // 而"点 X 关掉"是桌面端最常见的丢数据路径（最后 30s 的会话上不了云）。
                let _ = window.emit("app-flush-now", ());
                let _ = window.hide();
                api.prevent_close();
            }
            // 拖拽文件进窗口：rs 侧读出文本内容后 emit 给前端（前端 listen('files-dropped') 接收）
            // 桌面 webview 默认会拦截 OS 拖放，这里统一在 rs 侧读完再丢给网页内核
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                let mut files: Vec<ImportedFile> = Vec::new();
                for path in paths {
                    let ext = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_lowercase())
                        .unwrap_or_default();
                    if !["txt", "md", "json", "csv"].contains(&ext.as_str()) {
                        continue;
                    }
                    if let Ok(content) = std::fs::read_to_string(path) {
                        let name = path
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_default();
                        files.push(ImportedFile {
                            name,
                            path: path.to_string_lossy().to_string(),
                            content,
                        });
                    }
                }
                if !files.is_empty() {
                    let _ = window.emit("files-dropped", files);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}