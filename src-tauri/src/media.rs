use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
    let steam_library = url.starts_with("https://cdn.cloudflare.steamstatic.com/steam/apps/")
        || url.starts_with("https://cdn.akamai.steamstatic.com/steam/apps/")
        || url.starts_with("https://shared.akamai.steamstatic.com/store_item_assets/");
    steam_library && url.ends_with("/library_600x900.jpg") && !url.contains("..")
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
        let image = image::RgbaImage::from_raw(width, height)?;
        let dynamic = image::DynamicImage::ImageRgba8(image);
        let mut bytes = Cursor::new(Vec::new());
        dynamic.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
        Some(bytes.into_inner())
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
        assert!(!allowed_cover_url(
            "https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg"
        ));
        assert!(!allowed_cover_url("https://example.com/library_600x900.jpg"));
    }
}
