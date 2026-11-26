// runtime.rs — Node 运行时定位（4.70）
//
// 定位一个可用的 Node，供设置页状态显示、本地服务（含本机宿主 sidecar）启动用。
// **命令执行本身不依赖它** —— local_run_command 就是普通的进程启动，用户 PATH 里有 node 就能跑。
// 这里存在的意义是那条免装路径:用户点一下就从镜像下载一份自包含 Node，
// 让"下载即用"成立，而不是要求用户先自己装好运行时。
//
// 为什么要区分自带/系统:系统 Node 有三个坑 ——
//   ①装在移动盘上，盘不在时运行时凭空消失 ②版本可能太旧 ③无法校验完整性。
// 所以状态里把 source(自带/系统)如实报出来，让用户知道自己在依赖什么。
//
// 四级查找（2026-11-28 公开版起）：
//   1. <数据目录>/runtime/node/node.exe     ← 用户自行放置/旧版下载的运行时
//   2. <安装包资源目录>/runtime/node/node.exe ← 安装包内置（Windows 安装包随包 Node 24）
//   3. 系统 PATH 里的 node                   ← 回退，但必须报出路径与版本
//   4. 都没有 → 汇总上面每一级的原因，返回带指引的错误，而不是静默失败
//
// 与 lib.rs 的 spawn_tts 保持一致:那里也是 prefer 自带 python.exe、fallback 系统 python。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 最低可用 Node 版本 —— 2026-11-28（T4-B）从 20 提到 24。
/// 本机宿主 sidecar（server/local.mjs）用 `node:sqlite`（22.5+ 才有）与 `import.meta.dirname`
/// （20.11+），并要求内置 Web Streams/Request/Response 行为稳定；低于 24 的运行时会在启动期直接
/// 抛错或静默降级成"数据库不可用"，所以这里 fail-closed 而不是"大概能跑"。
const MIN_MAJOR: u32 = 24;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntime {
    /// node 可执行文件的绝对路径(或回退时的裸命令名 "node")
    pub program: String,
    /// 形如 "v24.15.0";取不到则为空串
    pub version: String,
    /// "bundled" = 数据目录里的自包含运行时;"system" = 系统 PATH 里的
    pub source: String,
    /// 是否支持 --permission(决定执行时能不能套沙箱)
    pub supports_permission: bool,
}

/// 数据目录下放运行时的位置:<数据目录>/runtime/node/
pub fn node_dir(storage_dir: &Path) -> PathBuf {
    storage_dir.join("runtime").join("node")
}

/// 在给定目录里找 node.exe。解压 Node 官方 zip 会带一层 `node-v24.x.x-win-x64/`,
/// 所以先看根目录,再看一层子目录 —— 两种布局都容忍。
fn find_node_exe(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join("node.exe");
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            let nested = p.join("node.exe");
            if nested.is_file() {
                return Some(nested);
            }
        }
    }
    None
}

/// 跑 `node --version` 拿版本,并解析主版本号
fn probe_version(program: &Path) -> Option<(String, u32)> {
    let out = Command::new(program).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // 形如 v24.15.0
    let major = v
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())?;
    Some((v, major))
}

/// 定位可用的 Node 运行时。
///
/// 查找顺序（2026-11-28 公开版起）：
///   1. `<数据目录>/runtime/node/`      —— 用户自己放置/旧版下载的自包含运行时；
///   2. `<安装包资源目录>/runtime/node/` —— 安装包内置（Windows 安装包随包 Node 24，无需用户另装）；
///   3. 系统 PATH 里的 `node`。
///
/// 任何一级「找到了但不可用」（版本过低 / 无法执行）都继续往下找，并把原因记下来；
/// 三级都不行时一次报全。这样升级安装包后，旧数据目录里遗留的 Node 20 不会把 App 永久卡死
/// （旧行为是数据目录一有旧版就直接 Err，公开版装包后反而起不来）。
pub fn locate(storage_dir: &Path, resource_dir: Option<&Path>) -> Result<NodeRuntime, String> {
    let mut notes: Vec<String> = Vec::new();
    let mut candidates: Vec<PathBuf> = vec![node_dir(storage_dir)];
    if let Some(res) = resource_dir {
        candidates.push(res.join("runtime").join("node"));
    }
    for dir in candidates {
        let Some(exe) = find_node_exe(&dir) else { continue };
        match probe_version(&exe) {
            Some((version, major)) if major >= MIN_MAJOR => {
                return Ok(NodeRuntime {
                    program: exe.to_string_lossy().to_string(),
                    version,
                    source: "bundled".into(),
                    supports_permission: true,
                });
            }
            Some((version, _)) => notes.push(format!(
                "{} 里的 Node 版本过低({version},需要 v{MIN_MAJOR}+)",
                dir.display()
            )),
            None => notes.push(format!("{} 里的 Node 无法执行", exe.display())),
        }
    }

    // 回退到系统 PATH。这里**不隐藏**来源 —— 前端会把 source/version 显示给用户,
    // 让他知道正在依赖一个可能随时消失(比如装在移动盘上)的运行时。
    match probe_version(Path::new("node")) {
        Some((version, major)) if major >= MIN_MAJOR => Ok(NodeRuntime {
            program: "node".into(),
            version,
            source: "system".into(),
            supports_permission: true,
        }),
        Some((version, _)) => {
            notes.push(format!("系统 Node 版本过低({version},需要 v{MIN_MAJOR}+)"));
            Err(runtime_missing(notes))
        }
        None => {
            notes.push("系统 PATH 里没有 node".into());
            Err(runtime_missing(notes))
        }
    }
}

/// One readable failure for every level that was tried; the wizard surfaces this verbatim.
fn runtime_missing(notes: Vec<String>) -> String {
    format!(
        "找不到可用的 Node 运行时（需要 v{MIN_MAJOR}+）：{}。Windows 安装包已内置运行时；只有从源码运行才需要自己安装 Node 24+。",
        notes.join("；")
    )
}

/// 给前端的运行时就绪状态(设置页显示用)。不抛错 —— 没有运行时也是一种"状态"。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    pub program: String,
    pub version: String,
    pub source: String,
    pub supports_permission: bool,
    pub message: String,
    /// 自包含运行时的预期位置(未安装时用来提示装到哪)
    pub expect_dir: String,
}

pub fn status(storage_dir: &Path, resource_dir: Option<&Path>) -> RuntimeStatus {
    let expect_dir = node_dir(storage_dir).to_string_lossy().to_string();
    match locate(storage_dir, resource_dir) {
        Ok(rt) => {
            // 消息必须先算 —— 结构体字段按书写顺序求值,`program` 一旦被移进去,
            // 后面再借用 rt.program 就是"borrow of moved value"(CI 首轮报的 E0382)。
            let message = if rt.source == "system" {
                format!(
                    "使用系统 Node {}（{}）。它依赖 PATH,换机器或移动盘拔掉后会失效;建议下载自带运行时。",
                    rt.version, rt.program
                )
            } else {
                format!("自带 Node {}", rt.version)
            };
            RuntimeStatus {
                ready: true,
                program: rt.program,
                version: rt.version,
                source: rt.source,
                supports_permission: rt.supports_permission,
                message,
                expect_dir,
            }
        }
        Err(e) => RuntimeStatus {
            ready: false,
            program: String::new(),
            version: String::new(),
            source: String::new(),
            supports_permission: false,
            message: e,
            expect_dir,
        },
    }
}
