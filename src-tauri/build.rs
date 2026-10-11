fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // FSE 身份文件（identity.msix / .cer / CustomCapability.SCCD）由 CI 现编现签，
    // 本地 dev 构建没有，就落一个空占位 —— 缺文件时 Tauri 打包会直接失败。
    for name in [
        "fse/identity.msix",
        "fse/identity.cer",
        "fse/CustomCapability.SCCD",
        // 自带版 OptiScaler 包（63 MB，见 toolbox.rs 的 OPTISCALER_BUNDLED_FILE）：
        // 正常情况下它在仓库里、随安装包发出去；万一没有（比如被人清掉了），也落一个空占位
        // 让打包别失败 —— 运行时认得「空文件 = 没带」，界面上那一项会自动消失，
        // 用户照样能装官方版本。三处路径（这里 / tauri.conf.json / 常量）改名要一起改。
        "optiscaler/OptiScaler-custom.7z",
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
