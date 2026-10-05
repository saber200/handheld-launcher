fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // FSE 身份文件（identity.msix / .cer / CustomCapability.SCCD）由 CI 现编现签，
    // 本地 dev 构建没有，就落一个空占位 —— 缺文件时 Tauri 打包会直接失败。
    for name in [
        "fse/identity.msix",
        "fse/identity.cer",
        "fse/CustomCapability.SCCD",
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
