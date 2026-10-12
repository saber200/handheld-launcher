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
/// （文件头是 `MZ` 的 PE 程序，7z 结构跟在 stub 后面）。按扩展名判的话 `.exe` 会走到 zip 分支，
/// 而 `Expand-Archive` 只吃 `.zip`，于是街机那张卡报「压缩包可能损坏」、永远装不上。
///
/// 判据 = **文件头 1 MiB 内有没有 7z 流**（自解压包一定在开头不远处）+ 签名头里的
/// `NextHeaderOffset` / `NextHeaderSize` 能对上文件大小。见 `find_7z_start`。
///
/// ⚠️ 上一版这里找的是**文件尾 32 字节里的签名**，那个判据对**真包永远为假**：
/// 7z 的尾部是 next header（编码头首字节是 `0x17`），签名只在**开头**。
/// 2026-10-12 用户真机报「街机安装一直提示下载失败」，根因就在这一条
/// ——（本机用真 MAME 包核过：`mame0289b_x64.exe` 的 7z 流起点是 205,824，尾部 32 字节里没有签名）。
///
/// 这个函数本身与平台无关（只用 std），所以不加 `cfg` —— 好让它在 macOS 上也能被单测跑到：
/// 「MAME 装不上」那个 bug 就是一条本机可测的纯函数判定，没有任何理由等真机才发现。
/// （`Path` 同理，在函数体内 use：文件头那两行是 Windows 专属的导入。）
#[cfg_attr(not(windows), allow(dead_code))]
fn looks_like_7z(archive: &std::path::Path) -> bool {
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
    // 用和真正解压时**同一个**判定：找得到 7z 流才算 7z。两处各写一套迟早走偏。
    find_7z_start(&mut file).is_ok()
}

/* ── 7z 自解压包（SFX）的读取窗口 ───────────────────────────────────────────
 *
 * 为什么需要（2026-10-12，用户真机「街机模拟器点了安装一直提示下载失败」的真根因）：
 * MAME 官方的 Windows 包 `mame0289b_x64.exe` 是一个 **7z 自解压包** —— 前面 205,824 字节是
 * PE stub（首字节 `4d 5a` = "MZ"），真正的 7z 结构挂在文件尾。而 `sevenz-rust2` 的
 * `Archive::read` 第一件事就是 `seek(Start(0))` 读 6 字节签名（该库 `reader.rs:196-204`），
 * 在 SFX 上读到的是 `MZ...` → 直接 `BadSignature`。库本身**没有任何 SFX 支持**
 * （README 与 issue 里全文搜不到），所以上一版那句「标准 7z 库都支持从尾部读 SFX，
 * 理论上没问题」是错的 —— 真机装不上就是这里。
 *
 * 好在它的所有偏移都相对 **7z 流起点**（`header_pos = 32 + next_header_offset`），
 * 于是给它一个「逻辑 0 = 7z 起点」的 Read+Seek 包装就够了：不引 7z CLI、也不用让用户
 * 自己去跑那个 exe（那等于让掌机执行一个刚下下来的二进制）。
 *
 * 起点怎么找：扫开头 1 MiB 找签名 `37 7A BC AF 27 1C`，再用签名头里的
 * `NextHeaderOffset` / `NextHeaderSize` 校验 `起点 + 32 + nextOff + nextSize == 文件大小`
 * （这条等式是实测 MAME 那个包对上的），不写死 205,824。
 */
#[cfg_attr(not(windows), allow(dead_code))]
const SEVEN_Z_SIGNATURE: [u8; 6] = [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C];

/// 自解压 stub 最多扫多长（MAME 的是 205,824 字节，留 1 MiB 余量足够）。
#[cfg_attr(not(windows), allow(dead_code))]
const SFX_SCAN_LIMIT: u64 = 1024 * 1024;

/// 把 `inner` 的逻辑 0 挪到 `offset` 的那个 Read + Seek 包装。
#[cfg(any(windows, test))]
pub struct SevenZipWindow<R> {
    inner: R,
    offset: u64,
    len: u64,
}

#[cfg(any(windows, test))]
impl<R: std::io::Read + std::io::Seek> SevenZipWindow<R> {
    /// 找到 7z 流起点并包好（普通 7z 的起点就是 0）。
    pub fn new(mut inner: R) -> Result<Self, String> {
        let offset = find_7z_start(&mut inner)?;
        let len = inner
            .seek(std::io::SeekFrom::End(0))
            .map_err(|err| crate::i18n::pick(&format!("读不了这个包：{err}"), &format!("Couldn't read this archive: {err}")))?
            - offset;
        inner
            .seek(std::io::SeekFrom::Start(offset))
            .map_err(|err| crate::i18n::pick(&format!("读不了这个包：{err}"), &format!("Couldn't read this archive: {err}")))?;
        Ok(Self { inner, offset, len })
    }

    /// 7z 流在文件里的起点（普通 7z 是 0）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn offset(&self) -> u64 {
        self.offset
    }
}

#[cfg(any(windows, test))]
impl<R: std::io::Read + std::io::Seek> std::io::Read for SevenZipWindow<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // 不许读过头（库里按 len 算尾部 next header 的位置）。
        let pos = self.inner.stream_position()?;
        let left = self.len.saturating_sub(pos.saturating_sub(self.offset));
        if left == 0 {
            return Ok(0);
        }
        let want = buf.len().min(left as usize);
        self.inner.read(&mut buf[..want])
    }
}

#[cfg(any(windows, test))]
impl<R: std::io::Read + std::io::Seek> std::io::Seek for SevenZipWindow<R> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        let target = match pos {
            std::io::SeekFrom::Start(value) => value as i128,
            std::io::SeekFrom::End(value) => self.len as i128 + value as i128,
            std::io::SeekFrom::Current(value) => {
                (self.inner.stream_position()? as i128 - self.offset as i128) + value as i128
            }
        };
        if target < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before the 7z stream",
            ));
        }
        let real = self.inner.seek(std::io::SeekFrom::Start(self.offset + target as u64))?;
        Ok(real - self.offset)
    }
}

/// 7z 流在文件里的起点：普通 7z 是 0，自解压包是签名所在的那个偏移。
///
/// 只用 std，所以**不加 cfg**：跨平台的 `looks_like_7z` 要用它当判据，
/// 本机的单测也靠它（「MAME 装不上」就是这条能本机钉住的判定）。
#[cfg_attr(not(windows), allow(dead_code))]
fn find_7z_start<R: std::io::Read + std::io::Seek>(reader: &mut R) -> Result<u64, String> {
    // 泛型上已经写了 Read + Seek，方法直接可用，不必再 use 一次（use 了反而报 unused）。
    use std::io::SeekFrom;
    let total = reader.seek(SeekFrom::End(0)).map_err(read_error)?;
    reader.seek(SeekFrom::Start(0)).map_err(read_error)?;
    let scan = SFX_SCAN_LIMIT.min(total) as usize;
    let mut head = vec![0u8; scan];
    reader.read_exact(&mut head).map_err(read_error)?;
    // 普通 7z：签名就在 0，剩下的交给库自己判（别在这里替它下结论）。
    if head.starts_with(&SEVEN_Z_SIGNATURE) {
        return Ok(0);
    }
    let mut index = 0usize;
    while let Some(found) = head[index..]
        .windows(SEVEN_Z_SIGNATURE.len())
        .position(|window| window == SEVEN_Z_SIGNATURE)
    {
        let at = (index + found) as u64;
        // 签名头 32 字节：签名 6 + 版本 2 + StartHeaderCRC 4 + NextHeaderOffset 8 + NextHeaderSize 8 + NextHeaderCRC 4
        if let Some(rest) = head.get(at as usize + 12..at as usize + 28) {
            let next_offset = u64::from_le_bytes(rest[..8].try_into().unwrap_or_default());
            let next_size = u64::from_le_bytes(rest[8..].try_into().unwrap_or_default());
            if at + 32 + next_offset + next_size == total {
                return Ok(at);
            }
        }
        index = at as usize + 1;
    }
    Err(crate::i18n::pick(
        "这个包里找不到 7z 数据（既不是 7z，也不像是 7z 自解压包）。",
        "No 7z data found in this file (it's neither a 7z nor a 7z self-extracting archive).",
    ))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn read_error(err: std::io::Error) -> String {
    crate::i18n::pick(&format!("读不了这个包：{err}"), &format!("Couldn't read this archive: {err}"))
}

/// 打开（可能带自解压 stub 的）7z 包，返回包里那份 Archive 元数据。
#[cfg(any(windows, test))]
pub fn read_7z_archive<R: std::io::Read + std::io::Seek>(
    reader: R,
) -> Result<sevenz_rust2::Archive, String> {
    let mut window = SevenZipWindow::new(reader)?;
    sevenz_rust2::Archive::read(&mut window, &sevenz_rust2::Password::empty()).map_err(|err| {
        crate::i18n::pick(
            &format!("读不出这个 7z：{err}"),
            &format!("Couldn't read this 7z: {err}"),
        )
    })
}

/// 解开（可能带自解压 stub 的）7z 包。`report` 收的是「已处理条目数 / 总条目数」。
#[cfg(any(windows, test))]
pub fn extract_7z_window<R: std::io::Read + std::io::Seek>(
    reader: R,
    dest: &std::path::Path,
    total: u64,
    report: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let window = SevenZipWindow::new(reader)?;
    // 计数**在这里面**做：调用方就不用自己拿一个可变计数器了 ——
    // 「闭包可变捕获 = FnMut」传不进 `&dyn Fn`，而这段只有 Windows 才编得到，
    // 本机（macOS）编不出来就不会红，只能在 CI 上炸（0.1.75 就是这么埋进去的）。
    let mut done: u64 = 0;
    sevenz_rust2::decompress_with_extract_fn(window, dest, |entry, reader, path| {
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
fn extract_7z(archive: &Path, dest: &Path, report: &dyn Fn(u64, u64)) -> Result<(), String> {
    // 先只看条目名（读元数据，不解压）：库不保证拒绝写到目标目录外的名字。
    // `Archive::open` 只认普通 7z（它内部从偏移 0 读签名），所以这里走
    // `read_7z_archive` —— 自解压包（MAME 的 Windows 包就是）也能读。
    let listing = read_7z_archive(std::fs::File::open(archive).map_err(read_error)?)?;
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
    // 再打开一次文件用来解压（元数据那一次已经把 reader 消耗掉了）。
    let file = std::fs::File::open(archive).map_err(read_error)?;
    extract_7z_window(file, &dest, total, report)
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
    /// MAME 的官方 Windows 包是 `mame0289b_x64.exe`：一个 7z 自解压包。只看扩展名的话 `.exe`
    /// 会走到 zip 分支，而 `Expand-Archive` 只吃 `.zip` —— 结果是每次都报「压缩包可能损坏」。
    ///
    /// ⚠️ 判据**不能**是「文件尾有没有签名」：真 7z 的尾部是 next header（首字节 `0x17`），
    /// 签名只在开头。上一版就是按尾巴找的，于是真包一律判成「不是 7z」，这个测试当时
    /// 也照着错的前提手搓了一个「尾部带签名」的假包，一路绿着 —— 真机上却永远装不上。
    /// 现在判据是「开头 1 MiB 里找得到 7z 流 + 签名头自洽」，见 `find_7z_start`。
    #[test]
    fn detects_7z_by_extension_and_by_sfx_header() {
        let dir = temp_dir("sevenz");

        // 扩展名就是 7z：不用读文件内容。
        let plain = dir.join("pcsx2.7z");
        std::fs::write(&plain, b"7z\xBC\xAF'\x1C").unwrap();
        assert!(looks_like_7z(&plain));

        // 自解压包：PE stub + 一个自洽的 7z 签名头（`NextHeaderOffset/Size` 要能对上文件大小）。
        let sfx = dir.join("mame0289b_x64.exe");
        std::fs::write(&sfx, build_fake_sfx(4096, 64)).unwrap();
        assert!(looks_like_7z(&sfx), "自解压的 .exe 没被认成 7z —— 街机那张卡就会走 zip 分支");

        // 签名头对不上文件大小的（例如被人截断）不算 7z。
        let broken = dir.join("truncated.exe");
        let mut body = build_fake_sfx(4096, 64);
        body.truncate(body.len() - 10);
        std::fs::write(&broken, &body).unwrap();
        assert!(!looks_like_7z(&broken), "签名头对不上文件大小还判成 7z，会把坏包送去解压");

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

    /// 手搓一个「PE stub + 自洽 7z 签名头」的假自解压包（只为判定/找起点用，内容不是真 7z）。
    fn build_fake_sfx(stub_len: usize, next_size: usize) -> Vec<u8> {
        let mut body = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
        body.resize(stub_len, 0);
        body.extend_from_slice(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]); // 签名
        body.extend_from_slice(&[0x00, 0x04]); // 版本
        body.extend_from_slice(&[0u8; 4]); // StartHeaderCRC
        // 紧跟签名头的 next header（32 字节头之后就是它）
        body.extend_from_slice(&0u64.to_le_bytes()); // NextHeaderOffset
        body.extend_from_slice(&(next_size as u64).to_le_bytes()); // NextHeaderSize
        body.extend_from_slice(&[0u8; 4]); // NextHeaderCRC
        body.resize(body.len() + next_size, 0x17);
        body
    }

    /// **自解压包真的能解开**（上一条只钉了「认得出」，这条钉「解得开」）。
    ///
    /// 真机现场：街机那张卡点了安装报失败。上一个测试证明包被认成了 7z，可是解压走的是
    /// `sevenz_rust2`，它的 `Archive::read` 第一件事是从**偏移 0** 读 6 字节签名 ——
    /// 自解压包那里是 `MZ`，直接 `BadSignature`。这一条用库自己的 writer 造一个真 7z、
    /// 前面糊一层 PE stub，走 `extract_7z_window` 把内容解出来（本机 macOS 就能跑：
    /// sevenz-rust2 在 `[dev-dependencies]` 里挂着同一份）。
    #[test]
    fn extracts_a_real_seven_zip_self_extracting_archive() {
        use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
        let dir = temp_dir("sfx-extract");

        // ① 一个真 7z，里面一个 hello.txt。
        let plain = dir.join("plain.7z");
        let mut writer = ArchiveWriter::create(&plain).unwrap();
        writer
            .push_archive_entry(
                ArchiveEntry::new_file("hello.txt"),
                Some(std::io::Cursor::new(b"hello from inside the stub".to_vec())),
            )
            .unwrap();
        writer.finish().unwrap();

        // ② 前面糊一段 PE stub（MAME 那个包是 205,824 字节；这里 4 KiB 足够说明问题）。
        let sfx = dir.join("mame-test.exe");
        let inner = std::fs::read(&plain).unwrap();
        let mut body = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
        body.extend(std::iter::repeat_n(0u8, 4096 - body.len()));
        body.extend_from_slice(&inner);
        std::fs::write(&sfx, &body).unwrap();

        // ③ 认得出是 7z、找得到 7z 流起点、读得出元数据、也解得出内容。
        assert!(looks_like_7z(&sfx));
        let archive = read_7z_archive(std::fs::File::open(&sfx).unwrap()).unwrap();
        assert_eq!(archive.files.len(), 1);
        assert_eq!(archive.files[0].name, "hello.txt");

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let entries = std::cell::Cell::new(0u64);
        extract_7z_window(std::fs::File::open(&sfx).unwrap(), &out, 1, &|_, _| {
            entries.set(entries.get() + 1)
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("hello.txt")).unwrap(),
            "hello from inside the stub",
            "自解压包里的文件没解出来"
        );
        assert!(entries.get() >= 1, "解压回调一次都没被调用");

        // ④ 普通 7z（偏移 0）走同一条路也不能坏。
        let out2 = dir.join("out2");
        std::fs::create_dir_all(&out2).unwrap();
        extract_7z_window(std::fs::File::open(&plain).unwrap(), &out2, 1, &|_, _| {}).unwrap();
        assert_eq!(
            std::fs::read_to_string(out2.join("hello.txt")).unwrap(),
            "hello from inside the stub"
        );

        // ⑤ 两头都不是 7z 的文件要报一句人话，而不是 panic。
        let junk = dir.join("junk.exe");
        std::fs::write(&junk, b"MZ\x90\x00 nothing to see here").unwrap();
        assert!(read_7z_archive(std::fs::File::open(&junk).unwrap()).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
