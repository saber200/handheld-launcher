use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::i18n::pick;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub editable: bool,
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
pub async fn file_list(path: String) -> Result<Vec<FileEntry>, String> {
    match crate::off_main(move || list_dir(Path::new(&path))).await {
        Ok(rows) => rows,
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn file_make_dir(parent: String, name: String) -> Result<(), String> {
    match crate::off_main(move || make_dir(&parent, &name)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn make_dir(parent: &str, name: &str) -> Result<(), String> {
    let name = check_name(name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(pick("已经有同名项目", "That name is already here."));
    }
    std::fs::create_dir(&dest).map_err(|err| pick(&format!("无法新建文件夹：{err}"), &format!("Couldn't create the folder: {err}")))
}

#[tauri::command]
pub async fn file_make_file(parent: String, name: String) -> Result<(), String> {
    match crate::off_main(move || make_file(&parent, &name)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn make_file(parent: &str, name: &str) -> Result<(), String> {
    let name = check_name(name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(pick("已经有同名项目", "That name is already here."));
    }
    std::fs::write(&dest, b"").map_err(|err| pick(&format!("无法新建文件：{err}"), &format!("Couldn't create the file: {err}")))
}

#[tauri::command]
pub async fn file_copy(from: String, dest_dir: String) -> Result<(), String> {
    match crate::off_main(move || copy_entry(from, dest_dir)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn copy_entry(from: String, dest_dir: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
    if is_drive_root(&from) {
        return Err(pick("不能复制磁盘根目录", "Can't copy a volume root."));
    }
    if !from.exists() {
        return Err(pick("找不到要复制的项目", "Couldn't find the item to copy."));
    }
    if !dest_dir.is_dir() {
        return Err(pick("只能粘贴到文件夹里", "Paste into a folder."));
    }
    reject_inside(&from, &dest_dir)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| pick("这个名称不能用", "That name can't be used"))?;
    let dest = dest_dir.join(sibling_name(&dest_dir, name));
    copy_path(&from, &dest).map_err(|err| pick(&format!("无法复制：{err}"), &format!("Couldn't copy: {err}")))
}

#[tauri::command]
pub async fn file_delete(path: String) -> Result<(), String> {
    match crate::off_main(move || delete_entry(path)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn delete_entry(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if is_drive_root(&path) || std::fs::canonicalize(&path).is_ok_and(|p| is_drive_root(&p)) {
        return Err(pick("不能删除盘符或共享根目录", "Can't delete a volume or share root."));
    }
    if !path.exists() {
        return Err(pick("找不到要删除的项目", "Couldn't find the item to delete."));
    }
    reject_reparse_dir(&path)?;
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    removed.map_err(|err| pick(&format!("无法删除：{err}"), &format!("Couldn't delete: {err}")))
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

fn reject_reparse_dir(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        // Reject directory junctions/symlinks anywhere in the tree: recursively
        // deleting or copying through a junction must never reach another volume.
        if path.is_dir() {
            let metadata = std::fs::symlink_metadata(path).map_err(|err| err.to_string())?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(pick("不能操作目录链接", "Can't operate on a directory link."));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}

#[tauri::command]
pub async fn file_move(from: String, dest_dir: String) -> Result<(), String> {
    match crate::off_main(move || move_entry(from, dest_dir)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn move_entry(from: String, dest_dir: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
    if is_drive_root(&from) || std::fs::canonicalize(&from).is_ok_and(|p| is_drive_root(&p)) {
        return Err(pick("不能移动磁盘根目录", "Can't move a volume root."));
    }
    if !from.exists() {
        return Err(pick("找不到要移动的项目", "Couldn't find the item to move."));
    }
    reject_reparse_dir(&from)?;
    if !dest_dir.is_dir() {
        return Err(pick("只能移动到文件夹里", "Move into a folder."));
    }
    if from.parent().is_some_and(|parent| same_path(parent, &dest_dir)) {
        return Err(pick("已经在这个文件夹里", "It's already in this folder."));
    }
    reject_inside(&from, &dest_dir)?;
    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| pick("这个名称不能用", "That name can't be used"))?;
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err(pick("目标里已经有同名项目", "That name is already here."));
    }
    match std::fs::rename(&from, &dest) {
        Ok(()) => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {}
        Err(err) => return Err(pick(&format!("无法移动：{err}"), &format!("Couldn't move: {err}"))),
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
    }).ok_or_else(|| "无法分配移动临时位置".to_string())?
      .map_err(|err| err.to_string())?;
    if let Err(err) = copy_path(&from, &staged) {
        let _ = remove_path(&staged);
        return Err(pick(&format!("无法移动：{err}"), &format!("Couldn't move: {err}")));
    }
    if let Err(err) = std::fs::rename(&staged, &dest) {
        let _ = remove_path(&staged);
        return Err(pick(&format!("无法完成移动：{err}"), &format!("Couldn't finish move: {err}")));
    }
    remove_path(&from).map_err(|err| pick(&format!("已经复制到目标，但原位置可能只删了一部分：{err}"), &format!("Copied, but the original may be partially removed: {err}")))
}

#[tauri::command]
pub async fn file_read_text(path: String) -> Result<String, String> {
    match crate::off_main(move || read_text(Path::new(&path))).await {
        Ok(read) => read,
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn file_write_text(path: String, text: String) -> Result<(), String> {
    match crate::off_main(move || write_text(path, text)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn write_text(path: String, text: String) -> Result<(), String> {
    let path = Path::new(&path);
    if path.is_dir() {
        return Err(pick("不能把文件夹当成文本保存", "A folder can't be saved as text."));
    }
    std::fs::write(path, text.as_bytes()).map_err(|err| pick(&format!("无法保存：{err}"), &format!("Couldn't save: {err}")))
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
pub async fn file_open(path: String) -> Result<(), String> {
    match crate::off_main(move || open_entry(path)).await {
        Ok(done) => done,
        Err(err) => Err(err),
    }
}

fn open_entry(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(pick("找不到这个文件", "Couldn't find that file."));
    }
    open_with_system(&path)
}

fn places() -> Vec<FileEntry> {
    let mut found = Vec::new();
    #[cfg(windows)]
    {
        found.extend(letters());
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let path = PathBuf::from(&home);
            if path.is_dir() {
                found.push(dir_entry(pick("用户文件夹", "Home"), path.display().to_string()));
            }
        }
    }
    #[cfg(not(windows))]
    {
        found.push(dir_entry(pick("根目录", "Root"), "/".to_string()));
        if let Some(home) = std::env::var_os("HOME") {
            let path = PathBuf::from(&home);
            if path.is_dir() {
                found.push(dir_entry(pick("用户文件夹", "Home"), path.display().to_string()));
            }
        }
    }
    found
}

fn dir_entry(name: String, path: String) -> FileEntry {
    FileEntry {
        name,
        path,
        kind: "dir".into(),
        bytes: 0,
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

fn list_dir(path: &Path) -> Result<Vec<FileEntry>, String> {
    if !path.is_dir() {
        return Err(pick("打不开这个文件夹", "Couldn't open this folder."));
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(path).map_err(|err| pick(&format!("无法读取文件夹：{err}"), &format!("Couldn't read the folder: {err}")))?;
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
            bytes: meta.map(|meta| meta.len()).unwrap_or(0),
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

fn read_text(path: &Path) -> Result<String, String> {
    if path.is_dir() {
        return Err(pick("文件夹不能当文本编辑", "A folder can't be edited as text."));
    }
    let meta = std::fs::metadata(path).map_err(|err| pick(&format!("无法读取：{err}"), &format!("Couldn't read: {err}")))?;
    if meta.len() > 1_000_000 {
        return Err(pick("文件太大，不能在这里编辑", "This file is too large to edit here."));
    }
    let bytes = std::fs::read(path).map_err(|err| pick(&format!("无法读取：{err}"), &format!("Couldn't read: {err}")))?;
    String::from_utf8(bytes).map_err(|_| pick("这个文件不是文本", "This file isn't text"))
}

fn check_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(pick("请输入名称", "Enter a name."));
    }
    if name == "." || name == ".." || name.len() > 120 {
        return Err(pick("这个名称不能用", "That name can't be used."));
    }
    if name.chars().any(|c| r#"\/:*?"<>|"#.contains(c) || c.is_control()) {
        return Err(pick(
            "名称里不能有 \\ / : * ? \" < > |",
            "A name can't contain \\ / : * ? \" < > |",
        ));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "LPT1" | "LPT2"
    ) {
        return Err(pick("这个名称不能用", "That name can't be used."));
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

fn reject_inside(from: &Path, dest_dir: &Path) -> Result<(), String> {
    let Ok(from) = std::fs::canonicalize(from) else {
        return Ok(());
    };
    let Ok(dest_dir) = std::fs::canonicalize(dest_dir) else {
        return Ok(());
    };
    if dest_dir.starts_with(&from) {
        return Err(pick("不能粘贴到它自己里面", "Can't paste a folder into itself."));
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

fn open_with_system(path: &str) -> Result<(), String> {
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
            return Err(pick("无法打开", "Couldn't open."));
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| pick(&format!("无法打开：{err}"), &format!("Couldn't open: {err}")))?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|err| pick(&format!("无法打开：{err}"), &format!("Couldn't open: {err}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        check_name, copy_path, file_delete, file_move, is_drive_root, is_editable_name, read_text,
        sibling_name,
    };

    /// `file_move` / `file_delete` 是 async 命令（都走 `off_main`），测试里得有个运行时空转，
    /// 用 Tauri 自己那套就够，不必为一个测试往 dev-dependencies 里塞 tokio。
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
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
        assert!(err.contains("已经在这个文件夹"));
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
        assert!(block_on(file_delete("C:\\".into()))
            .unwrap_err()
            .contains("盘符"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
