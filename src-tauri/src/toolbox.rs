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

/// 自带版 OptiScaler（用户自己构建的那一份，随启动器一起发出去）。
///
/// 为什么要有它：**官方包里的 `amd_fidelityfx_upscaler_dx12.dll` 是旧的 FSR 放大器**，而
/// FSR 4.1.1 只取决于这一个文件；用户自己构建了一份完整包（官方 v0.9.4 的文件清单 + 这个
/// DLL），要求「装的时候优先装它」。随包发出去的好处是**掌机上不用联网**、也永远是他那一版。
/// 面板上它排第一、默认选中；包不在（`build.rs` 落的是空占位）时整条自动消失，退回只列官方版本。
pub const OPTISCALER_BUNDLED_TAG: &str = "bundled";
/// 自带版压缩包在 resources 里的相对路径。`tauri.conf.json` 的 `bundle.resources` 与
/// `build.rs` 的占位用的都是它 —— 三处改名必须一起改。
pub const OPTISCALER_BUNDLED_FILE: &str = "optiscaler/OptiScaler-custom.7z";
/// 包里 `OptiScaler.dll` 自己的版本是 v0.9.4，放大器是 FSR 4.1.1 —— 账本与界面上就写这个。
pub const OPTISCALER_BUNDLED_VERSION: &str = "0.9.4-fsr4.1.1";
/// 「支不支持 FSR 4.1.1」到底取决于哪个文件。缺了它 OptiScaler 只能跑到旧的 FSR 4，
/// 所以这一条**装前查包、装后查游戏目录**，两处都留下证据 —— 不靠文案里写一句「支持」。
pub const FSR4_UPSCALER_DLL: &str = "amd_fidelityfx_upscaler_dx12.dll";

/// 自带版包在哪儿。`resource_dir()` 是安装包里的落点；`cargo run`（`target/debug/resources`）
/// 与手工解包（exe 旁边）各留一条候选 —— 与 `startup.rs::fse_payload` 同一套顺序。
///
/// **空文件 = 没带**（`build.rs` 在没有真包时落的是 0 字节占位）：宁可这一条在界面上消失，
/// 也不能拿一个空包去装。
pub fn bundled_archive(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(OPTISCALER_BUNDLED_FILE));
        candidates.push(dir.join("OptiScaler-custom.7z"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join(OPTISCALER_BUNDLED_FILE));
            candidates.push(parent.join("OptiScaler-custom.7z"));
        }
    }
    candidates.into_iter().find(|path| is_real_package(path))
}

/// 真的是一份包才认：存在，且**大于 1 MB**（占位是 0 字节；一个被截断的残包也不该被当成自带版）。
fn is_real_package(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.len() > 1024 * 1024)
        .unwrap_or(false)
}

/// 面板上的版本列表：自带版排第一（有才排），官方那些照旧。
///
/// 抽成纯函数是为了在本机（macOS）钉住「自带版优先」这条顺序 —— Windows 那半边编不到。
fn bundled_first(mut official: Vec<ModVersion>, bundled_bytes: Option<u64>) -> Vec<ModVersion> {
    if let Some(bytes) = bundled_bytes {
        official.insert(
            0,
            ModVersion {
                version: OPTISCALER_BUNDLED_VERSION.to_string(),
                tag: OPTISCALER_BUNDLED_TAG.to_string(),
                bytes,
                latest: false,
                bundled: true,
            },
        );
    }
    official
}

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
    /// 这个游戏目录里**试过**哪些注入名（含当前这个）。换名字重装会接着记，
    /// 所以能算出「下一个该试哪个」—— 用户不必自己记，也不必等我们改代码。
    #[serde(default)]
    pub tried: Vec<String>,
    /// 装进去的文件里有没有 FSR 4.1.1 的放大器（`amd_fidelityfx_upscaler_dx12.dll`）。
    /// 记下来是为了让面板能如实说「这一套装的支持 4.1.1」—— 而不是靠版本名猜。
    #[serde(default)]
    pub fsr4: bool,
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
    /// 文件落点：**主程序 exe 所在目录**（官方要求装这儿，不是游戏根目录）。
    /// 找不到游戏目录时是 None（Steam 游戏没设过路径时就是这种）。
    pub dir: Option<String>,
    /// 主程序 exe 的文件名。None = 没认出主程序，这次会装到游戏根目录兜底。
    pub exe: Option<String>,
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
    /// 这个游戏**会加载**的注入名（读它自己的 PE 导入表得出，按官方优先顺序）。
    /// 空 = 从导入表看不出来（照官方顺序试）。这是「不用按游戏打表」的那条正路。
    pub hook_candidates: Vec<String>,
    /// 面板该默认选哪个：会加载的名字里的第一个，认不出就是官方默认 `dxgi.dll`。
    pub default_hook: String,
    /// 已经试过（没成功）的注入名，账本里记着。
    pub tried_hooks: Vec<String>,
    /// 下次该试哪个（没试过的、且不是当前这个）；全试完了就是 None。
    pub suggested_hook: Option<String>,
    /// 上次装完之后，游戏跑起来**加载到了** OptiScaler 吗（看 `OptiScaler.log` 有没有新出现）。
    /// 这是唯一能自动判定「到底生效没有」的信号，装了必开日志（见 `enable_log`）。
    pub log_seen: bool,
    /// 装着的那一套里有没有 FSR 4.1.1 的放大器（`amd_fidelityfx_upscaler_dx12.dll`）——
    /// 面板据此如实说「支持 4.1.1 / 只是旧 FSR 4」，不看版本名猜。
    pub fsr4: bool,
    pub message: String,
}

/// 面板上能选的一个版本。`tag` 是 GitHub 上的标签（`v0.9.4`），安装时按它去查；
/// 自带版是个例外：`tag` 是 `bundled`，安装时直接用随包的那个压缩包，不联网。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModVersion {
    pub version: String,
    pub tag: String,
    pub bytes: u64,
    pub latest: bool,
    /// 是不是随启动器一起发出去的自带版（带 FSR 4.1.1 放大器那一份）。
    pub bundled: bool,
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
    installed_mods(games)
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

/// 能装的版本列表（自带版排第一，然后官方最近的几个）。
///
/// 要 `AppHandle` 是为了找**随包的自带版**（`bundled_archive`）：它在 resources 里，
/// 跟官方那些要走网络的版本不是一回事。
#[tauri::command]
pub async fn toolbox_optiscaler_versions(app: tauri::AppHandle) -> Vec<ModVersion> {
    crate::off_main(move || toolbox_optiscaler_versions_now(&app))
        .await
        .unwrap_or_default()
}

fn toolbox_optiscaler_versions_now(app: &tauri::AppHandle) -> Vec<ModVersion> {
    let bundled_bytes = bundled_archive(app)
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len());
    #[cfg(windows)]
    {
        return bundled_first(windows::optiscaler_versions(), bundled_bytes);
    }
    #[cfg(not(windows))]
    {
        bundled_first(Vec::new(), bundled_bytes)
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
            exe: None,
            installed: false,
            version: None,
            hook: None,
            legacy: false,
            conflict: None,
            arch: None,
            running: false,
            hooks: hook_list(),
            hook_candidates: Vec::new(),
            default_hook: OPTISCALER_DEFAULT_HOOK.to_string(),
            tried_hooks: Vec::new(),
            suggested_hook: None,
            log_seen: false,
            // 非 Windows 分支永远走不到安装，永远没有 FSR 4.1.1 放大器。
            fsr4: false,
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
            exe: None,
            installed: false,
            version: None,
            hook: None,
            legacy: false,
            conflict: None,
            arch: None,
            running: false,
            hooks: hook_list(),
            hook_candidates: Vec::new(),
            default_hook: OPTISCALER_DEFAULT_HOOK.to_string(),
            tried_hooks: Vec::new(),
            suggested_hook: None,
            log_seen: false,
            fsr4: false,
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

/// 一次安装的落点。
///
/// 官方口径（Wiki「Manual Installation」第 1 条，`setup_windows.bat` 里也再提示了一遍）：
/// **把压缩包里的全部文件解压到「主程序 exe 所在目录」**，不是游戏根目录。
/// 主程序在子目录的游戏很常见 —— UE 是 `<游戏>\<代号>\Binaries\Win64\<代号>-Win64-Shipping.exe`
/// （官方脚本原话：「Found Engine folder. If this is an Unreal Engine game, then please extract
/// Optiscaler to #CODENAME#\Binaries\Win64」，例子 `\Jedi Survivor\SwGame\Binaries\Win64`），
/// 另外还有 Cyberpunk 的 `bin\x64`、HITMAN 3 的 `Retail` 这类。
///
/// 主程序在子目录时把 `dxgi.dll` 丢进游戏根目录，游戏根本不会去加载它：
/// 表现就是「装完了、进游戏按 Insert 没反应」。2026-10-04 真机反馈的「没装成功」
/// 就是这一条（旧实现只认扫描出来的 `install_path`，而它就是游戏根目录）。
#[derive(Debug, Clone, PartialEq)]
pub struct InstallPlan {
    /// 文件落点：主程序 exe 所在目录。
    pub dir: PathBuf,
    /// 主程序 exe（认不出就是 None）：位数检查读它，面板也显示它。
    pub exe: Option<PathBuf>,
    /// 游戏根目录。0.1.5x 的安装记录写在根目录，卸载时要回查一遍。
    pub root: PathBuf,
}

/// 算出这次该装到哪个目录（见 `InstallPlan`）。
#[cfg_attr(not(windows), allow(dead_code))]
fn install_plan(launch_path: &str, install_path: &str) -> Option<InstallPlan> {
    let root = resolve_game_dir(launch_path, install_path)?;
    // 主程序优先在游戏目录里按官方规则找；认不出才退回启动路径里那个 exe。
    let exe = main_game_exe(&root).or_else(|| {
        let hinted = PathBuf::from(launch_path.trim().trim_matches('"'));
        (is_exe_path(&hinted) && hinted.is_file()).then_some(hinted)
    });
    let dir = exe
        .as_deref()
        .and_then(Path::parent)
        .filter(|dir| dir.is_dir())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.clone());
    Some(InstallPlan { dir, exe, root })
}

/// UE 的主程序在第 3 层（`<游戏>\<代号>\Binaries\Win64`），再深就基本是工具 / 运行库了。
#[cfg_attr(not(windows), allow(dead_code))]
const MAIN_EXE_DEPTH: usize = 4;

/// 主程序 = 官方认的那个 exe。
///
/// 打分顺序照官方文档来：先认 UE 的 `*-Win64-Shipping.exe` / `*-WinGDK-Shipping.exe`
/// （`setup_windows.bat` 就是拿这两个名字去匹配支持列表的），再看名字跟游戏目录对不对得上，
/// 最后才是体积最大的那个（大多数游戏的主程序就是最大的 exe）。
/// `Engine` 这类目录直接不进（官方文档专门强调 UE 要忽略 `Engine`）。
#[cfg_attr(not(windows), allow(dead_code))]
fn main_game_exe(root: &Path) -> Option<PathBuf> {
    let hints = name_hints(root);
    let mut best: Option<(i32, u64, PathBuf)> = None;
    let mut found = Vec::new();
    walk_exes(root, MAIN_EXE_DEPTH, &mut found);
    for exe in found {
        let size = std::fs::metadata(&exe).map(|meta| meta.len()).unwrap_or(0);
        let score = score_main_exe(&exe, &hints);
        let better = match &best {
            Some((best_score, best_size, _)) => (score, size) > (*best_score, *best_size),
            None => true,
        };
        if better {
            best = Some((score, size, exe));
        }
    }
    best.map(|(_, _, exe)| exe)
}

/// 打分用的名字线索：游戏目录名（Steam 那边一般就是游戏名）＋ 它的首字母缩写。
///
/// 为什么要有缩写：不少游戏的主程序就叫缩写 —— 大镖客 2 是 `RDR2.exe`，
/// 而目录名是 `Red Dead Redemption 2`，只比全名一个都对不上，最后只能靠体积决胜，
/// 于是同目录里的安装器（`Social-Club-Setup.exe`）被选了进来。
#[cfg_attr(not(windows), allow(dead_code))]
fn name_hints(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Some(name) = root.file_name() else {
        return out;
    };
    let raw = name.to_string_lossy().to_string();
    let folded = fold_text(&raw);
    // 「games」「common」这类通用名不是线索，留着只会把杂七杂八的 exe 抬上来。
    if folded.len() >= 4 && !GENERIC_DIRS.contains(&folded.as_str()) {
        out.push(folded);
    }
    let acronym = acronym_of(&raw);
    // 缩写太短（1 个字母）就别当线索，否则能把半个目录的 exe 都匹配上。
    if acronym.len() >= 2 && !out.contains(&acronym) {
        out.push(acronym);
    }
    out
}

/// 目录名按词取首字母：`Red Dead Redemption 2` → `rdr2`，`GTA V` → `gtav`。
/// 已经是大写的词整段留下（`GTA` 不该被压成 `g`），纯数字词也一样（`… 2` → `…2`）。
#[cfg_attr(not(windows), allow(dead_code))]
fn acronym_of(value: &str) -> String {
    let mut out = String::new();
    for word in value.split(|c: char| !c.is_ascii_alphanumeric()) {
        if word.is_empty() {
            continue;
        }
        let lower = word.to_ascii_lowercase();
        let digits_only = lower.chars().all(|c| c.is_ascii_digit());
        let all_caps = word.len() > 1
            && word
                .chars()
                .all(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase());
        if digits_only || all_caps {
            out.push_str(&lower);
        } else if let Some(first) = lower.chars().next() {
            out.push(first);
        }
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
const GENERIC_DIRS: [&str; 6] = [
    "games",
    "steamapps",
    "common",
    "programfiles",
    "programfilesx86",
    "goggames",
];

/// 装 Mod 时不该被当成「主程序所在目录」的目录名（引擎自带工具 / 安装器 / 运行库）。
#[cfg_attr(not(windows), allow(dead_code))]
const NOISE_DIRS: [&str; 13] = [
    "engine",
    "redist",
    "redistributables",
    "_commonredist",
    "directx",
    "dotnet",
    "support",
    "crashpad",
    "tools",
    "editor",
    "installers",
    "prerequisites",
    "prereqs",
];

/// 只留字母数字并转小写：`Cyberpunk 2077` → `cyberpunk2077`。
#[cfg_attr(not(windows), allow(dead_code))]
fn fold_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn score_main_exe(path: &Path, hints: &[String]) -> i32 {
    let stem = fold_text(
        &path
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    if stem.is_empty() {
        return 0;
    }
    let mut score = 0;
    // 官方点名的 UE 主程序（`setup_windows.bat`：`<代号>-win64-shipping.exe` / `-wingdk-shipping.exe`）。
    if stem.contains("shipping") {
        score += 400;
    }
    // 名字跟游戏目录（或它的缩写）**一模一样**最可信：`RDR2.exe` 对 `Red Dead Redemption 2`。
    if hints.iter().any(|hint| !hint.is_empty() && *hint == stem) {
        score += 300;
    } else if hints
        .iter()
        .any(|hint| !hint.is_empty() && (hint.contains(&stem) || stem.contains(hint)))
    {
        score += 200;
    }
    // 官方给 UE 指的那一层（`Binaries\Win64` / `WinGDK`）。
    let parent = path
        .parent()
        .and_then(|dir| dir.file_name())
        .map(|name| fold_text(&name.to_string_lossy()))
        .unwrap_or_default();
    if parent == "win64" || parent == "wingdk" {
        score += 100;
    }
    score
}

/// 递归收集候选 exe：跳过 `Engine` 这类目录，也别把卸载器 / 崩溃处理器当主程序。
#[cfg_attr(not(windows), allow(dead_code))]
fn walk_exes(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten().take(120) {
        if out.len() >= 200 {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            let name = fold_text(
                &path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
            if depth == 0 || NOISE_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_exes(&path, depth - 1, out);
            continue;
        }
        if is_exe_path(&path) && !is_noise_exe(&path) {
            out.push(path);
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_noise_exe(path: &Path) -> bool {
    let stem = fold_text(
        &path
            .file_stem()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    // 名字里带这些词的一律不是游戏主程序（安装器 / 运行库 / 社交客户端安装包）。
    // `socialclub` 与 `setup` 是 2026-10-10 补的：大镖客 2 目录里躺着 Rockstar 的
    // `Social-Club-Setup.exe`，体积比 `RDR2.exe` 还大，当时只按「整名等于 setup」判，
    // 于是它被当成主程序 —— 文件全装到 `Redistributables\` 里去了，游戏当然不加载。
    const NOISE_PARTS: [&str; 7] = [
        "setup",
        "install",
        "socialclub",
        "redist",
        "unins",
        "vcredist",
        "crashhandler",
    ];
    // 这几个用前缀认：后面常跟版本 / 位数（`crashreporter64`、`dotnet48`）。
    const NOISE_PREFIXES: [&str; 3] = ["crashreporter", "crashpadhandler", "dotnet"];
    NOISE_PARTS.iter().any(|part| stem.contains(part))
        || NOISE_PREFIXES.iter().any(|name| stem.starts_with(name))
}

// ---------------------------------------------------------------------------
// 注入名怎么选（读游戏自己的 PE 导入表）
//
// 这是「换一个游戏就出一次问题」的正解：OptiScaler 是**代理 DLL**，只有当游戏真的加载了
// 那个名字的 DLL 时才生效。与其让用户把 7 个官方名字轮流试一遍（大镖客 2 就是 dxgi.dll
// 不加载、winmm.dll 才加载），不如直接读游戏自己的导入表 —— 它 import 了哪个，哪个就一定
// 会在进程启动时被加载，我们顶上去就能生效。这样不需要任何「按游戏名打表」的知识，
// 也不需要在用户报 bug 之后一版一版地补。
// ---------------------------------------------------------------------------

#[cfg_attr(not(windows), allow(dead_code))]
fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// 读 PE 的**导入表**：这个 exe / dll 一启动，Windows 会连带加载哪些 DLL（小写、去重）。
///
/// 自己解析是因为要的是「按文件事实决定」，而不是猜：结果与 `objdump -p` 的输出逐个核对过
/// （PE32 的 7zr.exe 与 PE32+ 的 handle64.exe 各一个）。任何解析不出来的情况都返回空 ——
/// 认不出就不说话，绝不让一个坏文件把安装流程带进坑里。
#[cfg_attr(not(windows), allow(dead_code))]
fn pe_imports(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return out;
    }
    let lfanew = u32_at(bytes, 0x3c).unwrap_or(0) as usize;
    if bytes.get(lfanew..lfanew + 4) != Some(b"PE\0\0") {
        return out;
    }
    let coff = lfanew + 4;
    let sections = u16_at(bytes, coff + 2).unwrap_or(0) as usize;
    let opt_size = u16_at(bytes, coff + 16).unwrap_or(0) as usize;
    let opt = coff + 20;
    // 数据目录的起点随 PE32 / PE32+ 变；导入表是第 2 项（索引 1）。
    let dir = match u16_at(bytes, opt).unwrap_or(0) {
        0x10b => opt + 96,
        0x20b => opt + 112,
        _ => return out,
    };
    let import_rva = u32_at(bytes, dir + 8).unwrap_or(0) as usize;
    if import_rva == 0 {
        return out;
    }
    let section_table = opt + opt_size;
    let rva_to_offset = |rva: usize| -> Option<usize> {
        for index in 0..sections {
            let head = section_table + index * 40;
            let virtual_size = u32_at(bytes, head + 8)? as usize;
            let virtual_address = u32_at(bytes, head + 12)? as usize;
            let raw_size = u32_at(bytes, head + 16)? as usize;
            let raw = u32_at(bytes, head + 20)? as usize;
            let span = virtual_size.max(raw_size);
            if rva >= virtual_address && rva < virtual_address + span {
                return Some(rva - virtual_address + raw);
            }
        }
        None
    };
    let Some(mut descriptor) = rva_to_offset(import_rva) else {
        return out;
    };
    // 描述符数组以全 0 结束；上限 64 个只是防坏文件跑飞。
    for _ in 0..64 {
        if (0..5).all(|index| u32_at(bytes, descriptor + index * 4).unwrap_or(0) == 0) {
            break;
        }
        let name_rva = u32_at(bytes, descriptor + 12).unwrap_or(0) as usize;
        if let Some(offset) = rva_to_offset(name_rva) {
            let end = bytes[offset..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|len| offset + len)
                .unwrap_or(offset);
            let name = String::from_utf8_lossy(&bytes[offset..end])
                .trim()
                .to_ascii_lowercase();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
        descriptor += 20;
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn read_pe_imports(path: &Path, cap: u64) -> Vec<String> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if meta.len() > cap {
        return Vec::new();
    }
    match std::fs::read(path) {
        Ok(bytes) => pe_imports(&bytes),
        Err(_) => Vec::new(),
    }
}

/// 主程序可以有几百 MB（大镖客 2 的 RDR2.exe 就是），同目录的 DLL 只给到 32 MB。
#[cfg_attr(not(windows), allow(dead_code))]
const EXE_IMPORT_CAP: u64 = 512 * 1024 * 1024;
#[cfg_attr(not(windows), allow(dead_code))]
const DLL_IMPORT_CAP: u64 = 32 * 1024 * 1024;

/// 从一堆导入名里挑出「我们支持的注入名」，按官方优先顺序（dxgi 优先）。
#[cfg_attr(not(windows), allow(dead_code))]
fn hook_candidates_in(imports: &[String]) -> Vec<&'static str> {
    OPTISCALER_HOOKS
        .iter()
        .copied()
        .filter(|hook| {
            imports
                .iter()
                .any(|name| name.eq_ignore_ascii_case(hook))
        })
        .collect()
}

/// 这个游戏**会加载**的注入名（按官方优先顺序）；空 = 从导入表看不出来。
///
/// 先看主程序；主程序看不出来再看同目录的 DLL —— Unity 那种壳 exe 自己不碰图形 API，
/// 真正 import `dxgi.dll` 的是 `UnityPlayer.dll`，只看 exe 会误判成「认不出」。
/// 扫 DLL 时要跳过**我们自己装进去的文件**（尤其是改名后的那个注入名本身），
/// 否则会拿我们自己的文件当证据，越装越「自信」。
#[cfg_attr(not(windows), allow(dead_code))]
fn hook_candidates(dir: &Path, exe: Option<&Path>, installed: &[String]) -> Vec<&'static str> {
    let mut imports: Vec<String> = Vec::new();
    if let Some(exe) = exe {
        imports.extend(read_pe_imports(exe, EXE_IMPORT_CAP));
    }
    let mut found = hook_candidates_in(&imports);
    if !found.is_empty() {
        return found;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten().take(80) {
        let path = entry.path();
        if !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"))
        {
            continue;
        }
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
            continue;
        };
        if OPTISCALER_HOOKS
            .iter()
            .any(|hook| name.eq_ignore_ascii_case(hook))
            || installed
                .iter()
                .any(|file| file.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        imports.extend(read_pe_imports(&path, DLL_IMPORT_CAP));
        found = hook_candidates_in(&imports);
        if !found.is_empty() {
            break;
        }
    }
    found
}

/// 下一个该试的注入名：先在这个游戏会加载的名字里找没试过的，再退回官方顺序。
/// 「试过哪些」记在账本里，所以换名字重装不会把历史丢掉 —— 用户不用自己记。
#[cfg_attr(not(windows), allow(dead_code))]
fn next_hook_to_try(
    candidates: &[&'static str],
    tried: &[String],
    current: Option<&str>,
) -> Option<&'static str> {
    let untried = |hook: &'static str| {
        !tried.iter().any(|done| done.eq_ignore_ascii_case(hook))
            && Some(hook) != current
    };
    candidates
        .iter()
        .copied()
        .find(|hook| untried(hook))
        .or_else(|| OPTISCALER_HOOKS.iter().copied().find(|hook| untried(hook)))
}

// ---------------------------------------------------------------------------
// 安装账本（纯文件操作）
//
// 为什么这部分不在 `mod windows` 里：装 Mod 的实际落点是 Windows 专属的事，但
// 「账本记了什么、卸载去哪儿找」是纯 `std::fs` + serde 的逻辑 —— 放在外面本机
// （macOS）就能跑单测。这一步很值：账本在游戏根目录那批（0.1.5x 装错位置的）
// 能不能被新版正确卸载、还原，全靠这里。
// ---------------------------------------------------------------------------

#[cfg_attr(not(windows), allow(dead_code))]
fn marker_present(dir: &Path) -> bool {
    dir.join(OPTISCALER_MARKER).is_file()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(OPTISCALER_MANIFEST)
}

/// 账本读不出来（文件坏了 / 是别的东西）就当没有：宁可按「没记录」报错，也不乱删文件。
#[cfg_attr(not(windows), allow(dead_code))]
fn read_manifest(dir: &Path) -> Option<ModManifest> {
    let text = std::fs::read_to_string(manifest_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn write_manifest(dir: &Path, manifest: &ModManifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|err| {
        pick(
            &format!("无法生成安装记录：{err}"),
            &format!("Couldn't write the install record: {err}"),
        )
    })?;
    std::fs::write(manifest_path(dir), text).map_err(|err| {
        pick(
            &format!("无法写入安装记录：{err}"),
            &format!("Couldn't save the install record: {err}"),
        )
    })
}

/// 读安装账本：先看主程序旁（新版写这儿），再回查游戏根目录（0.1.5x 装错位置那批）。
/// 返回值里带上「账本是在哪个目录找到的」：账本记的是相对路径，卸载要照那个目录拼。
#[cfg_attr(not(windows), allow(dead_code))]
fn read_installed(plan: &InstallPlan) -> Option<(ModManifest, PathBuf)> {
    [&plan.dir, &plan.root]
        .into_iter()
        .find_map(|dir| read_manifest(dir).map(|manifest| (manifest, dir.clone())))
}

/// 只有旧版纯文本标记（没有账本）的安装：主程序旁和游戏根目录都查。
#[cfg_attr(not(windows), allow(dead_code))]
fn legacy_installed(plan: &InstallPlan) -> bool {
    marker_present(&plan.dir) || marker_present(&plan.root)
}

/// OptiScaler 的日志文件名（INI 里 `LogFileName=auto` 的默认值：主程序旁的那个文件）。
#[cfg_attr(not(windows), allow(dead_code))]
const OPTISCALER_LOG: &str = "OptiScaler.log";

/// 「上次装完之后，游戏跑起来到底加载到 OptiScaler 没有」—— 就看日志有没有**新**出现。
///
/// 这是整个流程里唯一能自动判定成败的信号：OptiScaler 是被游戏加载才会写日志的，
/// 加载不上就什么都没有。安装时会先把老日志删掉，所以「有新日志」= 这次真的加载上了。
/// （日志默认是关的，`enable_log` 负责打开。）
#[cfg_attr(not(windows), allow(dead_code))]
fn log_since(dir: &Path, manifest: Option<&ModManifest>) -> bool {
    let Some(installed_at) = manifest.map(|found| found.installed_at) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(dir.join(OPTISCALER_LOG)) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    millis >= installed_at
}

/// 把 `OptiScaler.ini` 的 `LogToFile=` 打开（只动这一行，其余字节连 CRLF 一起原样保留）。
///
/// 为什么非开不可：日志是唯一能自动判断「DLL 有没有被游戏加载」的东西。没有它，用户只能靠
/// 「按 Insert 没反应」猜，我们也只能等用户报 bug 才知道装没装上 —— 那样每换一个游戏都要走
/// 一轮「用户报 bug → 开发者改代码」，这正是要避免的。
/// 用户自己写死的 `true` / `false` 一律尊重，只改默认的 `auto`（缺这一行时补一行）。
#[cfg_attr(not(windows), allow(dead_code))]
fn enable_log(dir: &Path) -> bool {
    let path = dir.join("OptiScaler.ini");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let mut out = String::with_capacity(text.len() + 16);
    let mut done = false;
    let mut rest = text.as_str();
    while let Some(pos) = rest.find('\n') {
        let (line, tail) = rest.split_at(pos + 1);
        out.push_str(&rewrite_log_line(line, &mut done));
        rest = tail;
    }
    out.push_str(&rewrite_log_line(rest, &mut done));
    if !done {
        out.push_str("LogToFile=true\r\n");
    }
    std::fs::write(&path, out).is_ok()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn rewrite_log_line(line: &str, done: &mut bool) -> String {
    let trimmed = line.trim_start();
    if *done || !trimmed.to_ascii_lowercase().starts_with("logtofile=") {
        return line.to_string();
    }
    *done = true;
    let value = trimmed
        .split_once('=')
        .map(|(_, value)| value)
        .unwrap_or("")
        .trim();
    if !value.is_empty() && !value.eq_ignore_ascii_case("auto") {
        return line.to_string();
    }
    let indent = &line[..line.len() - trimmed.len()];
    let ending = if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    format!("{indent}LogToFile=true{ending}")
}

/// 找出游戏目录里「账本不在当前落点」的那些目录 —— 老版本装错位置留下的（0.1.58–0.1.66
/// 把文件铺在游戏根目录、或铺在 Social-Club-Setup.exe 所在的 `Redistributables\`）。
///
/// 为什么要在装之前扫一遍：落点一改，那些账本**新版再也找不到**（卸载只认落点和游戏根目录），
/// 于是它们连同几十上百 MB 的 `libxess*.dll` 一起烂在游戏目录里，备份也永远还原不回去。
/// 这里只认**我们自己的账本文件**，清的时候也只删账本里记过的路径，不碰游戏自己的东西。
#[cfg_attr(not(windows), allow(dead_code))]
fn stale_install_dirs(root: &Path, keep: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk_manifests(root, 3, &mut found);
    found.into_iter().filter(|dir| dir != keep).collect()
}

/// 找出所有带账本的目录。**故意不跳 `NOISE_DIRS`**：用户那台机器上的旧账本恰好就在
/// `Redistributables\` 里，跳掉就永远清不掉了。
#[cfg_attr(not(windows), allow(dead_code))]
fn walk_manifests(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= 50 {
        return;
    }
    if manifest_path(dir).is_file() {
        out.push(dir.to_path_buf());
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten().take(200) {
        let path = entry.path();
        if path.is_dir() {
            walk_manifests(&path, depth - 1, out);
        }
    }
}

/// 「这个游戏装了 OptiScaler 吗」—— 给游戏卡片上那颗图标用（用户 2026-10-12 要求
/// 「哪个游戏装了、哪个没装都没显示，你不如在游戏的卡片上加一个图标」）。
///
/// 判据必须是**我们自己的账本 / 旧版标记**，不能是「目录里有没有 `dxgi.dll`」：
/// 那个文件名 DXVK、ReShade、游戏自带的代理 DLL 都在用，按文件名判会给一堆没装过的游戏
/// 也标上图标 —— 标错比不标更糟（用户按图标去开 FSR，结果什么都没有）。
///
/// 三个落点都查：账本（新）、目标目录里的旧标记、游戏根目录里的旧标记（0.1.5x 那批）。
/// 不查版本号 —— 卡片上只要一个「有 / 没有」。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn game_has_mod(launch_path: &str, install_path: &str) -> bool {
    let Some(plan) = install_plan(launch_path, install_path) else {
        return false;
    };
    read_installed(&plan).is_some() || marker_present(&plan.dir) || marker_present(&plan.root)
}

/// 列出装了 OptiScaler 的游戏：账本优先；只有旧版标记（没账本）的也列出来，
/// 版本写空串 —— 「装了但不知道装的哪版」是真实状态，不编一个版本号。
#[cfg_attr(not(windows), allow(dead_code))]
fn installed_mods(games: Vec<crate::scan::ScannedGame>) -> Vec<InstalledMod> {
    let mut out = Vec::new();
    for game in games {
        let Some(plan) = install_plan(&game.launch_path, &game.install_path) else {
            continue;
        };
        // 报**真实所在**的那个目录：老安装（0.1.5x 把文件铺在游戏根目录那批）要是报主程序旁，
        // 就把用户指到一个空目录去了。
        let (dir, version, hook) = match read_installed(&plan) {
            Some((row, where_)) => (where_, row.version, row.hook),
            None if marker_present(&plan.dir) => (plan.dir.clone(), String::new(), String::new()),
            None if marker_present(&plan.root) => (plan.root.clone(), String::new(), String::new()),
            None => continue,
        };
        out.push(InstalledMod {
            game: game.name,
            dir: dir.display().to_string(),
            version,
            hook,
        });
    }
    out
}

/// 这次重装能不能把目标目录里那个同名 DLL 当成「我们自己上次装的」。
///
/// 必须「账本就在这个目录里」且「注入名相同」两条都满足 —— 否则 `<hook>.fantasyhub.bak`
/// 里存的那份**游戏原文件**会被上一轮的 OptiScaler 覆盖掉，从此再也还原不回来。
/// 账本记在游戏根目录那批（0.1.5x）落点不同，目标目录里的同名文件是游戏自己的，不算我们的。
#[cfg_attr(not(windows), allow(dead_code))]
fn keeps_previous_backup(
    previous: Option<&(ModManifest, PathBuf)>,
    hook: &str,
    dir: &Path,
) -> bool {
    previous.is_some_and(|(found, where_)| found.hook == hook && where_ == dir)
}

/// 按账本卸载：先删我们写的文件（有备份的路径留给还原），再还原备份，最后删空目录。
#[cfg_attr(not(windows), allow(dead_code))]
fn remove_installed_files(dir: &Path, manifest: &ModManifest) -> Result<(), String> {
    let restored: Vec<&str> = manifest
        .backups
        .iter()
        .map(|backup| backup.file.as_str())
        .collect();
    for file in &manifest.files {
        // 有备份的文件不能删：下一步会用备份覆盖回去。
        if restored.contains(&file.as_str()) {
            continue;
        }
        let target = dir.join(file);
        if target.is_file() {
            let _ = std::fs::remove_file(&target);
        }
    }
    for backup in &manifest.backups {
        let saved = dir.join(&backup.backup);
        let target = dir.join(&backup.file);
        if saved.is_file() {
            std::fs::copy(&saved, &target).map_err(|err| {
                pick(
                    &format!("无法还原 {}：{err}", backup.file),
                    &format!("Couldn't restore {}: {err}", backup.file),
                )
            })?;
            let _ = std::fs::remove_file(&saved);
        }
    }
    // 目录倒序删（先深后浅），且只在空的时候删 —— 里面有自己的东西就留着。
    let mut dirs = manifest.dirs.clone();
    dirs.sort_by_key(|path| std::cmp::Reverse(path.matches(['/', '\\']).count()));
    for sub in dirs {
        let _ = std::fs::remove_dir(dir.join(sub));
    }
    let _ = std::fs::remove_file(manifest_path(dir));
    let _ = std::fs::remove_file(dir.join(OPTISCALER_MARKER));
    Ok(())
}

/// 旧版（只有纯文本标记）的清理：先还原备份；没备份就删掉标记里记的那个注入 DLL
/// —— 标记还在，说明那个 DLL 是我们放的，删它不会动游戏自带文件。
#[cfg_attr(not(windows), allow(dead_code))]
fn legacy_cleanup(dir: &Path) -> Result<(), String> {
    for hook in OPTISCALER_HOOKS {
        let backup = dir.join(format!("{hook}.fantasyhub.bak"));
        if backup.is_file() {
            let _ = std::fs::copy(&backup, dir.join(hook));
            let _ = std::fs::remove_file(&backup);
        }
    }
    let marker = dir.join(OPTISCALER_MARKER);
    let hook = std::fs::read_to_string(&marker)
        .ok()
        .map(|text| text.trim().to_string());
    if let Some(hook) = hook.filter(|name| !name.is_empty() && !name.contains(['/', '\\'])) {
        let target = dir.join(&hook);
        if target.is_file() {
            let _ = std::fs::remove_file(&target);
        }
    }
    let _ = std::fs::remove_file(dir.join("OptiScaler.ini"));
    let _ = std::fs::remove_file(&marker);
    Ok(())
}

/// 所选注入名在游戏目录里已存在、而且不是我们装的 → 报给前端，让用户改选或知情。
/// 已经有 `.fantasyhub.bak` 说明上一轮处理过它，不再当冲突。
#[cfg_attr(not(windows), allow(dead_code))]
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

        let cache = crate::net::cache_dir(app, "toolbox")?;
        let installer = cache.join(file_name);
        // 运行库是几 MB 的小文件，没有进度也不给取消（跟原来一样）—— `net::download`
        // 照样要一个 report 回调，这里给个空的。
        crate::net::download(url, &installer, 0, &|| false, &|_, _| {})?;
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
        let plan = install_plan(launch_path, install_path);
        // 账本可能记在主程序旁（新版），也可能记在游戏根目录（0.1.5x 那批装错位置的）。
        let previous = plan.as_ref().and_then(read_installed);
        let manifest = previous.as_ref().map(|(manifest, _)| manifest.clone());
        let legacy = plan.as_ref().is_some_and(legacy_installed);
        let conflict = plan
            .as_ref()
            .and_then(|plan| hook_conflict(&plan.dir, hook, manifest.as_ref()));
        let exe = plan.as_ref().and_then(|plan| plan.exe.clone());
        let arch = exe.as_deref().and_then(exe_arch_problem);
        // 这个游戏会加载哪些注入名：读它自己的 PE 导入表（不用按游戏名打表）。
        let installed_files = manifest
            .as_ref()
            .map(|found| found.files.clone())
            .unwrap_or_default();
        let candidates = match plan.as_ref() {
            Some(plan) => hook_candidates(&plan.dir, plan.exe.as_deref(), &installed_files),
            None => Vec::new(),
        };
        let default_hook = candidates.first().copied().unwrap_or(OPTISCALER_DEFAULT_HOOK);
        let tried: Vec<String> = manifest
            .as_ref()
            .map(|found| found.tried.clone())
            .unwrap_or_default();
        let installed = manifest.is_some() || legacy;
        // 装了之后有没有真的被加载：只看日志有没有在上次安装之后出现过。
        // 主程序旁和游戏根目录都查 —— OptiScaler 的默认日志名是「当前目录下的 OptiScaler.log」，
        // 而「当前目录」取决于谁启动的游戏（我们自己启动会设成 exe 目录，Steam 常常是游戏根目录）。
        let log_seen = plan.as_ref().is_some_and(|plan| {
            installed
                && (log_since(&plan.dir, manifest.as_ref())
                    || (plan.root != plan.dir && log_since(&plan.root, manifest.as_ref())))
        });
        let suggested = installed
            .then(|| next_hook_to_try(&candidates, &tried, manifest.as_ref().map(|m| m.hook.as_str())))
            .flatten();
        let running = !fh_core::process::pids_for_game(launch_path, install_path).is_empty();
        let message = match plan.as_ref() {
            None => pick(
                "找不到游戏目录。Steam 游戏请先在卡片菜单里用「改路径」选中游戏的 exe。",
                "Couldn't find the game folder. For Steam games, pick the game exe from the card menu first.",
            ),
            Some(_) if running => pick(
                "游戏正在运行，先退出再装。",
                "The game is running. Quit it first.",
            ),
            Some(_) if arch.is_some() => {
                let name = arch.clone().unwrap_or_default();
                pick(
                    &format!("{name} 不是 64 位程序，OptiScaler 只有 64 位版，装进去游戏会起不来。"),
                    &format!("{name} isn't 64-bit. OptiScaler is x64-only and would break the game."),
                )
            }
            Some(plan) if plan.exe.is_none() => pick(
                &format!(
                    "没认出主程序 exe，这次会装到游戏根目录 {}；装完游戏不生效，就把这些文件移到主程序旁边。",
                    plan.dir.display()
                ),
                &format!(
                    "Couldn't identify the main exe, so files go to {}. If the mod doesn't load, move them next to the game exe.",
                    plan.dir.display()
                ),
            ),
            // 装了、也跑过了，但日志说明没加载上 —— 直接告诉用户下一步点哪个。
            Some(_) if installed && !log_seen && manifest.is_some() => match suggested {
                Some(next) => pick(
                    &format!(
                        "上次装完还没看到 OptiScaler 被加载（进游戏跑一次再看）。要是不出菜单，就点一下换成 {next} 重装 —— 这个游戏加载哪个名字是读它自己的导入表算出来的。"
                    ),
                    &format!(
                        "No sign of OptiScaler being loaded yet (run the game once). If the menu still doesn't show, switch to {next} — that name comes from reading the game's own import table."
                    ),
                ),
                None => pick(
                    "官方支持的 7 个注入名都试过了，还是没加载上：这个游戏可能得走 ASI 方式，或者它根本不加载这些 DLL。",
                    "All seven supported hook names were tried and none loaded. This game may need the ASI route, or it doesn't load any of these DLLs.",
                ),
            },
            Some(_) if installed && log_seen => pick(
                "上次游戏运行时 OptiScaler 已经加载成功了。菜单默认按键是 Insert（不行试 Alt+Insert）。",
                "OptiScaler was loaded the last time the game ran. The overlay key is Insert (try Alt+Insert if not).",
            ),
            Some(_) => pick("可以安装。", "Ready to install."),
        };
        OptiScalerStatus {
            dir: plan.as_ref().map(|plan| plan.dir.display().to_string()),
            exe: exe
                .as_deref()
                .and_then(Path::file_name)
                .map(|name| name.to_string_lossy().to_string()),
            installed,
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
            hook_candidates: candidates.iter().map(|hook| hook.to_string()).collect(),
            default_hook: default_hook.to_string(),
            tried_hooks: tried,
            suggested_hook: suggested.map(|hook| hook.to_string()),
            log_seen,
            // 账本里记着「这一套装进去时有没有那个放大器」；老账本没有这个字段就是 false。
            fsr4: manifest.as_ref().map(|found| found.fsr4).unwrap_or(false),
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
        // 官方要求放到**主程序 exe 旁边**（见 `InstallPlan`）：游戏根目录 ≠ 落点。
        let plan = install_plan(launch_path, install_path).ok_or_else(|| {
            pick(
                "找不到游戏目录。Steam 游戏请先在卡片菜单里用「改路径」选中游戏的 exe。",
                "Couldn't find the game folder. For Steam games, pick the game exe from the card menu first.",
            )
        })?;
        let dir = plan.dir.clone();
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
        if let Some(name) = plan.exe.as_deref().and_then(exe_arch_problem) {
            return Err(pick(
                &format!("{name} 不是 64 位程序，OptiScaler 只有 64 位版。"),
                &format!("{name} isn't 64-bit; OptiScaler is x64-only."),
            ));
        }
        // 这次装哪一份：**自带版**（随启动器的压缩包，不联网）还是官方版（联网下载）。
        //
        // 必须先定下来再清旧安装：下面「换没换版本」要靠版本名比。中间任何一步失败都还没动
        // 游戏目录里的东西 —— 宁可这次装不上，也不要留下半套文件。
        let cache = crate::net::cache_dir(app, "toolbox")?;
        let requested = version.map(str::trim).filter(|tag| !tag.is_empty());
        let bundled = super::bundled_archive(app);
        let want_bundled = match requested {
            Some(tag) if tag.eq_ignore_ascii_case(super::OPTISCALER_BUNDLED_TAG) => true,
            // 没点名版本 = 「装首选那一版」：有自带版就用自带版（这就是「优先安装这个版本」），
            // 没有（本地空构建 / 这份安装包里没带）才退回官方最新。
            None => bundled.is_some(),
            Some(_) => false,
        };
        if want_bundled && bundled.is_none() {
            return Err(pick(
                "这份安装包里没有自带版 OptiScaler，请从官方版本里选一个。",
                "This build doesn't carry the bundled OptiScaler. Pick an official version.",
            ));
        }
        let (archive_path, version_label) = if want_bundled {
            let path = bundled.expect("want_bundled 为真时一定找到了包");
            (path, super::OPTISCALER_BUNDLED_VERSION.to_string())
        } else {
            let release = optiscaler_release(requested)?;
            let archive_path = cache.join(&release.file_name);
            // 缓存里那份大小对得上就直接用：官方包 50 MB 上下，重装不该再下一次。
            let cached = release.bytes > 0
                && fs::metadata(&archive_path).map(|meta| meta.len()).ok() == Some(release.bytes);
            if !cached {
                let _ = fs::remove_file(&archive_path);
                crate::net::download(
                    &release.url,
                    &archive_path,
                    release.bytes,
                    &|| MOD_CANCEL.load(Ordering::Relaxed),
                    &|done, total| emit_mod(app, "download", done, total),
                )?;
            }
            (archive_path, release.version.clone())
        };

        // 同一个注入名重装 = 更新：账本里那个 DLL 是「我们自己」的，不能再备份一次
        // （`<hook>.fantasyhub.bak` 里存的是游戏原文件，覆盖掉就再也还原不回来）。
        // 判定条件见 `keeps_previous_backup`：账本在游戏根目录那批（0.1.5x 装在错位置的）
        // 落点不同，目标目录里那个同名文件不是我们的，必须照备份走。
        let previous = read_installed(&plan);
        let hook_is_ours = keeps_previous_backup(previous.as_ref(), hook, &dir);
        // **换版本**（自带版 ↔ 官方版、官方 A → 官方 B）是换了一整套文件：自带版比官方版多一个
        // FSR 4.1.1 放大器，不清干净就会留下没人认领的文件 —— 装回官方版之后游戏目录里还躺着
        // 那个放大器，「官方版看起来也支持 4.1.1」，而它不在新账本里，卸载永远清不掉。
        let switching = previous
            .as_ref()
            .is_some_and(|(found, _)| found.version != version_label);
        // 清掉之后目标目录里那个 DLL 已经还原成游戏原文件了，这一趟必须重新备份。
        let keep_backup = hook_is_ours && !switching;
        // 这次算「试过」：老账本的记录 + 现在这个（换名字重装时历史要接着记）。
        let mut tried: Vec<String> = previous
            .as_ref()
            .map(|(found, _)| found.tried.clone())
            .unwrap_or_default();
        if !tried.iter().any(|done| done.eq_ignore_ascii_case(hook)) {
            tried.push(hook.to_string());
        }
        if let Some((found, where_)) = previous {
            if switching || !hook_is_ours {
                // 换注入名、换了版本、或者上一套装在别处：先清干净（含还原备份）再装，
                // 否则两套文件会打架。
                remove_installed_files(&where_, &found)?;
            }
        } else if legacy_installed(&plan) {
            // 老版本只留一个纯文本标记，标记在哪个目录，哪套文件才是我们的。
            for target in [&dir, &plan.root] {
                if marker_present(target) {
                    legacy_cleanup(target)?;
                }
            }
        }
        // 落点改过之后，老账本可能留在别的目录（游戏根目录、`Redistributables\` 这类），
        // 新版再也找不到它 —— 装之前顺手清掉，别让几十上百 MB 的旧文件烂在游戏目录里。
        for stale in stale_install_dirs(&plan.root, &dir) {
            if let Some(found) = read_manifest(&stale) {
                remove_installed_files(&stale, &found)?;
            }
            if marker_present(&stale) {
                legacy_cleanup(&stale)?;
            }
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
        // 工具箱这张卡没有解压进度条，给个空回调。
        crate::net::extract_archive(&archive_path, &extract_dir, &|_, _| {})?;

        let package_root = find_optiscaler_root(&extract_dir).ok_or_else(|| {
            pick(
                "压缩包里找不到 OptiScaler 文件。",
                "Couldn't find OptiScaler files in the archive.",
            )
        })?;

        // 「支不支持 FSR 4.1.1」只取决于这一个文件，装之前先在包里找它：
        // 自带版存在的意义就是它，缺了就当场停下 —— 宁可这次不装，也不装一套冒充支持 4.1.1 的。
        let package_fsr4 = package_root.join(super::FSR4_UPSCALER_DLL).is_file();
        if want_bundled && !package_fsr4 {
            return Err(pick(
                &format!(
                    "这个包里没有 {}（缺了它就不支持 FSR 4.1.1），这次没有安装。",
                    super::FSR4_UPSCALER_DLL
                ),
                &format!(
                    "This package has no {} — FSR 4.1.1 wouldn't work, so nothing was installed.",
                    super::FSR4_UPSCALER_DLL
                ),
            ));
        }

        // 边写边记账：卸载/还原全靠这份记录，原来只写一个纯文本标记就完事。
        let mut ledger = ModManifest {
            version: version_label.clone(),
            hook: hook.to_string(),
            installed_at: crate::net::now_ms(),
            files: Vec::new(),
            backups: Vec::new(),
            dirs: Vec::new(),
            // 「试过哪些注入名」接着老账本记：换名字重装不能把历史丢掉，
            // 否则「下一个该试哪个」每次都从 dxgi 重新开始，用户得自己记。
            tried: tried,
            // 下面按「真的写进游戏目录了没有」填。
            fsr4: false,
        };
        emit_mod(app, "copy", 0, 0);
        copy_optiscaler_files(&package_root, &dir, hook, keep_backup, &mut ledger)?;
        // 装完再看一眼游戏目录：文件真落地了才算数 —— 这一条就是面板敢说「支持 4.1.1」的依据。
        let fsr4_installed = dir.join(super::FSR4_UPSCALER_DLL).is_file();
        ledger.fsr4 = fsr4_installed;
        // 先把老日志删掉，再打开日志：这样「有没有新日志」就等于「这次加载上没加载上」。
        let _ = fs::remove_file(dir.join(OPTISCALER_LOG));
        let _ = enable_log(&dir);
        write_manifest(&dir, &ledger)?;
        let _ = fs::remove_file(dir.join(OPTISCALER_MARKER));
        emit_mod(app, "done", 0, 0);
        // 自带版的意义就是那个放大器：文件没能落地（被占用、被杀软拦下、盘满）就如实报错 ——
        // 账本已经写了，卸载照样干净，但这次绝不说「装好了」。
        if want_bundled && !fsr4_installed {
            return Err(pick(
                &format!(
                    "自带版装上了，但 {} 没能写进游戏目录，这一次不算成功（文件可能被占用或被拦截）。",
                    super::FSR4_UPSCALER_DLL
                ),
                &format!(
                    "The bundled build installed, but {} couldn't be written into the game folder, so this didn't succeed (file in use or blocked).",
                    super::FSR4_UPSCALER_DLL
                ),
            ));
        }
        // 装完如实说清这一套带不带 FSR 4.1.1（判据是刚查过的那个文件，不是版本名）。
        let fsr4_note = if fsr4_installed {
            pick(
                &format!("这一套带 FSR 4.1.1 放大器（{}）。", super::FSR4_UPSCALER_DLL),
                &format!("This set includes the FSR 4.1.1 upscaler ({}).", super::FSR4_UPSCALER_DLL),
            )
        } else {
            pick(
                "这一套是官方包，放大器还是旧的 FSR 4（要 4.1.1 请装自带版）。",
                "This is an official package with the older FSR 4 upscaler (pick the bundled build for 4.1.1).",
            )
        };
        Ok(pick(
            &format!(
                "已安装 OptiScaler v{}（{hook}）。{fsr4_note}原文件已备份，可在卡片菜单里卸载还原；进游戏按 Insert 打开菜单。要是没反应，回卡片菜单再点「安装 Mod / 工具」——面板会告诉我们下一个该试哪个名字。",
                ledger.version
            ),
            &format!(
                "OptiScaler v{} installed as {hook}. {fsr4_note}Originals were backed up; press Insert in-game. If nothing happens, open this menu again — the panel will tell you which name to try next.",
                ledger.version
            ),
        ))
    }

    pub fn uninstall_optiscaler(launch_path: &str, install_path: &str) -> Result<String, String> {
        let plan = install_plan(launch_path, install_path)
            .ok_or_else(|| pick("找不到游戏目录。", "Couldn't find the game folder."))?;
        if !fh_core::process::pids_for_game(launch_path, install_path).is_empty() {
            return Err(pick(
                "游戏正在运行，先退出再卸载。",
                "The game is running. Quit it before uninstalling.",
            ));
        }
        // 账本在哪儿，相对路径就是相对哪儿记的 —— 卸载必须照着记的那个目录来。
        if let Some((manifest, where_)) = read_installed(&plan) {
            remove_installed_files(&where_, &manifest)?;
            return Ok(pick(
                "已卸载 OptiScaler，被覆盖的文件已还原。",
                "OptiScaler removed and the overwritten files restored.",
            ));
        }
        for dir in [&plan.dir, &plan.root] {
            if marker_present(dir) {
                legacy_cleanup(dir)?;
                return Ok(pick(
                    "已卸载 OptiScaler（这是旧版装的，没有完整记录，只清了注入 DLL 与配置）。",
                    "OptiScaler removed (legacy install; only the injected DLL and config were cleaned).",
                ));
            }
        }
        Err(pick(
            "这个目录里没有 FantasyHub 的安装记录，没有能自动卸载的东西。",
            "No FantasyHub install record in this folder; nothing to uninstall.",
        ))
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
                // 官方那几个不是自带版（自带版由 `bundled_first` 单独插到最前面）。
                bundled: false,
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

    /// 主程序不是 x64 就返回文件名：装进去游戏会起不来。
    /// 认不出主程序（没有 exe / 读不到头）返回 None —— 认不出就不拦，别把能装的挡住了。
    fn exe_arch_problem(exe: &Path) -> Option<String> {
        let mut head = [0u8; 1024];
        let mut file = fs::File::open(exe).ok()?;
        use std::io::Read;
        let read = file.read(&mut head).ok()?;
        match pe_is_x64(&head[..read]) {
            Some(false) => exe
                .file_name()
                .map(|name| name.to_string_lossy().to_string()),
            _ => None,
        }
    }

}

/// 安装包里的 `OptiScaler.dll` 所在目录即「包根」，展开后可能嵌在子目录里。
#[cfg_attr(not(windows), allow(dead_code))]
fn find_optiscaler_root(extract_dir: &Path) -> Option<PathBuf> {
    let dll = find_named_file(extract_dir, "OptiScaler.dll")
        .or_else(|| find_named_file(extract_dir, "OptiScaler.ini"))?;
    Some(
        dll.parent()
            .map(|parent| parent.to_path_buf())
            .unwrap_or_else(|| extract_dir.to_path_buf()),
    )
}

/// 官方的安装 / 卸载脚本（`setup_windows.bat`、`setup_linux.sh` 等）不进游戏目录。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_setup_script(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".bat", ".cmd", ".ps1", ".sh"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 递归找一个文件（不区分大小写）。官方包结构变过几次（有时嵌一层目录），
/// 所以「包根」不能写死，得先找到 `OptiScaler.dll` 再认它所在的目录。
#[cfg_attr(not(windows), allow(dead_code))]
fn find_named_file(root: &Path, name: &str) -> Option<PathBuf> {
    let direct = root.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(root).ok()?;
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

/// 把官方包的内容铺到**主程序旁**（`to`）：`OptiScaler.dll` 改名叫用户选的注入名，
/// 其余文件（含 `D3D12_Optiscaler/` 这类子目录）原样保留，**边写边记账**。
///
/// 照官方包的真实结构对过（2026-10-09 拉 `Optiscaler_0.9.4-final…7z` 验的，23 项全在根目录）：
/// `OptiScaler.dll` / `OptiScaler.ini` / `fakenvapi.dll` / `fakenvapi.ini` /
/// `dlssg_to_fsr3_amd_is_better.dll` / `libxess*.dll` / `amd_fidelityfx_*.dll` 平铺在包根，
/// 外加 `D3D12_Optiscaler/`、`Licenses/` 两个子目录；不进游戏目录的只有
/// `!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt` 和 `setup_windows.bat` / `setup_linux.sh`。
/// 官方文档只管这叫「解压到主程序旁」，没说改名 —— 改名只针对 `OptiScaler.dll` 一个文件，
/// `OptiScaler.ini` 必须保持原名（Wiki 原话：Please don't rename the ini file）。
#[cfg_attr(not(windows), allow(dead_code))]
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

#[cfg_attr(not(windows), allow(dead_code))]
fn copy_optiscaler_dir(
    root: &Path,
    dir: &Path,
    to: &Path,
    hook: &str,
    hook_is_ours: bool,
    ledger: &mut ModManifest,
    copied_dll: &mut bool,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|err| {
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
            std::fs::create_dir_all(&dest_dir).map_err(|err| {
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
        // 官方的「!! EXTRACT ALL FILES !!」提示与 setup / remove 脚本不进游戏目录。
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
                std::fs::copy(&dest, &bak).map_err(|err| {
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
        std::fs::copy(&src, &dest).map_err(|err| {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 自带版排第一 —— 面板默认选中的就是列表第一项，「装的时候优先装这一版」这条就靠这个顺序。
    /// 官方那几项原样不动（顺序、`latest` 标记都不许被这条改掉）。
    #[test]
    fn bundled_version_comes_first() {
        let official = vec![
            ModVersion {
                version: "0.9.4".to_string(),
                tag: "v0.9.4".to_string(),
                bytes: 55_000_000,
                latest: true,
                bundled: false,
            },
            ModVersion {
                version: "0.9.3".to_string(),
                tag: "v0.9.3".to_string(),
                bytes: 53_000_000,
                latest: false,
                bundled: false,
            },
        ];
        let with_bundled = bundled_first(official.clone(), Some(66_200_716));
        assert_eq!(with_bundled.len(), 3);
        assert!(with_bundled[0].bundled, "自带版必须排第一");
        assert_eq!(with_bundled[0].tag, OPTISCALER_BUNDLED_TAG);
        assert_eq!(with_bundled[0].version, OPTISCALER_BUNDLED_VERSION);
        assert!(!with_bundled[0].latest, "自带版不是 GitHub 上的 latest");
        assert!(with_bundled[1].latest && with_bundled[1].tag == "v0.9.4");
        assert_eq!(with_bundled[2].tag, "v0.9.3");

        // 没带这个包（本地空构建）时列表跟以前一模一样。
        assert_eq!(bundled_first(official, None).len(), 2);
    }

    /// 随包的这份 7z 必须真的带着 FSR 4.1.1 的放大器 —— 这是「面板敢写支持 4.1.1」的唯一依据。
    ///
    /// 为什么用 Rust 这边数条目而不是看文件名：Windows 上解它的就是 `sevenz-rust2`，而那段代码
    /// 本机（macOS）编不到；这里用**同一个库**把 63 MB 打开来数一遍，等价于「这个包在真机上
    /// 解得开、而且里面有那个文件」。包被换成空占位（没带）时这条跳过 —— 那是正常状态，
    /// 界面上自带版整条会消失，没有可验的东西。
    #[test]
    fn bundled_package_carries_the_fsr4_upscaler() {
        let path = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/optiscaler/OptiScaler-custom.7z"
        ));
        if !is_real_package(path) {
            eprintln!("自带版包不在（{}），跳过内容检查", path.display());
            return;
        }
        let archive = sevenz_rust2::Archive::open(path).expect("随包的自带版 7z 打不开");
        let names: Vec<String> = archive
            .files
            .iter()
            .map(|entry| entry.name.to_ascii_lowercase())
            .collect();
        assert!(
            names.iter().any(|name| name.ends_with("optiscaler.dll")),
            "包里没有 OptiScaler.dll"
        );
        assert!(
            names.iter().any(|name| name.ends_with(FSR4_UPSCALER_DLL)),
            "包里没有 {FSR4_UPSCALER_DLL} —— 缺了它就不该自称支持 FSR 4.1.1"
        );
    }

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

    /// 铺一个游戏目录树：`(相对路径, 字节数)`。
    fn game_tree(tag: &str, files: &[(&str, usize)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fh-toolbox-plan-{tag}"));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, size) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("temp dir");
            std::fs::write(&path, vec![0u8; *size]).expect("temp file");
        }
        root
    }

    /// 同上，但把游戏目录改名成指定名字 —— 「目录名 → 主程序名」那几条规则（名字线索 / 缩写）
    /// 只有在目录名真实时才测得准，用 `fh-toolbox-plan-xxx` 当目录名会把规则测假。
    /// 唯一性靠**上一层**带 tag：几个测试都要叫 `Red Dead Redemption 2`，同级改名会互相踩。
    fn named_root(tag: &str, folder: &str, files: &[(&str, usize)]) -> PathBuf {
        let base = std::env::temp_dir().join(format!("fh-toolbox-plan-{tag}"));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join(folder);
        for (rel, size) in files {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("temp dir");
            std::fs::write(&path, vec![0u8; *size]).expect("temp file");
        }
        root
    }

    fn plan_for(root: &Path) -> InstallPlan {
        install_plan("", &root.to_string_lossy()).unwrap_or_else(|| panic!("plan for {}", root.display()))
    }

    fn exe_name(plan: &InstallPlan) -> String {
        plan.exe
            .as_deref()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn install_target_is_the_folder_of_the_main_exe() {
        // UE 布局：主程序在 `<游戏>\<代号>\Binaries\Win64\`。
        // 官方文档第一条就是「全部文件解压到主程序 exe 旁边」，`setup_windows.bat` 还专门提示
        // UE 游戏要装到 `Binaries\Win64`；游戏根目录一个 exe 都没有 —— 旧实现往根目录丢文件，
        // 游戏永远加载不到，这就是真机反馈的「装不上」。
        let root = game_tree(
            "ue",
            &[
                ("SwGame/Binaries/Win64/SwGame-Win64-Shipping.exe", 4096),
                ("SwGame/Content/pakchunk0.pak", 1024),
                // 引擎自带的 exe 更大，但官方明确要忽略 `Engine`。
                ("Engine/Binaries/Win64/UnrealEditor.exe", 65536),
            ],
        );
        let plan = plan_for(&root);
        assert_eq!(plan.dir, root.join("SwGame").join("Binaries").join("Win64"));
        assert_eq!(exe_name(&plan), "SwGame-Win64-Shipping.exe");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_target_follows_non_unreal_subfolders() {
        // 非 UE 的同类布局（Cyberpunk 的 `bin\x64`、HITMAN 3 的 `Retail`）：靠名字认主程序。
        let root = game_tree(
            "bin",
            &[
                ("Cyberpunk 2077/bin/x64/Cyberpunk2077.exe", 2048),
                ("Cyberpunk 2077/bin/x64/tools/Helper.exe", 65536),
            ],
        );
        let plan = plan_for(&root.join("Cyberpunk 2077"));
        assert_eq!(plan.dir, root.join("Cyberpunk 2077").join("bin").join("x64"));
        assert_eq!(exe_name(&plan), "Cyberpunk2077.exe");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_target_prefers_the_exe_named_after_the_game() {
        // 名字对得上就赢过体积：工具 exe 比主程序大得多，也不能把文件装到它旁边。
        let root = game_tree(
            "named",
            &[
                ("Hades/Hades.exe", 2048),
                ("Hades/Extras/BigTool.exe", 65536),
            ],
        );
        let plan = plan_for(&root.join("Hades"));
        assert_eq!(plan.dir, root.join("Hades"));
        assert_eq!(exe_name(&plan), "Hades.exe");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_target_falls_back_to_the_game_root() {
        // 一个 exe 都认不出来时不能瞎猜：落点退回游戏根目录，面板会把这件事写出来。
        let root = game_tree("noexe", &[("data/pak.pak", 16)]);
        let plan = plan_for(&root);
        assert_eq!(plan.dir, root);
        assert_eq!(plan.exe, None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_target_skips_uninstallers_and_crash_handlers() {
        // 卸载器 / 崩溃处理器不是主程序：只有它们的时候必须认怂（退回根目录），
        // 不能把 dxgi.dll 装到它们旁边 —— 那才是真的「装错地方」。
        let root = game_tree(
            "noise",
            &[
                ("unins000.exe", 65536),
                ("UnityCrashHandler64.exe", 32768),
            ],
        );
        let plan = plan_for(&root);
        assert_eq!(plan.dir, root);
        assert_eq!(plan.exe, None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_target_ignores_the_rockstar_installer_in_rdr2() {
        // 真机 2026-10-10 的现场：`Red Dead Redemption 2\` 里躺着 Rockstar 的
        // `Social-Club-Setup.exe`，它比 `RDR2.exe` 还大，于是被当成主程序 ——
        // 文件全装进 `Redistributables\`，游戏当然不加载（用户看到的
        // 「目录找对了但没生效」）。两条规则缺一不可：安装器类 exe 不当候选、
        // 目录名的缩写（Red Dead Redemption 2 → rdr2）要能对上主程序名。
        let root = named_root(
            "rdr2",
            "Red Dead Redemption 2",
            &[
                ("RDR2.exe", 4096),
                ("PlayRDR2.exe", 1024),
                ("Redistributables/Social-Club-Setup.exe", 65536),
                ("x64/oo2core_5_win64.dll", 512),
            ],
        );
        let plan = plan_for(&root);
        assert_eq!(plan.dir, root, "主程序在游戏根目录，落点就该是根目录");
        assert_eq!(exe_name(&plan), "RDR2.exe");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stale_install_in_the_wrong_folder_is_found_and_cleaned() {
        // 真机现场：旧版把文件装进了 `Redistributables\`（因为 Social-Club-Setup.exe 在那儿）。
        // 落点改成游戏根目录之后，那份账本新版再也找不到 —— 装之前必须扫出来清掉，
        // 否则那 18 个文件（含 70 MB 的 libxess.dll）永远烂在游戏目录里，备份也还原不回去。
        let root = named_root(
            "stale",
            "Red Dead Redemption 2",
            &[
                ("RDR2.exe", 4096),
                ("Redistributables/Social-Club-Setup.exe", 1024),
            ],
        );
        let stale = root.join("Redistributables");
        std::fs::write(stale.join("dxgi.dll"), b"opti").expect("hook dll");
        std::fs::write(stale.join("OptiScaler.ini"), b"ini").expect("ini");
        write_manifest(
            &stale,
            &manifest_for("dxgi.dll", &["dxgi.dll", "OptiScaler.ini"], &[]),
        )
        .expect("manifest");

        let plan = plan_for(&root);
        assert_eq!(plan.dir, root, "新版落点是游戏根目录");
        let stale_dirs = stale_install_dirs(&plan.root, &plan.dir);
        assert_eq!(stale_dirs, vec![stale.clone()]);

        for dir in stale_dirs {
            let found = read_manifest(&dir).expect("stale manifest");
            remove_installed_files(&dir, &found).expect("clean stale");
        }
        assert!(!stale.join("dxgi.dll").exists());
        assert!(!stale.join("OptiScaler.ini").exists());
        assert!(!manifest_path(&stale).exists());
        assert!(
            stale.join("Social-Club-Setup.exe").is_file(),
            "游戏自己的文件一个都不能动"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 拼一个最小的 PE：含可选头、一个 .rdata 段，导入表里列出给定的 DLL 名。
    /// 用来在本机（macOS）验证「读游戏自己的导入表」这条路 —— 真机上是游戏的真实 exe。
    fn pe_with_imports(names: &[&str]) -> Vec<u8> {
        // 布局：0x00 DOS 头 / 0x80 PE 头 + 可选头 / 0x200 段表 / 0x400 .rdata
        let pe_at = 0x80usize;
        let opt_size = 240usize;
        let opt = pe_at + 24;
        let sections_at = opt + opt_size;
        let raw_at = 0x400usize;
        let mut bytes = vec![0u8; raw_at + 0x400];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&(pe_at as u32).to_le_bytes());
        bytes[pe_at..pe_at + 4].copy_from_slice(b"PE\0\0");
        bytes[pe_at + 4 + 2..pe_at + 4 + 4].copy_from_slice(&1u16.to_le_bytes()); // 1 个段
        bytes[pe_at + 4 + 16..pe_at + 4 + 18]
            .copy_from_slice(&(opt_size as u16).to_le_bytes());
        bytes[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes()); // PE32+
        // 数据目录：导入表（索引 1）在 opt+112+8
        let rdata_rva = 0x1000u32;
        bytes[opt + 112 + 8..opt + 112 + 12].copy_from_slice(&rdata_rva.to_le_bytes());
        // 段表：.rdata 虚拟地址 0x1000 → 文件偏移 0x400
        bytes[sections_at + 8..sections_at + 12].copy_from_slice(&0x400u32.to_le_bytes()); // VirtualSize
        bytes[sections_at + 12..sections_at + 16].copy_from_slice(&rdata_rva.to_le_bytes());
        bytes[sections_at + 16..sections_at + 20].copy_from_slice(&0x400u32.to_le_bytes()); // RawSize
        bytes[sections_at + 20..sections_at + 24].copy_from_slice(&(raw_at as u32).to_le_bytes());
        // 导入描述符：每个 20 字节，最后用全 0 收尾
        // 名字必须落在 .rdata 映射到的范围里（RVA 0x1000–0x1400），否则按 RVA 换算会算飞。
        let names_at = rdata_rva + 0x100u32;
        for (index, name) in names.iter().enumerate() {
            let desc = raw_at + index * 20;
            bytes[desc..desc + 4].copy_from_slice(&1u32.to_le_bytes()); // OriginalFirstThunk 非 0
            let name_rva = names_at + (index as u32) * 0x40;
            bytes[desc + 12..desc + 16].copy_from_slice(&name_rva.to_le_bytes());
            let offset = raw_at + (name_rva - rdata_rva) as usize;
            assert!(offset + name.len() < bytes.len(), "测试用的名字要塞得进段里");
            let raw = name.as_bytes();
            bytes[offset..offset + raw.len()].copy_from_slice(raw);
        }
        bytes
    }

    #[test]
    fn reads_imports_from_a_pe() {
        // 真机核对过：这两份期望值与 `objdump -p` 对同一批 exe 的输出一致
        // （PE32 的 7zr.exe 只有 kernel32/user32/…，PE32+ 的 handle64.exe 还带 version.dll）。
        let pe = pe_with_imports(&["KERNEL32.dll", "VERSION.dll", "d3d12.dll"]);
        let imports = pe_imports(&pe);
        assert!(imports.contains(&"kernel32.dll".to_string()));
        assert!(imports.contains(&"version.dll".to_string()));
        assert!(imports.contains(&"d3d12.dll".to_string()));
        // 认不出来的一律返回空，绝不猜。
        assert!(pe_imports(b"not a pe").is_empty());
        assert!(pe_imports(b"MZ").is_empty());
    }

    #[test]
    fn hook_candidates_come_from_the_games_own_imports() {
        // 关键的一条：不再按游戏名打表，而是看游戏**真的会加载**哪个名字。
        // 大镖客 2 就是这样 —— 它加载 winmm/version，不加载 dxgi，所以默认值不能写死 dxgi。
        let imports = vec![
            "kernel32.dll".to_string(),
            "version.dll".to_string(),
            "winmm.dll".to_string(),
        ];
        assert_eq!(
            hook_candidates_in(&imports),
            vec!["winmm.dll", "version.dll"],
            "按官方优先顺序排：winmm 在 version 前面"
        );
        // 一个都不沾：认不出就返回空，调用方退回官方默认值。
        assert!(hook_candidates_in(&["kernel32.dll".to_string()]).is_empty());
    }

    #[test]
    fn next_hook_skips_what_was_already_tried() {
        let candidates = vec!["winmm.dll", "version.dll"];
        // 试过 winmm、当前也是 winmm → 下一个是 version。
        let tried = vec!["winmm.dll".to_string()];
        assert_eq!(
            next_hook_to_try(&candidates, &tried, Some("winmm.dll")),
            Some("version.dll")
        );
        // 会加载的都试完了 → 退回官方顺序里还没试过的（dxgi 排在官方顺序第一位）。
        let tried = vec!["winmm.dll".to_string(), "version.dll".to_string()];
        assert_eq!(
            next_hook_to_try(&candidates, &tried, Some("winmm.dll")),
            Some("dxgi.dll")
        );
        // 七个都试过：没有下一个了，界面该说实话而不是接着转圈。
        let all: Vec<String> = OPTISCALER_HOOKS.iter().map(|h| h.to_string()).collect();
        assert_eq!(next_hook_to_try(&candidates, &all, Some("winmm.dll")), None);
    }

    #[test]
    fn install_enables_the_log_and_remembers_what_was_tried() {
        // 日志是唯一能自动判定「到底加载上没有」的信号，装的时候必须打开它。
        let root = game_tree("log", &[("OptiScaler.ini", 32)]);
        let ini = root.join("OptiScaler.ini");
        std::fs::write(&ini, "Enabled=auto\r\nLogToFile=auto\r\nLogLevel=auto\r\n").expect("ini");

        assert!(enable_log(&root));
        let text = std::fs::read_to_string(&ini).expect("ini");
        assert!(text.contains("LogToFile=true"), "{text}");
        assert!(text.contains("LogLevel=auto"), "别的行一个字节都不能动：{text}");
        assert!(text.contains("\r\n"), "行尾要保留（Windows 的 INI）：{text:?}");

        // 用户自己写死的 false 要尊重，不能被我们改回去。
        std::fs::write(&ini, "LogToFile=false\r\n").expect("ini");
        assert!(enable_log(&root));
        assert!(std::fs::read_to_string(&ini).expect("ini").contains("LogToFile=false"));

        // 缺这一行时补一行。
        std::fs::write(&ini, "Enabled=auto\r\n").expect("ini");
        assert!(enable_log(&root));
        assert!(std::fs::read_to_string(&ini).expect("ini").contains("LogToFile=true"));

        // 日志判定：装完（installed_at）之后出现的日志才算「加载上了」。
        let manifest = manifest_for("dxgi.dll", &["dxgi.dll"], &[]);
        assert!(!log_since(&root, Some(&manifest)), "还没日志 = 没加载上");
        std::fs::write(root.join(OPTISCALER_LOG), b"log").expect("log");
        let mut fresh = manifest.clone();
        fresh.installed_at = 0;
        assert!(log_since(&root, Some(&fresh)), "有比安装时间新的日志 = 加载上了");
        let mut older = manifest;
        older.installed_at = u64::MAX;
        assert!(!log_since(&root, Some(&older)), "装之前的老日志不算数");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn acronym_hint_matches_short_exe_names() {
        // 目录名 → 缩写：主程序叫缩写时全靠它（`RDR2.exe` 对 `Red Dead Redemption 2`）。
        assert_eq!(acronym_of("Red Dead Redemption 2"), "rdr2");
        assert_eq!(acronym_of("GTA V"), "gtav");
        // 纯数字词整段留下，别被压成一位。
        assert_eq!(acronym_of("Cyberpunk 2077"), "c2077");
        let root = named_root("acronym", "Red Dead Redemption 2", &[("RDR2.exe", 16)]);
        assert!(name_hints(&root).contains(&"rdr2".to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

    fn manifest_for(hook: &str, files: &[&str], backups: &[(&str, &str)]) -> ModManifest {
        ModManifest {
            version: "0.9.4".into(),
            hook: hook.into(),
            installed_at: 1,
            files: files.iter().map(|file| (*file).to_string()).collect(),
            backups: backups
                .iter()
                .map(|(file, backup)| ModBackup {
                    file: (*file).to_string(),
                    backup: (*backup).to_string(),
                })
                .collect(),
            dirs: Vec::new(),
            tried: Vec::new(),
            fsr4: false,
        }
    }

    /// 铺一个「主程序在子目录」的现场：返回 (plan, 游戏根目录, 主程序所在目录)。
    fn plan_with_subfolder(tag: &str) -> (InstallPlan, PathBuf, PathBuf) {
        let root = game_tree(tag, &[("Game/Binaries/Win64/Game-Win64-Shipping.exe", 1024)]);
        let plan = plan_for(&root);
        let dir = plan.dir.clone();
        (plan, root, dir)
    }

    #[test]
    fn ledger_next_to_the_exe_is_used_for_uninstall() {
        let (plan, root, dir) = plan_with_subfolder("ledger-new");
        assert_ne!(dir, root, "主程序在子目录里，落点不该是游戏根目录");
        let manifest = manifest_for("dxgi.dll", &["dxgi.dll", "OptiScaler.ini"], &[]);
        write_manifest(&dir, &manifest).expect("write manifest");
        std::fs::write(dir.join("dxgi.dll"), b"opti").expect("dll");

        let (found, where_) = read_installed(&plan).expect("账本要能找到");
        assert_eq!(where_, dir, "账本在主程序旁，就该按那个目录卸载");
        remove_installed_files(&where_, &found).expect("uninstall");
        assert!(!dir.join("dxgi.dll").exists());
        assert!(!manifest_path(&dir).exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_ledger_in_the_game_root_still_uninstalls() {
        // 0.1.5x 把文件装在游戏根目录（错位置）、账本也写在根目录。新版落点改成主程序旁
        // 之后，卸载必须还能顺着根目录那份账本把东西清干净 —— 否则老安装就永远卸不掉了。
        let (plan, root, dir) = plan_with_subfolder("ledger-old");
        assert_ne!(dir, root);
        std::fs::write(root.join("dxgi.dll"), b"opti").expect("dll");
        std::fs::write(root.join("OptiScaler.ini"), b"ini").expect("ini");
        let manifest = manifest_for("dxgi.dll", &["dxgi.dll", "OptiScaler.ini"], &[]);
        write_manifest(&root, &manifest).expect("write manifest");

        let (found, where_) = read_installed(&plan).expect("根目录那份账本也要认");
        assert_eq!(where_, root, "账本记的相对路径是相对根目录的");
        remove_installed_files(&where_, &found).expect("uninstall");
        assert!(!root.join("dxgi.dll").exists());
        assert!(!root.join("OptiScaler.ini").exists());
        assert!(!manifest_path(&root).exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn uninstall_restores_the_file_it_overwrote() {
        let root = game_tree("restore", &[("Game.exe", 64)]);
        std::fs::write(root.join("dxgi.dll"), b"the game's own dxgi").expect("original");
        std::fs::copy(root.join("dxgi.dll"), root.join("dxgi.dll.fantasyhub.bak")).expect("backup");
        std::fs::write(root.join("dxgi.dll"), b"optiscaler").expect("ours");
        let manifest = manifest_for("dxgi.dll", &["dxgi.dll"], &[("dxgi.dll", "dxgi.dll.fantasyhub.bak")]);

        remove_installed_files(&root, &manifest).expect("uninstall");
        assert_eq!(
            std::fs::read(root.join("dxgi.dll")).expect("restored"),
            b"the game's own dxgi"
        );
        assert!(!root.join("dxgi.dll.fantasyhub.bak").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn in_place_update_only_when_the_ledger_sits_in_the_target() {
        // 这一条弄错就会毁掉 `<hook>.fantasyhub.bak` 里那份游戏原文件（覆盖后无法还原）。
        let dir = PathBuf::from("/games/foo/bin/x64");
        let root = PathBuf::from("/games/foo");
        let here = (manifest_for("dxgi.dll", &["dxgi.dll"], &[]), dir.clone());
        let elsewhere = (manifest_for("dxgi.dll", &["dxgi.dll"], &[]), root.clone());

        // 账本就在这个目录 + 注入名相同 = 原地更新。
        assert!(keeps_previous_backup(Some(&here), "dxgi.dll", &dir));
        // 换了注入名：那个同名文件不是我们上次写的。
        assert!(!keeps_previous_backup(Some(&here), "winmm.dll", &dir));
        // 账本在游戏根目录那批：目标目录里的同名文件是游戏自己的。
        assert!(!keeps_previous_backup(Some(&elsewhere), "dxgi.dll", &dir));
        assert!(!keeps_previous_backup(None, "dxgi.dll", &dir));
    }

    /// 官方 0.9.4 包的真实结构（2026-10-09 把 release 的 `.7z` 拉下来核过：
    /// 文件全部平铺在包根，另有 `D3D12_Optiscaler/`、`Licenses/` 两个子目录，
    /// 只有「!! README…」和两个 setup 脚本不该进游戏目录）。
    const OFFICIAL_PACKAGE: [(&str, usize); 19] = [
        ("!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt", 8),
        ("OptiScaler.dll", 4096),
        ("OptiScaler.ini", 64),
        ("fakenvapi.dll", 32),
        ("fakenvapi.ini", 16),
        ("dlssg_to_fsr3_amd_is_better.dll", 32),
        ("libxell.dll", 32),
        ("libxess.dll", 32),
        ("libxess_dx11.dll", 32),
        ("libxess_fg.dll", 32),
        ("amd_fidelityfx_dx12.dll", 32),
        ("amd_fidelityfx_framegeneration_dx12.dll", 32),
        ("amd_fidelityfx_upscaler_dx12.dll", 32),
        ("amd_fidelityfx_vk.dll", 32),
        ("D3D12_Optiscaler/D3D12Core.dll", 32),
        ("Licenses/DirectX_LICENSE.txt", 8),
        ("Licenses/FidelityFX_v1_LICENSE.md", 8),
        ("setup_windows.bat", 8),
        ("setup_linux.sh", 8),
    ];

    #[test]
    fn package_lands_next_to_the_exe_with_only_the_dll_renamed() {
        let root = game_tree(
            "pkg-game",
            &[("Game/Binaries/Win64/Game-Win64-Shipping.exe", 1024)],
        );
        let plan = plan_for(&root);
        let dir = plan.dir.clone();
        // 游戏自带一个 dxgi.dll：装完必须变成 OptiScaler，但原文件要留底。
        std::fs::write(dir.join("dxgi.dll"), b"the game's own dxgi").expect("original dxgi");
        let package = game_tree("pkg-src", &OFFICIAL_PACKAGE);

        let mut ledger = manifest_for("dxgi.dll", &[], &[]);
        copy_optiscaler_files(&package, &dir, "dxgi.dll", false, &mut ledger).expect("copy package");

        // 改名只发生在 OptiScaler.dll 上，且落在主程序旁边。
        assert_ne!(std::fs::read(dir.join("dxgi.dll")).expect("hook dll"), b"the game's own dxgi");
        assert_eq!(
            std::fs::read(dir.join("dxgi.dll.fantasyhub.bak")).expect("backup"),
            b"the game's own dxgi"
        );
        // INI 保持原名（Wiki：Please don't rename the ini file）。
        assert!(dir.join("OptiScaler.ini").is_file());
        // 捆绑的 Fakenvapi / Nukem 也要平铺在主程序旁，不是塞进子目录。
        assert!(dir.join("fakenvapi.dll").is_file());
        assert!(dir.join("fakenvapi.ini").is_file());
        assert!(dir.join("dlssg_to_fsr3_amd_is_better.dll").is_file());
        // 子目录原样跟过去（FSR4 on Win10 要 `D3D12_Optiscaler`）。
        assert!(dir.join("D3D12_Optiscaler").join("D3D12Core.dll").is_file());
        assert!(dir.join("Licenses").join("DirectX_LICENSE.txt").is_file());
        // 提示文件与 setup 脚本不进游戏目录。
        assert!(!dir.join("setup_windows.bat").exists());
        assert!(!dir.join("setup_linux.sh").exists());
        assert!(!dir
            .join("!! README_EXTRACT ALL FILES TO GAME FOLDER !!.txt")
            .exists());

        // 账本记全：卸载才可能还原得回来。
        assert!(ledger.files.contains(&"dxgi.dll".to_string()));
        assert!(ledger.files.contains(&"OptiScaler.ini".to_string()));
        assert!(ledger.files.contains(&"fakenvapi.dll".to_string()));
        assert_eq!(ledger.backups.len(), 1);
        assert_eq!(ledger.backups[0].file, "dxgi.dll");
        assert!(ledger.dirs.contains(&"D3D12_Optiscaler".to_string()));

        // 装完再卸：游戏原来那个 dxgi.dll 要回来，我们铺的东西一个不剩。
        remove_installed_files(&dir, &ledger).expect("uninstall");
        assert_eq!(
            std::fs::read(dir.join("dxgi.dll")).expect("restored"),
            b"the game's own dxgi"
        );
        assert!(!dir.join("OptiScaler.ini").exists());
        assert!(!dir.join("fakenvapi.dll").exists());
        assert!(!dir.join("D3D12_Optiscaler").exists(), "自己建的目录要清掉");
        assert!(!dir.join("Licenses").exists());
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&package).ok();
    }

    #[test]
    fn package_without_optiscaler_dll_is_rejected() {
        // 认不出包就该报错收场，不能装一半留下半套文件。
        let root = game_tree("pkg-bad-game", &[("Game.exe", 64)]);
        let package = game_tree("pkg-bad-src", &[("OptiScaler.ini", 8)]);
        let mut ledger = manifest_for("dxgi.dll", &[], &[]);
        let err = copy_optiscaler_files(&package, &root, "dxgi.dll", false, &mut ledger)
            .expect_err("缺 dll 必须报错");
        assert!(err.contains("OptiScaler.dll"), "报错要说清缺什么：{err}");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&package).ok();
    }

    #[test]
    fn mod_list_reports_where_the_files_actually_are() {
        let scanned = |name: &str, install: &Path| crate::scan::ScannedGame {
            id: name.to_string(),
            name: name.to_string(),
            cover: String::new(),
            cover_path: String::new(),
            install_path: install.to_string_lossy().to_string(),
            launch_path: String::new(),
            size_bytes: 0,
            playtime_minutes: 0,
            // 扫描收尾才按账本覆盖；这里是测试夹具，测试自己会调 `installed_mods`。
            has_mod: false,
        };

        // 新装的一批：账本在主程序旁，列表就该报主程序旁。
        let (plan, root_new, dir_new) = plan_with_subfolder("list-new");
        write_manifest(&dir_new, &manifest_for("dxgi.dll", &["dxgi.dll"], &[])).expect("manifest");
        // 老的一批：账本在游戏根目录，列表必须照实报根目录（报主程序旁会指向空目录）。
        let (plan_old, root_old, _) = plan_with_subfolder("list-old");
        write_manifest(&root_old, &manifest_for("winmm.dll", &["winmm.dll"], &[])).expect("manifest");
        // 只有纯文本标记的旧安装：认得出，但版本写空串。
        let (plan_legacy, root_legacy, _) = plan_with_subfolder("list-legacy");
        std::fs::write(root_legacy.join(OPTISCALER_MARKER), "dxgi.dll\n").expect("marker");

        let rows = installed_mods(vec![
            scanned("新装的", &root_new),
            scanned("老位置的", &root_old),
            scanned("只有标记的", &root_legacy),
            scanned("没装的", &game_tree("list-none", &[("Game.exe", 32)])),
        ]);

        assert_eq!(rows.len(), 3, "没装的游戏不该出现在列表里");
        assert_eq!(rows[0].dir, plan.dir.display().to_string());
        assert_eq!(rows[0].version, "0.9.4");
        assert_eq!(rows[0].hook, "dxgi.dll");
        assert_eq!(rows[1].dir, plan_old.root.display().to_string());
        assert_eq!(rows[1].hook, "winmm.dll");
        assert_eq!(rows[2].dir, plan_legacy.root.display().to_string());
        assert_eq!(rows[2].version, "", "旧标记没记版本，不能编一个");
        for dir in [&root_new, &root_old, &root_legacy] {
            std::fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn legacy_marker_installs_are_recognised_and_cleaned() {
        // 0.1.57 及以前只写一个纯文本标记（内容就是注入名），没有账本。
        let (plan, root, _dir) = plan_with_subfolder("legacy");
        std::fs::write(root.join("winmm.dll"), b"opti").expect("dll");
        std::fs::write(root.join("OptiScaler.ini"), b"ini").expect("ini");
        std::fs::write(root.join(OPTISCALER_MARKER), "winmm.dll\n").expect("marker");
        assert!(legacy_installed(&plan), "标记在根目录也要认出来");
        assert!(read_installed(&plan).is_none(), "旧安装没有账本");

        legacy_cleanup(&root).expect("legacy cleanup");
        assert!(!root.join("winmm.dll").exists());
        assert!(!root.join("OptiScaler.ini").exists());
        assert!(!marker_present(&root));
        std::fs::remove_dir_all(&root).ok();
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
            tried: vec!["dxgi.dll".into(), "winmm.dll".into()],
            fsr4: true,
        };
        let json = serde_json::to_string(&manifest).expect("serialize");
        assert!(json.contains("installedAt"), "camelCase for the frontend: {json}");
        assert_eq!(serde_json::from_str::<ModManifest>(&json).ok(), Some(manifest));
        // 以后加字段时，旧账本（只有必填两项）也要能读进来。
        let old = r#"{"version":"0.9.0","hook":"dxgi.dll"}"#;
        let parsed = serde_json::from_str::<ModManifest>(old).expect("legacy manifest");
        assert!(parsed.files.is_empty() && parsed.backups.is_empty() && parsed.dirs.is_empty());
        assert!(parsed.tried.is_empty(), "老账本没有 tried，要能默认成空");
    }
}
