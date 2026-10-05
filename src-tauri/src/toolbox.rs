use serde::{Deserialize, Serialize};

use crate::i18n::pick;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePackage {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub installed: bool,
}

/// Downloads and unpacks archives / talks to the service manager: everything
/// here is far too slow to run on the webview event loop.
#[tauri::command]
pub async fn toolbox_runtimes() -> Vec<RuntimePackage> {
    crate::off_main(toolbox_runtimes_now).await.unwrap_or_default()
}

fn toolbox_runtimes_now() -> Vec<RuntimePackage> {
    #[cfg(windows)]
    {
        return windows::runtimes();
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn toolbox_install_runtime(app: tauri::AppHandle, id: String) -> Result<String, String> {
    match crate::off_main(move || toolbox_install_runtime_now(app, id)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_install_runtime_now(app: tauri::AppHandle, id: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows::install_runtime(&app, &id);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err(pick(
            "运行库安装只能在 Windows 上使用。",
            "Runtime installs only work on Windows.",
        ))
    }
}

/// OptiScaler 官方支持的注入名（就是 `setup_windows.bat` 菜单里的那几项）。
/// 官方口径是「dxgi.dll 优先，但取决于游戏」：游戏自带 dxgi.dll、或者已经被别的
/// Mod 占了，就得换 winmm.dll 这类不常被占用的名字 —— 所以必须让用户能选，不能写死。
/// 故意不含 `OptiScaler.asi`：那个要游戏侧先有 ASI Loader，装了可能静默不生效。
pub const OPTISCALER_HOOKS: [&str; 7] = [
    "dxgi.dll",
    "winmm.dll",
    "version.dll",
    "d3d12.dll",
    "dbghelp.dll",
    "wininet.dll",
    "winhttp.dll",
];

/// 默认注入名（官方首选）。
pub const OPTISCALER_DEFAULT_HOOK: &str = "dxgi.dll";

/// 安装账本：记录我们写进去的文件、覆盖前的备份、新建的目录。
/// 原来只有一个纯文本标记（内容是 `dxgi\n`），卸载时无从下手 —— 现在卸载/还原全靠这份记录。
pub const OPTISCALER_MANIFEST: &str = ".fantasyhub-optiscaler.json";
/// 旧版（0.1.57 及以前）写的纯文本标记。保留识别：老安装得能卸载干净。
pub const OPTISCALER_MARKER: &str = ".fantasyhub-optiscaler";

/// 一份安装记录。字段都带 `default`：以后加字段时旧账本仍能读进来。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModManifest {
    pub version: String,
    pub hook: String,
    #[serde(default)]
    pub installed_at: u64,
    /// 我们写进游戏目录的文件（相对路径），卸载时删这些。
    #[serde(default)]
    pub files: Vec<String>,
    /// 覆盖掉的原有文件：原文件已备份到 `backup`，卸载时还原。
    #[serde(default)]
    pub backups: Vec<ModBackup>,
    /// 安装时新建的目录（相对路径），卸载时若已空则删掉。
    #[serde(default)]
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModBackup {
    pub file: String,
    pub backup: String,
}

/// 面板上要显示的状态：装哪儿、装了没有、会不会冲突。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptiScalerStatus {
    /// 解析出来的游戏目录；找不到就是 None（Steam 游戏没设过路径时就是这种）。
    pub dir: Option<String>,
    pub installed: bool,
    /// 安装的版本（旧版标记没记版本，就是 None）。
    pub version: Option<String>,
    /// 当前用的注入名。
    pub hook: Option<String>,
    /// 只有旧版标记、没有账本 —— 能卸载，但不知道具体装了什么。
    pub legacy: bool,
    /// 目录里已存在、但不是我们装的同名文件（游戏自带的 dxgi.dll 这类）。
    pub conflict: Option<String>,
    /// 主程序不是 x64 时给出文件名：装进去游戏会起不来，前端要挡住。
    pub arch: Option<String>,
    /// 游戏正在运行（文件被占用）。
    pub running: bool,
    /// 可选的注入名，前端照着渲染选项。
    pub hooks: Vec<String>,
    pub message: String,
}

/// 面板上能选的一个版本。`tag` 是 GitHub 上的标签（`v0.9.4`），安装时按它去查。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModVersion {
    pub version: String,
    pub tag: String,
    pub bytes: u64,
    pub latest: bool,
}

/// 一次安装/卸载的取消开关。同一时刻只会有一个这类任务（前端也拦着重复点），
/// 所以一个进程级标志就够，不必像文件传输那样按 id 建表。
static MOD_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn toolbox_cancel_mod() -> bool {
    MOD_CANCEL.store(true, Ordering::Relaxed);
    true
}

/// 下载进度事件名（前端 `useModProgress` 在听）。
pub const MOD_EVENT: &str = "toolbox-mod-progress";

/// 一个装了 OptiScaler 的游戏（工具箱那张「游戏 Mod / 工具」卡的「查看列表」用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    pub game: String,
    /// 装在哪个目录（就是游戏目录）。
    pub dir: String,
    /// 账本里记的版本；旧版标记没记版本就是空串。
    pub version: String,
    pub hook: String,
}

/// 列出「哪些游戏装了 OptiScaler」。
///
/// 为什么要现扫一遍：账本（`.fantasyhub-optiscaler.json`）写在**每个游戏的目录里**，
/// 不是集中在一处；所以要先拿到库里的游戏（`scan_games`，含手动添加的），
/// 再逐个目录看有没有账本 / 旧版标记。慢一点（几秒），所以只由按钮触发，不在进页时跑。
#[tauri::command]
pub async fn toolbox_mod_list(app: tauri::AppHandle) -> Vec<InstalledMod> {
    let games = crate::scan::scan_games(app).await;
    crate::off_main(move || mod_list_now(games)).await.unwrap_or_default()
}

fn mod_list_now(games: Vec<crate::scan::ScannedGame>) -> Vec<InstalledMod> {
    #[cfg(windows)]
    {
        return windows::installed_mods(games);
    }
    #[cfg(not(windows))]
    {
        let _ = games;
        Vec::new()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProgress {
    /// `download` / `extract` / `copy` / `done`
    pub phase: String,
    pub bytes: u64,
    pub total_bytes: u64,
}

#[tauri::command]
pub async fn toolbox_install_optiscaler(
    app: tauri::AppHandle,
    launch_path: String,
    install_path: String,
    hook: String,
    version: Option<String>,
) -> Result<String, String> {
    match crate::off_main(move || {
        toolbox_install_optiscaler_now(app, launch_path, install_path, hook, version)
    })
    .await
    {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_install_optiscaler_now(
    app: tauri::AppHandle,
    launch_path: String,
    install_path: String,
    hook: String,
    version: Option<String>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        // 每次开工先清掉上一轮的取消标记，否则第一次取消之后再也装不上。
        MOD_CANCEL.store(false, Ordering::Relaxed);
        return windows::install_optiscaler(&app, &launch_path, &install_path, &hook, version.as_deref());
    }
    #[cfg(not(windows))]
    {
        let _ = (app, launch_path, install_path, hook, version);
        Err(pick(
            "OptiScaler 安装只能在 Windows 上使用。",
            "OptiScaler install only works on Windows.",
        ))
    }
}

/// 能装的版本列表（最近的几个，第一个是「最新」）。前端拿它做版本选择。
#[tauri::command]
pub async fn toolbox_optiscaler_versions() -> Vec<ModVersion> {
    crate::off_main(toolbox_optiscaler_versions_now)
        .await
        .unwrap_or_default()
}

fn toolbox_optiscaler_versions_now() -> Vec<ModVersion> {
    #[cfg(windows)]
    {
        return windows::optiscaler_versions();
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn toolbox_uninstall_optiscaler(
    launch_path: String,
    install_path: String,
) -> Result<String, String> {
    match crate::off_main(move || toolbox_uninstall_optiscaler_now(launch_path, install_path)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn toolbox_uninstall_optiscaler_now(
    launch_path: String,
    install_path: String,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows::uninstall_optiscaler(&launch_path, &install_path);
    }
    #[cfg(not(windows))]
    {
        let _ = (launch_path, install_path);
        Err(pick(
            "OptiScaler 卸载只能在 Windows 上使用。",
            "OptiScaler uninstall only works on Windows.",
        ))
    }
}

#[tauri::command]
pub async fn toolbox_optiscaler_status(
    launch_path: String,
    install_path: String,
    hook: Option<String>,
) -> OptiScalerStatus {
    crate::off_main(move || toolbox_optiscaler_status_now(launch_path, install_path, hook))
        .await
        .unwrap_or_else(|err| OptiScalerStatus {
            dir: None,
            installed: false,
            version: None,
            hook: None,
            legacy: false,
            conflict: None,
            arch: None,
            running: false,
            hooks: hook_list(),
            message: err,
        })
}

fn hook_list() -> Vec<String> {
    OPTISCALER_HOOKS.iter().map(|hook| hook.to_string()).collect()
}

fn toolbox_optiscaler_status_now(
    launch_path: String,
    install_path: String,
    hook: Option<String>,
) -> OptiScalerStatus {
    #[cfg(windows)]
    {
        return windows::optiscaler_status(&launch_path, &install_path, hook.as_deref());
    }
    #[cfg(not(windows))]
    {
        let _ = (launch_path, install_path, hook);
        OptiScalerStatus {
            dir: None,
            installed: false,
            version: None,
            hook: None,
            legacy: false,
            conflict: None,
            arch: None,
            running: false,
            hooks: hook_list(),
            message: pick(
                "OptiScaler 只能在 Windows 上安装。",
                "OptiScaler can only be installed on Windows.",
            ),
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
/// `steam://rungameid/440` 这种地址不是路径：拿它取 parent 会得到一个不存在的目录。
fn is_url_like(value: &str) -> bool {
    value.contains("://")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_exe_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}
#[cfg_attr(not(windows), allow(dead_code))]
/// 盘符 / 共享根不能当游戏目录。这里做文本判断（和 files.rs 的 `is_drive_root` 一个道理）：
/// 跑在 macOS 上的单测里，Windows 路径不会被解析成盘符根。
fn is_root_like(path: &Path) -> bool {
    if path.file_name().is_none() {
        return true;
    }
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    let text = text.strip_prefix("\\\\.\\").unwrap_or(text);
    let trimmed = text.trim_end_matches('\\');
    let bytes = trimmed.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    if let Some(share) = trimmed.strip_prefix("\\\\") {
        let mut parts = share.split('\\');
        return parts.next().is_some_and(|part| !part.is_empty())
            && parts.next().is_some_and(|part| !part.is_empty())
            && parts.next().is_none();
    }
    false
}
#[cfg_attr(not(windows), allow(dead_code))]
/// 单条路径 → 目录候选：exe 取上一层，其它当目录本身。
fn dir_from_hint(hint: &str) -> Option<PathBuf> {
    let value = hint.trim().trim_matches('"');
    if value.is_empty() || is_url_like(value) {
        return None;
    }
    let path = PathBuf::from(value);
    let dir = if is_exe_path(&path) {
        path.parent()?.to_path_buf()
    } else {
        path
    };
    // 真遇到脏数据（比如 install_path 被写成 C:\）宁可不装，也别把 DLL 撒进盘根。
    if is_root_like(&dir) {
        return None;
    }
    Some(dir)
}
#[cfg_attr(not(windows), allow(dead_code))]
/// 游戏目录候选，按可信度排序：**安装位置优先**，启动路径兜底。
///
/// 为什么不能只看 `launch_path`（老实现的毛病）：
/// - Steam / Epic 游戏的 `launch_path` 是 `steam://rungameid/<id>` 这类地址，取 parent
///   得到的是个假目录 → 老实现直接报「游戏目录无效」，Steam 用户根本装不上；
/// - 扫描出来的 `install_path` 才是真目录。
fn game_dir_candidates(launch_path: &str, install_path: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for hint in [install_path, launch_path] {
        if let Some(dir) = dir_from_hint(hint) {
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
    }
    out
}

/// 挑第一个真实存在的候选目录。
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_game_dir(launch_path: &str, install_path: &str) -> Option<PathBuf> {
    game_dir_candidates(launch_path, install_path)
        .into_iter()
        .find(|dir| dir.is_dir())
}

/// 把前端传来的注入名归一成官方拼写；不认识的名字返回 None（不认识的不能拿去当文件名）。
#[cfg_attr(not(windows), allow(dead_code))]
fn canonical_hook(hook: &str) -> Option<&'static str> {
    let hook = hook.trim();
    if hook.is_empty() {
        return Some(OPTISCALER_DEFAULT_HOOK);
    }
    OPTISCALER_HOOKS
        .iter()
        .find(|known| known.eq_ignore_ascii_case(hook))
        .copied()
}
#[cfg_attr(not(windows), allow(dead_code))]
/// 从文件头字节判断 PE 位数：`Some(true)` = x64，`Some(false)` = 别的位数
/// （x86 / ARM64），`None` = 不是 PE 或头部不完整。
///
/// 为什么需要它：OptiScaler 只有 x64 版。把 x64 的 dxgi.dll 放进 32 位游戏目录，
/// 游戏会因为「DLL 位数不对」直接起不来 —— 官方脚本不查，我们要查。
fn pe_is_x64(bytes: &[u8]) -> Option<bool> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return None;
    }
    let lfanew = u32::from_le_bytes([bytes[0x3c], bytes[0x3d], bytes[0x3e], bytes[0x3f]]) as usize;
    let machine_at = lfanew.checked_add(4)?;
    if lfanew + 2 > bytes.len() || machine_at + 2 > bytes.len() {
        return None;
    }
    if &bytes[lfanew..lfanew + 2] != b"PE" {
        return None;
    }
    let machine = u16::from_le_bytes([bytes[machine_at], bytes[machine_at + 1]]);
    Some(machine == 0x8664)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tauri::{Emitter, Manager};

    pub fn runtimes() -> Vec<RuntimePackage> {
        vec![
            RuntimePackage {
                id: "vc2015_2022_x64".into(),
                name: pick("Visual C++ 2015–2022 (x64)", "Visual C++ 2015–2022 (x64)"),
                detail: pick(
                    "多数新游戏依赖的官方运行库（64 位）。",
                    "Official redistributable used by most modern 64-bit games.",
                ),
                installed: vc_runtime_installed("x64"),
            },
            RuntimePackage {
                id: "vc2015_2022_x86".into(),
                name: pick("Visual C++ 2015–2022 (x86)", "Visual C++ 2015–2022 (x86)"),
                detail: pick(
                    "部分老游戏 / 32 位组件需要。",
                    "Needed by some older or 32-bit game components.",
                ),
                installed: vc_runtime_installed("x86"),
            },
            RuntimePackage {
                id: "net8_desktop_x64".into(),
                name: pick(".NET 8 桌面运行时 (x64)", ".NET 8 Desktop Runtime (x64)"),
                detail: pick(
                    "部分启动器与工具依赖。",
                    "Used by some launchers and tools.",
                ),
                installed: net_desktop_installed("8."),
            },
        ]
    }

    pub fn install_runtime(app: &tauri::AppHandle, id: &str) -> Result<String, String> {
        let (url, file_name, args) = match id {
            "vc2015_2022_x64" => (
                "https://aka.ms/vs/17/release/vc_redist.x64.exe",
                "vc_redist.x64.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            "vc2015_2022_x86" => (
                "https://aka.ms/vs/17/release/vc_redist.x86.exe",
                "vc_redist.x86.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            "net8_desktop_x64" => (
                "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe",
                "windowsdesktop-runtime-8-win-x64.exe",
                vec!["/install", "/quiet", "/norestart"],
            ),
            _ => {
                return Err(pick("未知的运行库项目", "Unknown runtime package"));
            }
        };

        let cache = cache_dir(app)?;
        let installer = cache.join(file_name);
        download(url, &installer)?;
        run_installer(&installer, &args)?;
        Ok(pick("安装完成。", "Install finished."))
    }

    /// 装哪儿、装了没有、会不会冲突、能不能装 —— 面板点开菜单先问它。
    pub fn optiscaler_status(
        launch_path: &str,
        install_path: &str,
        hook: Option<&str>,
    ) -> OptiScalerStatus {
        let hook = canonical_hook(hook.unwrap_or("")).unwrap_or(OPTISCALER_DEFAULT_HOOK);
        let dir = resolve_game_dir(launch_path, install_path);
        let manifest = dir.as_deref().and_then(read_manifest);
        let legacy = dir.as_deref().is_some_and(marker_present);
        let conflict = dir
            .as_deref()
            .and_then(|dir| hook_conflict(dir, hook, manifest.as_ref()));
        let arch = dir.as_deref().and_then(main_exe_arch_problem);
        let running = !fh_core::process::pids_for_game(launch_path, install_path).is_empty();
        let message = if dir.is_none() {
            pick(
                "找不到游戏目录。Steam 游戏请先在卡片菜单里用「改路径」选中游戏的 exe。",
                "Couldn't find the game folder. For Steam games, pick the game exe from the card menu first.",
            )
        } else if running {
            pick(
                "游戏正在运行，先退出再装。",
                "The game is running. Quit it first.",
            )
        } else if let Some(name) = arch.as_deref() {
            pick(
                &format!("{name} 不是 64 位程序，OptiScaler 只有 64 位版，装进去游戏会起不来。"),
                &format!("{name} isn't 64-bit. OptiScaler is x64-only and would break the game."),
            )
        } else {
            pick("可以安装。", "Ready to install.")
        };
        OptiScalerStatus {
            dir: dir.map(|path| path.display().to_string()),
            installed: manifest.is_some() || legacy,
            version: manifest.as_ref().map(|found| found.version.clone()),
            hook: manifest
                .as_ref()
                .map(|found| found.hook.clone())
                .or_else(|| legacy.then(|| OPTISCALER_DEFAULT_HOOK.to_string())),
            legacy,
            conflict,
            arch,
            running,
            hooks: super::hook_list(),
            message,
        }
    }

    pub fn install_optiscaler(
        app: &tauri::AppHandle,
        launch_path: &str,
        install_path: &str,
        hook: &str,
        version: Option<&str>,
    ) -> Result<String, String> {
        let hook = canonical_hook(hook).ok_or_else(|| {
            pick(
                "这个注入文件名不支持。",
                "That hook file name isn't supported.",
            )
        })?;
        let dir = resolve_game_dir(launch_path, install_path).ok_or_else(|| {
            pick(
                "找不到游戏目录。Steam 游戏请先在卡片菜单里用「改路径」选中游戏的 exe。",
                "Couldn't find the game folder. For Steam games, pick the game exe from the card menu first.",
            )
        })?;
        if !dir.is_dir() {
            return Err(pick("游戏目录无效。", "Game folder is invalid."));
        }
        // 游戏在跑时 DLL 被占用，写进去也加载不上：先拦下来，别留下半套文件。
        if !fh_core::process::pids_for_game(launch_path, install_path).is_empty() {
            return Err(pick(
                "游戏正在运行，先退出再装。",
                "The game is running. Quit it first.",
            ));
        }
        if let Some(name) = main_exe_arch_problem(&dir) {
            return Err(pick(
                &format!("{name} 不是 64 位程序，OptiScaler 只有 64 位版。"),
                &format!("{name} isn't 64-bit; OptiScaler is x64-only."),
            ));
        }
        // 同一个注入名重装 = 更新：账本里那个 DLL 是「我们自己」的，不能再备份一次
        // （`<hook>.fantasyhub.bak` 里存的是游戏原文件，覆盖掉就再也还原不回来）。
        let previous = read_manifest(&dir);
        let hook_is_ours = previous.as_ref().is_some_and(|found| found.hook == hook);
        // 换注入名重装：先把上一套删干净（含还原备份），否则两套文件会打架。
        if let Some(previous) = previous {
            if previous.hook != hook {
                remove_installed_files(&dir, &previous)?;
            }
        } else if marker_present(&dir) {
            legacy_cleanup(&dir)?;
        }

        let release = optiscaler_release(version)?;
        let cache = cache_dir(app)?;
        let archive_path = cache.join(&release.file_name);
        // 缓存里那份大小对得上就直接用：官方包 50 MB 上下，重装不该再下一次。
        let cached = release.bytes > 0
            && fs::metadata(&archive_path).map(|meta| meta.len()).ok() == Some(release.bytes);
        if !cached {
            let _ = fs::remove_file(&archive_path);
            download_with_progress(app, &release.url, &archive_path, release.bytes)?;
        }

        let extract_dir = cache.join("optiscaler-extract");
        let _ = fs::remove_dir_all(&extract_dir);
        fs::create_dir_all(&extract_dir).map_err(|err| {
            pick(
                &format!("无法准备解压目录：{err}"),
                &format!("Couldn't prepare extract folder: {err}"),
            )
        })?;
        emit_mod(app, "extract", 0, 0);
        expand_archive(&archive_path, &extract_dir)?;

        let package_root = find_optiscaler_root(&extract_dir).ok_or_else(|| {
            pick(
                "压缩包里找不到 OptiScaler 文件。",
                "Couldn't find OptiScaler files in the archive.",
            )
        })?;

        // 边写边记账：卸载/还原全靠这份记录，原来只写一个纯文本标记就完事。
        let mut ledger = ModManifest {
            version: release.version.clone(),
            hook: hook.to_string(),
            installed_at: now_ms(),
            files: Vec::new(),
            backups: Vec::new(),
            dirs: Vec::new(),
        };
        emit_mod(app, "copy", 0, 0);
        copy_optiscaler_files(&package_root, &dir, hook, hook_is_ours, &mut ledger)?;
        write_manifest(&dir, &ledger)?;
        let _ = fs::remove_file(dir.join(OPTISCALER_MARKER));
        emit_mod(app, "done", 0, 0);
        Ok(pick(
            &format!(
                "已安装 OptiScaler v{}（{hook}）。原文件已备份，可在卡片菜单里卸载还原；进游戏按 Insert 打开菜单。",
                release.version
            ),
            &format!(
                "OptiScaler v{} installed as {hook}. Originals were backed up; press Insert in-game.",
                release.version
            ),
        ))
    }

    pub fn uninstall_optiscaler(launch_path: &str, install_path: &str) -> Result<String, String> {
        let dir = resolve_game_dir(launch_path, install_path)
            .ok_or_else(|| pick("找不到游戏目录。", "Couldn't find the game folder."))?;
        if !fh_core::process::pids_for_game(launch_path, install_path).is_empty() {
            return Err(pick(
                "游戏正在运行，先退出再卸载。",
                "The game is running. Quit it before uninstalling.",
            ));
        }
        if let Some(manifest) = read_manifest(&dir) {
            remove_installed_files(&dir, &manifest)?;
            return Ok(pick(
                "已卸载 OptiScaler，被覆盖的文件已还原。",
                "OptiScaler removed and the overwritten files restored.",
            ));
        }
        if marker_present(&dir) {
            legacy_cleanup(&dir)?;
            return Ok(pick(
                "已卸载 OptiScaler（这是旧版装的，没有完整记录，只清了注入 DLL 与配置）。",
                "OptiScaler removed (legacy install; only the injected DLL and config were cleaned).",
            ));
        }
        Err(pick(
            "这个目录里没有 FantasyHub 的安装记录，没有能自动卸载的东西。",
            "No FantasyHub install record in this folder; nothing to uninstall.",
        ))
    }

    /// 列出装了 OptiScaler 的游戏：账本优先；只有旧版标记（没账本）的也列出来，
    /// 版本写空串 —— 「装了但不知道装的哪版」是真实状态，不编一个版本号。
    pub fn installed_mods(games: Vec<crate::scan::ScannedGame>) -> Vec<InstalledMod> {
        let mut out = Vec::new();
        for game in games {
            let Some(dir) = resolve_game_dir(&game.launch_path, &game.install_path) else {
                continue;
            };
            let manifest = read_manifest(&dir);
            if manifest.is_none() && !marker_present(&dir) {
                continue;
            }
            let (version, hook) = manifest
                .map(|row| (row.version, row.hook))
                .unwrap_or_default();
            out.push(InstalledMod {
                game: game.name,
                dir: dir.display().to_string(),
                version,
                hook,
            });
        }
        out
    }

    fn find_named_file(root: &Path, name: &str) -> Option<PathBuf> {
        let direct = root.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        let entries = fs::read_dir(root).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = find_named_file(&path, name) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
            {
                return Some(path);
            }
        }
        None
    }

    fn vc_runtime_installed(arch: &str) -> bool {
        let key = format!(r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\{arch}");
        let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
        if let Ok(sub) = hklm.open_subkey(&key) {
            if let Ok(1u32) = sub.get_value("Installed") {
                return true;
            }
        }
        false
    }

    fn net_desktop_installed(prefix: &str) -> bool {
        let output = Command::new("dotnet")
            .args(["--list-runtimes"])
            .output();
        let Ok(output) = output else {
            return false;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines().any(|line| {
            line.starts_with("Microsoft.WindowsDesktop.App ") && line.contains(prefix)
        })
    }

    fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|err| {
                pick(
                    &format!("无法定位缓存目录：{err}"),
                    &format!("Couldn't locate cache folder: {err}"),
                )
            })?
            .join("toolbox");
        fs::create_dir_all(&dir).map_err(|err| {
            pick(
                &format!("无法创建缓存目录：{err}"),
                &format!("Couldn't create cache folder: {err}"),
            )
        })?;
        Ok(dir)
    }

    fn download(url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let response = ureq::get(url)
            .set("User-Agent", "FantasyHub-Toolbox")
            .call()
            .map_err(|err| {
                pick(
                    &format!("下载失败：{err}"),
                    &format!("Download failed: {err}"),
                )
            })?;
        let mut reader = response.into_reader();
        let mut file = fs::File::create(dest).map_err(|err| {
            pick(
                &format!("无法写入下载文件：{err}"),
                &format!("Couldn't write download: {err}"),
            )
        })?;
        std::io::copy(&mut reader, &mut file).map_err(|err| {
            pick(
                &format!("保存下载失败：{err}"),
                &format!("Couldn't save download: {err}"),
            )
        })?;
        Ok(())
    }

    fn run_installer(path: &Path, args: &[&str]) -> Result<(), String> {
        let status = Command::new(path)
            .args(args)
            .status()
            .map_err(|err| {
                pick(
                    &format!("无法启动安装程序：{err}"),
                    &format!("Couldn't start installer: {err}"),
                )
            })?;
        // MSI quiet installs often return 0 or 3010 (reboot required).
        if status.success() || status.code() == Some(3010) {
            return Ok(());
        }
        Err(pick(
            &format!("安装程序退出码：{:?}", status.code()),
            &format!("Installer exit code: {:?}", status.code()),
        ))
    }

    fn marker_present(dir: &Path) -> bool {
        dir.join(OPTISCALER_MARKER).is_file()
    }

    fn manifest_path(dir: &Path) -> PathBuf {
        dir.join(OPTISCALER_MANIFEST)
    }

    /// 账本读不出来（文件坏了 / 是别的东西）就当没有：宁可按「没记录」报错，也不乱删文件。
    fn read_manifest(dir: &Path) -> Option<ModManifest> {
        let text = fs::read_to_string(manifest_path(dir)).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn write_manifest(dir: &Path, manifest: &ModManifest) -> Result<(), String> {
        let text = serde_json::to_string_pretty(manifest).map_err(|err| {
            pick(
                &format!("无法生成安装记录：{err}"),
                &format!("Couldn't write the install record: {err}"),
            )
        })?;
        fs::write(manifest_path(dir), text).map_err(|err| {
            pick(
                &format!("无法写入安装记录：{err}"),
                &format!("Couldn't save the install record: {err}"),
            )
        })
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }

    fn emit_mod(app: &tauri::AppHandle, phase: &str, bytes: u64, total_bytes: u64) {
        let _ = app.emit(
            MOD_EVENT,
            ModProgress {
                phase: phase.to_string(),
                bytes,
                total_bytes,
            },
        );
    }

    /// 按账本卸载：先删我们写的文件（有备份的路径留给还原），再还原备份，最后删空目录。
    fn remove_installed_files(dir: &Path, manifest: &ModManifest) -> Result<(), String> {
        let restored: Vec<&str> = manifest
            .backups
            .iter()
            .map(|backup| backup.file.as_str())
            .collect();
        for file in &manifest.files {
            // 有备份的文件不能删：下一步会用备份覆盖回去。
            if restored.iter().any(|path| *path == file.as_str()) {
                continue;
            }
            let target = dir.join(file);
            if target.is_file() {
                let _ = fs::remove_file(&target);
            }
        }
        for backup in &manifest.backups {
            let saved = dir.join(&backup.backup);
            let target = dir.join(&backup.file);
            if saved.is_file() {
                fs::copy(&saved, &target).map_err(|err| {
                    pick(
                        &format!("无法还原 {}：{err}", backup.file),
                        &format!("Couldn't restore {}: {err}", backup.file),
                    )
                })?;
                let _ = fs::remove_file(&saved);
            }
        }
        // 目录倒序删（先深后浅），且只在空的时候删 —— 里面有自己的东西就留着。
        let mut dirs = manifest.dirs.clone();
        dirs.sort_by_key(|path| std::cmp::Reverse(path.matches(['/', '\\']).count()));
        for sub in dirs {
            let _ = fs::remove_dir(dir.join(sub));
        }
        let _ = fs::remove_file(manifest_path(dir));
        let _ = fs::remove_file(dir.join(OPTISCALER_MARKER));
        Ok(())
    }

    /// 旧版（只有纯文本标记）的清理：先还原备份；没备份就删掉标记里记的那个注入 DLL
    /// —— 标记还在，说明那个 DLL 是我们放的，删它不会动游戏自带文件。
    fn legacy_cleanup(dir: &Path) -> Result<(), String> {
        for hook in OPTISCALER_HOOKS {
            let backup = dir.join(format!("{hook}.fantasyhub.bak"));
            if backup.is_file() {
                let _ = fs::copy(&backup, dir.join(hook));
                let _ = fs::remove_file(&backup);
            }
        }
        let marker = dir.join(OPTISCALER_MARKER);
        let hook = fs::read_to_string(&marker)
            .ok()
            .map(|text| text.trim().to_string());
        if let Some(hook) = hook.filter(|name| !name.is_empty() && !name.contains(['/', '\\'])) {
            let target = dir.join(&hook);
            if target.is_file() {
                let _ = fs::remove_file(&target);
            }
        }
        let _ = fs::remove_file(dir.join("OptiScaler.ini"));
        let _ = fs::remove_file(&marker);
        Ok(())
    }

    /// 所选注入名在游戏目录里已存在、而且不是我们装的 → 报给前端，让用户改选或知情。
    /// 已经有 `.fantasyhub.bak` 说明上一轮处理过它，不再当冲突。
    fn hook_conflict(dir: &Path, hook: &str, manifest: Option<&ModManifest>) -> Option<String> {
        if dir.join(format!("{hook}.fantasyhub.bak")).is_file() {
            return None;
        }
        if let Some(manifest) = manifest {
            if manifest.hook == hook || manifest.files.iter().any(|file| file == hook) {
                return None;
            }
        }
        dir.join(hook).is_file().then(|| hook.to_string())
    }

    /// 一次下载所需的全部信息（版本号要写进账本、大小用来判断缓存和校验完整性）。
    struct ReleaseAsset {
        version: String,
        tag: String,
        url: String,
        file_name: String,
        bytes: u64,
    }

    /// 最近的几个可装版本（跳过草稿与预发布；没有 7z/zip 附件的也不要）。
    pub fn optiscaler_versions() -> Vec<ModVersion> {
        let Some(json) = optiscaler_release_json(
            "https://api.github.com/repos/optiscaler/OptiScaler/releases?per_page=10",
        ) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (index, release) in json.as_array().into_iter().flatten().enumerate() {
            if release
                .get("draft")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || release
                    .get("prerelease")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                continue;
            }
            let Some(tag) = release.get("tag_name").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some((_, bytes)) = release_archive(release) else {
                continue;
            };
            out.push(ModVersion {
                version: tag.trim_start_matches('v').to_string(),
                tag: tag.to_string(),
                bytes,
                latest: index == 0,
            });
            if out.len() >= 5 {
                break;
            }
        }
        out
    }

    /// 查某个版本的下载信息；`tag` 为 None 时取 latest。
    fn optiscaler_release(tag: Option<&str>) -> Result<ReleaseAsset, String> {
        let url = match tag {
            // 传进来的就是 GitHub 上的标签（前端列表里带的），原样拼回地址。
            Some(tag) if !tag.trim().is_empty() => format!(
                "https://api.github.com/repos/optiscaler/OptiScaler/releases/tags/{}",
                tag.trim()
            ),
            _ => "https://api.github.com/repos/optiscaler/OptiScaler/releases/latest".to_string(),
        };
        let json = optiscaler_release_json(&url).ok_or_else(|| {
            pick(
                "无法查询 OptiScaler 版本（网络不通或 GitHub 拒绝）。",
                "Couldn't query the OptiScaler release (no network or GitHub refused).",
            )
        })?;
        let tag_name = json
            .get("tag_name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let (url, bytes) = release_archive(&json)
            .ok_or_else(|| pick("找不到 OptiScaler 的压缩包下载。", "Couldn't find an OptiScaler archive download."))?;
        let extension = if url.to_ascii_lowercase().ends_with(".zip") {
            ".zip"
        } else {
            ".7z"
        };
        Ok(ReleaseAsset {
            version: tag_name.trim_start_matches('v').to_string(),
            tag: tag_name.to_string(),
            url,
            // 一个版本一个缓存名：换版本重装时不会拿旧版本的文件顶上。
            file_name: format!("OptiScaler-{}{extension}", tag_name.trim_start_matches('v')),
            bytes,
        })
    }

    /// 拉一个 release（或 release 列表）的 JSON。网络/解析失败一律 None —— 调用方各自决定怎么报。
    fn optiscaler_release_json(url: &str) -> Option<serde_json::Value> {
        let body = ureq::get(url)
            .set("User-Agent", "FantasyHub-Toolbox")
            .set("Accept", "application/vnd.github+json")
            .call()
            .ok()?
            .into_string()
            .ok()?;
        serde_json::from_str(&body).ok()
    }

    /// 从一个 release 对象里挑压缩包：优先名字里带 optiscaler 的，否则拿第一个 7z/zip。
    /// 返回 (下载地址, 字节数)。
    fn release_archive(release: &serde_json::Value) -> Option<(String, u64)> {
        let assets = release.get("assets")?.as_array()?;
        let mut fallback: Option<(String, u64)> = None;
        for asset in assets {
            let name = asset.get("name").and_then(|value| value.as_str()).unwrap_or("");
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(".7z") && !lower.ends_with(".zip") {
                continue;
            }
            let Some(url) = asset.get("browser_download_url").and_then(|value| value.as_str())
            else {
                continue;
            };
            let entry = (
                url.to_string(),
                asset.get("size").and_then(|value| value.as_u64()).unwrap_or(0),
            );
            if lower.contains("optiscaler") {
                return Some(entry);
            }
            if fallback.is_none() {
                fallback = Some(entry);
            }
        }
        fallback
    }

    /// 官方包是 `.7z`（个别老包是 `.zip`），按扩展名选解压方式。
    fn expand_archive(archive: &Path, dest: &Path) -> Result<(), String> {
        let is_7z = archive
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("7z"));
        if is_7z {
            expand_7z(archive, dest)
        } else {
            expand_zip(archive, dest)
        }
    }

    /// `Expand-Archive` 只认 zip；7z 用纯 Rust 解（官方包带 BCJ2 过滤器）。
    fn expand_7z(archive: &Path, dest: &Path) -> Result<(), String> {
        // sevenz-rust2 要求目标是绝对路径，且不接受含 `..` 的路径。
        let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
        sevenz_rust2::decompress_file(archive, &dest).map_err(|err| {
            pick(
                &format!("解压 OptiScaler 失败：{err}"),
                &format!("Failed to extract OptiScaler: {err}"),
            )
        })
    }

    fn expand_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    escape_ps(zip_path),
                    escape_ps(dest)
                ),
            ])
            .status()
            .map_err(|err| {
                pick(
                    &format!("无法解压：{err}"),
                    &format!("Couldn't extract archive: {err}"),
                )
            })?;
        if status.success() {
            Ok(())
        } else {
            Err(pick("解压 OptiScaler 失败。", "Failed to extract OptiScaler."))
        }
    }

    fn escape_ps(path: &Path) -> String {
        path.to_string_lossy().replace('\'', "''")
    }

    /// 主程序不是 x64 就返回文件名：装进去游戏会起不来。
    /// 认不出主程序（没有 exe / 读不到头）返回 None —— 认不出就不拦，别把能装的挡住了。
    fn main_exe_arch_problem(dir: &Path) -> Option<String> {
        let exe = find_main_exe(dir)?;
        let mut head = [0u8; 1024];
        let mut file = fs::File::open(&exe).ok()?;
        use std::io::Read;
        let read = file.read(&mut head).ok()?;
        match pe_is_x64(&head[..read]) {
            Some(false) => exe
                .file_name()
                .map(|name| name.to_string_lossy().to_string()),
            _ => None,
        }
    }

    /// 主程序 = 游戏目录里最大的顶层 exe；顶层没有就去下一层找（`Binaries\Win64` 这类布局）。
    fn find_main_exe(dir: &Path) -> Option<PathBuf> {
        largest_exe(dir, 2)
    }

    fn largest_exe(dir: &Path, depth: usize) -> Option<PathBuf> {
        let mut best: Option<(u64, PathBuf)> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    if let Some(found) = largest_exe(&path, depth - 1) {
                        let size = fs::metadata(&found).map(|meta| meta.len()).unwrap_or(0);
                        if best.as_ref().is_none_or(|(best_size, _)| size > *best_size) {
                            best = Some((size, found));
                        }
                    }
                }
                continue;
            }
            if !is_exe_path(&path) {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if best.as_ref().is_none_or(|(best_size, _)| size > *best_size) {
                best = Some((size, path));
            }
        }
        best.map(|(_, path)| path)
    }

    /// 带进度的下载：要显示百分比、要能取消，所以自己分块读，
    /// 不用 `download()`（那个是给运行库这种小文件用的，没进度也不能取消）。
    fn download_with_progress(
        app: &tauri::AppHandle,
        url: &str,
        dest: &Path,
        total: u64,
    ) -> Result<(), String> {
        use std::io::{Read, Write};
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let response = ureq::get(url)
            .set("User-Agent", "FantasyHub-Toolbox")
            .call()
            .map_err(|err| {
                pick(
                    &format!("下载失败：{err}"),
                    &format!("Download failed: {err}"),
                )
            })?;
        // release API 里给了 asset 大小，重定向后的 Content-Length 更准，优先用它。
        let total = response
            .header("Content-Length")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(total);
        let mut reader = response.into_reader();
        let mut file = fs::File::create(dest).map_err(|err| {
            pick(
                &format!("无法写入下载文件：{err}"),
                &format!("Couldn't write download: {err}"),
            )
        })?;
        let mut buffer = vec![0u8; 64 * 1024];
        let mut done: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        emit_mod(app, "download", 0, total);
        loop {
            if MOD_CANCEL.load(Ordering::Relaxed) {
                drop(file);
                let _ = fs::remove_file(dest);
                return Err(pick("已取消安装。", "Install cancelled."));
            }
            let read = reader.read(&mut buffer).map_err(|err| {
                pick(
                    &format!("下载中断：{err}"),
                    &format!("Download interrupted: {err}"),
                )
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read]).map_err(|err| {
                pick(
                    &format!("保存下载失败：{err}"),
                    &format!("Couldn't save download: {err}"),
                )
            })?;
            done += read as u64;
            if last_emit.elapsed() >= std::time::Duration::from_millis(150) {
                last_emit = std::time::Instant::now();
                emit_mod(app, "download", done, total);
            }
        }
        if total > 0 && done != total {
            let _ = fs::remove_file(dest);
            return Err(pick(
                &format!("下载不完整（{done}/{total} 字节），请重试。"),
                &format!("Download incomplete ({done}/{total} bytes). Try again."),
            ));
        }
        Ok(())
    }

    /// 安装包里的 `OptiScaler.dll` 所在目录即「包根」，展开后可能嵌在子目录里。
    fn find_optiscaler_root(extract_dir: &Path) -> Option<PathBuf> {
        let dll = find_named_file(extract_dir, "OptiScaler.dll")
            .or_else(|| find_named_file(extract_dir, "OptiScaler.ini"))?;
        Some(
            dll.parent()
                .map(|parent| parent.to_path_buf())
                .unwrap_or_else(|| extract_dir.to_path_buf()),
        )
    }

    fn copy_optiscaler_files(
        from: &Path,
        to: &Path,
        hook: &str,
        hook_is_ours: bool,
        ledger: &mut ModManifest,
    ) -> Result<(), String> {
        let mut copied_dll = false;
        copy_optiscaler_dir(from, from, to, hook, hook_is_ours, ledger, &mut copied_dll)?;
        if !copied_dll {
            return Err(pick(
                "安装包里没有 OptiScaler.dll。",
                "Package is missing OptiScaler.dll.",
            ));
        }
        Ok(())
    }

    /// 逐层拷贝安装包内容：保留 `D3D12_Optiscaler/`、`Licenses/` 等子目录
    /// （官方 0.9.x 的这些文件必须一起进游戏目录），`OptiScaler.dll` 改名成用户选的
    /// 注入名（默认 `dxgi.dll`；原来是写死的）放到游戏目录根，**边写边记账**。
    fn copy_optiscaler_dir(
        root: &Path,
        dir: &Path,
        to: &Path,
        hook: &str,
        hook_is_ours: bool,
        ledger: &mut ModManifest,
        copied_dll: &mut bool,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|err| {
            pick(
                &format!("无法读取 OptiScaler 目录：{err}"),
                &format!("Couldn't read OptiScaler folder: {err}"),
            )
        })?;
        for entry in entries.flatten() {
            let src = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let rel = src.strip_prefix(root).unwrap_or(Path::new(&*name_str));
            if src.is_dir() {
                let dest_dir = to.join(rel);
                let fresh = !dest_dir.exists();
                fs::create_dir_all(&dest_dir).map_err(|err| {
                    pick(
                        &format!("无法创建目录 {}：{err}", dest_dir.display()),
                        &format!("Couldn't create {}: {err}", dest_dir.display()),
                    )
                })?;
                // 只记「这一趟新建」的目录：卸载时也只删这些，不动游戏原有的目录。
                if fresh {
                    ledger.dirs.push(rel.to_string_lossy().to_string());
                }
                copy_optiscaler_dir(root, &src, to, hook, hook_is_ours, ledger, copied_dll)?;
                continue;
            }
            if !src.is_file() {
                continue;
            }
            // 官方的「!! EXTRACT ALL FILES !!」提示与 setup/remove 脚本不进游戏目录。
            if name_str.starts_with("!!") || is_setup_script(&name_str) {
                continue;
            }
            // 已有的 OptiScaler.ini 是用户配置，重装时保留。
            // 用 rel 而不是写死文件名：子目录（如 D3D12_Optiscaler/）里的 INI 也要查对位置，
            // 根目录时 rel 就是 OptiScaler.ini，行为不变。
            if name_str.eq_ignore_ascii_case("OptiScaler.ini") && to.join(rel).is_file() {
                continue;
            }
            let is_optiscaler_dll = name_str.eq_ignore_ascii_case("OptiScaler.dll");
            let dest_name = if is_optiscaler_dll {
                *copied_dll = true;
                PathBuf::from(hook)
            } else {
                rel.to_path_buf()
            };
            let dest = to.join(&dest_name);
            if is_optiscaler_dll && dest.is_file() && !hook_is_ours {
                // 这个名字被占用了（游戏自带 / 别的 Mod）。先把原文件留一份备份并记账，
                // 卸载时还原。`.bak` 已存在就不再覆盖：里面存的是最初那份原文件。
                let backup_name = format!("{hook}.fantasyhub.bak");
                let bak = to.join(&backup_name);
                if !bak.is_file() {
                    fs::copy(&dest, &bak).map_err(|err| {
                        pick(
                            &format!("无法备份原 {hook}：{err}"),
                            &format!("Couldn't back up the original {hook}: {err}"),
                        )
                    })?;
                    ledger.backups.push(ModBackup {
                        file: hook.to_string(),
                        backup: backup_name,
                    });
                }
            }
            fs::copy(&src, &dest).map_err(|err| {
                pick(
                    &format!("无法写入 {}：{err}", dest_name.display()),
                    &format!("Couldn't write {}: {err}", dest_name.display()),
                )
            })?;
            // 相对路径记账（子目录用系统分隔符，卸载时照样 join 得回去）。
            let recorded = dest_name.to_string_lossy().to_string();
            if !ledger.files.contains(&recorded) {
                ledger.files.push(recorded);
            }
        }
        Ok(())
    }

    /// 官方的安装 / 卸载脚本（`setup_windows.bat`、`setup_linux.sh` 等）不进游戏目录。
    fn is_setup_script(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        [".bat", ".cmd", ".ps1", ".sh"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates(launch: &str, install: &str) -> Vec<String> {
        game_dir_candidates(launch, install)
            .into_iter()
            .map(|path| path.display().to_string())
            .collect()
    }

    #[test]
    fn steam_url_launch_path_falls_back_to_install_path() {
        // Steam 游戏的 launch_path 是 `steam://` 地址：老实现直接拿它取 parent，
        // 算出来是个假目录，于是 Steam 用户永远装不上 —— 安装位置必须优先。
        assert_eq!(
            candidates("steam://rungameid/440", r"D:\SteamLibrary\steamapps\common\Portal 2"),
            vec![r"D:\SteamLibrary\steamapps\common\Portal 2".to_string()]
        );
        // 只有 steam:// 时一个候选都没有：不能瞎猜一个目录出来。
        assert!(candidates("steam://rungameid/440", "   ").is_empty());
    }

    #[test]
    fn exe_hints_use_their_folder() {
        // 用 unix 风格路径跑这段逻辑：macOS 上 Windows 路径不会被切成多段，
        // 但「exe 取上一层 / 去重 / 忽略 URL」这几条规则两端一致。
        assert_eq!(
            candidates("/games/hades/hades.exe", ""),
            vec!["/games/hades".to_string()]
        );
        // 库里有时带引号，也要认。
        assert_eq!(
            candidates("\"/games/hades\"", ""),
            vec!["/games/hades".to_string()]
        );
        // 两个提示指向同一个目录时只留一个。
        assert_eq!(
            candidates("/games/hades/hades.exe", "/games/hades"),
            vec!["/games/hades".to_string()]
        );
        // URL 不是路径。
        assert!(candidates("https://example.com/play", "").is_empty());
    }

    #[test]
    fn volume_and_share_roots_are_not_game_folders() {
        assert!(candidates(r"C:\", "").is_empty());
        assert!(candidates(r"\\server\share", "").is_empty());
        assert!(candidates("/", "").is_empty());
        // 盘里的真目录照常（文本判断两端一致）。
        assert_eq!(candidates(r"D:\Games", ""), vec![r"D:\Games".to_string()]);
    }

    #[test]
    fn resolve_prefers_the_directory_that_exists() {
        let root = std::env::temp_dir().join("fh-toolbox-resolve-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp dir");
        let real = root.to_string_lossy().to_string();
        let missing = root.join("nope").to_string_lossy().to_string();

        assert_eq!(
            resolve_game_dir("steam://rungameid/1", &real),
            Some(root.clone())
        );
        assert_eq!(resolve_game_dir(&real, &missing), Some(root.clone()));
        assert_eq!(resolve_game_dir(&missing, ""), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn hook_names_are_canonicalised() {
        assert_eq!(canonical_hook(""), Some(OPTISCALER_DEFAULT_HOOK));
        assert_eq!(canonical_hook("DXGI.DLL"), Some("dxgi.dll"));
        assert_eq!(canonical_hook(" winmm.dll "), Some("winmm.dll"));
        // 不认识的名字不能当文件名用。
        assert_eq!(canonical_hook("evil.exe"), None);
    }

    /// 拼一个最小的 PE 头：MZ + e_lfanew 指向 PE 签名 + machine。
    fn pe_bytes(machine: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 0x100];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x82].copy_from_slice(b"PE");
        bytes[0x84..0x86].copy_from_slice(&machine.to_le_bytes());
        bytes
    }

    #[test]
    fn detects_only_x64_pe_files() {
        assert_eq!(pe_is_x64(&pe_bytes(0x8664)), Some(true));
        // 32 位游戏的 exe：装进去只会让游戏起不来，必须挡住。
        assert_eq!(pe_is_x64(&pe_bytes(0x014c)), Some(false));
        assert_eq!(pe_is_x64(&pe_bytes(0xaa64)), Some(false));
        assert_eq!(pe_is_x64(b"MZ"), None);
        assert_eq!(pe_is_x64(b"not a pe file at all"), None);
    }

    #[test]
    fn manifest_survives_a_round_trip() {
        let manifest = ModManifest {
            version: "0.9.4".into(),
            hook: "winmm.dll".into(),
            installed_at: 1,
            files: vec!["winmm.dll".into(), r"D3D12_Optiscaler\amd.dll".into()],
            backups: vec![ModBackup {
                file: "winmm.dll".into(),
                backup: "winmm.dll.fantasyhub.bak".into(),
            }],
            dirs: vec!["D3D12_Optiscaler".into()],
        };
        let json = serde_json::to_string(&manifest).expect("serialize");
        assert!(json.contains("installedAt"), "camelCase for the frontend: {json}");
        assert_eq!(serde_json::from_str::<ModManifest>(&json).ok(), Some(manifest));
        // 以后加字段时，旧账本（只有必填两项）也要能读进来。
        let old = r#"{"version":"0.9.0","hook":"dxgi.dll"}"#;
        let parsed = serde_json::from_str::<ModManifest>(old).expect("legacy manifest");
        assert!(parsed.files.is_empty() && parsed.backups.is_empty() && parsed.dirs.is_empty());
    }
}
