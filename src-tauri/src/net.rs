/*
 * 下载与解压的共用件（工具箱装运行库 / 装 OptiScaler、模拟器页装模拟器都用它）。
 *
 * 为什么单独抽出来：这几段原来住在 `toolbox.rs` 的 `windows` 模块里，模拟器页要用就得
 * 再抄一份 —— 而「带进度的下载」这份代码里有三处踩过坑的地方（重定向后的真实大小、
 * 每 150ms 才发一次进度、下完校验字节数），抄一份就是让第二个副本慢慢长歪。
 *
 * 两件事写在这里的规矩：
 *   1. **取消是调用方的事**：这里不认识任何全局标志，只认传进来的 `cancelled` 闭包 ——
 *      工具箱与模拟器各有自己的取消标志，共用一份反而会互相清掉对方的标记。
 *   2. **解压前先看条目名**（`is_escaping_name`）：`sevenz-rust2` 不保证拒绝「解出来跑到
 *      目标目录外面」的条目（`files.rs::expand_7z` 里有同样的守卫）。我们解的是**第三方
 *      官方包**，不是自己打的包，这一步不能省。
 *
 * 解压只在 Windows 上可用（zip 走 PowerShell 的 `Expand-Archive`，7z 走纯 Rust）。
 * 非 Windows 平台返回「不支持」，不假装能解。
 */
#[cfg(windows)]
use std::path::{Path, PathBuf};

/// 进度事件发得太密没有意义：掌机上一次 IPC + 一次重绘都要钱，150ms 一格够了
/// （这个数字是 0.1.5x 调出来的，照搬）。
#[cfg(windows)]
const EMIT_EVERY: std::time::Duration = std::time::Duration::from_millis(150);

/// 装东西用的缓存目录：`<app_data>/<slot>`（如 `<app_data>/toolbox`）。
///
/// 只在 Windows 上编：调用它的两处（装运行库、装 OptiScaler）都是 Windows 专属功能。
///
/// 为什么不放系统临时目录：这些文件（安装包、解压中转）动辄上百 MB，掌机的 C: 常常只有
/// 64–128 GB；落在 app_data 下至少有固定的地方可清，也能被「系统维护」那条清理看见。
#[cfg(windows)]
pub fn cache_dir(app: &tauri::AppHandle, slot: &str) -> Result<PathBuf, String> {
    // `path()` 来自 `Manager`，`emit()` 来自 `Emitter`：两个 trait 都只在函数体里用得上，
    // 就地在函数里 use，省得在文件头挂两个「非 Windows 用不到」的导入。
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| {
            crate::i18n::pick(
                &format!("无法定位缓存目录：{err}"),
                &format!("Couldn't locate cache folder: {err}"),
            )
        })?
        .join(slot);
    std::fs::create_dir_all(&dir).map_err(|err| {
        crate::i18n::pick(
            &format!("无法创建缓存目录：{err}"),
            &format!("Couldn't create cache folder: {err}"),
        )
    })?;
    Ok(dir)
}

/// 只在 Windows 上编：账本里记时间戳的只有「装 OptiScaler」那条路。
#[cfg(windows)]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 统一配好超时的 HTTP agent。
///
/// 为什么必须设超时：`ureq` 2.x 的默认 `timeout_read` 是 **None** —— 连接半死（掌机切 Wi-Fi、
/// 路由器掉了）时 `read` 会一直阻塞，而取消只在两次 `read` 之间检查，于是**进度条停住、
/// 「取消」点了也没用**，那一页的按钮会一直灰着等下去。读超时设成「多久收不到一个字节就算断」，
/// 出问题时报错退出，用户重试即可。
#[cfg(windows)]
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .user_agent("FantasyHub")
        .timeout_connect(std::time::Duration::from_secs(20))
        .timeout_read(std::time::Duration::from_secs(30))
        .build()
}

/// 带进度的下载。`total` 只是调用方从 API 里看到的参考值，重定向后的
/// `Content-Length` 更准，优先用它。
///
/// `report` 收的是 `(已下载, 总量)`：调用方自己决定配上哪个阶段名发出去
/// （工具箱只有「下载」一个阶段，模拟器那边还要报「解压 / 搬运」）。
///
/// 取消 / 失败都会把半截文件删掉 —— 留着的话下次会拿它当「已经下过」。
///
/// 只在 Windows 上编：`ureq` 是 Windows 分区里的依赖（见 `Cargo.toml`），
/// 而网络那几个调用点本来就都是 Windows 专属功能。
#[cfg(windows)]
pub fn download(
    url: &str,
    dest: &Path,
    total: u64,
    cancelled: &dyn Fn() -> bool,
    report: &dyn Fn(u64, u64),
) -> Result<(), String> {
    use std::io::{Read, Write};
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let response = agent()
        .get(url)
        .call()
        .map_err(|err| {
            crate::i18n::pick(
                &format!("下载失败：{err}"),
                &format!("Download failed: {err}"),
            )
        })?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(total);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(dest).map_err(|err| {
        crate::i18n::pick(
            &format!("无法写入下载文件：{err}"),
            &format!("Couldn't write download: {err}"),
        )
    })?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    report(0, total);
    loop {
        if cancelled() {
            drop(file);
            let _ = std::fs::remove_file(dest);
            return Err(crate::i18n::pick("已取消。", "Cancelled."));
        }
        let read = reader.read(&mut buffer).map_err(|err| {
            crate::i18n::pick(
                &format!("下载中断：{err}"),
                &format!("Download interrupted: {err}"),
            )
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|err| {
            crate::i18n::pick(
                &format!("保存下载失败：{err}"),
                &format!("Couldn't save download: {err}"),
            )
        })?;
        done += read as u64;
        if last_emit.elapsed() >= EMIT_EVERY {
            last_emit = std::time::Instant::now();
            report(done, total);
        }
    }
    // 下完对一次字节数：断流的连接会「正常」返回 0，不查的话解压时才报一个看不懂的错。
    if total > 0 && done != total {
        let _ = std::fs::remove_file(dest);
        return Err(crate::i18n::pick(
            &format!("下载不完整（{done}/{total} 字节），请重试。"),
            &format!("Download incomplete ({done}/{total} bytes). Try again."),
        ));
    }
    report(done, total);
    Ok(())
}

/// 一次 GET，返回响应体（上限 `limit` 字节）。给「查最新版本」这类小请求用：
/// release 元数据、版本号文件都是几 KB，读满上限就停，别为一个版本号拉几百兆。
#[cfg(windows)]
pub fn get_text(url: &str, limit: usize) -> Result<String, String> {
    use std::io::Read;
    let response = agent().get(url).call().map_err(|err| match err {
        // GitHub 的匿名 API 是**按出口 IP 每小时 60 次**。掌机上一般碰不到，但调试期或
        // 家里多台设备共用一个公网 IP 时会撞上，而 ureq 原样抛出来的只有一句
        // 「status code 403」，用户看不出该等一等还是该报 bug。
        ureq::Error::Status(code, _) if code == 403 || code == 429 => crate::i18n::pick(
            "GitHub 的接口暂时不给查了（每小时有次数上限），过一会儿再试。",
            "GitHub is rate-limiting the version check right now — try again in a little while.",
        ),
        other => crate::i18n::pick(
            &format!("请求失败：{other}"),
            &format!("Request failed: {other}"),
        ),
    })?;
    let mut body = String::new();
    response
        .into_reader()
        .take(limit as u64)
        .read_to_string(&mut body)
        .map_err(|err| {
            crate::i18n::pick(
                &format!("读取响应失败：{err}"),
                &format!("Couldn't read the response: {err}"),
            )
        })?;
    Ok(body)
}

/// 压缩包里的名字是否指向目标目录外面（绝对路径 / `..` / `C:` 这种盘符开头）。
///
/// 只在 Windows 上编：解压这条路上没有非 Windows 的实现（下面两个 `extract_*` 的
/// 非 Windows 版本直接报「不支持」），留着它本机就是一段没人调用的死代码。
///
/// `files.rs` 里有同名的守卫，这里是给「解压第三方官方包」用的第二份 —— 两份都在，
/// 是因为两处的调用方不同（文件页解用户自己的包、这里解网上下载的包）。
#[cfg(windows)]
pub fn is_escaping_name(name: &str) -> bool {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return true;
    }
    if normalized.split('/').any(|part| part == "..") {
        return true;
    }
    matches!(normalized.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic())
}

/// 按扩展名选解压方式：`.7z` 走纯 Rust（官方包常带 BCJ2 过滤器，PowerShell 解不了），
/// 其余当 zip 交给 PowerShell 的 `Expand-Archive`。
///
/// `report` 收到的是 `(已解条目数, 总条目数)`，**按文件数**而不是字节数 ——
/// `sevenz_rust2` 的逐条回调不给字节进度，而「解到第 137 / 902 个文件」是能如实说出来的话；
/// 编一个假的百分比（或者一条来回滑的假进度条）不如说清自己在数什么。
/// 总条目数未知（zip 走 PowerShell，看不到条目）时按 `(1, 0)` 报，界面自己决定怎么画。
///
/// 只在 Windows 上编：两个分支的实现都是 Windows 专属的（见下）。
#[cfg(windows)]
pub fn extract_archive(
    archive: &Path,
    dest: &Path,
    report: &dyn Fn(u64, u64),
) -> Result<(), String> {
    if looks_like_7z(archive) {
        extract_7z(archive, dest, report)
    } else {
        report(1, 0);
        extract_zip(archive, dest)
    }
}

/// 这个包该按 7z 解吗？
///
/// 不能只看扩展名：**MAME 的官方 Windows 包是 `mame0289b_x64.exe`** —— 一个 7z 自解压包
/// （文件头是 `MZ` 的 PE 程序，7z 结构挂在文件尾）。按扩展名判的话 `.exe` 会走到 zip 分支，
/// 而 `Expand-Archive` 只吃 `.zip`，于是街机那张卡**每次都报「压缩包可能损坏」，永远装不上**
/// （2026-10-10 的对抗性审查抓到的就是这个）。
///
/// 所以：扩展名是 `7z` 就用；是 `exe` 也不要直接否掉，而是**读文件尾的 7z 签名**
/// （`37 7A BC AF 27 1C`）。自解压包一定带这个尾签名（那是 7z 格式本身的结束标记），
/// 而真正的 zip 自解压包尾签名是 `PK\x05\x06`，不会被误判。
///
/// 这个函数本身与平台无关（只用 std），所以不加 `cfg` —— 好让它在 macOS 上也能被单测跑到
/// （调用点 `extract_archive` 是 Windows 专属，所以非 Windows 上它只被测试用到）：
/// 「MAME 装不上」那个 bug 就是一条本机可测的纯函数判定，没有任何理由等真机才发现。
/// （`Path` 同理，在函数体内 use：文件头那两行是 Windows 专属的导入。）
#[cfg_attr(not(windows), allow(dead_code))]
fn looks_like_7z(archive: &std::path::Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let by_extension = archive
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("7z"));
    if by_extension {
        return true;
    }
    let is_exe = archive
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"));
    if !is_exe {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(archive) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return false;
    };
    // 尾签名在最后 32 字节之内（7z 的结束头固定落在文件尾）。
    let tail_len = size.min(32) as usize;
    if tail_len == 0 {
        return false;
    }
    if file.seek(SeekFrom::End(-(tail_len as i64))).is_err() {
        return false;
    }
    let mut tail = vec![0u8; tail_len];
    if file.read_exact(&mut tail).is_err() {
        return false;
    }
    tail.windows(6).any(|window| window == b"7z\xBC\xAF'\x1C")
}

#[cfg(windows)]
fn extract_7z(archive: &Path, dest: &Path, report: &dyn Fn(u64, u64)) -> Result<(), String> {
    // 先只看条目名（读元数据，不解压）：库不保证拒绝写到目标目录外的名字。
    let listing = sevenz_rust2::Archive::open(archive).map_err(|err| {
        crate::i18n::pick(
            &format!("读不出这个 7z：{err}"),
            &format!("Couldn't read this 7z: {err}"),
        )
    })?;
    if let Some(bad) = listing
        .files
        .iter()
        .find(|entry| is_escaping_name(&entry.name))
    {
        return Err(crate::i18n::pick(
            &format!("压缩包里的路径指向目录外（{}），已阻止解压", bad.name),
            &format!(
                "The archive points outside the folder ({}); extract blocked",
                bad.name
            ),
        ));
    }
    // 目标要是绝对路径，且不允许含 `..`（库自己的要求）。
    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    // 逐条回调只用来数进度：文件仍然由库自己写盘（`default_entry_extract_fn`），
    // 我们不碰写文件的逻辑 —— 在这儿自己写盘就等于把上面那道越界检查绕过去了。
    let total = listing.files.len() as u64;
    let mut done: u64 = 0;
    sevenz_rust2::decompress_file_with_extract_fn(archive, &dest, |entry, reader, path| {
        done += 1;
        report(done, total);
        sevenz_rust2::default_entry_extract_fn(entry, reader, path)
    })
    .map_err(|err| {
        crate::i18n::pick(
            &format!("解压失败：{err}"),
            &format!("Extract failed: {err}"),
        )
    })
}

#[cfg(windows)]
fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        escape_ps(archive),
        escape_ps(dest)
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|err| {
            crate::i18n::pick(
                &format!("无法启动解压程序：{err}"),
                &format!("Couldn't start the extractor: {err}"),
            )
        })?;
    if status.success() {
        return Ok(());
    }
    Err(crate::i18n::pick(
        &format!("解压失败（PowerShell 退出码 {:?}）：压缩包可能损坏", status.code()),
        &format!(
            "Extract failed (PowerShell exit {:?}): the archive may be damaged",
            status.code()
        ),
    ))
}

#[cfg(windows)]
fn escape_ps(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hl-net-{tag}-{}-{serial}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// **这个测试是给「街机那张卡永远装不上」上的锁。**
    ///
    /// MAME 的官方 Windows 包是 `mame0289b_x64.exe`：一个 7z 自解压包（PE 头 + 尾部的 7z
    /// 结构）。只看扩展名的话 `.exe` 会走到 zip 分支，而 `Expand-Archive` 只吃 `.zip` ——
    /// 结果是每次都报「压缩包可能损坏」。所以判定必须也认**文件尾的 7z 签名**。
    #[test]
    fn detects_7z_by_extension_and_by_sfx_tail() {
        let dir = temp_dir("sevenz");

        // 扩展名就是 7z：不用读文件内容。
        let plain = dir.join("pcsx2.7z");
        std::fs::write(&plain, b"7z\xBC\xAF'\x1C").unwrap();
        assert!(looks_like_7z(&plain));

        // 自解压包：PE 头 + 一堆垃圾 + 尾部的 7z 签名（`MZ` 开头，像 MAME 那个包）。
        let sfx = dir.join("mame0289b_x64.exe");
        let mut body = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
        body.extend(std::iter::repeat_n(0u8, 4096));
        body.extend_from_slice(b"7z\xBC\xAF'\x1C");
        std::fs::write(&sfx, &body).unwrap();
        assert!(looks_like_7z(&sfx), "自解压的 .exe 没被认成 7z —— 街机那张卡就会走 zip 分支");

        // 普通的 exe 不能误判成 7z。
        let exe = dir.join("setup.exe");
        std::fs::write(&exe, b"MZ\x90\x00\x03\x00\x00\x00 no archive here").unwrap();
        assert!(!looks_like_7z(&exe));

        // zip（含 zip 自解压包）要走 zip 分支。
        let zip = dir.join("shadps4.zip");
        std::fs::write(&zip, b"PK\x03\x04 rest of a zip").unwrap();
        assert!(!looks_like_7z(&zip));

        // 空文件不能 panic。
        let empty = dir.join("empty.exe");
        std::fs::write(&empty, b"").unwrap();
        assert!(!looks_like_7z(&empty));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
