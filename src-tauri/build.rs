fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    for name in [
        "fse/identity.msix",
        "fse/identity.cer",
        "fse/CustomCapability.SCCD",
        "drivers/WinRing0x64.sys",
        // Game Bar 小组件（CI 的 gamebar 作业现编现签，见 frontend/gamebar/package-payload.ps1）：
        // 同样是空占位兜底 —— 装包时 register-widget.ps1 会认出 0 字节的占位并说"这个版本没带小组件"，
        // 而不会静默装个坏包。依赖包的三个文件名来自 MSBuild 的 Dependencies\x64 输出，Debug 配置。
        "payload/gamebar/widget.msix",
        "payload/gamebar/widget.cer",
        "payload/gamebar/deps/Microsoft.NET.CoreRuntime.2.2.appx",
        "payload/gamebar/deps/Microsoft.NET.CoreFramework.Debug.2.2.appx",
        "payload/gamebar/deps/Microsoft.VCLibs.x64.Debug.14.00.appx",
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
