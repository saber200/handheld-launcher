# 进度对照（v0.1.38）

对照「已经能用 / 刚改完待打包验证 / 还没做」。掌机请以最新 Release 为准。

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
- 独立置顶右侧窗（游戏中 Back+Start）；软件内 Start 用主窗抽屉（FSE 下不 duck 全屏，避免卡死）
- 打开方式：软件内 Start 开/关抽屉；游戏中 Back+Start 或 Ctrl+H 开浮层；关闭：B / Esc / Start
- 启动游戏：隐藏主窗（非最小化）+ away 会话锁，避免 FSE 立刻还原抢焦；浮层唤起前同样让出壳
- 打开时主窗锁定；关掉后才能继续操作主界面
- **手柄**：第二 WebView 用 Rust **XInput 桥**；浮层须 `focus-trap open` 才能移焦；Close 按钮不进手柄焦点
- 打开竞态：开按未松时不关；B / Start 须释放后再关

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
| SCCD 命名空间 `2018/sccd`（对齐可用 FSE 示例） | **0.1.28**；pack 校验 msix 内含 SCCD；登记时拷到 exe 旁 |
| FSE 启动 exe 名与安装文件一致（`FantasyHub.exe`） | **0.1.29**；旧版只有 `handheld-launcher.exe` 会导致开机找不到文件 |
| 对齐 OmniConsole **完整 WinUI MSIX** 形态 | **未做**（当前仍是稀疏身份包路线） |

结论：**你没有 Windows 也没关系。** 推送 `v*` 标签或手动 Run `Build Windows`，Actions 会在 `windows-latest` 上生成身份包再打 NSIS。若该步失败，看 Actions 日志里 `Pack fullscreen experience identity`。完整 MSIX 仅作备选。

## 页面现状（摘要）

| 页面 | 状态 |
| --- | --- |
| 设置 | 可用（含 FSE 入口） |
| 游戏库 / 软件库 | 可用 |
| 文件管理 | 可用 |
| 前端浮层 | **0.1.28** 修手柄开即关与焦点；待掌机验证 |

## 待完成 / 已知缺口

1. **FSE**：已被识别为主应用（0.1.28+）；0.1.29 修开机找不到 `FantasyHub.exe`
2. **前端手柄**：0.1.28 修开即关；掌机验证 D-pad / A / B
3. **OptiScaler**：版本 / hook 选型以后对表再做
4. **扫描**：GOG、Game Pass、微软商店应用等
5. **风扇 / Game++**：明确延后（见 `FUTURE.md`）
6. 无代码签名（SmartScreen）；无自动化测试

## 近期改动备忘

- 0.1.38：启动改为隐藏主窗 + away 会话（FSE 下不最小化抢焦）；浮层唤起前让出壳并加强 TOPMOST
- 0.1.37：软件内 Start 用主窗抽屉；游戏中才开置顶浮窗；去掉 duck 全屏与主窗获焦抢前端（修卡死）
- 0.1.36：交互音效（Tab / 焦点 / 开关 / 粘贴移动 / 扫描 loading / 完成）
- 0.1.35：前端改回独立置顶浮窗（FSE 下先让出主窗全屏 + TOPMOST）；全站克制交互动效（Tab/列表错落/抽屉菜单）
- 0.1.34：Start 可关抽屉；启动先最小化让游戏获焦；游戏中 Back+Start 可开关浮层；TDP 驱动重启后可直接启动服务
- 0.1.33：FSE 下 Start「卡死」→ 日志显示第二窗已 shown 但被全屏挡住；软件内 Start 改为内联抽屉
- 0.1.32：rebuild after schedule_focus AppHandle clone fix
- 0.1.31：FSE 下按 Start 卡死 → 去掉乐观 inert/焦点互抢；打开前端改为后台调度、不堵 IPC
- 0.1.30：设为 FSE 主应用后开屏闪退 → 启动自动登记不再 `Remove-AppxPackage`（会杀掉本进程）
- 0.1.29：FSE 主应用开机找不到 exe → 二进制改为 `FantasyHub.exe`，并给旧安装写别名拷贝
- 0.1.28：前端手柄竞态 + `focus-trap open`；FSE SCCD → `2018/sccd`；Game++ 记入 FUTURE 延后
- 前端预创建隐藏窗；TDP WinRing0 安装；FSE CI 打身份包
