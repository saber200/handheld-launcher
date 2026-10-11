OptiScaler-custom.7z —— 自带版 OptiScaler（用户自己构建、支持 FSR 4.1.1 的那一份）。

它随启动器一起发出去（tauri.conf.json 的 bundle.resources），装 Mod 面板里排第一、默认选中，
装它**不用联网**。官方那几个版本照旧可选。

为什么单独带一份：官方包里的 amd_fidelityfx_upscaler_dx12.dll 是旧的 FSR 放大器，
「支不支持 FSR 4.1.1」只取决于这一个文件。这一份就是官方 v0.9.4 的完整包 + FSR 4.1.1 的放大器。

内容与来源（2026-10-11）：
- 用户给的是桌面上那个 128 MB 的 Optiscaler.zip（官方 v0.9.4 的完整文件清单）。
- 这里只是**重新压缩**（zip → 7z/LZMA2，63 MB），文件内容一个字节没动；
  zip 128 MB 推不上 GitHub（单文件 >100 MB 直接被拒），所以换了容器。
- 用 sevenz-rust2（Windows 上真正解压它的那个库）核对过：包能打开，
  且里面有 OptiScaler.dll 与 amd_fidelityfx_upscaler_dx12.dll —— 这条钉在
  toolbox.rs 的单测 `bundled_package_carries_the_fsr4_upscaler` 里。

要换新版本：替换这个文件（保持文件名不变），同步 toolbox.rs 里的
OPTISCALER_BUNDLED_VERSION（界面上显示、账本里记的就是它），然后重跑
`cargo test -p handheld-launcher`（会真去开这个包数条目）。

包不在时：build.rs 会落一个 0 字节占位让打包不失败，运行时认得「空文件 = 没带」，
面板上自带版整条消失、退回只列官方版本。
