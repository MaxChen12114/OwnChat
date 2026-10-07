// runtime.rs — Node 运行时定位（4.70）
//
// 定位一个可用的 Node，供设置页状态显示与将来的「下载自带运行时」用。
// **命令执行本身不依赖它** —— local_run_command 就是普通的进程启动，用户 PATH 里有 node 就能跑。
// 这里存在的意义是那条免装路径:用户点一下就从镜像下载一份自包含 Node，
// 让"下载即用"成立，而不是要求用户先自己装好运行时。
//
// 为什么要区分自带/系统:系统 Node 有三个坑 ——
//   ①装在移动盘上，盘不在时运行时凭空消失 ②版本可能太旧 ③无法校验完整性。
// 所以状态里把 source(自带/系统)如实报出来，让用户知道自己在依赖什么。
//
// 三级查找(照 spawn_tts 的两级回退扩了一级):
//   1. <数据目录>/runtime/node/node.exe   ← 自包含，由「下载运行时」放置
//   2. 系统 PATH 里的 node                ← 回退，但必须报出路径与版本
//   3. 都没有 → 返回带指引的错误，而不是静默失败
//
// 与 lib.rs 的 spawn_tts 保持一致:那里也是 prefer 自带 python.exe、fallback 系统 python。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 最低可用 Node 版本。--permission(权限模型)自 Node 20 起提供;
/// 低于这个版本沙箱参数会被当成未知选项、进程直接启动失败。
const MIN_MAJOR: u32 = 20;

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
/// 自包含优先;自包含存在但版本过低时**不静默回退**,而是明确报错 ——
/// 因为那通常意味着下载不完整,静默换系统 Node 会让行为变得不可预测。
pub fn locate(storage_dir: &Path) -> Result<NodeRuntime, String> {
    let bundled_dir = node_dir(storage_dir);
    if let Some(exe) = find_node_exe(&bundled_dir) {
        match probe_version(&exe) {
            Some((version, major)) if major >= MIN_MAJOR => {
                return Ok(NodeRuntime {
                    program: exe.to_string_lossy().to_string(),
                    version,
                    source: "bundled".into(),
                    supports_permission: true,
                });
            }
            Some((version, _)) => {
                return Err(format!(
                    "自带的 Node 版本过低({version},需要 v{MIN_MAJOR}+)。请重新安装测试扩展,或删除 {} 后用系统 Node。",
                    bundled_dir.display()
                ));
            }
            None => {
                return Err(format!(
                    "自带的 Node 无法执行({})。文件可能损坏,建议重新安装测试扩展。",
                    exe.display()
                ));
            }
        }
    }

    // 回退到系统 PATH。这里**不隐藏**来源 —— 前端会把 source/version 显示给用户,
    // 让他知道正在依赖一个可能随时消失(比如装在移动盘上)的运行时。
    let probe = Path::new("node");
    match probe_version(probe) {
        Some((version, major)) if major >= MIN_MAJOR => Ok(NodeRuntime {
            program: "node".into(),
            version,
            source: "system".into(),
            supports_permission: true,
        }),
        Some((version, _)) => Err(format!(
            "系统 Node 版本过低({version},需要 v{MIN_MAJOR}+)。请升级,或安装测试扩展使用自带运行时。"
        )),
        None => Err(
            "找不到 Node 运行时。可以在设置里点「安装测试扩展」下载自带版本(推荐),或自行安装 Node v20+。"
                .into(),
        ),
    }
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

pub fn status(storage_dir: &Path) -> RuntimeStatus {
    let expect_dir = node_dir(storage_dir).to_string_lossy().to_string();
    match locate(storage_dir) {
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
