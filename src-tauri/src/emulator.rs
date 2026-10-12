/*
 * 模拟器页（新页签「模拟器」）：一张卡一个平台，能自动装的走「下载 → 解压 → 便携模式 → 记账本」。
 *
 * 为什么单独一个文件而不是塞进 toolbox.rs：工具箱那三张卡是「给已有的游戏打补丁 / 装运行库」，
 * 这一页是「装一整个程序」，两者共用的只有下载与解压（已抽到 `net.rs`）；剩下的判断全都不同
 * —— 装到哪块盘、装完怎么找到主程序、怎么让它别把配置写到 C 盘。
 *
 * 三条定下来的规矩（都是真机踩过的那类坑）：
 *
 * 1. **装到非系统盘**：掌机的 C: 常常只有 64–128 GB，而 RetroArch 一个就 200 MB 上下、
 *    MAME 80 MB，再算上 ROM 与存档，C: 几天就满。默认根目录 = `D:\Emulation\Apps`，
 *    但**不写死 D:**：D: 不存在（很多机器只有一个分区）时退回系统盘，用户也能自己改
 *    （见 `default_root`）。仓库里「导入 ROM」任务的 ROM 根已经是这个路子了。
 *
 * 2. **便携模式**：装完必须让模拟器把配置 / 存档 / 缓存留在**自己目录里**。默认情况下
 *    它们会写到 `%APPDATA%` / `%LOCALAPPDATA%`，于是「卸载 = 删目录」就不成立了 ——
 *    用户在 C 盘留一堆再也用不上的垃圾，而且换机时配置带不走。每个模拟器需要什么标记
 *    见 `PortableMark`。
 *
 * 3. **失败不能留半个安装**：下载 → 解压中转目录 → 找到主程序 → 原子改名搬进去。
 *    中途任何一步失败都把中转目录删掉，目标目录原样不动（重装时旧版留在 `.old` 里，
 *    搬成功了才删）。宁可报错，也不要留一个「装了一半、点启动没反应」的目录。
 */
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
// `emit()` 来自 `Emitter`，只在 Windows 那条路上用得上（装东西的流程），所以按平台挂上。
// `path()`（`Manager`）在 `manifest_path` 里就地在函数体内 use —— 那个函数是跨平台的。
#[cfg(windows)]
use tauri::Emitter;

use crate::i18n::pick;

/// 进度事件名（前端 `useEmulatorProgress` 在听）。
///
/// 非 Windows 上没人发也没人听（装东西整块是 Windows 专属），挂 allow 而不是 cfg：
/// 名字本身是常量，留着不占运行期成本。
#[cfg_attr(not(windows), allow(dead_code))]
pub const EMU_EVENT: &str = "emulator-install-progress";

/// 取消标志。一次只装一个（跟工具箱装 Mod 一个道理：同一时刻只有一个进度条，不必按 id 建表）。
static EMU_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 「现在有没有安装在跑」。
///
/// **这道闸门必须在后端**：一次安装要下几十到两百 MB、还要解压与改名，而两次安装会用**同一个**
/// `staging` 目录和同一个 `target` —— 撞在一起就是「后进来的把先进来的下载删掉」「两次 rename
/// 交错」「账本读-改-写丢行」，最坏是旧安装被挪走而新的没到位。
/// 前端也会把其他卡的按钮禁掉（那是体验），但用户连点两下、或者以后加了快捷键，都可能绕过前端。
#[cfg_attr(not(windows), allow(dead_code))]
static EMU_INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 「同一个官方文件挂在另一台**官方**主机上」。
///
/// 为什么需要它：GitHub 的 release 资产在有些网络下拉不动（用户真机报「街机安装一直提示
/// 下载失败」—— 那个包 87 MB，走 GitHub 时断在中途），而 MAME 官方发布页**同时**把同一个
/// 文件挂在 SourceForge 上（名字、字节数一模一样：`mame0289b_x64.exe` 87,626,249 字节，
/// 两边实测都是 200 + 同一个 Content-Length）。拉不动就换这台官方主机再试一遍，
/// 而不是把用户的掌机指去某个第三方镜像站 —— 那种站上的"同一个文件"没人能核实。
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy)]
enum Mirror {
    /// SourceForge：`https://downloads.sourceforge.net/project/<项目>/<目录>/<文件名>`。
    ///
    /// 目录由 release 的 tag 推出来：MAME 的 tag 是 `mame0289`（`<前缀>` + `0` + `289`），
    /// SourceForge 那边是 `mame/0.289/`。文件名与 GitHub 那侧完全一致，直接用挑中的那个。
    SourceForge {
        project: &'static str,
        /// tag 里版本号前面的固定前缀（MAME 是 `mame`，去掉它剩下 `0289`）。
        tag_prefix: &'static str,
    },
}

/// 模拟器的二进制从哪来。
#[cfg_attr(not(windows), allow(dead_code))]
enum Source {
    /// GitHub Release：`(仓库, 资产名必须包含的小写片段, 备用片段, 备源)`。
    ///
    /// 有两个片段是因为 RPCS3 那种仓库会改命名：现在的构建叫 `..._win64_msvc.7z`，
    /// 2021 年的老构建叫 `..._win64.7z`（没有 `_msvc`）。主片段匹配不上时再用备用的，
    /// 两个都没有才报错。备用片段传空串 = 没有备用。
    Github {
        repo: &'static str,
        asset: &'static str,
        asset_fallback: &'static str,
        /// 官方备源（没有就 `None`）—— 见 `Mirror` 的说明。
        mirror: Option<Mirror>,
    },
    /// 自建 Forgejo/Gitea 的 release（Eden 模拟器）。
    ///
    /// Eden 的代码与发布都不在 GitHub，在自己那台 Forgejo 上
    /// （`https://git.eden-emu.dev/eden-emu/eden`）；它的 API 与 GitHub 形状相近但字段名不同
    /// （`assets[].browser_download_url` 是同一个名字，列表接口是
    /// `/api/v1/repos/<owner>/<repo>/releases?limit=1`），所以单独一个分支比硬塞进
    /// `resolve_github` 清楚。
    Forgejo {
        /// API 根（`https://git.eden-emu.dev/api/v1`）。
        api: &'static str,
        repo: &'static str,
        asset: &'static str,
        asset_fallback: &'static str,
    },
    /// RetroArch 官方的 buildbot：目录列表里既有版本号也有文件，一次请求拿全。
    RetroArchBuildbot,
    /// 官方没给可直链的二进制（RPCS3 的 release 里 0 个附件、Switch 那边原仓库已下架）。
    /// 这种卡不装东西，只把用户送到官网 —— **不拿第三方镜像站顶上**：那是让用户的掌机
    /// 去装一个来路不明的 exe。
    ///
    /// ⚠️ 2026-10-12 起**没有卡用它了**（原来唯一的用户是 Switch/Ryujinx 那张，换上 Eden 之后
    /// 六张卡都能自动装）。故意留着这一档与下面 `resolve()` 里对应的分支：哪天又有个模拟器
    /// 下架、只能指官网，按这条路把卡改回来就行 —— 删掉它省下的代码还不到十行，而重写一遍
    /// 那段"宁可什么都不给，也不指一个核实不了的站"的判断要重新想一遍。
    #[allow(dead_code)]
    Official {
        /// 给用户看的一句话（为什么这里不能自动装）。
        reason: (&'static str, &'static str),
        /// 官方下载页。**空串 = 连官网都没有了**（Switch 就是这种：原项目下架、原来的
        /// 官网也没了）。空的时候界面不给「打开官网」那颗按钮 —— 指一个来路不明的同名站
        /// 比什么都不给更糟。
        url: &'static str,
    },
}

/// 装完之后为了让配置留在自己目录里，需要放下的那个标记。
///
/// **这一张表是逐个去官方文档 / 源码核过的**（2026-10-10，四个模拟器全核）：名字或类型错了
/// 就等于没生效 —— 配置照样写进 `%APPDATA%`，而「卸载 = 删目录」这条承诺就破了。
/// 核错的代价是用户在 C 盘留一堆再也用不到的垃圾，所以**改这里之前必须再核一次**。
#[derive(Clone, Copy)]
#[cfg_attr(not(windows), allow(dead_code))]
enum PortableMark {
    /// 主程序目录下放一个空**目录**。目前只有 RPCS3 用它（`portable` 目录）。
    Dir(&'static str),
    /// 主程序目录下放一个空**文件**。PCSX2 用它（`portable.txt`）。
    ///
    /// 出处：PCSX2 官方文档写明「在 `pcsx2-qt.exe` 同目录建一个空文件 `portable.txt`
    /// 或 `portable.ini`，或者用命令行参数 `-portable`」。没有标记时它把配置写进
    /// Windows 的「文档」目录。**注意是文件、不是目录** —— 做成目录等于没做。
    File(&'static str),
    /// RetroArch 没有「便携标记文件」这回事，判据是 **`retroarch.cfg` 在不在 exe 同目录**
    /// （官方文档：Windows 上先找 exe 同目录的 retroarch.cfg，再找 `%APPDATA%\retroarch.cfg`）。
    ///
    /// 所以这里不是「放个空文件」，而是**真的写一份 cfg** —— 而且下面那些目录键必须写死成
    /// 绝对路径：官方模板里 `savefile_directory` / `savestate_directory` / `system_directory`
    /// 全是**注释掉的空值**，空着时存档落哪儿并不保证在程序目录里。只放一个空 cfg 是假便携。
    RetroArchCfg,
    /// 不需要任何开关。
    ///
    /// - **MAME**：所有路径默认相对**当前工作目录**（`-inipath` = `.;ini;ini/presets`，
    ///   cfg / nvram / state / snap 也都是相对目录名），根本不碰 AppData。
    /// - **shadPS4 不在此列**，它要 `user` 目录，见下面那张卡的 `PortableMark::Dir("user")`。
    None,
}

/// 一个平台 = 一张卡。
///
/// 字段分两拨：`name` / `badge` / `desc` 这些是**卡片要画的**（跨平台都要读），
/// `exe` / `exe_rel` / `portable` / `source` 是**装的时候才用的**（只有 Windows 读得到）。
/// 非 Windows 上后者用不上，但整张表还是要留在代码里 —— 它是这份功能的唯一事实来源。
#[cfg_attr(not(windows), allow(dead_code))]
struct EmulatorDef {
    /// 稳定 id（写进账本、前端按它调命令，**不要改**）。
    id: &'static str,
    /// 平台名（卡上的大标题）。
    name: &'static str,
    /// 平台缩写，画在卡角上的大字（PS2 / PS3 / NS / PS4 / ARC / ALL）。
    badge: &'static str,
    /// 模拟器名（卡上的小字）。
    emulator: &'static str,
    vendor: &'static str,
    /// 卡上的两行说明。
    desc: (&'static str, &'static str),
    /// 安装根目录下的子目录名。
    dir: &'static str,
    /// ROM 落在 `<非系统盘>:\Emulation\ROMs\<rom_dir>` 下。
    ///
    /// 为什么放在这张表里：这是「这个模拟器吃哪个目录的 ROM」的**唯一事实来源** ——
    /// 前端那张「导入 ROM」的分组表（`src/files/taskMeta.ts` 的 `ROM_PLATFORMS`）也用同一套
    /// 目录名，三处（导入 / 预览标签 / 本页的游戏列表）必须是同一个字符串。
    /// 探针里有一条断言盯着：重叠的三种（ps2 / switch / retro）两边必须一致。
    rom_dir: &'static str,
    /// 主程序 exe 的文件名（**核验用**：解压完必须能找到它，找不到就当这次失败）。
    exe: &'static str,
    /// 主程序相对安装目录的路径（`exe` 在子目录里时用，如 shadPS4 的 `shadPS4.exe` 就在根）。
    /// 找不到这个相对路径时会退回按文件名搜（官方换了打包结构也不至于认不出来）。
    exe_rel: &'static str,
    /// 反盗版 / 自制程序之外的免责说明，直接画在卡上（Switch 卡必须写）。
    note: Option<(&'static str, &'static str)>,
    source: Source,
    portable: PortableMark,
}

/// 目录名要找的标记：一个空目录（存在即可，内容无所谓）。
#[cfg_attr(not(windows), allow(dead_code))]
fn touch_dir(dir: &Path, name: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join(name))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn touch_file(dir: &Path, name: &str) -> std::io::Result<()> {
    let path = dir.join(name);
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, b"")
}

/// 把路径拼成 **Windows 风格**（反斜杠分隔）的字符串。
///
/// 为什么不写 `path.to_string_lossy().replace('/', "\\")`：那在 POSIX 路径上会把开头的 `/`
/// 也换成 `\\`，于是 `/var/folders/...` 变成 `\var\folders\...` —— 一个坏路径（写进 cfg
/// 里就是这个模拟器的存档目录，谁也不会去检查它长什么样）。逐段拼就没有这个问题。
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_path(path: &Path) -> String {
    let mut out = String::new();
    for part in path.components() {
        let text = part.as_os_str().to_string_lossy();
        if text.is_empty() {
            continue;
        }
        if part == std::path::Component::RootDir {
            // 根：Windows 的 `D:\`（`Prefix` 那一段已经写进去了）或 POSIX 的 `/` 已经到齐。
            if !out.is_empty() {
                out.push('\\');
            }
            continue;
        }
        if !out.is_empty() && !out.ends_with('\\') {
            out.push('\\');
        }
        out.push_str(&text);
    }
    out
}

/// RetroArch 的便携 cfg 内容：把该留在自己目录里的目录写死成绝对路径。
///
/// 为什么非要自己写一份（而不是让 RetroArch 自己生成）：它没有 cfg 时确实会在 exe 目录新建
/// 一份，但那份官方模板里 `savefile_directory` / `savestate_directory` / `system_directory`
/// 全是**空值**，空着时这些东西落哪儿不受我们控制 —— 而存档是用户最不能丢的。
///
/// 只写这三个键（调研时逐字核过的），**不写没核过的键**：写错名字的键会被它原样留在 cfg 里，
/// 看起来像是配好了，其实没生效 —— 那比不写更坏。用户之后在界面里改设置不会丢：RetroArch
/// 退出时把整份 cfg 写回去，这只是给了它一组正确的初始值。
///
/// `target` 是**最终安装目录**：cfg 会跟着 exe 一起被搬走，所以里面必须写搬家之后的路径。
///
/// 基路径就是 `target` 自己 —— **不是 `target` 再加一层**。搬家那一步是
/// `fs::rename(&exe_dir, target)`（源就是主程序所在目录），所以 `exe_dir` 里的内容
/// **直接落在 `target` 下**；写成 `target\RetroArch-Win64` 会指向一个不存在的目录，
/// 而 RetroArch 只会安静地另造一层、或者回落到 `%APPDATA%` —— 正是这一页要避免的事。
/// （2026-10-10 的对抗性审查抓到的就是这个；当时那条单测是照着错的实现写断言，所以一直绿。）
#[cfg_attr(not(windows), allow(dead_code))]
fn retroarch_cfg(target: &Path) -> String {
    let dir = |name: &str| windows_path(&target.join(name));
    let mut cfg = String::new();
    cfg.push_str("# 由 FantasyHub 写入：让 RetroArch 把存档与系统文件留在自己目录里\n");
    cfg.push_str("# 这一份是初始值；在 RetroArch 界面里改设置后它会自己把整份写回去。\n");
    cfg.push_str(&format!("savefile_directory = \"{}\"\n", dir("saves")));
    cfg.push_str(&format!("savestate_directory = \"{}\"\n", dir("states")));
    cfg.push_str(&format!("system_directory = \"{}\"\n", dir("system")));
    cfg
}

/// RetroArch 的 cfg 会点名的三个目录（它自己只认 cfg 里的路径，不会替我们建）。
#[cfg_attr(not(windows), allow(dead_code))]
const RETROARCH_DIRS: [&str; 3] = ["saves", "states", "system"];

/// 装上之后放便携标记。放在**主程序所在目录**（不是安装根目录）—— 判据看的是 exe 旁边。
///
/// 返回「还需要在安装目录里建哪几个空目录」（相对 `target`）：目前只有 RetroArch 要
/// （它 cfg 里写的那几个路径得真的存在）。返回值是**相对 `target`** 的，因为这一刻 exe 还在
/// 解压中转目录里，等安装流程把整个目录改名到 `target` 之后，相对结构就正好落到最终位置。
#[cfg_attr(not(windows), allow(dead_code))]
fn apply_portable(exe_dir: &Path, mark: PortableMark, target: &Path) -> Result<Vec<&'static str>, String> {
    let result = match mark {
        PortableMark::Dir(name) => touch_dir(exe_dir, name).map(|_| Vec::new()),
        PortableMark::File(name) => touch_file(exe_dir, name).map(|_| Vec::new()),
        PortableMark::None => return Ok(Vec::new()),
        PortableMark::RetroArchCfg => {
            // cfg 里那几个目录先建出来再让 RetroArch 见它：只写路径不建目录的话，用户把
            // BIOS 放进 `system\` 时得先自己猜出这个目录名（而它在 cfg 里写的是反斜杠路径）。
            let mut dirs = Vec::new();
            let mut build = || -> std::io::Result<()> {
                for name in RETROARCH_DIRS {
                    std::fs::create_dir_all(exe_dir.join(name))?;
                    dirs.push(name);
                }
                std::fs::write(exe_dir.join("retroarch.cfg"), retroarch_cfg(target))
            };
            build().map(|_| dirs)
        }
    };
    result.map_err(|err| {
        pick(
            &format!("装好了，但没法让它进入便携模式：{err}"),
            &format!("Installed, but portable mode couldn't be enabled: {err}"),
        )
    })
}

const CATALOG: &[EmulatorDef] = &[
    EmulatorDef {
        id: "ps2",
        name: "PlayStation 2",
        badge: "PS2",
        emulator: "PCSX2",
        vendor: "PCSX2 Team",
        desc: (
            "PS2 上兼容性最好的模拟器，官方 Windows 版。",
            "The most compatible PS2 emulator. Official Windows build.",
        ),
        dir: "PCSX2",
        rom_dir: "ps2",
        exe: "pcsx2-qt.exe",
        exe_rel: "pcsx2-qt.exe",
        note: None,
        source: Source::Github {
            repo: "PCSX2/pcsx2",
            asset: "windows-x64-qt.7z",
            asset_fallback: "",
            mirror: None,
        },
        // PCSX2 认的是 exe 同目录的空**文件** `portable.txt`（官方文档；它还有 `-portable`
        // 参数，但用户从资源管理器直接双击 exe 时参数就没了，标记文件更稳）。
        portable: PortableMark::File("portable.txt"),
    },
    EmulatorDef {
        id: "ps3",
        name: "PlayStation 3",
        badge: "PS3",
        emulator: "RPCS3",
        vendor: "RPCS3 Team",
        desc: (
            "PS3 模拟器。从不发稳定版，装到的是官方最新的滚动构建。",
            "PS3 emulator. No stable builds — you get the newest official rolling build.",
        ),
        dir: "RPCS3",
        rom_dir: "ps3",
        exe: "rpcs3.exe",
        exe_rel: "rpcs3.exe",
        note: None,
        // 主仓库（`RPCS3/rpcs3`）的 release 里**一个附件都没有**（官网只让去 rpcs3.net 下，
        // 而那个站有 Cloudflare）。官方的 Windows 二进制在**另一个仓库**
        // `RPCS3/rpcs3-binaries-win`：每次构建发一个 release，tag 是 `build-<40 位 sha>`，
        // 附件是 `rpcs3-v<版本>-<构建号>-<短sha>_win64_msvc.7z`（2021 年的老构建没有 `_msvc`）。
        // 2026-10-10 实测：直链 HTTP 200 / Range 206、38,909,481 字节 —— 所以这一项能自动装。
        source: Source::Github {
            repo: "RPCS3/rpcs3-binaries-win",
            asset: "_win64_msvc.7z",
            asset_fallback: "_win64.7z",
            mirror: None,
        },
        // RPCS3 当前版本（源码 `Utilities/File.cpp` 的 `fs::get_config_dir()`）默认就用 exe
        // 所在目录，本来就不写 AppData；这个 `portable` 目录是官方也认的显式开关。
        portable: PortableMark::Dir("portable"),
    },
    EmulatorDef {
        id: "switch",
        name: "Nintendo Switch",
        badge: "NS",
        // 2026-10-12 用户要求换掉：Ryujinx 2024 年下架（那张卡原来只写「本程序不提供下载」，
        // 等于这一格永远装不了）。Eden 是它之后还在维护的一支（Yuzu/Suyu 血统），
        // 官方有 Windows 包、有稳定版、有自建发布站 —— 于是这一格回到「能自动装」。
        emulator: "Eden",
        vendor: "Eden Project",
        desc: (
            "Switch 模拟器（原 Ryujinx 下架后换成 Eden）。",
            "Switch emulator — Eden, after Ryujinx was taken down.",
        ),
        dir: "Eden",
        rom_dir: "switch",
        exe: "eden.exe",
        exe_rel: "eden.exe",
        note: Some((
            "只玩你自己拥有的游戏。本程序不附带任何游戏本体。",
            "Play games you own. This app ships no game content.",
        )),
        // Eden 的代码与发布都在它自己的 Forgejo 上（不在 GitHub）。资产名形如
        // `Eden-Windows-v0.2.1-amd64-msvc-standard.zip`。
        //
        // **为什么首选 msvc-standard 而不是官方推荐的 clang-pgo**（2026-10-12 逐条核过官方
        // release notes 的分档表）：clang-pgo 是 MinGW + PGO，官方写明「要求 Ryzen / 第 4 代
        // Intel 或更新」（即 x86-64-v3），老掌机（Jasper Lake 那类）跑它会直接非法指令崩掉；
        // msvc-standard 只要求 x86-64 基线，Intel / AMD 通吃，官方也把它写成「其他构建出图形
        // 问题时的兜底」。拿不准的硬件上，能跑比快一点重要。
        // 2026-10-12 实测：直链 HTTP 200、Content-Length 31,319,001、content-type: application/zip、
        // 走 Cloudflare（cf-cache-status: HIT）、支持 Range（206）。
        source: Source::Forgejo {
            api: "https://git.eden-emu.dev/api/v1",
            repo: "eden-emu/eden",
            asset: "amd64-msvc-standard.zip",
            // msvc 那份哪天不发了，就退到同架构的 gcc 构建（同样要求 x86-64-v3，但总比 arm64 强）。
            asset_fallback: "amd64-gcc-standard.zip",
        },
        // 源码 `src/common/fs/path_util.cpp::Reinitialize()`：Windows 上先看
        // **exe 同目录下有没有 `user` 目录**（`#define PORTABLE_DIR "user"`，见 `fs_paths.h`），
        // 有就整个数据目录（config / nand / keys / saves）都落在那里，没有才退回 `%APPDATA%\eden`。
        // 和 shadPS4 那个 `user` 目录是同一个套路，但不是同一个程序 —— 改这里之前重新核一遍。
        portable: PortableMark::Dir("user"),
    },
    EmulatorDef {
        id: "ps4",
        name: "PlayStation 4",
        badge: "PS4",
        emulator: "shadPS4",
        vendor: "shadPS4 Team",
        desc: (
            "PS4 模拟器，还在早期，能跑通的商业游戏不多。",
            "PS4 emulator. Still early — only a handful of commercial games boot.",
        ),
        dir: "shadPS4",
        rom_dir: "ps4",
        exe: "shadPS4.exe",
        exe_rel: "shadPS4.exe",
        note: None,
        source: Source::Github {
            repo: "shadps4-emu/shadPS4",
            asset: "win64",
            asset_fallback: "",
            mirror: None,
        },
        // shadPS4 认的是 exe 同目录下一个叫 `user` 的**文件夹**（源码 `path_util.cpp` 的
        // `PORTABLE_DIR = "user"`，判断用的是进程工作目录；我们从 exe 所在目录启动它，
        // 见 `scan.rs::spawn_exe` 的 `current_dir`）。没有它时配置写到 `%APPDATA%\shadPS4`。
        portable: PortableMark::Dir("user"),
    },
    /*
     * ⚠️ TODO（用户 2026-10-12）：**这张卡不是用户想要的街机模拟器**，原话「我发现你这个街机模拟器
     * 用的不对，这个模拟器不是我想要的那个模拟器，这个问题你记一下之后改吧」。
     * 现在这张卡是 MAME（`mame.exe` + 7z 自解压包，能自动装、romset 要对 0.289）。
     * 等用户说清他想要的是哪一个（FBNeo / RetroArch 的 FBNeo 核心 / 别的前端？）再换 ——
     * 换的时候注意三处一起动：`Source`（新的下载源）、`PortableMark`（便携标记）、
     * `rom_dir`（ROM 目录名，要和 `src/files/taskMeta.ts` 的对照表对齐）。
     */
    EmulatorDef {
        id: "arcade",
        name: "街机",
        badge: "ARC",
        emulator: "MAME",
        vendor: "MAME Team",
        desc: (
            "街机模拟器，官方 Windows 自解压包。",
            "Arcade emulator. Official self-extracting Windows package.",
        ),
        dir: "MAME",
        rom_dir: "arcade",
        exe: "mame.exe",
        exe_rel: "mame.exe",
        note: None,
        source: Source::Github {
            repo: "mamedev/mame",
            asset: "b_x64.exe",
            asset_fallback: "x64.exe",
            // 真机报「一直提示下载失败」时加的这一档：同一个文件 MAME 官方也挂在 SourceForge，
            // 而 GitHub 那 87 MB 在某些网络下拉不完（2026-10-12 用户真机）。
            mirror: Some(Mirror::SourceForge {
                project: "mame",
                tag_prefix: "mame",
            }),
        },
        // **这一项有一处没能本机验证**：MAME 的 `mame0289b_x64.exe` 是一个 7z 自解压包
        // （文件头是 `MZ` 的 PE 程序，7z 结构在文件尾）。`extract_archive` 按扩展名把它
        // 当 7z 解，走的还是 `sevenz_rust2` —— 标准 7z 库都支持从尾部读 SFX，理论上没问题，
        // 但这台开发机（macOS）下不动这 87 MB 的包，没法实地验一次。
        // 真机上如果这一步报「读不出这个 7z」，就是这里：换成 `mame0289lx.zip`
        // （官方另一个附件，Linux 版）之外的方案，或者改指 mamedev.org 的安装包。
        // 失败是干净的（没有任何东西落进安装目录），所以这个未知数的代价只是「装不上」。
        // MAME 所有路径默认相对**当前工作目录**（`-inipath` = `.;ini;ini/presets`，cfg/nvram/
        // state 也都是相对目录名），根本不碰 AppData —— 不需要任何标记。
        // 前提是「工作目录 = 安装目录」：`scan.rs::spawn_exe` 启动时把工作目录设成了 exe 所在
        // 目录，所以从这一页启动它就对得上；用户从别处（比如桌面快捷方式）启动则取决于那个
        // 快捷方式的「起始位置」—— 那是用户自己可控的事，不是我们能改的。
        portable: PortableMark::None,
    },
    EmulatorDef {
        id: "retro",
        name: "全能模拟器",
        badge: "ALL",
        emulator: "RetroArch",
        vendor: "Libretro",
        desc: (
            "一个前端带一堆核心，NES 到 PSP 都能跑。核心另外下。",
            "One frontend with many cores — NES through PSP. Cores are a separate download.",
        ),
        dir: "RetroArch",
        rom_dir: "retro",
        exe: "retroarch.exe",
        exe_rel: "retroarch.exe",
        note: None,
        source: Source::RetroArchBuildbot,
        portable: PortableMark::RetroArchCfg,
    },
];

fn def_by_id(id: &str) -> Option<&'static EmulatorDef> {
    CATALOG.iter().find(|entry| entry.id == id)
}

/* ── 账本 ───────────────────────────────────────────────────────────────── */

/// 一个装好的模拟器。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledEntry {
    version: String,
    /// 安装目录（绝对路径）。
    dir: String,
    /// 主程序绝对路径（启动用它）。
    exe: String,
    installed_at: u64,
    /// 安装包的字节数（下次更新时显示「要下多少」用）。
    #[serde(default)]
    bytes: u64,
}

/// 账本。字段都带 `default`：以后加字段时旧账本仍能读进来（跟 OptiScaler 的账本一个规矩）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// 用户选的安装根目录。空 = 还没选过，用 `default_root()`。
    #[serde(default)]
    root: String,
    /// `emulator id` → 安装记录。
    #[serde(default)]
    installed: std::collections::BTreeMap<String, InstalledEntry>,
}

fn manifest_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| pick(&format!("无法定位配置目录：{err}"), &format!("Couldn't locate the config folder: {err}")))?;
    std::fs::create_dir_all(&dir).map_err(|err| {
        pick(
            &format!("无法创建配置目录：{err}"),
            &format!("Couldn't create the config folder: {err}"),
        )
    })?;
    Ok(dir.join("emulators.json"))
}

/// 读账本。读不动就当空的（不是错误：第一次跑本来就没有这个文件）。
fn read_manifest(app: &tauri::AppHandle) -> Manifest {
    manifest_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_manifest(app: &tauri::AppHandle, manifest: &Manifest) -> Result<(), String> {
    let path = manifest_path(app)?;
    let text = serde_json::to_string_pretty(manifest).map_err(|err| {
        pick(
            &format!("无法保存安装记录：{err}"),
            &format!("Couldn't save the install record: {err}"),
        )
    })?;
    std::fs::write(&path, text).map_err(|err| {
        pick(
            &format!("无法保存安装记录：{err}"),
            &format!("Couldn't save the install record: {err}"),
        )
    })
}

/* ── 安装根目录 ─────────────────────────────────────────────────────────── */

/// 默认装哪儿：**第一块非系统盘**（掌机上就是 D:），没有就退回系统盘。
///
/// 为什么不写死 `D:\`：很多掌机只有一个分区，写死之后那一页整张卡都是死的。
/// 为什么优先非系统盘：C: 常常只有 64–128 GB，模拟器加 ROM 上来就是几十 GB。
fn default_root() -> PathBuf {
    root_from_drives(&crate::sysinfo::drives_now())
}

/// 从一张盘表里挑出装哪儿。
///
/// 抽成纯函数是为了能单测：`drives_now()` 在本机（macOS）永远是空表，不抽出来这段判定
/// 就一行都测不到。判定的顺序是「内置盘 + 非系统盘」→「任何非系统盘」→「第一块盘」——
/// 掌机上第一档就是 D:；只有一块盘的机器退到系统盘（还能用，只是占系统空间）；
/// 一块盘都读不到时给一个明确属于本程序的目录，**绝不往别处写**。
fn root_from_drives(drives: &[crate::sysinfo::DriveSpace]) -> PathBuf {
    let is_system = |mount: &str| mount.trim().to_ascii_uppercase().starts_with('C');
    let pick_drive = drives
        .iter()
        .find(|row| row.kind == "fixed" && !is_system(&row.mount))
        .or_else(|| drives.iter().find(|row| !is_system(&row.mount)))
        .or_else(|| drives.first());
    match pick_drive {
        Some(row) => PathBuf::from(format!(
            "{}\\Emulation\\Apps",
            row.mount.trim_end_matches('\\')
        )),
        None => home_fallback(),
    }
}

#[cfg(not(windows))]
#[cfg_attr(not(windows), allow(dead_code))]
fn home_fallback() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".fantasyhub")
        .join("Emulation")
}

#[cfg(windows)]
#[cfg_attr(not(windows), allow(dead_code))]
fn home_fallback() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\"))
        .join("Emulation")
        .join("Apps")
}

/// 这次该用哪个根目录：用户选过的优先，否则用默认值。
fn current_root(app: &tauri::AppHandle) -> PathBuf {
    let manifest = read_manifest(app);
    if manifest.root.trim().is_empty() {
        default_root()
    } else {
        PathBuf::from(manifest.root)
    }
}

/* ── 查最新版本 / 下载地址 ─────────────────────────────────────────────── */

/// 查到的可装版本。只在 Windows 上被构造（查版本要走网络）。
#[cfg_attr(not(windows), allow(dead_code))]
struct Resolved {
    version: String,
    /// 依次尝试的下载地址：**第一项是主源**，后面是同一个文件的官方备源（见 `Mirror`）。
    /// 一个都没有时 `resolve` 就已经报错了，所以这里至少一项。
    urls: Vec<String>,
    file_name: String,
    bytes: u64,
    /// 看 release 说明用（本版没用到，但账本与卡片以后要）。
    #[allow(dead_code)]
    page: String,
}

/// 从附件名里抠出人类看得懂的版本号（`rpcs3-v0.0.43-20273-987129bc_win64_msvc.7z` → `0.0.43`）。
///
/// 为什么不能拿 tag 当版本号：RPCS3 的二进制仓库 tag 是 `build-<40 位 commit sha>`，每次构建
/// 都变、而且不是版本号；它的版本号只存在于**附件名**里。通用做法是找名字里第一个
/// `v<数字>` 的位置（`v0.0.43` / `v.0.19.0` / `v2.8.2` 都吃），取到下一个分隔符为止。
#[cfg_attr(not(windows), allow(dead_code))]
fn version_from_asset_name(name: &str) -> Option<String> {
    let bytes = name.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] != b'v' {
            continue;
        }
        let rest = &name[index + 1..];
        let digits = rest.strip_prefix('.').unwrap_or(rest);
        if !digits.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let end = digits
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(digits.len());
        let version = digits[..end].trim_end_matches('.').to_string();
        if !version.is_empty() {
            return Some(version);
        }
    }
    None
}

/// tag → 卡片上显示的版本号。
///
/// 三种情况（都是实测见过的形状）：
///   - `v0.2.1` / `v.0.19.0`（Eden / shadPS4）→ 去掉 `v` / `v.` 前缀 → `0.2.1` / `0.19.0`；
///   - `<字母><纯数字>`（MAME 的 tag 是 `mame0289`）→ `0.289` —— 它把点省了当 tag，
///     直接显示 `mame0289` 在卡片上很难看；
///   - 其他（RPCS3 的 `build-<40 位 sha>`）原样返回 —— 但那种仓库的**附件名**里有真版本号，
///     `version_from_asset_name` 会先接住（见调用点）。
#[cfg_attr(not(windows), allow(dead_code))]
fn version_from_tag(tag: &str) -> String {
    let trimmed = tag.trim_start_matches('v').trim_start_matches('.');
    if trimmed != tag {
        return trimmed.to_string();
    }
    let digits = tag.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    let prefix = &tag[..tag.len() - digits.len()];
    if !prefix.is_empty() && digits.len() >= 2 && digits.chars().all(|c| c.is_ascii_digit()) {
        let (head, rest) = digits.split_at(1);
        return format!("{head}.{rest}");
    }
    tag.to_string()
}

/// GitHub Release 里挑资产。返回 `Err` 时里面已经是给用户看的话。
#[cfg(windows)]
fn resolve_github(
    repo: &str,
    asset_needle: &str,
    asset_fallback: &str,
    mirror: Option<Mirror>,
) -> Result<Resolved, String> {
    let body = crate::net::get_text(
        &format!("https://api.github.com/repos/{repo}/releases/latest"),
        512 * 1024,
    )?;
    github_from_json(&body, asset_needle, asset_fallback, mirror)
}

/// 「GitHub 的 release JSON → 下载地址」——**纯函数**，与网络无关。
///
/// 为什么拆出来：`ureq` 只在 Windows 依赖里，这段逻辑要是和 HTTP 调用写在一起，本机
/// （macOS）就一行都测不到 —— 而它正是「挑错资产 / 版本号抠错 / 备源地址推错」这些
/// 一错就要重发一版的地方。拆开之后本机可以直接拿真实的 API 返回（缩掉几个字段）当夹具测。
#[cfg_attr(not(windows), allow(dead_code))]
fn github_from_json(
    body: &str,
    asset_needle: &str,
    asset_fallback: &str,
    mirror: Option<Mirror>,
) -> Result<Resolved, String> {
    let release: serde_json::Value = serde_json::from_str(body).map_err(|err| {
        pick(
            &format!("读不懂 GitHub 的返回：{err}"),
            &format!("Couldn't parse GitHub's reply: {err}"),
        )
    })?;
    // 预发布与草稿不当正式版：draft 不会出现在 latest 里，但 prerelease 会。
    if release
        .get("prerelease")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Err(pick("最新版还是预发布版，这次先不装。", "The newest build is still a pre-release."));
    }
    let tag = release
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let page = release
        .get("html_url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let assets = release
        .get("assets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let asset_name = |asset: &serde_json::Value| {
        asset
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };
    // 先按主片段找，再按备用片段找（RPCS3 的老构建没有 `_msvc` 后缀）。
    // 两条都要求名字里带 `.7z`/`.zip`/`.exe` 这类归档后缀，免得匹配到 `.sha256` 校验文件。
    let matches = |asset: &serde_json::Value, needle: &str| {
        let name = asset_name(asset);
        !needle.is_empty()
            && name.contains(needle)
            && [".7z", ".zip", ".exe", ".tar.xz"]
                .iter()
                .any(|ext| name.ends_with(ext))
    };
    let needle = asset_needle.to_ascii_lowercase();
    let fallback = asset_fallback.to_ascii_lowercase();
    let asset = assets
        .iter()
        .find(|asset| matches(asset, &needle))
        .or_else(|| assets.iter().find(|asset| matches(asset, &fallback)))
        .ok_or_else(|| {
            pick(
                "这个版本里没有我们要的那个安装包（官方换了打包方式），已停止下载。",
                "This release has no asset matching our pattern (packaging changed); download stopped.",
            )
        })?;
    // 只认直链：`browser_download_url` 才是能直接下的，`url` 那个要带 token 的请求头。
    let url = asset
        .get("browser_download_url")
        .and_then(|value| value.as_str())
        .ok_or_else(|| pick("这个安装包没给下载地址。", "That asset has no download URL."))?
        .to_string();
    let file_name = asset
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("download.bin")
        .to_string();
    let bytes = asset
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    // 版本号优先从**附件名**里取（RPCS3 的 tag 是 `build-<sha>`，不是版本号）；
    // 附件名里没有 `v<数字>` 那种写法时退回 tag —— 但要把 `v` / `v.` 这类前缀去掉，
    // 否则卡片上会写「.0.19.0」（shadPS4 的 tag 就是 `v.0.19.0`）。
    let version = version_from_asset_name(&file_name).unwrap_or_else(|| version_from_tag(&tag));
    let mut urls = vec![url];
    if let Some(mirror) = mirror {
        if let Some(fallback) = mirror_url(&mirror, &tag, &file_name) {
            urls.push(fallback);
        }
    }
    Ok(Resolved {
        version,
        urls,
        file_name,
        bytes,
        page,
    })
}

/// 官方备源的直链（推不出来就返回 `None`，那就只剩主源 —— 不编地址）。
#[cfg_attr(not(windows), allow(dead_code))]
fn mirror_url(mirror: &Mirror, tag: &str, file_name: &str) -> Option<String> {
    match mirror {
        Mirror::SourceForge {
            project,
            tag_prefix,
        } => {
            // `mame0289` → `0289` → `0.289`（SourceForge 的目录名是带点的版本号）。
            let digits = tag.strip_prefix(tag_prefix)?;
            let (head, rest) = digits.split_at(digits.len().min(1));
            if rest.is_empty() || !head.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            Some(format!(
                "https://downloads.sourceforge.net/project/{project}/{tag_prefix}/{head}.{rest}/{file_name}"
            ))
        }
    }
}

/// Forgejo / Gitea 的 release：`/api/v1/repos/<owner>/<repo>/releases?limit=1`。
///
/// 与 GitHub 那段的差别只有三处：地址、`assets[].browser_download_url` 之外不需要别的字段、
/// 以及**列表本身就是数组**（GitHub 是单个对象）。其余判断（预发布不装、按片段挑资产、
/// 归档后缀、版本号从附件名里抠）照旧 —— 两处各写一套迟早会走偏。
#[cfg(windows)]
fn resolve_forgejo(
    api: &str,
    repo: &str,
    asset_needle: &str,
    asset_fallback: &str,
) -> Result<Resolved, String> {
    // 取 20 条而不是 1 条：要靠**tag 的形状**挑稳定版，见 `forgejo_from_json`。
    let body = crate::net::get_text(
        &format!("{api}/repos/{repo}/releases?limit=20"),
        1024 * 1024,
    )?;
    forgejo_from_json(&body, asset_needle, asset_fallback)
}

/// 「Forgejo 的 releases JSON → 下载地址」——纯函数，理由同 `github_from_json`。
#[cfg_attr(not(windows), allow(dead_code))]
fn forgejo_from_json(
    body: &str,
    asset_needle: &str,
    asset_fallback: &str,
) -> Result<Resolved, String> {
    let releases: serde_json::Value = serde_json::from_str(body).map_err(|err| {
        pick(
            &format!("读不懂发布站的返回：{err}"),
            &format!("Couldn't parse the release server's reply: {err}"),
        )
    })?;
    let list = releases.as_array().ok_or_else(|| {
        pick(
            "发布站的返回不是一份 release 列表。",
            "The release server didn't return a list of releases.",
        )
    })?;
    /*
     * **稳定版只能靠 tag 的形状挑**：Eden 那台 Forgejo 上 `prerelease` 字段没有区分度 ——
     * 2026-10-12 实测 14 条 release（含全部 rc）的 `prerelease` **统统是 false**，
     * 信它就会把 `v0.2.0-rc2` 装到用户机器上。所以：`tag_name` 必须严格是 `v<数字>.<数字>.<数字>`，
     * 且仍要过一遍 `prerelease` 这道闸（别的 Forgejo 实例是正常填的）。
     */
    let is_stable = |release: &serde_json::Value| {
        if release
            .get("prerelease")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return false;
        }
        release
            .get("tag_name")
            .and_then(|value| value.as_str())
            .is_some_and(|tag| {
                let mut parts = tag.trim_start_matches('v').split('.');
                let (Some(a), Some(b), Some(c), None) =
                    (parts.next(), parts.next(), parts.next(), parts.next())
                else {
                    return false;
                };
                [a, b, c]
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            })
    };
    let release = list.iter().find(|release| is_stable(release)).ok_or_else(|| {
        pick(
            "发布站上没有正式版（只有预发布或每日构建），这次先不装。",
            "The release server has no stable release (only pre-releases or nightlies).",
        )
    })?;
    let tag = release
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let page = release
        .get("html_url")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let assets = release
        .get("assets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let matches = |asset: &serde_json::Value, needle: &str| {
        let name = asset
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        !needle.is_empty()
            && name.contains(needle)
            && [".7z", ".zip", ".exe", ".tar.xz"]
                .iter()
                .any(|ext| name.ends_with(ext))
    };
    let needle = asset_needle.to_ascii_lowercase();
    let fallback = asset_fallback.to_ascii_lowercase();
    let asset = assets
        .iter()
        .find(|asset| matches(asset, &needle))
        .or_else(|| assets.iter().find(|asset| matches(asset, &fallback)))
        .ok_or_else(|| {
            pick(
                "这个版本里没有我们要的那个安装包（官方换了打包方式），已停止下载。",
                "This release has no asset matching our pattern (packaging changed); download stopped.",
            )
        })?;
    let url = asset
        .get("browser_download_url")
        .and_then(|value| value.as_str())
        .ok_or_else(|| pick("这个安装包没给下载地址。", "That asset has no download URL."))?
        .to_string();
    let file_name = asset
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("download.bin")
        .to_string();
    let bytes = asset
        .get("size")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let version = version_from_asset_name(&file_name).unwrap_or_else(|| version_from_tag(&tag));
    Ok(Resolved {
        version,
        urls: vec![url],
        file_name,
        bytes,
        page,
    })
}

/// RetroArch：官方 buildbot 的目录列表里同时有版本号和文件名，一次请求全拿到。
///
/// 为什么不用它 GitHub 的 release：那个 release 只有源码包（`sourceonly`），
/// Windows 二进制只在 buildbot 上。
#[cfg(windows)]
fn resolve_retroarch() -> Result<Resolved, String> {
    let body = crate::net::get_text("https://buildbot.libretro.com/stable/", 512 * 1024)?;
    // 形如 `/stable/1.22.2/`，取版本号最大的那个。
    let version = body
        .split("href=\"")
        .filter_map(|chunk| chunk.split('"').next())
        .filter_map(|href| {
            let trimmed = href.trim_end_matches('/');
            let value = trimmed.rsplit('/').next().unwrap_or("");
            let mut parts = value.split('.');
            let major = parts.next()?.parse::<u32>().ok()?;
            let minor = parts.next()?.parse::<u32>().ok()?;
            if parts.next().is_none() {
                return None;
            }
            Some((major, minor, value.to_string()))
        })
        .max_by_key(|(major, minor, _)| (*major, *minor))
        .map(|(_, _, value)| value)
        .ok_or_else(|| {
            pick(
                "没在官方构建站上找到 RetroArch 的版本号。",
                "Couldn't find a RetroArch version on the official build server.",
            )
        })?;
    let url = format!("https://buildbot.libretro.com/stable/{version}/windows/x86_64/RetroArch.7z");
    Ok(Resolved {
        version,
        urls: vec![url],
        file_name: "RetroArch.7z".to_string(),
        // 目录列表里没有大小，交给下载时的 Content-Length。
        bytes: 0,
        page: "https://www.retroarch.com/?page=platforms".to_string(),
    })
}

#[cfg_attr(not(windows), allow(dead_code))]
fn resolve(def: &EmulatorDef) -> Result<Resolved, String> {
    // 网络那几个函数是 Windows 专属（`ureq` 在 Cargo.toml 的 Windows 分区里，见 `net.rs`）。
    // 非 Windows 上 `emulator_install_now` 在这之前就已经返回「只能在 Windows 上用」了，
    // 所以这里只需要一个能让本机（macOS）编过去的出口。
    // 两个分支都是块表达式，直接当函数的返回值（写 `return` 的话 clippy 会说多余）。
    #[cfg(not(windows))]
    {
        let _ = def;
        Err(pick(
            "这一项没有可直接下载的官方安装包。",
            "This one has no official package available for direct download.",
        ))
    }
    #[cfg(windows)]
    {
        match &def.source {
            Source::Github {
                repo,
                asset,
                asset_fallback,
                mirror,
            } => resolve_github(repo, asset, asset_fallback, *mirror),
            Source::Forgejo {
                api,
                repo,
                asset,
                asset_fallback,
            } => resolve_forgejo(api, repo, asset, asset_fallback),
            Source::RetroArchBuildbot => resolve_retroarch(),
            Source::Official { .. } => Err(pick(
                "这一项没有可直接下载的官方安装包。",
                "This one has no official package available for direct download.",
            )),
        }
    }
}

/* ── 状态（卡片画什么） ────────────────────────────────────────────────── */

/// 一张卡要画的全部内容（前端 `EmulatorStatus`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorStatus {
    pub id: String,
    pub name: String,
    pub badge: String,
    pub emulator: String,
    pub vendor: String,
    pub desc: String,
    /// 免责 / 说明那行（可能为空）。
    pub note: String,
    /// 自动装不了时那句原因（空 = 能自动装）。
    pub manual_reason: String,
    /// 手动项的官网地址。
    pub manual_url: String,
    pub installed: bool,
    pub version: String,
    pub dir: String,
    /// ROM 根下这个平台的子目录名（见 `EmulatorDef::rom_dir`）。
    pub rom_dir: String,
    pub exe: String,
    /// 已占用的字节数（没装 = 0）。按需量，见 `with_size`。
    pub bytes: u64,
    /// 能不能自动装（非 Windows 上为 false：解压与启动都做不到）。
    pub supported: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
/// 一张卡的状态。`root` 由调用方传进来（`emulator_list` 只读一次盘表 —— 六张卡各读一次
/// 等于把盘符探测（有些机器上会退到起 PowerShell 的 WMI 兜底）跑六遍）。
fn status_for(
    manifest: &Manifest,
    def: &EmulatorDef,
    root: &Path,
    fallback_root: &Path,
) -> EmulatorStatus {
    let entry = manifest.installed.get(def.id);
    // 判「装了没有」的目录：**账本里记的那个优先**。
    //
    // 为什么不是「当前安装根目录 + 目录名」：用户换过安装根目录之后，已经装好的那几份还在
    // 原地（换路径只影响以后装的，界面上就是这么承诺的）。按新根目录去找，它们会集体变成
    // 「未安装」—— 按钮消失、旧目录成孤儿、再点安装还会装第二份。而 `emulator_sizes` 一直
    // 是按账本的目录量的，两个命令口径不一致本身就是个 bug。
    let (dir, recorded) = match entry {
        Some(entry) if !entry.dir.trim().is_empty() => (PathBuf::from(&entry.dir), true),
        _ => (root.join(def.dir), false),
    };
    // 「装了没有」以**主程序在不在**为准：账本可能被用户手动删了目录而失效，
    // 而一个没有 exe 的目录点启动只会报错。账本只用来补版本号 / 体积这类信息。
    let mut exe = find_exe(&dir, def).unwrap_or_else(|| dir.join(def.exe_rel));
    let mut dir = dir;
    let mut installed = exe.is_file();
    // 账本记的目录里没有主程序（用户手删了 / 挪走了）：再按当前根目录找一次，两处都没有才
    // 算未安装。账本那一行留着不动 —— 用户可能只是没插那块盘（D: 是 SD 卡时很常见）。
    if !installed && recorded {
        let fallback = fallback_root.join(def.dir);
        let found = find_exe(&fallback, def).unwrap_or_else(|| fallback.join(def.exe_rel));
        if found.is_file() {
            dir = fallback;
            exe = found;
            installed = true;
        }
    }
    let (desc, manual_reason, manual_url) = match &def.source {
        Source::Official { reason, url } => (
            pick(def.desc.0, def.desc.1).to_string(),
            pick(reason.0, reason.1).to_string(),
            (*url).to_string(),
        ),
        _ => (pick(def.desc.0, def.desc.1).to_string(), String::new(), String::new()),
    };
    EmulatorStatus {
        id: def.id.to_string(),
        name: def.name.to_string(),
        badge: def.badge.to_string(),
        emulator: def.emulator.to_string(),
        vendor: def.vendor.to_string(),
        desc,
        note: def.note.map(|note| pick(note.0, note.1).to_string()).unwrap_or_default(),
        manual_reason,
        manual_url,
        installed,
        version: if installed {
            entry.map(|entry| entry.version.clone()).unwrap_or_default()
        } else {
            String::new()
        },
        dir: dir.to_string_lossy().to_string(),
        rom_dir: def.rom_dir.to_string(),
        exe: exe.to_string_lossy().to_string(),
        bytes: if installed {
            entry.map(|entry| entry.bytes).unwrap_or(0)
        } else {
            0
        },
        supported: cfg!(windows),
    }
}

/// 在安装目录里找主程序：先看约定的相对路径，找不到再按文件名往下搜（最多 4 层）。
///
/// 为什么要搜：官方换一次打包结构（多套一层目录、换个版本号目录名），写死的路径就失效，
/// 而「装好了却找不到 exe」在用户眼里就是「装失败了」。写死的那条路径仍然优先 ——
/// 搜是兜底，不是主路径。
fn find_exe(dir: &Path, def: &EmulatorDef) -> Option<PathBuf> {
    let direct = dir.join(def.exe_rel);
    if direct.is_file() {
        return Some(direct);
    }
    search_named(dir, def.exe, 4)
}

/// 我们自己的两个中转目录（下载中转 / 重装备份）的目录名前缀。
///
/// 这两个目录里**也可能有一份完整可用的主程序**（重装备份就是上一版的原样目录），所以按
/// 文件名往下搜时必须跳过它们，否则会出现两种很难查的假象：
///   - `emulator_list` 把「只剩一份失败备份」的目录报成「已安装」；
///   - 卸载时那道安全闸门（「目录里有主程序才允许删」）在 `.backup-<id>` 里找到了
///     `mame.exe`，于是**把一个其实没有主程序的目录删掉了** —— 那道闸门本来就是为了防这个。
const TEMP_DIR_PREFIXES: [&str; 2] = [".staging-", ".backup-"];

fn is_temp_dir(name: &str) -> bool {
    TEMP_DIR_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn search_named(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        if path.is_dir() {
            if is_temp_dir(&file_name) {
                continue;
            }
            dirs.push(path);
        } else if file_name.eq_ignore_ascii_case(name) {
            return Some(path);
        }
    }
    dirs.sort();
    dirs.into_iter()
        .find_map(|next| search_named(&next, name, depth - 1))
}

/* ── 命令 ──────────────────────────────────────────────────────────────── */

/// 安装根目录 + 这台机器上能不能装。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorRoot {
    pub root: String,
    /// 默认值（用户没选过时就是它）。界面用它写「恢复默认」。
    pub default_root: String,
    /// 是不是用户自己选的（false = 正在用默认值）。
    pub custom: bool,
    /// 能不能装（macOS 上为 false）。
    pub supported: bool,
}

#[tauri::command]
pub async fn emulator_root(app: tauri::AppHandle) -> EmulatorRoot {
    crate::off_main(move || {
        let manifest = read_manifest(&app);
        EmulatorRoot {
            root: current_root(&app).to_string_lossy().to_string(),
            default_root: default_root().to_string_lossy().to_string(),
            custom: !manifest.root.trim().is_empty(),
            supported: cfg!(windows),
        }
    })
    .await
    .unwrap_or(EmulatorRoot {
        root: String::new(),
        default_root: String::new(),
        custom: false,
        supported: false,
    })
}

/// 改安装根目录。空串 = 恢复默认。
///
/// **只改以后装到哪儿**：已经装好的那几个留在原地（移动一个几百 MB 的目录、还要改快捷方式，
/// 不该由「换个路径」这一个动作顺手做掉）。所以界面要说清这一点。
#[tauri::command]
pub async fn emulator_set_root(app: tauri::AppHandle, root: String) -> Result<EmulatorRoot, String> {
    crate::off_main(move || {
        let mut manifest = read_manifest(&app);
        let trimmed = root.trim().to_string();
        manifest.root = trimmed;
        write_manifest(&app, &manifest)?;
        Ok(EmulatorRoot {
            root: current_root(&app).to_string_lossy().to_string(),
            default_root: default_root().to_string_lossy().to_string(),
            custom: !manifest.root.trim().is_empty(),
            supported: cfg!(windows),
        })
    })
    .await?
}

#[tauri::command]
pub async fn emulator_list(app: tauri::AppHandle) -> Vec<EmulatorStatus> {
    crate::off_main(move || {
        let manifest = read_manifest(&app);
        // 盘表只读一次：六张卡共用（有些机器上这一步会退到起 PowerShell 的 WMI 兜底）。
        let root = current_root(&app);
        let fallback = default_root();
        CATALOG
            .iter()
            .map(|def| status_for(&manifest, def, &root, &fallback))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 量一个已装模拟器占了多少地方（递归数文件，几百 MB 的目录要一会儿）。
///
/// 为什么单独一条命令、不跟着 `emulator_list` 一起做：这一页每次切回来都要重画卡片，
/// 而「量目录」是这一页最慢的一件事（RetroArch 上万个文件）。跟工具箱「快照 + 手动自检」
/// 一个路子：默认只画账本里记得的数，用户按「自检」才重新量。
#[tauri::command]
pub async fn emulator_sizes(app: tauri::AppHandle) -> Vec<(String, u64)> {
    crate::off_main(move || {
        let manifest = read_manifest(&app);
        let mut out = Vec::new();
        let mut changed = false;
        for def in CATALOG {
            let Some(entry) = manifest.installed.get(def.id) else {
                continue;
            };
            let dir = PathBuf::from(&entry.dir);
            if !dir.is_dir() {
                continue;
            }
            let bytes = dir_size(&dir);
            out.push((def.id.to_string(), bytes));
            if bytes != entry.bytes {
                changed = true;
            }
        }
        // 量出来的数写回账本：下次进来直接画，不必再量一遍。
        if changed {
            let mut manifest = manifest;
            for (id, bytes) in &out {
                if let Some(entry) = manifest.installed.get_mut(id) {
                    entry.bytes = *bytes;
                }
            }
            let _ = write_manifest(&app, &manifest);
        }
        out
    })
    .await
    .unwrap_or_default()
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// 装一个模拟器。进度走 `EMU_EVENT`，取消用 `emulator_cancel`。
#[tauri::command]
pub async fn emulator_install(app: tauri::AppHandle, id: String) -> Result<String, String> {
    // 外层 `?` 是「后台线程本身失败」（`off_main` 的错误），内层那个 Result 才是这次安装的结果。
    crate::off_main(move || emulator_install_now(app, id)).await?
}

#[cfg(not(windows))]
fn emulator_install_now(_app: tauri::AppHandle, _id: String) -> Result<String, String> {
    Err(pick(
        "安装模拟器只能在 Windows 上使用。",
        "Installing emulators only works on Windows.",
    ))
}

/// 装一个：下载 → 解压 → 便携标记 → 原子搬进目标目录 → 记账本。
/// **整块只在 Windows 上编**：解压（PowerShell / sevenz-rust2）与下载（ureq）都是 Windows 分区里的东西。
#[cfg(windows)]
fn emulator_install_now(app: tauri::AppHandle, id: String) -> Result<String, String> {
    // 抢闸门：已经是 true 就说明有一个装在跑，直接拒掉（而不是排队 —— 用户看不见队列，
    // 而两次安装的目标目录是同一个，排队也只会互相踩）。
    if EMU_INSTALLING.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return Err(pick(
            "已经有一个模拟器在装了，等它跑完再试。",
            "Another emulator is already installing — wait for it to finish.",
        ));
    }
    // 从这里往下无论怎么退出（成功 / 报错 / 取消）都要把闸门放掉，所以整个函数体包一层。
    let outcome = install_guarded(&app, &id);
    EMU_INSTALLING.store(false, std::sync::atomic::Ordering::Relaxed);
    outcome
}

#[cfg(windows)]
fn install_guarded(app: &tauri::AppHandle, id: &str) -> Result<String, String> {
    // 每次开工先清掉上一轮的取消标记，否则第一次取消之后就再也装不上。
    EMU_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    let def = def_by_id(id).ok_or_else(|| pick("没有这个模拟器。", "No such emulator."))?;
    let root = current_root(&app);
    let target = root.join(def.dir);
    std::fs::create_dir_all(&root).map_err(|err| {
        pick(
            &format!("无法创建安装目录（{}）：{err}", root.display()),
            &format!("Couldn't create the install folder ({}): {err}", root.display()),
        )
    })?;

    emit(&app, "resolve", 0, 0);
    let resolved = resolve(def)?;
    let total = resolved.bytes;

    // 下载与解压都放在**目标盘**上的临时目录里：C: 常常只有几十 GB，下载包先落 C: 的话
    // 装 RetroArch（200 MB 包 + 解压后 400 MB）会把系统盘挤爆。放在目标盘就同盘改名，
    // 搬进最终目录是一瞬间的事（跨盘搬一个 400 MB 目录要几十秒）。
    let staging = root.join(format!(".staging-{}", def.id));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|err| {
        pick(
            &format!("无法创建临时目录：{err}"),
            &format!("Couldn't create the temp folder: {err}"),
        )
    })?;
    // 失败 / 取消都要把这个临时目录收掉，所以走一个闭包，出口只有一处。
    let outcome = install_into(&app, def, &resolved, &staging, &target, total);
    let _ = std::fs::remove_dir_all(&staging);
    let (version, exe, bytes) = outcome?;

    // 记账本：装完了才写，写的就是刚才那个 exe。
    let mut manifest = read_manifest(&app);
    manifest.installed.insert(
        def.id.to_string(),
        InstalledEntry {
            version: version.clone(),
            dir: target.to_string_lossy().to_string(),
            exe: exe.to_string_lossy().to_string(),
            installed_at: crate::net::now_ms(),
            bytes,
        },
    );
    write_manifest(&app, &manifest)?;
    emit(&app, "done", bytes, bytes);
    Ok(pick(
        &format!("{} {} 装好了。", def.emulator, version),
        &format!("{} {} is installed.", def.emulator, version),
    ))
}

/// 下载 + 解压 + 搬进目标目录。返回 `(版本号, 主程序, 占用字节数)`。
#[cfg(windows)]
fn install_into(
    app: &tauri::AppHandle,
    def: &EmulatorDef,
    resolved: &Resolved,
    staging: &Path,
    target: &Path,
    total: u64,
) -> Result<(String, PathBuf, u64), String> {
    let archive = staging.join(&resolved.file_name);
    /*
     * 依次尝试主源与官方备源（见 `Mirror`）。
     *
     * 用户真机上的现场：街机那个包 87 MB，走 GitHub 断在中途，报「下载失败」。
     * 同一份文件在 MAME 官方的 SourceForge 上也有，所以这里换一台官方主机重来一次 ——
     * 每次换源都把进度条归零重发一遍「下载」阶段（用户看到的是「又从头下了一次」，
     * 而不是进度条停在 60% 不动）。`net::download` 失败时自己会把半截文件删掉，
     * 所以重试不会拿到上一次的残片。
     * 取消是用户的意愿：一旦点了取消就立刻退出，不换源重试。
     */
    let cancelled = || EMU_CANCEL.load(std::sync::atomic::Ordering::Relaxed);
    let mut failure: Option<String> = None;
    let mut downloaded = false;
    for (index, url) in resolved.urls.iter().enumerate() {
        if index > 0 {
            emit(app, "download", 0, total);
        }
        match crate::net::download(url, &archive, total, &cancelled, &|done, total| {
            emit(app, "download", done, total)
        }) {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(err) => {
                if cancelled() {
                    return Err(err);
                }
                failure = Some(err);
            }
        }
    }
    if !downloaded {
        return Err(failure.unwrap_or_else(|| {
            pick("下载失败：没有可用的下载源。", "Download failed: no source available.")
        }));
    }

    emit(app, "extract", 0, 0);
    /*
     * 解压目标一定是 `staging` **下面的一层**（`unpacked/`），不能是 `staging` 自己。
     *
     * 为什么：下面那句「把主程序所在目录改名成安装目录」用的就是解压根目录直接推出来的
     * 路径。如果压缩包里主程序就在根目录（不套版本文件夹 —— MAME 的自解压包就是这样），
     * 那 `exe_dir` 会等于 `staging` 本身，于是**整个 `staging`（含刚下载的安装包）被改名
     * 成了安装目录**，而那 80–200 MB 的安装包就被当成模拟器的一部分留在里面。
     * 多建一层，`staging` 就永远不会被搬走。
     */
    let unpacked = staging.join("unpacked");
    std::fs::create_dir_all(&unpacked).map_err(|err| {
        pick(
            &format!("无法创建解压目录：{err}"),
            &format!("Couldn't create the extract folder: {err}"),
        )
    })?;
    crate::net::extract_archive(&archive, &unpacked, &|done, total| {
        emit(app, "extract", done, total)
    })?;
    // 包已经解开了，先删掉省地方（解压中转里再留一份等于占双份磁盘）。
    let _ = std::fs::remove_file(&archive);

    // 找到主程序：官方包的根目录常常是一个带版本号的文件夹，所以按文件名搜而不是拼路径。
    let exe = search_named(&unpacked, def.exe, 4).ok_or_else(|| {
        pick(
            &format!("解压完了但没找到 {}，官方可能换了打包结构。", def.exe),
            &format!("Extracted, but {} wasn't found — packaging may have changed.", def.exe),
        )
    })?;
    // `unpacked` 这一层也要挡住：`exe_dir` 必须比它更深，否则就是要把解压根整个搬走
    // （那会连别的残留一起搬进安装目录）。
    let exe_dir = exe
        .parent()
        .filter(|dir| dir.starts_with(&unpacked) && *dir != unpacked.as_path())
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| {
            // 主程序就在解压根目录：把根目录里的东西整体当成要装的内容。
            unpacked.clone()
        });

    // 便携模式标记必须在**主程序目录**：判据看的是 exe 旁边。
    // `target` 传进去是给 RetroArch 写 cfg 用的（里面要写最终路径，不是解压中转路径）；
    // 它顺手要建的那几个空目录也建在解压目录里，改名之后自然落到安装目录下（相对结构不变）。
    apply_portable(&exe_dir, def.portable, target)?;

    emit(app, "copy", 0, 0);
    // 搬进最终目录：先把旧的挪到一边，成功了才删 —— 中途失败时旧版还在。
    //
    // 备份路径**不用 `with_extension("old")`**：`"PCSX2".with_extension("old")` 得到的是
    // 「PCSX2.old」没问题，但目录名里带点的（`shadPS4-0.19.0` 这种）会被整个换掉。
    // 放在**安装根目录**下、用 `.backup-<id>`：重装失败留下的残骸都在同一个地方，
    // 不会混进用户自己挑的目录里。
    // 这个路径上的残留已经在 `install_guarded` 开工前清过了（见那边的说明）——
    // 放在那儿是为了「下载之前就报错」，而不是等几百 MB 下完才失败。
    let backup = target
        .parent()
        .unwrap_or(target)
        .join(format!(".backup-{}", def.id));
    let had_old = target.exists();
    if had_old {
        std::fs::rename(target, &backup).map_err(|err| {
            pick(
                &format!("旧版本挪不开（可能正在运行）：{err}"),
                &format!("Couldn't move the old version aside (is it still running?): {err}"),
            )
        })?;
    }
    if let Err(err) = std::fs::rename(&exe_dir, target) {
        // 回滚也要说清楚结果：回滚失败的话旧版只剩 `.backup-<id>`，那句提示决定了用户
        // 下一步该干什么（去那个目录把东西捞回来）。
        if had_old {
            if let Err(back_err) = std::fs::rename(&backup, target) {
                crate::logutil::write_line(&format!(
                    "emulator: rollback failed for {}: {back_err}",
                    def.id
                ));
                return Err(pick(
                    &format!(
                        "搬进安装目录失败（{err}），而且旧版本也挪不回来了。\n旧版本还在 {} 里，别删它。",
                        backup.display()
                    ),
                    &format!(
                        "Couldn't move it into place ({err}), and the previous version couldn't be moved back.\nIt is still in {} — don't delete it.",
                        backup.display()
                    ),
                ));
            }
        }
        return Err(pick(
            &format!("搬进安装目录失败：{err}"),
            &format!("Couldn't move it into place: {err}"),
        ));
    }
    // 到这里新的已经就位，备份可以删了；删不掉不影响使用（下次开工前还会再清一次），
    // 但要在日志里留一行 —— 不然「安装目录里多出一个看不见的 .backup-xxx」没人查得出来。
    if let Err(err) = std::fs::remove_dir_all(&backup) {
        crate::logutil::write_line(&format!(
            "emulator: couldn't remove the backup {}: {err}",
            backup.display()
        ));
    }

    // 搬完之后重新定位一次主程序：`staging` 里的路径已经不成立了。
    let installed_exe = find_exe(target, def).ok_or_else(|| {
        pick(
            "搬完之后找不到主程序了。",
            "The main program went missing after the move.",
        )
    })?;
    let bytes = dir_size(target);
    Ok((resolved.version.clone(), installed_exe, bytes))
}

/// 只在 Windows 上编：进度事件是「装东西」那条路上的。
#[cfg(windows)]
fn emit(app: &tauri::AppHandle, phase: &str, bytes: u64, total_bytes: u64) {
    let _ = app.emit(
        EMU_EVENT,
        EmulatorProgress {
            phase: phase.to_string(),
            bytes,
            total_bytes,
        },
    );
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct EmulatorProgress {
    /// `resolve` / `download` / `extract` / `copy` / `done`
    pub phase: String,
    pub bytes: u64,
    pub total_bytes: u64,
}

/// 取消正在进行的安装。返回 true 只表示「标记收到了」，真正的收尾在下载循环里做。
#[tauri::command]
pub fn emulator_cancel() -> bool {
    EMU_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    true
}

/// 卸载：删掉整个安装目录，再抹掉账本里那一行。
///
/// 只删**账本里记着的那个目录**、且必须是一个「像我们装的」目录（里面有主程序）。
/// 为什么加这道闸：账本里的路径是磁盘上的字符串，用户可能把根目录指到别处之后又改过账本；
/// 真删错一次就是几百 GB 的游戏库，这个风险不值得省。
#[tauri::command]
pub async fn emulator_uninstall(app: tauri::AppHandle, id: String) -> Result<String, String> {
    crate::off_main(move || {
        let def = def_by_id(&id).ok_or_else(|| pick("没有这个模拟器。", "No such emulator."))?;
        let mut manifest = read_manifest(&app);
        let entry = manifest.installed.get(&id).cloned();
        let dir = entry
            .as_ref()
            .map(|entry| PathBuf::from(&entry.dir))
            .unwrap_or_else(|| current_root(&app).join(def.dir));
        if dir.is_dir() {
            // 目录里得有这个模拟器的主程序，才认它是我们装的。
            if find_exe(&dir, def).is_none() {
                return Err(pick(
                    "这个目录里没有该模拟器的主程序，为安全起见没有删除。",
                    "That folder has no main program for this emulator, so nothing was deleted.",
                ));
            }
            std::fs::remove_dir_all(&dir).map_err(|err| {
                pick(
                    &format!("删除失败（可能正在运行）：{err}"),
                    &format!("Delete failed (is it still running?): {err}"),
                )
            })?;
        }
        manifest.installed.remove(&id);
        write_manifest(&app, &manifest)?;
        Ok(pick(
            &format!("{} 已卸载。", def.emulator),
            &format!("{} was removed.", def.emulator),
        ))
    })
    .await?
}

/// 打开官网（手动项那一张卡，以及「打开下载页」）。
#[tauri::command]
pub async fn emulator_open_site(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let def = def_by_id(&id).ok_or_else(|| pick("没有这个模拟器。", "No such emulator."))?;
    let Source::Official { url, .. } = &def.source else {
        return Err(pick("这一项不需要打开官网。", "This one doesn't need a website."));
    };
    let url = (*url).to_string();
    let _ = app;
    crate::files::open_with_system(&url).map_err(|err| {
        pick(
            &format!("打不开浏览器：{}", err.message),
            &format!("Couldn't open the browser: {}", err.message),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        // 带上序号：测试是并行跑的（跟 files.rs 里那个同名的助手一个理由）。
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hl-emu-{tag}-{}-{serial}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// tag → 卡片上的版本号：三种形状各来一个。
    #[test]
    fn turns_tags_into_readable_versions() {
        assert_eq!(version_from_tag("v0.2.1"), "0.2.1");
        assert_eq!(version_from_tag("v.0.19.0"), "0.19.0");
        // MAME：`mame0289` 是 `0.289` 去掉了点。
        assert_eq!(version_from_tag("mame0289"), "0.289");
        assert_eq!(version_from_tag("mame0301"), "0.301");
        // RPCS3：tag 是 `build-<sha>`，这里原样返回（真版本号在附件名里，另一条路会接住）。
        assert_eq!(version_from_tag("build-987129bc"), "build-987129bc");
    }

    /// GitHub 的 release JSON → 下载地址：挑对资产、抠出版本号、把官方备源排到后面。
    ///
    /// 夹具是**真实 API 返回**（2026-10-12 抓的 `repos/mamedev/mame/releases/latest`，
    /// 只留了用得上的字段）：MAME 那份里同时有 arm64 / x64 / Linux 包与校验文件，
    /// 挑错一个就是把 85 MB 的 arm64 包装进掌机。
    #[test]
    fn picks_the_right_asset_and_mirror_from_a_github_release() {
        let body = r#"{
          "tag_name": "mame0289",
          "prerelease": false,
          "html_url": "https://github.com/mamedev/mame/releases/tag/mame0289",
          "assets": [
            {"name": "mame0289b_arm64.exe", "size": 85192947, "browser_download_url": "https://github.com/mamedev/mame/releases/download/mame0289/mame0289b_arm64.exe"},
            {"name": "mame0289b_x64.exe", "size": 87626249, "browser_download_url": "https://github.com/mamedev/mame/releases/download/mame0289/mame0289b_x64.exe"},
            {"name": "mame0289lx.zip", "size": 19725605, "browser_download_url": "https://github.com/mamedev/mame/releases/download/mame0289/mame0289lx.zip"},
            {"name": "SHA256SUMS", "size": 415, "browser_download_url": "https://github.com/mamedev/mame/releases/download/mame0289/SHA256SUMS"}
          ]
        }"#;
        let mirror = Mirror::SourceForge {
            project: "mame",
            tag_prefix: "mame",
        };
        let resolved = github_from_json(body, "b_x64.exe", "x64.exe", Some(mirror)).unwrap();
        assert_eq!(resolved.version, "0.289");
        assert_eq!(resolved.file_name, "mame0289b_x64.exe");
        assert_eq!(resolved.bytes, 87626249);
        // 主源在前、官方备源在后（下载失败时才换第二项）。
        assert_eq!(resolved.urls.len(), 2);
        assert!(resolved.urls[0].starts_with("https://github.com/mamedev/mame/releases/download/"));
        assert_eq!(
            resolved.urls[1],
            "https://downloads.sourceforge.net/project/mame/mame/0.289/mame0289b_x64.exe"
        );

        // 校验文件（.txt/.sha256）不许被当成安装包；没有匹配资产时要报错而不是瞎挑。
        assert!(github_from_json(body, "whatsnew", "", None).is_err());
        // 预发布不装。
        let pre = body.replace("\"prerelease\": false", "\"prerelease\": true");
        assert!(github_from_json(&pre, "b_x64.exe", "", None).is_err());
    }

    /// Forgejo 的 releases JSON → 下载地址（Eden 走这一条）。
    ///
    /// 夹具同样是真实返回（2026-10-12 抓的 `git.eden-emu.dev/api/v1/repos/eden-emu/eden/releases`），
    /// 里面有 Android / Linux / Windows 三种包、Windows 又分 msvc / clang-pgo / arm64 ——
    /// 挑错的后果是把 Android 的 apk 或 arm64 的包装进 x64 掌机。
    #[test]
    fn picks_the_windows_zip_from_a_forgejo_release() {
        let body = r#"[{
          "tag_name": "v0.2.0-rc2",
          "prerelease": false,
          "html_url": "https://git.eden-emu.dev/eden-emu/eden/releases/tag/v0.2.0-rc2",
          "assets": [
            {"name": "Eden-Windows-v0.2.0-rc2-amd64-msvc-standard.zip", "size": 0, "browser_download_url": "https://stable.eden-emu.dev/v0.2.0-rc2/Eden-Windows-v0.2.0-rc2-amd64-msvc-standard.zip"}
          ]
        }, {
          "tag_name": "v0.2.1",
          "prerelease": false,
          "html_url": "https://git.eden-emu.dev/eden-emu/eden/releases/tag/v0.2.1",
          "assets": [
            {"name": "Eden-Android-v0.2.1-standard.apk", "size": 0, "browser_download_url": "https://stable.eden-emu.dev/v0.2.1/Eden-Android-v0.2.1-standard.apk"},
            {"name": "Eden-Linux-v0.2.1-amd64-clang-pgo.AppImage", "size": 0, "browser_download_url": "https://stable.eden-emu.dev/v0.2.1/Eden-Linux-v0.2.1-amd64-clang-pgo.AppImage"},
            {"name": "Eden-Windows-v0.2.1-amd64-clang-pgo.zip", "size": 0, "browser_download_url": "https://stable.eden-emu.dev/v0.2.1/Eden-Windows-v0.2.1-amd64-clang-pgo.zip"},
            {"name": "Eden-Windows-v0.2.1-arm64-msvc-standard.zip", "size": 0, "browser_download_url": "https://stable.eden-emu.dev/v0.2.1/Eden-Windows-v0.2.1-arm64-msvc-standard.zip"}
          ]
        }]"#;
        // 夹具**故意把 `v0.2.0-rc2` 放在前面**：那台 Forgejo 的 `prerelease` 字段连 rc 都写 false，
        // 所以只能靠 tag 形状跳过它 —— 挑错了就是把 rc 装到用户机器上。
        let resolved = forgejo_from_json(body, "windows-v", "-windows-").unwrap();
        assert_eq!(resolved.version, "0.2.1");
        assert!(
            !resolved.file_name.contains("rc"),
            "挑到了预发布版：{}",
            resolved.file_name
        );
        assert_eq!(resolved.file_name, "Eden-Windows-v0.2.1-amd64-clang-pgo.zip");
        assert_eq!(resolved.urls.len(), 1);
        assert!(resolved.urls[0].starts_with("https://stable.eden-emu.dev/v0.2.1/"));
        // 资产列表是空的时候要报错，而不是给一个空地址。
        assert!(forgejo_from_json("[]", "windows", "").is_err());
    }

    /// 官方备源的地址推导（MAME → SourceForge）。
    ///
    /// 这一条钉的是**用户真机报「下载失败」之后加的那一档**：GitHub 拉不动 87 MB 的包时换
    /// SourceForge。地址是实测过的（2026-10-12：302 → 镜像 200，Content-Length 87,626,249，
    /// 与 GitHub 那侧同一个字节数），所以这里断言的是那个**真实 URL**，不是随手编的形状。
    #[test]
    fn builds_the_sourceforge_mirror_url() {
        let mirror = Mirror::SourceForge {
            project: "mame",
            tag_prefix: "mame",
        };
        assert_eq!(
            mirror_url(&mirror, "mame0289", "mame0289b_x64.exe").as_deref(),
            Some("https://downloads.sourceforge.net/project/mame/mame/0.289/mame0289b_x64.exe")
        );
        // 三位数版本（MAME 0.300 之后）也要推得对：`mame0301` → `mame/0.301`。
        assert_eq!(
            mirror_url(&mirror, "mame0301", "mame0301b_x64.exe").as_deref(),
            Some("https://downloads.sourceforge.net/project/mame/mame/0.301/mame0301b_x64.exe")
        );
        // 推不出来就返回 None（只剩主源），不许编一个看起来像的地址。
        assert_eq!(mirror_url(&mirror, "build-abc123", "x.exe"), None);
        assert_eq!(mirror_url(&mirror, "mame", "x.exe"), None);
    }

    /// 找主程序：约定的相对路径优先，找不到就按文件名往下搜（官方换打包结构时的兜底）。
    #[test]
    fn finds_the_exe_directly_or_by_name() {
        let def = def_by_id("ps2").unwrap();
        let root = temp_dir("find-direct");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(def.exe), b"MZ").unwrap();
        assert_eq!(find_exe(&root, def).unwrap(), root.join(def.exe));
        let _ = std::fs::remove_dir_all(&root);

        // 官方把内容套进一个带版本号的目录（RetroArch 的包就是这样）也要找得到。
        let root = temp_dir("find-nested");
        let nested = root.join("RetroArch-Win64").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(def.exe), b"MZ").unwrap();
        assert_eq!(find_exe(&root, def).unwrap(), nested.join(def.exe));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **这个测试是给「卸载删错目录」那类事故上的锁**：
    /// `.backup-<id>` 里可能有一份上一版的完整主程序（重装失败留下的），它绝不能被当成
    /// 「这个目录里有主程序」的证据 —— 卸载的安全闸门用的就是这个判断。
    #[test]
    fn ignores_our_own_staging_and_backup_dirs() {
        let def = def_by_id("ps2").unwrap();
        let root = temp_dir("skip-temp");

        // 只有中转 / 备份，没有正式安装。
        let backup = root.join(".backup-ps2");
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join(def.exe), b"MZ").unwrap();
        let staging = root.join(".staging-ps2");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join(def.exe), b"MZ").unwrap();

        assert!(
            find_exe(&root, def).is_none(),
            "中转目录里的 exe 被当成了已安装 —— 卸载时就会删掉一个没有主程序的目录"
        );

        // 正式安装出现之后，找到的必须是它，而不是那两个中转目录。
        std::fs::write(root.join(def.exe), b"MZ").unwrap();
        assert_eq!(find_exe(&root, def).unwrap(), root.join(def.exe));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 版本号从附件名里抠：RPCS3 的 tag 是 `build-<40 位 sha>`（每次构建都变、不是版本号），
    /// 版本号只存在于附件名里；shadPS4 的 tag 是 `v.0.19.0`（直接去 `v` 会得到 `.0.19.0`）。
    #[test]
    fn reads_versions_out_of_asset_names() {
        // 四个真实附件名（本机核过的那些 release 的原文）。
        assert_eq!(
            version_from_asset_name("rpcs3-v0.0.43-20273-987129bc_win64_msvc.7z").as_deref(),
            Some("0.0.43")
        );
        // shadPS4 的附件名里没有 `v`：这里就该返回 None，让调用方退回它的 tag
        // （`v.0.19.0` → 去掉 `v` 与那个点 → `0.19.0`）。
        assert_eq!(version_from_asset_name("shadps4-win64-sdl-0.19.0.zip"), None);
        assert_eq!(
            version_from_asset_name("pcsx2-v2.8.2-windows-x64-Qt.7z").as_deref(),
            Some("2.8.2")
        );
        assert_eq!(
            version_from_asset_name("mame0289b_x64.exe").as_deref(),
            // MAME 的附件名里没有 `v<数字>`：返回 None，由调用方退回 tag（`mame0289`）。
            None
        );
        assert_eq!(
            version_from_asset_name("rpcs3-v0.0.18-12817-fff0c96b_win64.7z").as_deref(),
            Some("0.0.18")
        );
    }

    /// tag → 给用户看的版本号：`v2.8.2` → `2.8.2`、`v.0.19.0` → `0.19.0`、`mame0289` 原样。
    /// shadPS4 那个 `v.` 前缀要是不处理，卡片上就会写「.0.19.0」。
    #[test]
    fn tag_fallback_strips_the_v_and_a_leading_dot() {
        let clean = |tag: &str| tag.trim_start_matches('v').trim_start_matches('.').to_string();
        assert_eq!(clean("v2.8.2"), "2.8.2");
        assert_eq!(clean("v.0.19.0"), "0.19.0");
        assert_eq!(clean("mame0289"), "mame0289");
        assert_eq!(clean("0.0.43"), "0.0.43");
    }

    /// 便携标记：**文件就是文件、目录就是目录**，名字与类型都必须跟官方对上。
    /// 这一条要是错了不会报错，只会安静地把配置写到 C 盘的 AppData 去。
    #[test]
    fn portable_markers_match_each_emulator() {
        let root = temp_dir("portable");
        let exe_dir = root.join("install");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let target = root.join("Apps").join("PCSX2");

        // PCSX2：空**文件** `portable.txt`（做成目录等于没做）。
        apply_portable(&exe_dir, def_by_id("ps2").unwrap().portable, &target).unwrap();
        assert!(
            exe_dir.join("portable.txt").is_file(),
            "PCSX2 的便携标记必须是一个文件"
        );

        // shadPS4：`user` **目录**。
        apply_portable(&exe_dir, def_by_id("ps4").unwrap().portable, &target).unwrap();
        assert!(exe_dir.join("user").is_dir(), "shadPS4 的便携标记必须是 user 目录");

        // Eden（Switch）：也是 `user` **目录**，但和 shadPS4 是两个程序 ——
        // 源码 `src/common/fs/fs_paths.h` 的 `#define PORTABLE_DIR "user"`，判据在
        // `src/common/fs/path_util.cpp::Reinitialize()`：Windows 上先看 exe 同目录有没有 `user`，
        // 有就整份数据目录（config / nand / keys / saves）都落在那里，没有才写 `%APPDATA%\eden`。
        // 先把 shadPS4 那一步留下的目录删掉，免得这条断言是「前一步的功劳」。
        std::fs::remove_dir_all(exe_dir.join("user")).unwrap();
        apply_portable(&exe_dir, def_by_id("switch").unwrap().portable, &target).unwrap();
        assert!(exe_dir.join("user").is_dir(), "Eden 的便携标记必须是 user 目录");

        // MAME：什么都不放。
        let before: Vec<_> = std::fs::read_dir(&exe_dir).unwrap().flatten().map(|e| e.file_name()).collect();
        apply_portable(&exe_dir, def_by_id("arcade").unwrap().portable, &target).unwrap();
        let after: Vec<_> = std::fs::read_dir(&exe_dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(before.len(), after.len(), "MAME 不需要任何便携标记");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// RetroArch：写出来的必须是一份**带绝对路径**的 `retroarch.cfg`，而且写的是**搬家之后
    /// 真的存在**的路径。
    ///
    /// 这个测试不照着实现写断言，而是**真的把主程序目录改名成安装目录**（跟安装流程里
    /// `fs::rename(&exe_dir, target)` 一模一样），再看 cfg 指的目录在不在 —— 上一版就是
    /// 因为断言抄了实现的错值（多写了一层 `RetroArch-Win64`）才一直绿着。
    #[test]
    fn retroarch_cfg_points_at_dirs_that_exist_after_the_move() {
        let root = temp_dir("ra-cfg");
        // 解压中转里的样子：<staging>/unpacked/RetroArch-Win64/{retroarch.exe,saves,...}
        let exe_dir = root.join("staging").join("unpacked").join("RetroArch-Win64");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join("retroarch.exe"), b"MZ").unwrap();
        let target = root.join("Apps").join("RetroArch");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();

        apply_portable(&exe_dir, def_by_id("retro").unwrap().portable, &target).unwrap();
        let cfg = std::fs::read_to_string(exe_dir.join("retroarch.cfg")).unwrap();
        // 便携标记那一步就该把 cfg 点名的目录建好（不然用户得自己猜目录名）。
        for name in ["saves", "states", "system"] {
            assert!(exe_dir.join(name).is_dir(), "解压目录里没建 {name}");
        }

        // 搬家（安装流程里真正做的那一步：源就是主程序所在目录）。
        std::fs::rename(&exe_dir, &target).unwrap();

        let base = windows_path(&target);
        assert!(
            cfg.contains(&format!("savefile_directory = \"{base}\\saves\"")),
            "存档目录必须是安装目录下的绝对路径，实际是：{cfg}"
        );
        assert!(cfg.contains("savestate_directory = "), "少了即时存档目录");
        assert!(cfg.contains("system_directory = "), "少了 system 目录");

        // 真正的判据：cfg 里写的那几个目录，搬完之后得**真的在那儿**。
        for name in ["saves", "states", "system"] {
            assert!(
                target.join(name).exists(),
                "cfg 指的 {name} 目录在安装目录里不存在：{cfg}"
            );
        }
        // 临时目录名不许漏进 cfg（扁平包时最容易漏的是 `unpacked`）。
        assert!(
            !cfg.contains("staging") && !cfg.contains("unpacked"),
            "cfg 里写进了临时目录，装完之后就是个死路径：{cfg}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 默认装到**第一块非系统盘**（掌机上就是 D:）：C: 常常只有 64–128 GB。
    /// 这里只验纯函数的判定，盘符从 `sysinfo` 真的读来了什么由系统决定。
    #[test]
    fn picks_a_non_system_drive_when_there_is_one() {
        let rows = vec![
            crate::sysinfo::DriveSpace {
                mount: "C:".into(),
                label: "System".into(),
                total_bytes: 1,
                free_bytes: 1,
                kind: "fixed".into(),
            },
            crate::sysinfo::DriveSpace {
                mount: "D:".into(),
                label: "Data".into(),
                total_bytes: 1,
                free_bytes: 1,
                kind: "fixed".into(),
            },
        ];
        let root = root_from_drives(&rows);
        assert!(
            root.to_string_lossy().to_uppercase().starts_with("D:"),
            "应该选 D:，实际是 {}",
            root.display()
        );
    }
}
