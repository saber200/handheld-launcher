//! 把浮层那块屏幕区域拷成一张 BMP —— 因为「窗口说自己在屏上」和「屏上真有它」是两件事。
//!
//! 0.1.48 的教训：日志写着 `is_visible=true`、`topmost=true`、`fg=true`，人却看不见。
//! 三种可能（被压在整屏窗口下面 / 画到了别的地方 / 页面根本没渲染）在日志里长得一模一样，
//! 只能靠猜。`BitBlt` 抓的是**合成之后的屏幕像素**，一张图就能把它们分开：
//! 图里有那块深色面板 = 真画上去了；图里是纯黑 = 没画上去（或者抓不到 —— 独占全屏 /
//! 受保护内容抓下来就是黑的，那也是一种信息，别混为一谈）。
//!
//! 写到 `%APPDATA%\handheld-launcher\overlay-shot.bmp`（和日志同目录，用户一次能拷全），
//! **每次显示覆盖上一张**：只留最近一次现场，不堆文件。
//!
//! 只读屏幕、只写自己目录里的一个文件，不碰前端/启动器之间的任何通道（FRONTEND.md §2）。

use tauri::WebviewWindow;

/// 抓一张浮层所在区域的截图。返回一句给人看的描述（写进日志），失败返回原因。
#[cfg(windows)]
pub fn capture(window: &WebviewWindow) -> Result<String, String> {
    win::capture(window)
}

/// 非 Windows 没有 GDI 这套（本机开发时用不到）：如实说明，别假装成功。
#[cfg(not(windows))]
pub fn capture(_window: &WebviewWindow) -> Result<String, String> {
    Err("screen capture is windows-only".into())
}

#[cfg(windows)]
mod win {
    use std::io::Write;

    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HBITMAP, SRCCOPY,
    };

    /// 抓图 + 写文件。任何一步失败都返回人能看懂的原因。
    pub fn capture(window: &WebviewWindow) -> Result<String, String> {
        // 位置和尺寸问窗口自己（物理像素，与 `GetDC(NULL)` 的坐标系一致）。
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let width = size.width as i32;
        let height = size.height as i32;
        if width <= 0 || height <= 0 {
            return Err(format!("empty rect {width}x{height}"));
        }
        let (pixels, warning) = grab(position.x, position.y, width, height)?;
        let described = write_bmp(&pixels, width, height)?;
        Ok(match warning {
            Some(note) => format!("{described} {note}"),
            None => described,
        })
    }

    /// 屏幕 → 内存位图 → 24 位像素。行按 4 字节对齐、自下而上（BMP 的老规矩）。
    /// 第二个返回值是「抓的时候出过问题但图还写下来了」的那句话。
    fn grab(x: i32, y: i32, width: i32, height: i32) -> Result<(Vec<u8>, Option<String>), String> {
        let stride = (((width * 3 + 3) / 4) * 4) as usize;
        unsafe {
            // 屏幕 DC：null 表示「整个屏幕」。
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(format!("GetDC failed err={}", GetLastError()));
            }
            let memory = CreateCompatibleDC(screen);
            let bitmap: HBITMAP = CreateCompatibleBitmap(screen, width, height);
            if memory.is_null() || bitmap.is_null() {
                if !memory.is_null() {
                    DeleteDC(memory);
                }
                ReleaseDC(std::ptr::null_mut(), screen);
                return Err(format!("GDI surface failed err={}", GetLastError()));
            }
            let previous = SelectObject(memory, bitmap as _);
            // 抓不到时（独占全屏 / 受保护内容）这里返回 0，像素会全黑 —— 图照写：
            // 「一整块黑」本身就是结论，只是要说明 BitBlt 确实失败过。
            let copied = BitBlt(memory, 0, 0, width, height, screen, x, y, SRCCOPY);

            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // 正数 = 自下而上：与 BMP 文件里像素的排列顺序一致，可以直接落盘。
                biHeight: height,
                biPlanes: 1,
                biBitCount: 24,
                biCompression: BI_RGB,
                biSizeImage: (stride * height as usize) as u32,
                biXPelsPerMeter: 2835,
                biYPelsPerMeter: 2835,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mut pixels = vec![0u8; stride * height as usize];
            let lines = GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            );

            SelectObject(memory, previous);
            DeleteObject(bitmap as _);
            DeleteDC(memory);
            ReleaseDC(std::ptr::null_mut(), screen);

            if lines == 0 {
                return Err(format!("GetDIBits read 0 lines err={}", GetLastError()));
            }
            let warning = (copied == 0).then(|| format!("bitblt-failed err={}", GetLastError()));
            Ok((pixels, warning))
        }
    }

    /// 24 位 BMP（文件头 14 字节 + 信息头 40 字节）—— 不引依赖，手写这 54 个字节。
    fn write_bmp(pixels: &[u8], width: i32, height: i32) -> Result<String, String> {
        let stride = (((width * 3 + 3) / 4) * 4) as usize;
        let body = stride * height as usize;
        let mut header = Vec::with_capacity(54);
        header.extend_from_slice(b"BM");
        header.extend_from_slice(&((54 + body) as u32).to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());
        header.extend_from_slice(&54u32.to_le_bytes());
        header.extend_from_slice(&40u32.to_le_bytes());
        header.extend_from_slice(&width.to_le_bytes());
        header.extend_from_slice(&height.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes());
        header.extend_from_slice(&24u16.to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());
        header.extend_from_slice(&(body as u32).to_le_bytes());
        header.extend_from_slice(&2835u32.to_le_bytes());
        header.extend_from_slice(&2835u32.to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());

        let path = fh_core::logutil::dir().join("overlay-shot.bmp");
        let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        file.write_all(&header).map_err(|e| e.to_string())?;
        file.write_all(&pixels[..body]).map_err(|e| e.to_string())?;
        drop(file);

        // 一句话说清「这张图里有什么」：非黑字节的比例。全 0 = 那一片是黑的，
        // 也就是「没画上去」或者「抓不到」——正是要区分的东西。
        let lit = pixels[..body].iter().filter(|byte| **byte != 0).count();
        let ratio = lit * 100 / body.max(1);
        Ok(format!(
            "overlay-shot.bmp {width}x{height} nonBlack={ratio}% path={}",
            path.display()
        ))
    }
}
