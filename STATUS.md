# 进度对照（v0.1.23 开发中）

对照「已经能用 / 刚改完待打包验证 / 还没做」。掌机请以最新 Release 为准；下列含未发版改动。

## 已完成（壳与主流程）

### 壳与工程

- Tauri 2 + React + TypeScript + Vite
- 无边框全屏壳；正式名「幻想枢纽 / FantasyHub」；标识 `com.handheld.launcher`
- 要求管理员清单（`requireAdministrator`）；启动日志写 `%APPDATA%\handheld-launcher\fantasyhub.log`（含 `elevated=`）
- GitHub Actions：`v*` 标签打 Windows NSIS 安装包

### 顶部标签与导航

- 游戏库 / 软件库 / 文件管理；LB/RB 切页；方向键/摇杆移焦；A 确认；Back 开设置
- 中英文切换

### 设置抽屉

- 开机自启、全屏、回桌面、电源（休眠/重启/关机）、退出
- FSE：状态、一键登记、打开系统全屏体验设置页（见下方 FSE 缺口）

### 库与文件

- Steam / Epic 扫描、封面缓存、分组、手动添加、运行中边框、强制退出游戏
- 文件管理：盘符、复制/移动/多选、列表/视图等

### 前端浮层（Start）

- 独立置顶右侧窗；启动时**预创建隐藏**（避免 Windows WebView2 在同步 IPC 里 `build()` 卡死）
- 打开方式：软件内 Start；游戏中 Back+Start 或 Ctrl+H；关闭：Start / B / Esc / End
- 打开时主窗锁定；关掉后才能继续操作主界面
- **手柄**：第二 WebView 的 Gamepad API 不可靠 → 前端显示时由 Rust **XInput 桥**推 `frontend-pad`（方向/A/B/Start）
- 同一次 Start 不会再「开完立刻关」（隐藏窗不再抢输入；启用时对已按下按键做 held 播种）

### TDP（Intel / OXP3 先做）

- 后端：WinRing0 MSR（5–40W 预设 + 滑条）
- 打开前端先**检测驱动**；未就绪只显示安装引导；装好后再显示调节 UI
- 一键下载 WinRing0、注册 `WinRing0_1_2_0` 服务（需管理员；Defender 可能拦截）

### 工具箱

- 运行库：VC++ 2015–2022 x86/x64、.NET 8 桌面
- OptiScaler：选游戏 → 下官方 latest zip → 装成 `dxgi.dll`（**版本选择暂缓**，以后再对可装版本）

## FSE / 全屏体验（稀疏包）— 做到哪了

| 项 | 状态 |
| --- | --- |
| `AppxManifest` + `gamingHome` + SCCD + ExternalLocation | 清单与脚本已写 |
| `register.ps1`：证书、开发者模式、`Add-AppxPackage`、失败 token | **代码已做**，错误进 `fse-last-error.txt` + 主日志 |
| 设置页状态 / 重新登记 / 打开系统设置 | **已做** |
| 启动时尝试自动登记 | **已做** |
| 仓库内 `identity.msix` / `identity.cer` | **gitignore，不提交**；由 CI 生成 |
| **GitHub Actions** 打安装包前跑 `fse/pack.ps1` | **已接入**（`build-windows.yml`）；你不需要本机 Windows |
| 对齐 OmniConsole **完整 WinUI MSIX** 形态 | **未做**（当前仍是稀疏身份包路线） |

结论：**你没有 Windows 也没关系。** 推送 `v*` 标签或手动 Run `Build Windows`，Actions 会在 `windows-latest` 上生成身份包再打 NSIS。若该步失败，看 Actions 日志里 `Pack fullscreen experience identity`。完整 MSIX 仅作备选。

## 页面现状（摘要）

| 页面 | 状态 |
| --- | --- |
| 设置 | 可用（含 FSE 入口；身份包空则登记失败） |
| 游戏库 / 软件库 | 可用 |
| 文件管理 | 可用 |
| 前端浮层 | 可用（待掌机验证 XInput 桥与 TDP 驱动安装） |

## 待完成 / 已知缺口

1. **FSE**：用 CI 打一版含真实身份包的安装包，掌机上开开发人员模式后登记验证
2. **TDP**：掌机验证驱动安装 + 调节；无 UAC / `elevated=false` 时需查清单是否进包
3. **OptiScaler**：版本 / hook 选型以后对表再做
4. **扫描**：GOG、Game Pass、微软商店应用等
5. **风扇**：明确延后（见 `FUTURE.md`）
6. 无代码签名（SmartScreen）；无自动化测试

## 近期改动备忘（未发版汇总）

- 前端预创建隐藏窗 + 异步显隐；封面 CDN 回退；开屏缩短
- Start 双窗抢输入修复；前端 XInput 桥
- TDP WinRing0 检测/安装挪到性能区；工具箱只留运行库与 OptiScaler
- FSE 登记脚本与设置 UI 加固（仍缺真实身份包文件）
