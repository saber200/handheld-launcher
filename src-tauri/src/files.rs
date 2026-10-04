use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::i18n::pick;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    /// 修改时间（Unix 毫秒，取不到就是 0）。按时间排序、属性面板看日期都要它。
    pub modified: u64,
    pub editable: bool,
}

/// 文件操作失败的原因。
///
/// 以前一律 `Err(String)`：前端只能把这句原文照贴，于是「先关掉占用它的程序」「得用管理员
/// 身份」「路径太长」这些**该给不同建议**的情况长得一模一样。`reason` 是稳定的机器码
/// （`denied` / `busy` / `space` / `toolong` / `missing` / `exists` / `name` / `rule` /
/// `cancelled` / `other`），`message` 才是给人看的那句话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub reason: String,
    pub message: String,
}

impl FileError {
    pub fn new(reason: &str, message: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            message: message.into(),
        }
    }

    /// 业务规则上的拒绝：不能动盘符、不能粘到自己里面…… 这不是系统报错。
    pub fn rule(message: impl Into<String>) -> Self {
        Self::new("rule", message)
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", pick("已取消", "Cancelled"))
    }

    /// 已经有现成文案、只是没有 `io::Error` 的场合（拼路径失败之类）。
    pub fn raw(message: impl Into<String>) -> Self {
        Self::new("other", message)
    }

    pub fn io(zh: &str, en: &str, err: &std::io::Error) -> Self {
        Self::new(
            io_reason(err),
            pick(&format!("{zh}：{err}"), &format!("{en}: {err}")),
        )
    }
}

/// Windows 的原始错误码比 `ErrorKind` 细：占用、盘满、路径过长都落在 `Other` 里，
/// 只看 `kind()` 会把它们全归成「其他」。这里先看码，再看类型。
fn io_reason(err: &std::io::Error) -> &'static str {
    if let Some(code) = err.raw_os_error() {
        match code {
            2 | 3 => return "missing",   // FILE_NOT_FOUND / PATH_NOT_FOUND
            5 | 65 => return "denied",   // ACCESS_DENIED / NETWORK_ACCESS_DENIED
            32 | 33 => return "busy",    // SHARING_VIOLATION / LOCK_VIOLATION
            39 | 112 => return "space",  // HANDLE_DISK_FULL / DISK_FULL
            123 => return "name",        // INVALID_NAME
            145 => return "notempty",    // DIR_NOT_EMPTY
            206 => return "toolong",     // FILENAME_EXCED_RANGE
            _ => {}
        }
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => "missing",
        std::io::ErrorKind::PermissionDenied => "denied",
        std::io::ErrorKind::AlreadyExists => "exists",
        _ => "other",
    }
}

/// 把磁盘活儿丢给 worker 线程，但把两种失败分开：worker 自己挂了是没有原因可言的代码问题
/// （`other`），活儿失败则带着自己那条明确的 reason。
async fn worker<T, F>(work: F) -> Result<T, FileError>
where
    F: FnOnce() -> Result<T, FileError> + Send + 'static,
    T: Send + 'static,
{
    match crate::off_main(work).await {
        Ok(done) => done,
        Err(err) => Err(FileError::raw(err)),
    }
}

// Disk work runs on a worker thread: the Files tab re-asks for the drive list
// and the current folder every time the tab is (re)mounted, and a plain
// `#[tauri::command] fn` would hold the main thread — and with it every window
// — for as long as a dead card reader or an unreachable share takes to answer.
#[tauri::command]
pub async fn file_places() -> Vec<FileEntry> {
    crate::off_main(places).await.unwrap_or_default()
}

#[tauri::command]
pub async fn file_list(path: String) -> Result<Vec<FileEntry>, FileError> {
    worker(move || list_dir(Path::new(&path))).await
}

#[tauri::command]
pub async fn file_make_dir(parent: String, name: String) -> Result<(), FileError> {
    worker(move || make_dir(&parent, &name)).await
}

fn make_dir(parent: &str, name: &str) -> Result<(), FileError> {
    let name = check_name(name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(FileError::new(
            "exists",
            pick("已经有同名项目", "That name is already here."),
        ));
    }
    std::fs::create_dir(&dest).map_err(|err| {
        FileError::io("无法新建文件夹", "Couldn't create the folder", &err)
    })
}

#[tauri::command]
pub async fn file_make_file(parent: String, name: String) -> Result<(), FileError> {
    worker(move || make_file(&parent, &name)).await
}

fn make_file(parent: &str, name: &str) -> Result<(), FileError> {
    let name = check_name(name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(FileError::new(
            "exists",
            pick("已经有同名项目", "That name is already here."),
        ));
    }
    std::fs::write(&dest, b"")
        .map_err(|err| FileError::io("无法新建文件", "Couldn't create the file", &err))
}

#[tauri::command]
pub async fn file_copy(from: String, dest_dir: String) -> Result<(), FileError> {
    worker(move || copy_entry(from, dest_dir)).await
}

fn copy_entry(from: String, dest_dir: String) -> Result<(), FileError> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
    if is_drive_root(&from) {
        return Err(FileError::rule(pick("不能复制磁盘根目录", "Can't copy a volume root.")));
    }
    if !from.exists() {
        return Err(FileError::new(
            "missing",
            pick("找不到要复制的项目", "Couldn't find the item to copy."),
        ));
    }
    if !dest_dir.is_dir() {
        return Err(FileError::rule(pick("只能粘贴到文件夹里", "Paste into a folder.")));
    }
    reject_inside(&from, &dest_dir)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FileError::rule(pick("这个名称不能用", "That name can't be used")))?;
    let dest = dest_dir.join(sibling_name(&dest_dir, name));
    copy_path(&from, &dest).map_err(|err| FileError::io("无法复制", "Couldn't copy", &err))
}

#[tauri::command]
pub async fn file_delete(path: String) -> Result<(), FileError> {
    worker(move || delete_entry(path)).await
}

fn delete_entry(path: String) -> Result<(), FileError> {
    let path = PathBuf::from(path);
    if is_drive_root(&path) || std::fs::canonicalize(&path).is_ok_and(|p| is_drive_root(&p)) {
        return Err(FileError::rule(pick(
            "不能删除盘符或共享根目录",
            "Can't delete a volume or share root.",
        )));
    }
    if !path.exists() {
        return Err(FileError::new(
            "missing",
            pick("找不到要删除的项目", "Couldn't find the item to delete."),
        ));
    }
    reject_reparse_dir(&path)?;
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    removed.map_err(|err| FileError::io("无法删除", "Couldn't delete", &err))
}

fn is_drive_root(path: &Path) -> bool {
    if path.parent().is_none() && path.has_root() {
        return true;
    }
    // Windows Path::components handles drive, UNC and verbatim share prefixes.
    // The textual check also protects Windows paths in cross-platform unit tests.
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    let text = text.strip_prefix("\\\\.\\").unwrap_or(text);
    let trimmed = text.trim_end_matches('\\');
    let bytes = trimmed.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    if let Some(share) = trimmed.strip_prefix("UNC\\").or_else(|| trimmed.strip_prefix("\\\\")) {
        let mut parts = share.split('\\');
        return parts.next().is_some_and(|s| !s.is_empty())
            && parts.next().is_some_and(|s| !s.is_empty())
            && parts.next().is_none();
    }
    false
}

fn reject_reparse_dir(path: &Path) -> Result<(), FileError> {
    // 递归删除 / 递归复制碰到目录链接就得停：它可能指向另一块盘，甚至指回自己。
    if path.is_dir() && is_reparse(path) {
        return Err(FileError::rule(pick(
            "不能操作目录链接",
            "Can't operate on a directory link.",
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn file_move(from: String, dest_dir: String) -> Result<(), FileError> {
    worker(move || move_entry(from, dest_dir)).await
}

fn move_entry(from: String, dest_dir: String) -> Result<(), FileError> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
    if is_drive_root(&from) || std::fs::canonicalize(&from).is_ok_and(|p| is_drive_root(&p)) {
        return Err(FileError::rule(pick("不能移动磁盘根目录", "Can't move a volume root.")));
    }
    if !from.exists() {
        return Err(FileError::new(
            "missing",
            pick("找不到要移动的项目", "Couldn't find the item to move."),
        ));
    }
    reject_reparse_dir(&from)?;
    if !dest_dir.is_dir() {
        return Err(FileError::rule(pick("只能移动到文件夹里", "Move into a folder.")));
    }
    if from.parent().is_some_and(|parent| same_path(parent, &dest_dir)) {
        return Err(FileError::rule(pick(
            "已经在这个文件夹里",
            "It's already in this folder.",
        )));
    }
    reject_inside(&from, &dest_dir)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| FileError::rule(pick("这个名称不能用", "That name can't be used")))?;
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err(FileError::new(
            "exists",
            pick("目标里已经有同名项目", "That name is already here."),
        ));
    }
    match std::fs::rename(&from, &dest) {
        Ok(()) => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {}
        Err(err) => return Err(FileError::io("无法移动", "Couldn't move", &err)),
    }
    // Reserve the staging name atomically; never clean up another process's path.
    let is_dir = from.is_dir();
    let staged = (0u32..100).find_map(|attempt| {
        let candidate = dest_dir.join(format!(".fantasyhub-move-{}-{attempt}-{name}", std::process::id()));
        let result = if is_dir {
            std::fs::create_dir(&candidate)
        } else {
            std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate).map(|_| ())
        };
        match result {
            Ok(()) => Some(Ok(candidate)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(err) => Some(Err(err)),
        }
    }).ok_or_else(|| FileError::raw(pick("无法分配移动临时位置", "Couldn't reserve a temporary name")))?
      .map_err(|err| FileError::io("无法移动", "Couldn't move", &err))?;
    if let Err(err) = copy_path(&from, &staged) {
        let _ = remove_path(&staged);
        return Err(FileError::io("无法移动", "Couldn't move", &err));
    }
    if let Err(err) = std::fs::rename(&staged, &dest) {
        let _ = remove_path(&staged);
        return Err(FileError::io("无法完成移动", "Couldn't finish move", &err));
    }
    remove_path(&from).map_err(|err| {
        FileError::new(
            io_reason(&err),
            pick(
                &format!("已经复制到目标，但原位置可能只删了一部分：{err}"),
                &format!("Copied, but the original may be partially removed: {err}"),
            ),
        )
    })
}

#[tauri::command]
pub async fn file_read_text(path: String) -> Result<String, FileError> {
    worker(move || read_text(Path::new(&path))).await
}

#[tauri::command]
pub async fn file_write_text(path: String, text: String) -> Result<(), FileError> {
    worker(move || write_text(path, text)).await
}

fn write_text(path: String, text: String) -> Result<(), FileError> {
    let path = Path::new(&path);
    if path.is_dir() {
        return Err(FileError::rule(pick(
            "不能把文件夹当成文本保存",
            "A folder can't be saved as text.",
        )));
    }
    std::fs::write(path, text.as_bytes()).map_err(|err| FileError::io("无法保存", "Couldn't save", &err))
}

#[tauri::command]
pub async fn file_icon(app: tauri::AppHandle, path: String) -> String {
    if path.trim().is_empty() {
        return String::new();
    }
    // Icon extraction + PNG encoding is tens of milliseconds per file; keep it
    // off the event loop so a card of new programs cannot stall the shell.
    crate::off_main(move || crate::media::cached_icon(&app, &path, &path))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn file_open(path: String) -> Result<(), FileError> {
    worker(move || open_entry(path)).await
}

fn open_entry(path: String) -> Result<(), FileError> {
    if !Path::new(&path).exists() {
        return Err(FileError::new(
            "missing",
            pick("找不到这个文件", "Couldn't find that file."),
        ));
    }
    open_with_system(&path)
}

fn places() -> Vec<FileEntry> {
    let mut found = Vec::new();
    #[cfg(windows)]
    found.extend(letters());
    #[cfg(not(windows))]
    found.push(dir_entry(pick("根目录", "Root"), "/".to_string()));
    if let Some(home) = home_dir() {
        found.extend(shortcut_folders(&home));
        found.push(dir_entry(pick("用户文件夹", "Home"), home.display().to_string()));
    }
    found
}

/// 用户家目录：Windows 看 `USERPROFILE`，其余看 `HOME`。取不到就当没有 —— 与其给一个
/// 点进去报错的路径，不如不列。
fn home_dir() -> Option<PathBuf> {
    let raw = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }?;
    let path = PathBuf::from(raw);
    path.is_dir().then_some(path)
}

/// 「常用位置」：桌面 / 下载 / 文档 / 图片 / 音乐 / 视频。
///
/// 这里**故意**只拼家目录下的常规名字，不问 `SHGetKnownFolderPath`：那个 API 要 Shell 的
/// 内存分配，而 Windows 侧代码在本机（macOS）编不了、只能等 CI —— 为一个入口去赌一次
/// 类型检查不划算。代价是用户把「下载」重定向到别的盘时这里列不出来（照旧能从盘符进去），
/// 而不是列出一个点进去报错的位置：不存在的目录会被跳过。
fn shortcut_folders(home: &Path) -> Vec<FileEntry> {
    const SUBS: [(&str, &str, &str); 6] = [
        ("桌面", "Desktop", "Desktop"),
        ("下载", "Downloads", "Downloads"),
        ("文档", "Documents", "Documents"),
        ("图片", "Pictures", "Pictures"),
        ("音乐", "Music", "Music"),
        ("视频", "Videos", "Videos"),
    ];
    SUBS.iter()
        .copied()
        .map(|(zh, en, folder)| (pick(zh, en), home.join(folder)))
        .filter(|(_, path)| path.is_dir())
        .map(|(name, path)| dir_entry(name, path.display().to_string()))
        .collect()
}

fn dir_entry(name: String, path: String) -> FileEntry {
    FileEntry {
        name,
        path,
        kind: "dir".into(),
        bytes: 0,
        modified: 0,
        editable: false,
    }
}

/// `DRIVE_NO_ROOT_DIR`: the letter is in the bitmap but has no usable root
/// (an empty card reader, a removed USB stick). See Win32 `GetDriveType`.
#[cfg(windows)]
const DRIVE_NO_ROOT_DIR: u32 = 1;

/// Drive letters from the kernel's cached bitmask.
///
/// The old loop probed `Path::new("X:\\").exists()` for A..Z, i.e. real device
/// I/O per letter: an empty card reader or an unreachable share answers late
/// (or never), so simply opening the Files tab could block for seconds.
/// `GetLogicalDrives` + `GetDriveTypeW` only read cached state.
#[cfg(windows)]
fn letters() -> Vec<FileEntry> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        // No bitmap (rare): never hand the user an empty list, C: always exists.
        return vec![dir_entry("C:".into(), "C:\\".into())];
    }
    let mut found = Vec::new();
    for letter in b'A'..=b'Z' {
        if mask & (1u32 << (letter - b'A')) == 0 {
            continue;
        }
        let path = format!("{}:\\", letter as char);
        let mut wide: Vec<u16> = path.encode_utf16().collect();
        wide.push(0);
        if unsafe { GetDriveTypeW(wide.as_ptr()) } == DRIVE_NO_ROOT_DIR {
            continue;
        }
        found.push(dir_entry(format!("{}:", letter as char), path));
    }
    found
}

fn list_dir(path: &Path) -> Result<Vec<FileEntry>, FileError> {
    if !path.is_dir() {
        return Err(FileError::new(
            "notdir",
            pick("打不开这个文件夹", "Couldn't open this folder."),
        ));
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(path)
        .map_err(|err| FileError::io("无法读取文件夹", "Couldn't read the folder", &err))?;
    for item in read.flatten() {
        let path = item.path();
        let Some(name) = item.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let meta = item.metadata().ok();
        let is_dir = meta.as_ref().is_some_and(|meta| meta.is_dir());
        entries.push(FileEntry {
            editable: !is_dir && is_editable_name(&name),
            kind: if is_dir { "dir" } else { "file" }.into(),
            bytes: meta.as_ref().map(|meta| meta.len()).unwrap_or(0),
            modified: meta.as_ref().map(modified_ms).unwrap_or(0),
            name,
            path: path.display().to_string(),
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 修改时间（Unix 毫秒）。取不到就是 0 —— 前端按 0 当作「未知」，不参与时间排序。
fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn read_text(path: &Path) -> Result<String, FileError> {
    if path.is_dir() {
        return Err(FileError::rule(pick(
            "文件夹不能当文本编辑",
            "A folder can't be edited as text.",
        )));
    }
    let meta = std::fs::metadata(path)
        .map_err(|err| FileError::io("无法读取", "Couldn't read", &err))?;
    if meta.len() > 1_000_000 {
        return Err(FileError::new(
            "big",
            pick("文件太大，不能在这里编辑", "This file is too large to edit here."),
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|err| FileError::io("无法读取", "Couldn't read", &err))?;
    String::from_utf8(bytes).map_err(|_| FileError::new("binary", pick("这个文件不是文本", "This file isn't text")))
}

fn check_name(name: &str) -> Result<&str, FileError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(FileError::new("name", pick("请输入名称", "Enter a name.")));
    }
    if name == "." || name == ".." || name.len() > 120 {
        return Err(FileError::new("name", pick("这个名称不能用", "That name can't be used.")));
    }
    if name.chars().any(|c| r#"\/:*?"<>|"#.contains(c) || c.is_control()) {
        return Err(FileError::new(
            "name",
            pick(
                "名称里不能有 \\ / : * ? \" < > |",
                "A name can't contain \\ / : * ? \" < > |",
            ),
        ));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "LPT1" | "LPT2"
    ) {
        return Err(FileError::new("name", pick("这个名称不能用", "That name can't be used.")));
    }
    Ok(name)
}

fn is_editable_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        ".gitignore" | ".gitattributes" | ".editorconfig" | "readme" | "license"
    ) {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => matches!(
            ext,
            "txt"
                | "md"
                | "json"
                | "log"
                | "ini"
                | "cfg"
                | "conf"
                | "xml"
                | "csv"
                | "yaml"
                | "yml"
                | "toml"
                | "html"
                | "htm"
                | "css"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "rs"
                | "py"
                | "bat"
                | "cmd"
                | "ps1"
                | "vdf"
                | "url"
        ),
        _ => !lower.contains('.'),
    }
}

fn sibling_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = split_name(name);
    let word = pick("副本", "copy");
    for n in 1..100 {
        let candidate = if ext.is_empty() {
            if n == 1 {
                format!("{stem} {word}")
            } else {
                format!("{stem} {word} {n}")
            }
        } else if n == 1 {
            format!("{stem} {word}.{ext}")
        } else {
            format!("{stem} {word} {n}.{ext}")
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{name}.copy")
}

fn split_name(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (name, ""),
    }
}

fn reject_inside(from: &Path, dest_dir: &Path) -> Result<(), FileError> {
    let Ok(from) = std::fs::canonicalize(from) else {
        return Ok(());
    };
    let Ok(dest_dir) = std::fs::canonicalize(dest_dir) else {
        return Ok(());
    };
    if dest_dir.starts_with(&from) {
        return Err(FileError::rule(pick(
            "不能粘贴到它自己里面",
            "Can't paste a folder into itself.",
        )));
    }
    Ok(())
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
}

fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if from.is_dir() {
        use std::os::windows::fs::MetadataExt;
        if std::fs::symlink_metadata(from)?.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "directory reparse point"));
        }
    }
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for item in std::fs::read_dir(from)? {
            let item = item?;
            copy_path(&item.path(), &to.join(item.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
        Ok(())
    }
}

fn open_with_system(path: &str) -> Result<(), FileError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let file: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().chain(Some(0)).collect();
        let op: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (code as isize) <= 32 {
            return Err(FileError::new("other", pick("无法打开", "Couldn't open.")));
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| FileError::io("无法打开", "Couldn't open", &err))?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| FileError::io("无法打开", "Couldn't open", &err))?;
        Ok(())
    }
}

// ------------------------------------------------------- 属性 / 改名 / 搜索

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperties {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    /// 文件夹的大小是当场走一遍算的；`false` 表示没算完（超时），这时数字是**下限**，
    /// 前端会标出来，免得用户把它当准数。
    pub size_complete: bool,
    pub modified: u64,
    pub created: u64,
    pub extension: String,
    pub readonly: bool,
    pub hidden: bool,
    /// 这个地方现在能不能写。不是猜的：目录里建一个临时文件再删掉，文件就以写方式打开。
    pub writable: bool,
    /// 不能写的机器码（`denied` / `busy` / 空）。前端用它决定要不要提「管理员」。
    pub write_reason: String,
    /// 系统 / 程序目录：提权引导只对这种位置说「可能需要管理员」。
    pub protected: bool,
}

/// 走盘算大小的预算。属性面板给一个文件夹 3 秒；文件列表一屏几十个文件夹**共用**同一个
/// 截止时间（见 `dir_sizes`）—— 掌机上不能因为某个几万文件的目录让「进目录」一直转。
const DIR_SIZE_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

/// 走一遍目录算总大小。`deadline` 是共用截止时间：超了就返回下限（`false`）。
fn dir_bytes_until(path: &Path, deadline: std::time::Instant) -> (u64, bool) {
    let mut stack = vec![path.to_path_buf()];
    let mut total = 0u64;
    while let Some(dir) = stack.pop() {
        if std::time::Instant::now() >= deadline {
            return (total, false);
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => stack.push(entry.path()),
                Ok(meta) => total += meta.len(),
                Err(_) => continue,
            }
        }
    }
    (total, true)
}

/// 属性面板用：单个文件夹，自己一份预算。
fn dir_bytes(path: &Path) -> (u64, bool) {
    dir_bytes_until(path, std::time::Instant::now() + DIR_SIZE_BUDGET)
}

fn is_hidden(path: &Path, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        let _ = path;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        path.file_name()
            .map(|name| name.to_string_lossy().starts_with('.'))
            .unwrap_or(false)
    }
}

/// 系统 / 程序目录。只用于**提示**（「这里可能要管理员」），不拿去拦操作：
/// 用户真想往里写就让他试，失败了我们会给出真正的原因。
fn is_protected(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    const ROOTS: [&str; 4] = [
        "c:\\windows",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\programdata",
    ];
    ROOTS.iter().any(|root| text.starts_with(root))
}

fn writability(path: &Path) -> (bool, String) {
    if path.is_dir() {
        for attempt in 0..20u32 {
            let probe = path.join(format!(".fantasyhub-write-{}-{attempt}", std::process::id()));
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&probe);
                    return (true, String::new());
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return (false, io_reason(&err).to_string()),
            }
        }
        return (false, "other".into());
    }
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => (true, String::new()),
        Err(err) => (false, io_reason(&err).to_string()),
    }
}

#[tauri::command]
pub async fn file_properties(path: String) -> Result<FileProperties, FileError> {
    worker(move || inspect(Path::new(&path))).await
}

fn inspect(path: &Path) -> Result<FileProperties, FileError> {
    let meta = std::fs::metadata(path)
        .map_err(|err| FileError::io("无法读取属性", "Couldn't read properties", &err))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.display().to_string());
    let is_dir = meta.is_dir();
    let (bytes, size_complete) = if is_dir {
        dir_bytes(path)
    } else {
        (meta.len(), true)
    };
    let created = meta
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    let (writable, write_reason) = writability(path);
    Ok(FileProperties {
        extension: if is_dir {
            String::new()
        } else {
            path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
        },
        hidden: is_hidden(path, &meta),
        readonly: meta.permissions().readonly(),
        kind: if is_dir { "dir".into() } else { "file".into() },
        name,
        path: path.display().to_string(),
        bytes,
        size_complete,
        modified: modified_ms(&meta),
        created,
        writable,
        write_reason,
        protected: is_protected(path),
    })
}

/// 文件列表里「文件夹多大」。文件夹的大小只能走一遍盘才知道，所以是**异步补上来**的：
/// `complete: false` 表示预算用完没走完（`bytes` 是下限，前端加「≥」）；`bytes = 0` 且没走完
/// 表示压根没轮到算（前端先不显示数字）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirSize {
    pub path: String,
    pub bytes: u64,
    pub complete: bool,
}

/// 算一屏文件夹的大小。走 worker 线程、可取消（前端换目录时 `file_cancel`），
/// 所以列目录本身永远是瞬时的，大小是一个个补上来的。
#[tauri::command]
pub async fn file_dir_sizes(id: String, parent: String) -> Result<Vec<DirSize>, FileError> {
    let token = job_start(&id);
    let found = worker(move || dir_sizes(Path::new(&parent), &token)).await;
    job_finish(&id);
    found
}

/// 只算**直接子文件夹**，而且不跟进链接（junction 可能指回自己，也可能让同一份数据被算两遍）。
/// 所有子文件夹共用一份预算：一屏里前几个很大的目录不会把后面全拖成「没算」。
fn dir_sizes(parent: &Path, token: &Arc<AtomicBool>) -> Result<Vec<DirSize>, FileError> {
    if !parent.is_dir() {
        return Ok(Vec::new());
    }
    let read = std::fs::read_dir(parent)
        .map_err(|err| FileError::io("无法读取文件夹", "Couldn't read the folder", &err))?;
    let dirs: Vec<PathBuf> = read
        .flatten()
        .map(|item| item.path())
        .filter(|path| path.is_dir() && !is_reparse(path))
        .collect();
    let deadline = std::time::Instant::now() + DIR_SIZE_BUDGET;
    let mut out = Vec::with_capacity(dirs.len());
    for dir in dirs {
        // 取消 = 前端已经换目录了：剩下的没必要再走盘。
        if token.load(Ordering::Relaxed) {
            break;
        }
        let (bytes, complete) = if std::time::Instant::now() < deadline {
            dir_bytes_until(&dir, deadline)
        } else {
            (0, false)
        };
        out.push(DirSize {
            path: dir.display().to_string(),
            bytes,
            complete,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn file_rename(from: String, to: String) -> Result<(), FileError> {
    worker(move || rename_entry(&from, &to)).await
}

fn rename_entry(from: &str, to: &str) -> Result<(), FileError> {
    let from = PathBuf::from(from);
    if is_drive_root(&from) {
        return Err(FileError::rule(pick("不能重命名盘符", "Can't rename a volume.")));
    }
    if !from.exists() {
        return Err(FileError::new(
            "missing",
            pick("找不到这个项目", "Couldn't find that item."),
        ));
    }
    // 只改最后一段名字：目标必须还在同一个父目录里。跨目录的 `rename` 跨盘时会直接失败，
    // 而且「重命名」也不该悄悄变成「移动」。
    let parent = from
        .parent()
        .ok_or_else(|| FileError::rule(pick("这个位置不能重命名", "This location can't be renamed.")))?
        .to_path_buf();
    let name = check_name(to)?;
    let dest = parent.join(name);
    if same_path(&from, &dest) {
        return Ok(());
    }
    if dest.exists() {
        return Err(FileError::new(
            "exists",
            pick("已经有同名项目", "That name is already here."),
        ));
    }
    std::fs::rename(&from, &dest).map_err(|err| FileError::io("无法重命名", "Couldn't rename", &err))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFailure {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReport {
    pub done: usize,
    pub failures: Vec<RenameFailure>,
}

struct RenameStep {
    from: PathBuf,
    dest: PathBuf,
    temp: PathBuf,
    name: String,
}

#[tauri::command]
pub async fn file_rename_many(pairs: Vec<RenamePair>) -> Result<RenameReport, FileError> {
    worker(move || rename_many(&pairs)).await
}

/// 批量改名。新名字由前端算好（预览和执行必须是**同一份算法**，否则会出现「预览显示 X、
/// 执行成 Y」），这里只负责安全落地：
/// 1. 先整体校验 —— 只改名、新名合法、没有两个源要变成同一个目标、目标没被外人占着；
/// 2. 全部先改成临时名，再改成目标名。为什么必须两步：`1.txt → 2.txt` 和 `2.txt → 3.txt`
///    这种**互相占位**的换名，按顺序直接改是改不动的（前一个的目标被后一个占着）；
/// 3. 中途失败就把还没落地的改回原名，并如实报出是哪一项、为什么。
fn rename_many(pairs: &[RenamePair]) -> Result<RenameReport, FileError> {
    let mut steps: Vec<RenameStep> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for pair in pairs {
        let from = PathBuf::from(&pair.from);
        let name = from
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if is_drive_root(&from) {
            return Err(FileError::rule(pick("不能重命名盘符", "Can't rename a volume.")));
        }
        if !from.exists() {
            return Err(FileError::new(
                "missing",
                pick(&format!("找不到「{name}」"), &format!("Couldn't find “{name}”")),
            ));
        }
        let parent = from
            .parent()
            .ok_or_else(|| FileError::rule(pick("这个位置不能重命名", "This location can't be renamed.")))?
            .to_path_buf();
        let target = check_name(&pair.to)?;
        let dest = parent.join(target);
        if same_path(&from, &dest) {
            continue;
        }
        if let Some(other) = seen.insert(dest.to_string_lossy().to_lowercase(), name.clone()) {
            return Err(FileError::new(
                "exists",
                pick(
                    &format!("「{other}」和「{name}」会改成同一个名字"),
                    &format!("“{other}” and “{name}” would end up with the same name"),
                ),
            ));
        }
        // 目标被占着：占用者本身也在这一批里要被改走就没关系（两步改名会先把它挪开）。
        let taken_by_outsider = pairs
            .iter()
            .all(|other| !same_path(Path::new(&other.from), &dest));
        if dest.exists() && taken_by_outsider {
            return Err(FileError::new(
                "exists",
                pick(
                    &format!("已经有「{target}」了"),
                    &format!("“{target}” is already here"),
                ),
            ));
        }
        let temp = parent.join(format!(
            ".fantasyhub-rename-{}-{}",
            std::process::id(),
            steps.len()
        ));
        steps.push(RenameStep { from, dest, temp, name });
    }
    if steps.is_empty() {
        return Ok(RenameReport {
            done: 0,
            failures: Vec::new(),
        });
    }

    let mut temped: Vec<&RenameStep> = Vec::new();
    for step in &steps {
        if let Err(err) = std::fs::rename(&step.from, &step.temp) {
            for done in &temped {
                let _ = std::fs::rename(&done.temp, &done.from);
            }
            return Err(FileError::io("无法重命名", "Couldn't rename", &err));
        }
        temped.push(step);
    }

    let mut done = 0;
    let mut failures = Vec::new();
    for (index, step) in temped.iter().enumerate() {
        match std::fs::rename(&step.temp, &step.dest) {
            Ok(()) => done += 1,
            Err(err) => {
                let _ = std::fs::rename(&step.temp, &step.from);
                failures.push(RenameFailure {
                    name: step.name.clone(),
                    message: FileError::io("无法重命名", "Couldn't rename", &err).message,
                });
                for rest in &temped[index + 1..] {
                    let _ = std::fs::rename(&rest.temp, &rest.from);
                }
                break;
            }
        }
    }
    Ok(RenameReport { done, failures })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub modified: u64,
    /// 相对搜索起点的目录（如 `存档/2024`），前端当第二行显示。
    pub relative: String,
}

/// 搜索的边界。掌机上「搜索」必须是**能停下来**的操作：用户搜个 “a” 不能变成扫整块盘。
/// 命中 300 条、深度 6 层、跑满 15 秒，任一到达就收工（前端会说明结果是截断过的）。
const SEARCH_MAX_HITS: usize = 300;
const SEARCH_MAX_DEPTH: usize = 6;
const SEARCH_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

#[tauri::command]
pub async fn file_search(id: String, root: String, query: String) -> Result<Vec<SearchHit>, FileError> {
    let token = job_start(&id);
    let found = worker(move || search_tree(Path::new(&root), &query, &token)).await;
    job_finish(&id);
    found
}

fn search_tree(root: &Path, query: &str, token: &Arc<AtomicBool>) -> Result<Vec<SearchHit>, FileError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err(FileError::rule(pick(
            "先输入要搜索的名字",
            "Type something to search for.",
        )));
    }
    if !root.is_dir() {
        return Err(FileError::new(
            "notdir",
            pick("只能在文件夹里搜索", "Search inside a folder."),
        ));
    }
    let started = std::time::Instant::now();
    let mut hits = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if token.load(Ordering::Relaxed) {
            return Err(FileError::cancelled());
        }
        if hits.len() >= SEARCH_MAX_HITS || started.elapsed() > SEARCH_BUDGET {
            break;
        }
        // 没权限的子目录直接跳过：因为撞上一个 System Volume Information 就整次搜索失败，
        // 对用户毫无帮助。
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            let path = item.path();
            let Some(name) = item.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(meta) = item.metadata() else {
                continue;
            };
            // 先算好「要不要往下走」：名字马上要被搬进搜索结果里，之后再借就晚了。
            let descend =
                meta.is_dir() && depth + 1 < SEARCH_MAX_DEPTH && !is_system_dir(&name) && !is_reparse(&path);
            if name.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    relative: relative_dir(root, &dir),
                    kind: if meta.is_dir() { "dir".into() } else { "file".into() },
                    bytes: if meta.is_dir() { 0 } else { meta.len() },
                    modified: modified_ms(&meta),
                    name,
                    path: path.display().to_string(),
                });
                if hits.len() >= SEARCH_MAX_HITS {
                    break;
                }
            }
            if descend {
                stack.push((path, depth + 1));
            }
        }
    }
    hits.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(hits)
}

/// 搜索不进的目录：回收站和「系统卷信息」里全是几万条记录，搜什么都能撞上，
/// 而用户几乎不可能想从那里找东西。
fn is_system_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "$recycle.bin" | "system volume information" | "$windows.~bt" | "$windows.~ws"
    )
}

fn relative_dir(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .ok()
        .map(|rest| rest.display().to_string())
        .unwrap_or_default()
}

/// 是不是目录链接（junction / symlink）。链接不能跟进、不能递归删、不能递归拷：
/// 它可能指向另一块盘，甚至指回自己。
fn is_reparse(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::fs::symlink_metadata(path)
            .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        std::fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(true)
    }
}

// ---------------------------------------------------------------- 传输引擎

/// 进度事件名：前端 `listen("files-transfer")` 收。带 `id` 是因为同一时间可以有多个任务
/// （左右两栏各一个），前端按 id 认领自己那条。
const TRANSFER_EVENT: &str = "files-transfer";

/// 分块大小。1 MiB 在 SD 卡 / U 盘上不碎，报进度也够密。
const COPY_CHUNK: usize = 1024 * 1024;

/// 进度最多每 100 ms 报一次：按块报的话，一堆小文件就能把事件塞爆，而每条事件都会唤醒
/// 一次前端。
const EMIT_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 登记一个可取消的活儿（复制 / 移动 / 搜索）。
fn job_start(id: &str) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    jobs()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(id.to_string(), token.clone());
    token
}

fn job_finish(id: &str) {
    jobs()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(id);
}

/// 取消一个正在跑的活儿。任务已经结束就返回 false —— 前端据此知道「它自己跑完了」。
#[tauri::command]
pub fn file_cancel(id: String) -> bool {
    let map = jobs().lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(token) = map.get(&id) else {
        return false;
    };
    token.store(true, Ordering::SeqCst);
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub id: String,
    /// `scan`（先数总量）/ `run`（在搬）/ `done` / `cancelled` / `error`
    pub phase: String,
    pub name: String,
    pub item_index: usize,
    pub item_total: usize,
    pub items_done: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Conflict {
    /// 覆盖同名的
    Replace,
    /// 跳过已存在的
    Skip,
    /// 给新的换个名字（`xxx 副本`），一个都不动
    Keep,
}

impl Conflict {
    fn parse(raw: &str) -> Self {
        match raw {
            "replace" => Self::Replace,
            "skip" => Self::Skip,
            // 默认「保留两者」：**不删用户的东西**永远是安全的那一边。
            _ => Self::Keep,
        }
    }
}

struct Planned {
    from: PathBuf,
    dest: PathBuf,
    name: String,
    size: u64,
}

/// 一次传输的记账本：进度事件、取消检查、最终汇总都从这里出。
///
/// 「怎么把进度送出去」做成注入的 sink，而不是直接抓 `AppHandle`：这样复制 / 移动 / 同名
/// 策略这几条最容易出人命的路径在**本机**（macOS）就能单测，不必等 Windows 真机。
struct Runner<'a> {
    sink: &'a mut dyn FnMut(&TransferProgress),
    id: String,
    token: Arc<AtomicBool>,
    phase: &'static str,
    name: String,
    item_index: usize,
    item_total: usize,
    items_done: usize,
    skipped: usize,
    bytes: u64,
    total_bytes: u64,
    last_emit: std::time::Instant,
}

impl Runner<'_> {
    fn cancelled(&self) -> bool {
        self.token.load(Ordering::Relaxed)
    }

    fn event(&self, message: String, reason: String) -> TransferProgress {
        TransferProgress {
            id: self.id.clone(),
            phase: self.phase.to_string(),
            name: self.name.clone(),
            item_index: self.item_index,
            item_total: self.item_total,
            items_done: self.items_done,
            skipped: self.skipped,
            bytes: self.bytes,
            total_bytes: self.total_bytes,
            message,
            reason,
        }
    }

    fn emit(&mut self) {
        let event = self.event(String::new(), String::new());
        (self.sink)(&event);
    }

    /// 每块 / 每次换项都过一下：取消要立刻生效，进度最多每 100 ms 报一次。
    fn tick(&mut self) -> Result<(), FileError> {
        if self.cancelled() {
            return Err(FileError::cancelled());
        }
        if self.last_emit.elapsed() >= EMIT_EVERY {
            self.last_emit = std::time::Instant::now();
            self.emit();
        }
        Ok(())
    }
}

/// 开始一次复制 / 移动。
///
/// 命令**立刻返回**：活儿交给独立线程，进度走事件。以前的 `file_copy` / `file_move` 要等
/// 整个复制完成才回话 —— 拷一个 20 GB 的游戏时前端只能干等，连「取消」都按不动，
/// 正是 0.1.44 修过的那类「主线程卡死」。
#[tauri::command]
pub async fn file_transfer(
    app: AppHandle,
    id: String,
    items: Vec<String>,
    dest_dir: String,
    mode: String,
    conflict: String,
) -> Result<(), FileError> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(FileError::rule(pick("只能粘贴到文件夹里", "Paste into a folder.")));
    }
    if items.is_empty() {
        return Err(FileError::rule(pick("没有要处理的项目", "Nothing to transfer.")));
    }
    let moving = mode == "move";
    let policy = Conflict::parse(&conflict);
    let token = job_start(&id);
    std::thread::spawn(move || {
        // 不用 `off_main`：blocking pool 的活儿是「等它跑完再回话」的，而这个线程要活到
        // 大文件拷完，还得能中途取消。
        let payload = {
            let mut sink = |progress: &TransferProgress| {
                let _ = app.emit(TRANSFER_EVENT, progress.clone());
            };
            let mut run = Runner {
                sink: &mut sink,
                id: id.clone(),
                token: token.clone(),
                phase: "scan",
                name: String::new(),
                item_index: 0,
                item_total: items.len(),
                items_done: 0,
                skipped: 0,
                bytes: 0,
                total_bytes: 0,
                last_emit: std::time::Instant::now(),
            };
            match run_transfer(&mut run, &items, &dest, moving, policy) {
                Ok(()) => {
                    run.phase = "done";
                    run.event(String::new(), String::new())
                }
                Err(err) => {
                    // 收尾事件也带着已经搬了多少 —— 「取消了，但已拷 3 项」比
                    // 只丢一句「已取消」有用得多。
                    run.phase = if err.reason == "cancelled" { "cancelled" } else { "error" };
                    run.event(err.message, err.reason)
                }
            }
        };
        job_finish(&id);
        let _ = app.emit(TRANSFER_EVENT, payload);
    });
    Ok(())
}

fn run_transfer(
    run: &mut Runner,
    items: &[String],
    dest_dir: &Path,
    moving: bool,
    policy: Conflict,
) -> Result<(), FileError> {
    // 先列计划：这一遍就把「不能动盘符」「同名怎么处理」定下来，免得搬完前两项才发现
    // 第三项根本不该动。
    let mut planned: Vec<Planned> = Vec::new();
    for raw in items {
        let from = PathBuf::from(raw);
        if is_drive_root(&from) || std::fs::canonicalize(&from).is_ok_and(|p| is_drive_root(&p)) {
            return Err(FileError::rule(pick("不能复制磁盘根目录", "Can't copy a volume root.")));
        }
        if !from.exists() {
            let label = from
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            return Err(FileError::new(
                "missing",
                pick(&format!("找不到「{label}」"), &format!("Couldn't find “{label}”")),
            ));
        }
        reject_reparse_dir(&from)?;
        reject_inside(&from, dest_dir)?;
        let name = from
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let dest = match policy {
            Conflict::Keep => dest_dir.join(sibling_name(dest_dir, &name)),
            _ => dest_dir.join(&name),
        };
        // 往自己所在的文件夹里搬：目标就是自己，跳过比报错更有用。
        if same_path(&from, &dest) {
            continue;
        }
        planned.push(Planned { from, dest, name, size: 0 });
    }
    if planned.is_empty() {
        return Ok(());
    }
    run.item_total = planned.len();

    // 先数总量。没有总量，进度条只能一直转圈，用户看不出「还要 3 分钟还是 30 分钟」。
    run.phase = "scan";
    for item in &mut planned {
        run.name = item.name.clone();
        run.emit();
        item.size = scan_size(&item.from, run)?;
        run.total_bytes += item.size;
    }

    run.phase = "run";
    for (index, item) in planned.iter().enumerate() {
        run.item_index = index;
        run.name = item.name.clone();
        run.emit();
        run.tick()?;

        if item.dest.exists() {
            match policy {
                Conflict::Skip => {
                    // 跳过的那些不计进总量：进度条该显示的是「真正要搬多少」。
                    run.total_bytes = run.total_bytes.saturating_sub(item.size);
                    run.skipped += 1;
                    run.items_done += 1;
                    run.emit();
                    continue;
                }
                Conflict::Replace => {
                    remove_path(&item.dest).map_err(|err| {
                        FileError::io("无法覆盖同名项目", "Couldn't replace the existing item", &err)
                    })?;
                }
                Conflict::Keep => {}
            }
        }

        if moving {
            move_item(run, item)?;
        } else {
            copy_tree(run, &item.from, &item.dest)?;
        }
        run.items_done += 1;
        run.emit();
    }
    Ok(())
}

/// 数一件东西有多大。目录要递归走完 —— 没有总量进度条只能一直转圈；走的路上照常报进度、
/// 照常可取消。目录链接不跟进，也就没有大小。
fn scan_size(from: &Path, run: &mut Runner) -> Result<u64, FileError> {
    run.tick()?;
    let meta = std::fs::symlink_metadata(from)
        .map_err(|err| FileError::io("无法读取", "Couldn't read", &err))?;
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    if is_reparse(from) {
        return Ok(0);
    }
    let mut total = 0;
    let read = std::fs::read_dir(from)
        .map_err(|err| FileError::io("无法读取文件夹", "Couldn't read the folder", &err))?;
    for entry in read.flatten() {
        total += scan_size(&entry.path(), run)?;
    }
    Ok(total)
}

/// 递归复制。目录链接不跟进：它可能指向另一块盘，甚至指回自己。
fn copy_tree(run: &mut Runner, from: &Path, dest: &Path) -> Result<(), FileError> {
    let meta = std::fs::symlink_metadata(from)
        .map_err(|err| FileError::io("无法读取", "Couldn't read", &err))?;
    if meta.is_dir() {
        if is_reparse(from) {
            return Err(FileError::rule(pick("不复制目录链接", "Won't copy a directory link.")));
        }
        std::fs::create_dir_all(dest)
            .map_err(|err| FileError::io("无法新建文件夹", "Couldn't create the folder", &err))?;
        let read = std::fs::read_dir(from)
            .map_err(|err| FileError::io("无法读取文件夹", "Couldn't read the folder", &err))?;
        for entry in read.flatten() {
            run.tick()?;
            copy_tree(run, &entry.path(), &dest.join(entry.file_name()))?;
        }
        return Ok(());
    }
    copy_file(run, from, dest)
}

/// 移动一件东西。同一个卷里 `rename` 是瞬时的；跨卷（`CrossesDevices`）才退化成
/// 「整份复制成功 → 再删源」—— 中途断电最多是「两边都有一份」，绝不是「两边都没有」。
fn move_item(run: &mut Runner, item: &Planned) -> Result<(), FileError> {
    match std::fs::rename(&item.from, &item.dest) {
        Ok(()) => {
            run.bytes += item.size;
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_tree(run, &item.from, &item.dest)?;
            remove_path(&item.from).map_err(|err| {
                FileError::new(
                    io_reason(&err),
                    pick(
                        &format!("已经复制到目标，但原位置没删干净：{err}"),
                        &format!("Copied, but the original wasn't fully removed: {err}"),
                    ),
                )
            })
        }
        Err(err) => Err(FileError::io("无法移动", "Couldn't move", &err)),
    }
}

/// 分块复制，边拷边报进度。
///
/// 先写成隐藏的 `.fantasyhub-part` 再改名：拷到一半被取消 / 断电时，目标目录里不会留下
/// 一个**顶着正式名字的半截文件**（用户会以为已经拷好了）。
fn copy_file(run: &mut Runner, from: &Path, dest: &Path) -> Result<(), FileError> {
    let mut source =
        std::fs::File::open(from).map_err(|err| FileError::io("无法打开", "Couldn't open", &err))?;
    let modified = source.metadata().ok().and_then(|meta| meta.modified().ok());
    let staged = part_path(dest);
    let mut target = std::fs::File::create(&staged)
        .map_err(|err| FileError::io("无法写入", "Couldn't write", &err))?;
    let mut buffer = vec![0u8; COPY_CHUNK];
    loop {
        if let Err(err) = run.tick() {
            let _ = std::fs::remove_file(&staged);
            return Err(err);
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => {
                let _ = std::fs::remove_file(&staged);
                return Err(FileError::io("无法读取", "Couldn't read", &err));
            }
        };
        if let Err(err) = target.write_all(&buffer[..read]) {
            let _ = std::fs::remove_file(&staged);
            return Err(FileError::io("无法写入", "Couldn't write", &err));
        }
        run.bytes += read as u64;
    }
    if let Err(err) = target.flush() {
        let _ = std::fs::remove_file(&staged);
        return Err(FileError::io("无法写入", "Couldn't write", &err));
    }
    drop(target);
    // 保留修改时间：不然拷完所有文件都变成「刚刚」，按时间排序和属性面板就都没意义了。
    if let Some(time) = modified {
        if let Ok(handle) = std::fs::OpenOptions::new().write(true).open(&staged) {
            let _ = handle.set_modified(time);
        }
    }
    // 目标已存在（replace 刚删过、keep 换了名、skip 走不到这里）—— 再兜一次，
    // 免得最后那步 rename 因为「目标已存在」失败。
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&staged, dest).map_err(|err| {
        let _ = std::fs::remove_file(&staged);
        FileError::io("无法完成复制", "Couldn't finish the copy", &err)
    })
}

fn part_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    match dest.parent() {
        Some(parent) => parent.join(format!(".{name}.fantasyhub-part")),
        None => PathBuf::from(format!(".{name}.fantasyhub-part")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        check_name, copy_path, dir_sizes, file_delete, file_move, io_reason, is_drive_root,
        is_editable_name, is_system_dir, part_path, read_text, relative_dir, rename_many,
        run_transfer, sibling_name, Conflict, FileError, RenamePair, Runner, TransferProgress,
    };
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    /// `file_move` / `file_delete` 是 async 命令（都走 `off_main`），测试里得有个运行时空转，
    /// 用 Tauri 自己那套就够，不必为一个测试往 dev-dependencies 里塞 tokio。
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        // 带上序号：测试是并行跑的，同一个进程里两只用例要是拿到同一个目录，
        // 就会互相删对方的文件（一开始 `hl-move-<pid>` 正好和旧用例撞名）。
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hl-{tag}-{}-{serial}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 跑一次传输并把进度收下来。进度走注入的 sink，所以最容易出人命的几条路径
    /// （复制 / 移动 / 同名策略 / 取消）在**本机**就能断言，不用等 Windows 真机。
    fn run_case(
        items: &[String],
        dest: &std::path::Path,
        moving: bool,
        policy: Conflict,
        cancel: bool,
    ) -> (Result<(), FileError>, Vec<TransferProgress>) {
        let mut events = Vec::new();
        let outcome = {
            let mut sink = |progress: &TransferProgress| events.push(progress.clone());
            let mut run = Runner {
                sink: &mut sink,
                id: "test".into(),
                token: Arc::new(AtomicBool::new(cancel)),
                phase: "scan",
                name: String::new(),
                item_index: 0,
                item_total: 0,
                items_done: 0,
                skipped: 0,
                bytes: 0,
                total_bytes: 0,
                last_emit: std::time::Instant::now(),
            };
            run_transfer(&mut run, items, dest, moving, policy)
        };
        (outcome, events)
    }

    #[test]
    fn rejects_path_pieces_in_names() {
        assert!(check_name("笔记").is_ok());
        assert!(check_name("..").is_err());
        assert!(check_name("a/b").is_err());
        assert!(check_name("CON").is_err());
    }

    #[test]
    fn text_extensions_can_be_edited() {
        assert!(is_editable_name("笔记.txt"));
        assert!(is_editable_name("README"));
        assert!(!is_editable_name("封面.png"));
    }

    #[test]
    fn copies_file_and_adds_a_duplicate_name() {
        let dir = std::env::temp_dir().join(format!("hl-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("笔记.txt");
        std::fs::write(&src, "你好").unwrap();
        let dest = dir.join(sibling_name(&dir, "笔记.txt"));
        copy_path(&src, &dest).unwrap();
        assert_eq!(dest.file_name().unwrap(), "笔记 副本.txt");
        assert_eq!(read_text(&dest).unwrap(), "你好");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn moves_a_file_into_another_folder() {
        let dir = std::env::temp_dir().join(format!("hl-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let from_dir = dir.join("来源");
        let to_dir = dir.join("目标");
        std::fs::create_dir_all(&from_dir).unwrap();
        std::fs::create_dir_all(&to_dir).unwrap();
        let src = from_dir.join("a.txt");
        std::fs::write(&src, "move").unwrap();
        block_on(file_move(
            src.display().to_string(),
            to_dir.display().to_string(),
        ))
        .unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(to_dir.join("a.txt")).unwrap(), "move");
        let err = block_on(file_move(
            to_dir.join("a.txt").display().to_string(),
            to_dir.display().to_string(),
        ))
        .unwrap_err();
        assert!(err.message.contains("已经在这个文件夹"), "{err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deletes_a_file_and_refuses_a_drive() {
        assert!(is_drive_root(std::path::Path::new("C:\\")));
        assert!(is_drive_root(std::path::Path::new("D:")));
        assert!(!is_drive_root(std::path::Path::new("C:\\Games")));
        assert!(is_drive_root(std::path::Path::new(r"\\server\share\")));
        assert!(is_drive_root(std::path::Path::new(r"\\?\UNC\server\share\")));
        assert!(is_drive_root(std::path::Path::new(r"\\?\C:\")));
        assert!(!is_drive_root(std::path::Path::new(r"\\server\share\Games")));
        assert!(!is_drive_root(std::path::Path::new(r"\\?\C:\Games")));
        let dir = std::env::temp_dir().join(format!("hl-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        block_on(file_delete(file.display().to_string())).unwrap();
        assert!(!file.exists());
        let refusal = block_on(file_delete("C:\\".into())).unwrap_err();
        assert!(refusal.message.contains("盘符"), "{refusal:?}");
        assert_eq!(refusal.reason, "rule");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_reasons_are_machine_readable() {
        use std::io::{Error, ErrorKind};
        assert_eq!(io_reason(&Error::from(ErrorKind::PermissionDenied)), "denied");
        assert_eq!(io_reason(&Error::from(ErrorKind::NotFound)), "missing");
        assert_eq!(io_reason(&Error::from(ErrorKind::AlreadyExists)), "exists");
        assert!(!FileError::cancelled().reason.is_empty());
    }

    #[test]
    fn transfer_copies_a_tree_and_counts_bytes() {
        let dir = temp_dir("transfer");
        let src = dir.join("源");
        std::fs::create_dir_all(src.join("子目录")).unwrap();
        std::fs::write(src.join("a.txt"), "hello").unwrap();
        std::fs::write(src.join("子目录").join("b.txt"), "world!").unwrap();
        let dest = dir.join("目标");
        std::fs::create_dir_all(&dest).unwrap();

        let (outcome, events) = run_case(&[src.display().to_string()], &dest, false, Conflict::Keep, false);
        outcome.unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("源").join("a.txt")).unwrap(), "hello");
        assert_eq!(
            std::fs::read_to_string(dest.join("源").join("子目录").join("b.txt")).unwrap(),
            "world!"
        );
        assert!(src.exists(), "复制不该动源");
        assert!(events.iter().any(|event| event.phase == "scan"));
        let last = events.last().unwrap();
        assert_eq!(last.phase, "run");
        assert_eq!(last.items_done, 1);
        assert_eq!(last.total_bytes, 11);
        assert_eq!(last.bytes, 11);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer_keep_renames_instead_of_overwriting() {
        let dir = temp_dir("keep");
        let src = dir.join("a.txt");
        std::fs::write(&src, "new").unwrap();
        let dest = dir.join("目标");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), "old").unwrap();

        let (outcome, _events) = run_case(&[src.display().to_string()], &dest, false, Conflict::Keep, false);
        outcome.unwrap();

        // 老的没被动，新的换了名字 —— 这就是「保留两者」的语义。
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(dest.join("a 副本.txt")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer_skip_leaves_both_sides_alone() {
        let dir = temp_dir("skip");
        let src = dir.join("a.txt");
        std::fs::write(&src, "new").unwrap();
        let dest = dir.join("目标");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("a.txt"), "old").unwrap();

        let (outcome, events) = run_case(&[src.display().to_string()], &dest, true, Conflict::Skip, false);
        outcome.unwrap();

        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert!(src.exists(), "跳过时源要留着（不然就成了静默删除）");
        let last = events.last().unwrap();
        assert_eq!(last.skipped, 1);
        assert_eq!(last.bytes, 0);
        // 跳过的量不算进总量，否则进度条永远到不了头。
        assert_eq!(last.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer_moves_a_file_into_another_folder() {
        let dir = temp_dir("move");
        let from = dir.join("来源");
        let dest = dir.join("目标");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(from.join("a.txt"), "move").unwrap();

        let (outcome, _events) = run_case(
            &[from.join("a.txt").display().to_string()],
            &dest,
            true,
            Conflict::Keep,
            false,
        );
        outcome.unwrap();
        assert!(!from.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dest.join("a.txt")).unwrap(), "move");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer_stops_when_cancelled() {
        let dir = temp_dir("cancel");
        let src = dir.join("a.txt");
        std::fs::write(&src, "data").unwrap();
        let dest = dir.join("目标");
        std::fs::create_dir_all(&dest).unwrap();

        // 一开始就是「已取消」：第一件事就是查它，所以一个文件都不该被碰。
        let (outcome, _events) =
            run_case(&[src.display().to_string()], &dest, false, Conflict::Keep, true);
        assert_eq!(outcome.unwrap_err().reason, "cancelled");
        assert!(!dest.join("a.txt").exists());
        // 半截文件也不能留下。
        assert!(!part_path(&dest.join("a.txt")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_rename_can_swap_two_names() {
        let dir = temp_dir("swap");
        std::fs::write(dir.join("1.txt"), "one").unwrap();
        std::fs::write(dir.join("2.txt"), "two").unwrap();
        let pairs = vec![
            RenamePair {
                from: dir.join("1.txt").display().to_string(),
                to: "2.txt".into(),
            },
            RenamePair {
                from: dir.join("2.txt").display().to_string(),
                to: "1.txt".into(),
            },
        ];
        let report = rename_many(&pairs).unwrap();
        assert_eq!(report.done, 2);
        assert!(report.failures.is_empty());
        // 内容真的换过来了（两步改名就是为了这种互相占位）。
        assert_eq!(std::fs::read_to_string(dir.join("2.txt")).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(dir.join("1.txt")).unwrap(), "two");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_rename_refuses_two_targets_that_collide() {
        let dir = temp_dir("collide");
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        let pairs = vec![
            RenamePair {
                from: dir.join("a.txt").display().to_string(),
                to: "c.txt".into(),
            },
            RenamePair {
                from: dir.join("b.txt").display().to_string(),
                to: "c.txt".into(),
            },
        ];
        let err = rename_many(&pairs).unwrap_err();
        assert_eq!(err.reason, "exists");
        // 整体拒绝：一个都不该动（改一半比不改更糟）。
        assert!(dir.join("a.txt").exists() && dir.join("b.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_helpers_do_what_they_say() {
        assert!(is_system_dir("$RECYCLE.BIN"));
        assert!(is_system_dir("System Volume Information"));
        assert!(!is_system_dir("Games"));
        assert!(part_path(std::path::Path::new("/tmp/a.txt"))
            .to_string_lossy()
            .ends_with(".a.txt.fantasyhub-part"));
        assert_eq!(
            relative_dir(
                std::path::Path::new("/root"),
                std::path::Path::new("/root/存档/2024")
            ),
            "存档/2024"
        );
    }

    /// 「文件夹显示多大」：只算直接子文件夹、子目录里的文件也要算进去，普通文件不出现。
    #[test]
    fn dir_sizes_counts_direct_subfolders_only() {
        let root = temp_dir("dir-sizes");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a").join("x.bin"), vec![7u8; 4096]).unwrap();
        std::fs::create_dir_all(root.join("b").join("deep")).unwrap();
        std::fs::write(root.join("b").join("deep").join("y.bin"), vec![7u8; 1024]).unwrap();
        std::fs::write(root.join("note.txt"), b"hi").unwrap();

        let token = Arc::new(AtomicBool::new(false));
        let rows = dir_sizes(&root, &token).unwrap();
        assert_eq!(rows.len(), 2, "只有文件夹算大小：{rows:?}");
        assert!(rows.iter().all(|row| row.complete));
        let size_of = |name: &str| {
            rows.iter()
                .find(|row| row.path.ends_with(name))
                .map(|row| row.bytes)
                .unwrap_or_default()
        };
        assert_eq!(size_of("a"), 4096);
        assert_eq!(size_of("b"), 1024, "子目录里的文件也要算进去");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 取消标记一置上，剩下的文件夹就不再走盘（换目录时前端就是这么叫停的）。
    #[test]
    fn dir_sizes_stops_when_cancelled() {
        let root = temp_dir("dir-sizes-cancel");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();

        let token = Arc::new(AtomicBool::new(true));
        let rows = dir_sizes(&root, &token).unwrap();
        assert!(rows.is_empty(), "取消后一个都不该算：{rows:?}");

        let _ = std::fs::remove_dir_all(&root);
    }
}
