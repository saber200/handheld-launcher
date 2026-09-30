fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    for name in [
        "fse/identity.msix",
        "fse/identity.cer",
        "fse/CustomCapability.SCCD",
        "drivers/WinRing0x64.sys",
        // 随包分发的前端安装包：CI 会把真实产物拷到这里；本地/dev 构建留个空占位，
        // 免得 bundler 因为文件不存在直接报错（工具箱那边会提示"这个版本没内置"）。
        "payload/frontend-setup.exe",
    ] {
        let path = manifest_dir.join(name);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&path, []);
        }
    }
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run build script");
}
