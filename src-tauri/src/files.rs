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

#[tauri::command]
pub fn file_places() -> Vec<FileEntry> {
    places()
}

#[tauri::command]
pub fn file_list(path: String) -> Result<Vec<FileEntry>, String> {
    list_dir(Path::new(&path))
}

#[tauri::command]
pub fn file_make_dir(parent: String, name: String) -> Result<(), String> {
    let name = check_name(&name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(pick("已经有同名项目", "That name is already here."));
    }
    std::fs::create_dir(&dest).map_err(|err| pick(&format!("无法新建文件夹：{err}"), &format!("Couldn't create the folder: {err}")))
}

#[tauri::command]
pub fn file_make_file(parent: String, name: String) -> Result<(), String> {
    let name = check_name(&name)?;
    let dest = PathBuf::from(parent).join(name);
    if dest.exists() {
        return Err(pick("已经有同名项目", "That name is already here."));
    }
    std::fs::write(&dest, b"").map_err(|err| pick(&format!("无法新建文件：{err}"), &format!("Couldn't create the file: {err}")))
}

#[tauri::command]
pub fn file_copy(from: String, dest_dir: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
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
pub fn file_delete(path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    if is_drive_root(&path) {
        return Err(pick("不能删除盘符", "A drive can't be deleted."));
    }
    if !path.exists() {
        return Err(pick("找不到要删除的项目", "Couldn't find the item to delete."));
    }
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    removed.map_err(|err| pick(&format!("无法删除：{err}"), &format!("Couldn't delete: {err}")))
}

fn is_drive_root(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('/', "\\");
    let trimmed = text.trim_end_matches('\\');
    trimmed.len() == 2 && trimmed.as_bytes().get(1) == Some(&b':')
}

#[tauri::command]
pub fn file_move(from: String, dest_dir: String) -> Result<(), String> {
    let from = PathBuf::from(from);
    let dest_dir = PathBuf::from(dest_dir);
    if !from.exists() {
        return Err(pick("找不到要移动的项目", "Couldn't find the item to move."));
    }
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
    if std::fs::rename(&from, &dest).is_ok() {
        return Ok(());
    }
    copy_path(&from, &dest).map_err(|err| pick(&format!("无法移动：{err}"), &format!("Couldn't move: {err}")))?;
    let removed = if from.is_dir() {
        std::fs::remove_dir_all(&from)
    } else {
        std::fs::remove_file(&from)
    };
    removed.map_err(|err| pick(&format!("已经复制到目标，但原位置没删掉：{err}"), &format!("Copied, but the original is still there: {err}")))
}

#[tauri::command]
pub fn file_read_text(path: String) -> Result<String, String> {
    read_text(Path::new(&path))
}

#[tauri::command]
pub fn file_write_text(path: String, text: String) -> Result<(), String> {
    let path = Path::new(&path);
    if path.is_dir() {
        return Err(pick("不能把文件夹当成文本保存", "A folder can't be saved as text."));
    }
    std::fs::write(path, text.as_bytes()).map_err(|err| pick(&format!("无法保存：{err}"), &format!("Couldn't save: {err}")))
}

#[tauri::command]
pub fn file_icon(app: tauri::AppHandle, path: String) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    crate::media::cached_icon(&app, path, path)
}

#[tauri::command]
pub fn file_open(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(pick("找不到这个文件", "Couldn't find that file."));
    }
    open_with_system(&path)
}

fn places() -> Vec<FileEntry> {
    let mut found = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            if Path::new(&path).exists() {
                found.push(dir_entry(format!("{}:", letter as char), path));
            }
        }
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

fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
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
        return Ok(());
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
        file_move(src.display().to_string(), to_dir.display().to_string()).unwrap();
        assert!(!src.exists());
        assert_eq!(std::fs::read_to_string(to_dir.join("a.txt")).unwrap(), "move");
        let err = file_move(
            to_dir.join("a.txt").display().to_string(),
            to_dir.display().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("已经在这个文件夹"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deletes_a_file_and_refuses_a_drive() {
        assert!(is_drive_root(std::path::Path::new("C:\\")));
        assert!(is_drive_root(std::path::Path::new("D:")));
        assert!(!is_drive_root(std::path::Path::new("C:\\Games")));
        let dir = std::env::temp_dir().join(format!("hl-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        file_delete(file.display().to_string()).unwrap();
        assert!(!file.exists());
        assert!(file_delete("C:\\".into()).unwrap_err().contains("盘符"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
