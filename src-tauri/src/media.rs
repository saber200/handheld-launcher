use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg(not(windows))]
use crate::i18n::pick;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct CoverRequest {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCover {
    pub id: String,
    pub cover_path: String,
}

pub fn allowed_cover_url(url: &str) -> bool {
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    if base.contains("..") || query.contains("..") || query.contains("://") {
        return false;
    }
    let host_ok = base.starts_with("https://cdn.cloudflare.steamstatic.com/steam/apps/")
        || base.starts_with("https://cdn.akamai.steamstatic.com/steam/apps/")
        || base.starts_with("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/")
        || base.starts_with("https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/");
    if !host_ok {
        return false;
    }
    let Some(rest) = base.split("/steam/apps/").nth(1) else {
        return false;
    };
    let mut parts = rest.split('/');
    let appid = parts.next().unwrap_or("");
    if appid.is_empty() || !appid.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    matches!(
        parts.next_back().unwrap_or(""),
        "library_600x900.jpg" | "library_600x900_2x.jpg" | "library_capsule.jpg" | "library_capsule_2x.jpg"
    )
}

/// Steam now stores new library art at a hashed path. Older games still use library_600x900.jpg.
pub fn library_cover_from_assets(assets: &serde_json::Value) -> Option<String> {
    let format = assets.get("asset_url_format")?.as_str()?;
    let file = ["library_capsule", "library_capsule_2x"].into_iter().find_map(|key| {
        let name = assets.get(key)?.as_str()?;
        cover_asset_name_ok(name).then_some(name)
    })?;
    if !format.starts_with("steam/apps/") || !format.contains("${FILENAME}") {
        return None;
    }
    let appid = format.trim_start_matches("steam/apps/").split('/').next()?;
    if appid.is_empty() || appid.len() > 10 || !appid.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let path = format.replacen("${FILENAME}", file, 1);
    if path.contains("..") {
        return None;
    }
    Some(format!("https://shared.akamai.steamstatic.com/store_item_assets/{path}"))
}

fn cover_asset_name_ok(name: &str) -> bool {
    let file = name.rsplit('/').next().unwrap_or("");
    if !matches!(
        file,
        "library_capsule.jpg" | "library_capsule_2x.jpg" | "library_600x900.jpg" | "library_600x900_2x.jpg"
    ) {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.')
    })
}

pub fn fetch_steam_library_cover(appid: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        return windows::fetch_steam_library_cover(appid);
    }
    #[cfg(not(windows))]
    {
        let _ = appid;
        Err(pick("只能在 Windows 上获取 Steam 封面。", "Steam covers can only be fetched on Windows.").into())
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn local_steam_cover(app: &tauri::AppHandle, roots: &[PathBuf], appid: &str) -> String {
    #[cfg(windows)]
    {
        return windows::local_steam_cover(app, roots, appid);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, roots, appid);
        String::new()
    }
}

pub fn cache_remote_covers(app: &tauri::AppHandle, covers: Vec<CoverRequest>) -> Vec<CachedCover> {
    #[cfg(windows)]
    {
        return windows::cache_remote_covers(app, covers);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, covers);
        Vec::new()
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn cached_icon(app: &tauri::AppHandle, id: &str, display_icon: &str) -> String {
    #[cfg(windows)]
    {
        return windows::cached_icon(app, id, display_icon);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, display_icon);
        String::new()
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn cache_name(id: &str, ext: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("{safe}.{ext}")
}

#[cfg(windows)]
mod windows {
    use super::{allowed_cover_url, cache_name, CachedCover, CoverRequest};
    use crate::i18n::pick;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use tauri::Manager;

    pub fn local_steam_cover(app: &tauri::AppHandle, roots: &[PathBuf], appid: &str) -> String {
        let Some(dest) = cache_file(app, "covers", &cache_name(&format!("steam_{appid}"), "jpg"))
        else {
            return String::new();
        };
        if dest.is_file() {
            return dest.display().to_string();
        }
        let Some(source) = steam_library_cover(roots, appid) else {
            return String::new();
        };
        if std::fs::copy(&source, &dest).is_ok() {
            dest.display().to_string()
        } else {
            String::new()
        }
    }

    pub fn cache_remote_covers(
        app: &tauri::AppHandle,
        covers: Vec<CoverRequest>,
    ) -> Vec<CachedCover> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(8))
            .timeout_read(std::time::Duration::from_secs(20))
            .build();
        let mut saved = Vec::new();
        for cover in covers {
            if !allowed_cover_url(&cover.url) {
                continue;
            }
            let Some(dest) = cache_file(app, "covers", &cache_name(&cover.id, "jpg")) else {
                continue;
            };
            if !dest.is_file() && !download(&agent, &cover.url, &dest) {
                continue;
            }
            if dest.is_file() {
                saved.push(CachedCover {
                    id: cover.id,
                    cover_path: dest.display().to_string(),
                });
            }
        }
        saved
    }

    pub fn cached_icon(app: &tauri::AppHandle, id: &str, display_icon: &str) -> String {
        let Some(dest) = cache_file(app, "icons", &cache_name(id, "png")) else {
            return String::new();
        };
        if dest.is_file() {
            return dest.display().to_string();
        }
        let (path, index) = split_icon(display_icon);
        let source = PathBuf::from(&path);
        if !source.is_file() {
            return String::new();
        }
        let bytes = if is_exe(&source) {
            exe_icon_png(&source, index)
        } else {
            image_file_png(&source)
        };
        let Some(bytes) = bytes else {
            return String::new();
        };
        if std::fs::write(&dest, bytes).is_ok() {
            dest.display().to_string()
        } else {
            String::new()
        }
    }

    fn steam_library_cover(roots: &[PathBuf], appid: &str) -> Option<PathBuf> {
        let names = [
            format!("appcache/librarycache/{appid}_library_600x900.jpg"),
            format!("appcache/librarycache/{appid}/library_600x900.jpg"),
        ];
        for root in roots {
            for name in &names {
                let path = root.join(name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    }

    fn download(agent: &ureq::Agent, url: &str, dest: &Path) -> bool {
        let temp = dest.with_extension("part");
        let Ok(response) = agent.get(url).call() else {
            return false;
        };
        if response.status() != 200 {
            return false;
        }
        let Ok(mut file) = std::fs::File::create(&temp) else {
            return false;
        };
        if std::io::copy(&mut response.into_reader(), &mut file).is_err() {
            let _ = std::fs::remove_file(&temp);
            return false;
        }
        drop(file);
        let big_enough = std::fs::metadata(&temp).map(|meta| meta.len() > 1024).unwrap_or(false);
        if !big_enough {
            let _ = std::fs::remove_file(&temp);
            return false;
        }
        if std::fs::rename(&temp, dest).is_err() {
            let _ = std::fs::remove_file(&temp);
            return false;
        }
        true
    }

    fn cache_file(app: &tauri::AppHandle, folder: &str, name: &str) -> Option<PathBuf> {
        let dir = app.path().app_data_dir().ok()?.join(folder);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.join(name))
    }

    fn split_icon(raw: &str) -> (String, i32) {
        let trimmed = raw.trim();
        if let Some(rest) = trimmed.strip_prefix('"') {
            if let Some((path, tail)) = rest.split_once('"') {
                let index = tail
                    .trim()
                    .trim_start_matches(',')
                    .trim()
                    .parse()
                    .unwrap_or(0);
                return (path.to_string(), index);
            }
        }
        if let Some((path, index)) = trimmed.rsplit_once(',') {
            let index_text = index.trim();
            if !index_text.is_empty()
                && index_text.chars().all(|c| c.is_ascii_digit() || c == '-')
                && path.to_ascii_lowercase().contains(".exe")
            {
                return (path.trim().trim_matches('"').to_string(), index_text.parse().unwrap_or(0));
            }
        }
        (trimmed.trim_matches('"').to_string(), 0)
    }

    fn is_exe(path: &Path) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("dll"))
    }

    fn image_file_png(path: &Path) -> Option<Vec<u8>> {
        let image = image::open(path).ok()?;
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
        Some(bytes.into_inner())
    }

    fn exe_icon_png(path: &Path, index: i32) -> Option<Vec<u8>> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut icon = extract_icon(wide.as_ptr(), index);
        if icon.is_null() && index != 0 {
            icon = extract_icon(wide.as_ptr(), 0);
        }
        if icon.is_null() {
            return None;
        }
        let png = unsafe { hicon_png(icon) };
        unsafe {
            DestroyIcon(icon);
        }
        png
    }

    fn extract_icon(path: *const u16, index: i32) -> windows_sys::Win32::UI::WindowsAndMessaging::HICON {
        use windows_sys::Win32::UI::Shell::ExtractIconExW;
        let mut icon = std::ptr::null_mut();
        let count = unsafe { ExtractIconExW(path, index, &mut icon, std::ptr::null_mut(), 1) };
        if count == 0 {
            std::ptr::null_mut()
        } else {
            icon
        }
    }

    unsafe fn hicon_png(
        icon: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
    ) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{
            DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

        let mut info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(icon, &mut info) == 0 || info.hbmColor.is_null() {
            if !info.hbmColor.is_null() {
                DeleteObject(info.hbmColor);
            }
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
            return None;
        }
        let mut bitmap: BITMAP = std::mem::zeroed();
        let read = GetObjectW(
            info.hbmColor,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut BITMAP as *mut _,
        );
        if read == 0 {
            DeleteObject(info.hbmColor);
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
            return None;
        }
        let width = bitmap.bmWidth.unsigned_abs();
        let height = bitmap.bmHeight.unsigned_abs();
        if width == 0 || height == 0 || width > 512 || height > 512 {
            DeleteObject(info.hbmColor);
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
            return None;
        }
        let mut info_bits: BITMAPINFO = std::mem::zeroed();
        info_bits.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let hdc = GetDC(std::ptr::null_mut());
        let lines = GetDIBits(
            hdc,
            info.hbmColor,
            0,
            height,
            pixels.as_mut_ptr() as *mut _,
            &mut info_bits,
            DIB_RGB_COLORS,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        DeleteObject(info.hbmColor);
        if !info.hbmMask.is_null() {
            DeleteObject(info.hbmMask);
        }
        if lines == 0 {
            return None;
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        if pixels.chunks_exact(4).all(|pixel| pixel[3] == 0) {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        let image = image::RgbaImage::from_raw(width, height, pixels)?;
        let dynamic = image::DynamicImage::ImageRgba8(image);
        let mut bytes = Cursor::new(Vec::new());
        dynamic.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
        Some(bytes.into_inner())
    }

    pub fn fetch_steam_library_cover(appid: &str) -> Result<String, String> {
        if appid.is_empty() || appid.len() > 10 || !appid.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(pick("请输入 Steam 的数字编号。", "Enter a numeric Steam app ID.").into());
        }
        let input = format!(
            r#"{{"ids":[{{"appid":{appid}}}],"context":{{"language":"english","country_code":"US","steam_realm":1}},"data_request":{{"include_assets":true}}}}"#
        );
        let url = format!(
            "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={}",
            encode_query(&input)
        );
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(8))
            .timeout_read(std::time::Duration::from_secs(20))
            .build();
        let response = agent
            .get(&url)
            .set("User-Agent", "FantasyHub")
            .call()
            .map_err(|_| pick("没有连上 Steam，封面没取到。", "Couldn't reach Steam, so the cover wasn't loaded.").to_string())?;
        let body = response
            .into_string()
            .map_err(|_| pick("没有找到这个 Steam 编号的封面。", "No cover found for that Steam ID.").to_string())?;
        let data: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| pick("没有找到这个 Steam 编号的封面。", "No cover found for that Steam ID.").to_string())?;
        let assets = data
            .pointer("/response/store_items/0/assets")
            .ok_or(pick("没有找到这个 Steam 编号的封面。", "No cover found for that Steam ID."))?;
        super::library_cover_from_assets(assets).ok_or_else(|| pick("没有找到这个 Steam 编号的封面。", "No cover found for that Steam ID.").into())
    }

    fn encode_query(text: &str) -> String {
        let mut out = String::new();
        for byte in text.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::allowed_cover_url;

    #[test]
    fn accepts_steam_library_art_only() {
        assert!(allowed_cover_url(
            "https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg"
        ));
        assert!(allowed_cover_url(
            "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3357650/2c65f388cb3ac6631c8a38ff1a59903263fc70e9/library_capsule.jpg?t=1789603448"
        ));
        assert!(!allowed_cover_url(
            "https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg"
        ));
        assert!(!allowed_cover_url("https://example.com/library_600x900.jpg"));
    }

    #[test]
    fn reads_hashed_library_capsule() {
        let assets = serde_json::json!({
            "asset_url_format": "steam/apps/3357650/${FILENAME}?t=1789603448",
            "library_capsule": "2c65f388cb3ac6631c8a38ff1a59903263fc70e9/library_capsule.jpg"
        });
        assert_eq!(
            super::library_cover_from_assets(&assets).as_deref(),
            Some("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3357650/2c65f388cb3ac6631c8a38ff1a59903263fc70e9/library_capsule.jpg?t=1789603448")
        );
    }
}
