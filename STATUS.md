# 进度对照（v0.1.49）

> **发布基准：`v0.1.0` 稳定版** — 内容与内部构建 0.1.38 一致（见 `v0.1.0` 标签 / `release/0.1.0` 分支）。
> `0.1.31`–`0.1.49` 均为测试版，仅内部验证用，不作为发布版。

对照「已经能用 / 刚改完待打包验证 / 还没做」。掌机请以最新 Release 为准。

## 0.1.49 这一版

修「**一次按键，两边都响应**」：前端浮层与启动器的界面读的是**同一份**手柄状态（XInput 每个进程都能只读轮询，Windows 不给「独占」，只能在逻辑上仲裁），谁都不设闸就有两个响应者 —— 呼出浮层的 `Back+Start` 里的 `Back` 正好是启动器的设置键，**浮层出来的同时设置抽屉也被拉开**；浮层开着时启动器的方向键 / A 键仍在身后生效（A 甚至会把身后的游戏启动起来）。

- **闸一（稳态）：浮层在屏上时，启动器彻底停止消费手柄**。新增 `src-tauri/src/overlay_watch.rs`：每 200 ms **只读**观察「有没有属于 `FantasyHubFrontend.exe` 的**可见**顶层窗口」（`EnumWindows` + `IsWindowVisible`，再用 `PROCESS_QUERY_LIMITED_INFORMATION` + `QueryFullProcessImageNameW` 比对影像名；找到的句柄缓存，每轮再确认「还在、还属于前端程序」—— 窗口句柄会被系统回收，只认句柄可能盯上别的窗口 —— 前端重启才重新枚举），只在状态变化时记一行 `overlay watch: frontend overlay visible → launcher pad off` 并 `emit("overlay-state")`；界面据此 `useGamepadNav({ enabled: intro === "done" && !overlayOpen })`。停的只是手柄：键鼠与 Esc 照旧（键盘事件只进焦点窗口，浮层抢了焦点就不会漏回启动器）；重新启用复用 0.1.45 就有的 `seedHeld()`（把按着的键记为已按住），关浮层那一下不会顺手触发动作
- 为什么是「启动器自己看窗口」而不是「让前端上报」（新 IPC 命令 / `frontend.json`）：后者要两个程序同时升级、老前端不写就没信号，前端被杀 / 崩溃之后状态还会卡在「开着」→ 启动器手柄**永久失灵**；看窗口对**已经装好的前端立刻生效**，前端退出即自动复位，也不给「前端 → 启动器」加新通道（FRONTEND.md §2 的边界）。判定用**可见性**不用焦点：§3 说 `TAKE_FOCUS` 以后要变成设置项，浮层不抢焦点时焦点判断正好失灵；「浮层在屏上」才是「谁该用手柄」的语义
- **闸二（瞬态）：设置键从「单击 View / Share」改成双击**。和弦里的 `Back` 按下那一下就是启动器的设置键，而浮层正在这时才刚出现（闸一的 200 ms 还来不及生效）。`useGamepadNav` 新增 `viewGesture: "press" | "double"`：450 ms 内两次点按才触发，**单击什么都不做**；第二次按下时若 Menu 还按着就整串吞掉（那正是和弦），第一次点按之后的一小段时间里 Menu 也不算独立按下。和弦是**按住两个键**、不会出现两次点按，所以双击既零延迟又天然分得开 —— 押后判定（按下后等几十毫秒看 Menu 是否也按下）会让设置键肉眼可见地变慢（这一步是刻意选的）。`viewGesture` 默认 `"press"`，键盘 Esc 与不用手柄的场景不变，前端自己的界面也不受影响
- 文档：新增 FRONTEND.md §10「手柄归属」（谁在什么时候吃手柄，含两道闸的取舍与边界），并改掉 `frontend/src-tauri/src/chord.rs` 顶部「阶段 3 删掉了启动器自己的和弦监听，一次按键只会有前端响应」这句**已经不对**的话（删掉的是启动器 Rust 侧的 XInput 监听，界面侧走的 Gamepad API 读的仍是同一份手柄）；README 与页脚提示同步成「双击 Back / Share 设置」
- 验证：`tsc` + Vite 构建通过；工作区 `cargo clippy --workspace --all-targets` 零**错误**、未新增警告（本机是 macOS，`#[cfg(windows)]` 专属代码在被编译掉的路径上的 dead_code 是老账，与本次无关）；新 Win32 代码抽进一个只依赖 `windows-sys` 的临时 crate，用 `--target x86_64-pc-windows-msvc` 真编 + clippy（干净）。**掌机冒烟仍待做**：① 启动器里按 `Back+Start` → 只出浮层、不拉设置抽屉，日志出现 `overlay watch: frontend overlay visible → launcher pad off`；② 浮层开着时方向键 / A 只作用于浮层，身后不响应；③ 关掉浮层日志出现 `pad on`，手柄立刻回到启动器、设置抽屉也不弹（`seedHeld`）；④ 单独双击 `Back` → 设置照常开关；⑤ 游戏内呼出浮层表现相同

## 0.1.47 这一版

修 0.1.46 的两个 bug（在掌机上都以「托盘 / 热键按了没反应」的形式露出来），并补上本地与 CI 的 lint 门。

- **前端窗口加载错页面**：`frontend/src-tauri/tauri.conf.json` 的窗口少写 `"url": "frontend.html"`。Tauri 的 `WebviewUrl` 默认是 `index.html`（不是「跟着入口页走」），而 `devUrl` 里已经带了 `/frontend.html` —— 所以只有安装包里才露出来：正式包的前端窗口加载的是**启动器**的整屏界面，而那页一挂载就 `setFullscreen(true)`，会把 660×1200 的浮层窗口拉成全屏。现在窗口页写死，并且每次显示都把**实际加载的 URL** 记进日志（`frontend show begin (...) url=...`），一行就能看穿
- **可见性标记会说谎**：`frontend/src-tauri/src/overlay.rs` 里 `toggle` 只读静态 `VISIBLE`；`show()` 又吞掉 `window.show()` 的返回值、然后**无条件**写 `frontend shown`。于是「窗口没出来」在日志里长得和成功一模一样。现在 `toggle` 问的是窗口自己的 `is_visible()`，`show()/hide()` 记真实结果与错误，并在「说了要显示却仍然不可见」时补记窗口真实位置/尺寸（`frontend show end (...) is_visible=...` / `frontend still hidden: pos=... size=...`）
- 现场日志（`%APPDATA%\handheld-launcher\fantasyhub.log`）读出来的结论：托盘 / `Ctrl+H` / 手柄 `Back+Start` / 自启全部正常（`tray installed autostart=true`、`global shortcut Control+H registered`、`chord watch started (Back+Start)`、`frontend ready (visible=false, autostart=true)`）；`frontend place x=1260 y=0 w=660 h=1200 scale=1.5` 与历代老浮层**逐字相同**（全物理单位：1920×1200 @150% 贴右、整高，placement 数学没毛病）；23 秒内被点了 4 次托盘。唯一断掉的就是窗口里的页面
- **工程：补上四个人能看到问题的门**。0.1.46 之前仓库里**一个本地检查都没有**（没有 `.vscode/`、没有 clippy、没有 pre-commit，CI 又只在打标签时 `cargo build`、从不跑测试）：
  - 编辑器：`.vscode/settings.json`（rust-analyzer 走 clippy）+ `.vscode/extensions.json`
  - 提交：`.githooks/pre-commit`（**只检查这次提交碰过的语言**：碰到 `.ts/.tsx/.html` 跑 `tsc --noEmit`，碰到 `Cargo.toml/lock` 或 `.rs` 跑 `clippy --workspace --all-targets`，非零就拦 —— 这里**没有** `cargo fmt`）
  - 推送 / PR：`.github/workflows/lint.yml`（Windows runner，分钟级）
  - 打标签：`build-windows.yml` 里加 `Compile check` 步骤（打包前先编译）
- 清掉 14 条跨平台 clippy 警告（全在非 Windows 的 stub 分支：12 条 `useless_conversion`、2 条 `needless_return`，外加 `manual_range_contains`、`collapsible_match`）；`--all-targets` 一开就暴露 `files.rs` 测试里 4 个**真编译错误**（async 的 `file_move` / `file_delete` 漏 `.await`）—— 这类错误 CI 以前永远看不到
- 边界（诚实说）：**跨平台**问题现在本地能拦；**Windows 独占**的编译问题仍交给每次推送的 Windows lint 作业。本机 `--target x86_64-pc-windows-msvc` 交叉检查试过，不可行（`ring` 的 C 代码需要 Windows C 工具链），这条路不走

## 0.1.46 这一版

- 前端（幻想前端）拆成**独立程序**：托盘常驻 + 贴右置顶浮层，`Ctrl+H` / 手柄 `Back+Start` 开关；启动器不再创建浮层窗口、不再注册它的热键、不再和它同步开关状态 —— 0.1.45「开机就出现、还关不掉」那一类问题从结构上消失
- 两个安装包：启动器安装包会**带上并自动安装**前端（`payload/frontend-setup.exe`），工具箱里也能单独安装/更新；更新前安装器会请正在运行的前端自己退出
- TDP 由前端经**本地 IPC** 问启动器（启动器没运行就显示不可用）；进程检测与「退出游戏」由前端自己做（免提权）；装 TDP 驱动仍在启动器工具箱
- 工程：改成 Cargo 工作区（`fh-core` 共享内核 + 两个 Tauri app），CI 一次出两个安装包
- 设计与边界见仓库根 `FRONTEND.md`


## 已完成（壳与主流程）

### 壳与工程

- Tauri 2 + React + TypeScript + Vite
- 无边框全屏壳；正式名「幻想枢纽 / FantasyHub」；标识 `com.handheld.launcher`
- 要求管理员清单（`requireAdministrator`）；启动日志写 `%APPDATA%\handheld-launcher\fantasyhub.log`（含 `elevated=`）
- GitHub Actions：`v*` 标签打 Windows NSIS 安装包；已加 Cargo 依赖缓存，整轮 15 分 31 秒 → 6 分 08 秒（依赖编译 9 分 35 秒 → 0）

### 顶部标签与导航

- 游戏库 / 软件库 / 文件管理 / 工具箱；LB/RB 切页；方向键/摇杆移焦；A 确认；Back 开设置
- 中英文切换

### 设置抽屉

- 开机自启、全屏、回桌面、电源（休眠/重启/关机）、退出
- FSE：状态、一键登记、打开系统全屏体验设置页（见下方 FSE 缺口）

### 库与文件

- Steam / Epic 扫描、封面缓存、分组、手动添加、运行中边框、强制退出游戏
- 文件管理：盘符、复制/移动/多选、列表/视图等

### 前端（0.1.46 起独立成软件）

- **前端不再是启动器的一部分**：独立程序 `FantasyHubFrontend.exe`（托盘常驻 + 贴右置顶浮窗），有自己的安装包；启动器不起它、不杀它、不发生命、不注册它的快捷键。设计与边界见仓库根 `FRONTEND.md`
- 开关只有两个，都归前端：`Ctrl+H`（全局热键）、手柄 `Back+Start`（XInput 轮询，不依赖焦点）；关窗 = 隐藏到托盘，真正退出只在托盘菜单
- 启动器侧已删尽：第二 WebView（`frontend.rs`）、Start 抽屉、`open/close/toggle/focus_frontend` 四个命令、Ctrl+H 注册、`frontend-state` 状态机、`Focused → hide_overlay`。0.1.45「开机就出现、还关不掉」的那套组合不复存在
- 旧做法存档：`git show v0.1.45:src-tauri/src/frontend.rs`、`git show v0.1.45:src/pages/FrontendPage.tsx`（界面已搬进独立程序：`src/frontend/`）
- **界面与能力（0.1.46）**：TDP 面板照旧（预设 + 滑条 + 手柄调瓦数），运行中游戏与「退出游戏」由**前端自己**枚举/结束进程（免提权），TDP 走本地 IPC 问启动器（启动器没运行就显示"启动器没在运行"，其余照常）；装 TDP 驱动仍只在启动器工具箱（要管理员）

### TDP（Intel / OXP3 先做）

- 后端：WinRing0 MSR（5–40W 预设 + 滑条）
- 打开前端先**检测驱动**；未就绪只显示安装引导；装好后再显示调节 UI
- 一键下载 WinRing0、注册 `WinRing0_1_2_0` 服务（需管理员；Defender 可能拦截）

### 工具箱

- 独立第 4 个标签页（**0.1.41**）；**0.1.44** 起只放运行库（跨游戏通用），游戏相关工具走卡片菜单
- 运行库：VC++ 2015–2022 x86/x64、.NET 8 桌面
- OptiScaler：游戏卡片菜单「安装 Mod / 工具」直接装 → 下官方 latest `.7z` → 装成 `dxgi.dll`（**版本选择暂缓**，以后再对可装版本）；工具箱里不再放「选游戏」下拉，避免和卡片入口重复

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
| 工具箱 | **0.1.41** 独立成标签页；0.1.44 起只留运行库，OptiScaler 走游戏卡片菜单；实机装包待掌机验证 |
| 前端浮层 | **0.1.46** 起是独立程序（托盘常驻 + 贴右置顶浮层，`Ctrl+H` / 手柄 `Back+Start`）；**0.1.47** 修正式包里加载错页面（启动器整屏界面）与可见性日志说谎；**0.1.48** 补回大屏模式（FSE）下的置顶/抢前台手法与 Z 序现场日志；**0.1.49** 手柄归属两道闸（浮层在屏上时启动器不消费手柄、设置键改双击）；掌机冒烟仍是最后一道关 |

## 待完成 / 已知缺口

1. **FSE**：已被识别为主应用（0.1.28+）；0.1.29 修开机找不到 `FantasyHub.exe`
2. **前端手柄**：0.1.28 修开即关；掌机验证 D-pad / A / B
3. **OptiScaler**：**0.1.41** 起吃官方 `.7z`（含 BCJ2），此前只认 `.zip` 所以一直装不上；游戏内 hook 与 Insert 菜单待掌机验证；版本 / hook 选型以后对表再做
4. **扫描**：GOG、Game Pass、微软商店应用等
5. **风扇 / Game++**：明确延后（见 `FUTURE.md`）
6. 无代码签名（SmartScreen）；无自动化测试（**0.1.47 起有 lint 门**：编辑器 / pre-commit / 每次推送的 Windows lint 作业 / 打包前编译检查；单元测试仍未做）
7. **全屏回库**：0.1.44 起主窗不再隐藏 / 让出，退出游戏后直接就是启动器；游戏里按 Back+Start 呼出浮层可直接「退出游戏」（探不到进程时会提示没找到，库页面卡片菜单里也能退）

## 近期改动备忘

- 0.1.49：修「**一次按键，两边都响应**」。前端浮层与启动器读的是**同一份**手柄状态（XInput 每个进程都能只读轮询，Windows 不给独占），于是 0.1.48 之前同时有两个症状：① 用 `Back+Start` 呼出浮层时，和弦里的 `Back`（View / 8 号键）正好是启动器的设置键 —— **浮层出来的同时设置抽屉也被拉开**；② 浮层开着时启动器的方向键 / A 键仍在身后生效（A 甚至会把身后的游戏启动起来）。两道闸：**闸一（稳态）** 新增 `src-tauri/src/overlay_watch.rs`，启动器每 200 ms **只读**观察「有没有属于 `FantasyHubFrontend.exe` 的**可见**顶层窗口」（`EnumWindows` + `IsWindowVisible`，再用 `PROCESS_QUERY_LIMITED_INFORMATION` + `QueryFullProcessImageNameW` 比对影像名；找到的句柄缓存、每轮再确认「还在、还属于前端程序」，前端重启才重找），只在状态变化时记一行 `overlay watch: frontend overlay visible → launcher pad off` 并 `emit("overlay-state")`，界面据此 `useGamepadNav({ enabled: … && !overlayOpen })` 彻底停止手柄消费（键鼠 / Esc 照旧）；重新启用时复用 0.1.45 就有的 `seedHeld()`（把按着的键记为已按住），关浮层那一下不会顺手触发动作。判定用**可见性**不用焦点（FRONTEND.md §3 的 `TAKE_FOCUS` 以后要变成设置项，浮层不抢焦点时焦点判断正好失灵）；由启动器自己看窗口而不是让前端上报，是因为后者要两个程序同时升级、老前端不写就没信号、前端崩了状态还会「卡在开着」。**闸二（瞬态）** 启动器的设置键从「单击 View / Share」改成**双击**（`useGamepadNav` 新增 `viewGesture: "double"`：450 ms 内两次点按，单击什么都不做；第二次按下时若 Menu 也按着就整串吞掉，那正是和弦）：和弦是按住两个键、不会出现两次点按，所以零延迟也不会误触，`onView` 那串「收起文件菜单 / 关对话框 / 开关设置」整体搬到双击上；键盘 Esc 与不用手柄的场景不变。前端一行未改；文档新增 FRONTEND.md §10「手柄归属」，并改掉 `chord.rs` 顶部「阶段 3 删掉了启动器自己的和弦监听，一次按键只会有前端响应」这句**已经不对**的话（删掉的是启动器 Rust 侧的 XInput 监听，界面侧 Gamepad API 照样读同一份手柄）、README 与页脚提示的手柄键位说明（「双击 Back / Share 设置」）
- 0.1.48：修「**桌面模式下正常、一进大屏模式前端就呼不出来**」。0.1.47 的日志已经排除了页面与位置：`frontend show begin (...) url=.../frontend.html`、`frontend place x=1260 y=0 w=660 h=1200`、`frontend show end (...) is_visible=true` 全对 —— 只剩一种可能：窗口确实在屏上，但**压在铺满整屏的启动器下面**。这正是 0.1.33 记过的老账（「第二窗已 shown 但被全屏挡住」），0.1.39–0.1.45 的解法是启动器 `frontend.rs` 里那三件 Win32 手法：`detach_owner`（清 `GW_OWNER`、补 `WS_EX_TOOLWINDOW`）、`force_topmost`（`SetWindowPos(HWND_TOPMOST)`，把窗口推到置顶层**最上面**）、`steal_foreground`（`VK_MENU` 按下/抬起解锁前台锁 → `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow` + `SetActiveWindow`）。0.1.46 把前端拆成独立程序时**没有把它们搬过来**（只剩一句 `set_always_on_top` —— 它只保证窗口**属于**置顶层，同层里谁压谁由激活顺序决定；而后台进程的 `show()`/`set_focus()` 会被 Windows 的前台锁静默挡掉，于是窗口永远差一层）。新增 `frontend/src-tauri/src/topmost.rs` 按 0.1.45 的顺序搬回这三件事，`overlay.rs` 在 `show()` 前后各调一次；同时补两条**现场日志**，下次无论成不成都不用再猜：前端每次显示记 `frontend layer (...) fg=<类名"标题"(pid)> | ours topmost=.. fg=.. rect=.. | above=<压在我们上面的可见窗口>`（`above` 里出现 `FantasyHub` = 被全屏启动器压住；`topmost=false` = 置顶没写进去；`fg=true` = 前台也抢到了），启动器进/出大屏模式时记 `big-screen mode (fill screen)` / `desktop mode (leave fullscreen + start explorer)`（此前日志完全看不出当时是哪种模式）。验证方式：本机无 Windows C 工具链、整仓交叉编译不可行（0.1.47 的结论），于是把新 Win32 代码抽进一个只依赖 `windows-sys` 的临时 crate，用 `--target x86_64-pc-windows-msvc` 真编 + clippy（干净）；工作区 `cargo clippy --workspace --all-targets` 零错误，Windows 专属代码仍由每次推送的 Lint 作业兜底
- 0.1.47：修 0.1.46 的两个 bug —— ① 前端窗口漏写 `"url": "frontend.html"`（`WebviewUrl` 默认 `index.html`，`devUrl` 里带了 `/frontend.html` 所以只在安装包里露出来）：正式包的前端窗口加载的是启动器的整屏界面，那页一挂载就 `setFullscreen(true)`；② `frontend/src-tauri/src/overlay.rs` 的 `toggle` 只读静态 `VISIBLE`，`show()` 又吞掉 `window.show()` 的返回值后无条件写 `frontend shown` —— 于是「窗口没出来」和成功在日志里长得一样。两处都补了现场日志：显示时记**实际加载的 URL** 与真实 `is_visible()`，说了要显示却仍不可见时补记窗口位置/尺寸。另补四个 lint 门（`.vscode/`、`.githooks/pre-commit`、`.github/workflows/lint.yml`、`build-windows.yml` 的 `Compile check`）+ 清 14 条 clippy 警告；`--all-targets` 暴露的 4 个测试编译错误（`files.rs` 里 async 的 `file_move`/`file_delete` 漏 `.await`）一并修掉
- 0.1.44：修「切标签 / 退回主应用后整机卡住」——**所有重活都从主线程搬到工作线程**（Tauri 的同步 `#[tauri::command] fn` 跑在主线程，即消息循环所在线程：一次盘符探测、图标提取或封面下载超时会把**所有窗口**一起冻住，Back+Start 也要等超时结束才反应；这也解释了「频繁切页后卡一会儿又自己好」）。具体：`files.rs`（盘符/列目录/读写/图标/打开）、`scan.rs`（扫描/运行中探测/封面/启动/退出）、`tdp.rs`、`toolbox.rs`、`startup.rs` 全部改 `async` + `spawn_blocking`；盘符改用 `GetLogicalDrives` + `GetDriveTypeW`（不再对 A–Z 逐个 `Path::exists()` 做真 I/O，空读卡器不再拖住列表）；封面下载失败记 10 分钟冷却，不再每次进页重试；`running_games` 轮询加在途保护。另：`key={tab}` 重挂载导致的重复加载 —— 文件管理记住本次会话的目录与列表（回页即出、3 秒内不重列），扫描结果的封面/图标跟进改成 10 分钟内不重跑。前端状态事件 `{open, surface}` 之前被当成布尔读，浮层会永远「自认已激活」，已按 `payload.open` 解析。另：工具箱去掉「OptiScaler + 选游戏」那一块 —— 卡片菜单「安装 Mod / 工具」本来就是同一件事的入口（原来还先跳标签页、再选一次游戏，纯重复），现在卡片菜单直接下载安装并把结果写在库页面提示行（`installLibraryGameMods`，带并发保护），工具箱只剩运行库；`optiscaler*` i18n 键、`toolbox-select` 样式和 `focusGameId` 预选链路一并删掉。另三处前端逻辑：① 启动游戏 / 软件不再隐藏主窗 —— Windows 会把焦点给新开的程序，我们只要别抢即可，`launch_item` 的隐藏 + `watch_game_exit` 自动回壳 + `reveal_launcher` 命令 + `AWAY_SESSION` / `away_suppress` 状态与 `Focused` 里的抢焦拦截全部删除；② 浮层「回到启动器」换成「退出游戏」，只在库里的游戏正在运行时出现（软件 / 主应用不显示），点一下 `quit_game` 立刻结束；③ TDP 滑条支持手柄：`steerFocus` 遇到 range 输入就 ±1 W 调整（按住由 320/140 ms 连发驱动），页面按 260 ms 合并写入并在写入在途时保留最新值，A 发 `gamepad-commit` 立即提交，↑ / ↓ 仍离开滑条；同时去掉「写入时禁用滑条 / 预设」——禁用会把焦点丢回 body，下一次方向键就跳回列表顶部。
- 0.1.43：修「全屏下让出主窗后回不来」。浮层加「回到启动器」；让出后后台守望游戏进程，确认退出就自动回壳；切已运行游戏只在切换成功时才让出。另修 OptiScaler 重装时子目录 `OptiScaler.ini` 被覆盖（保留判断改查 `to.join(rel)`，根目录行为不变）；清理 GitHub 上 34 条 tag 作用域废缓存（约 794 MB），并把 npm 缓存也改成只让 main 保存（`package-lock.json` 里的版本号每次发布都变 → setup-node 的 key 每次都不同，tag 存下的那条 23 MB 永远不会被下次发布命中）
- 0.1.42：无功能变更；CI 加 Cargo 依赖缓存（依赖编译 9 分 35 秒 → 0，整轮 15 分 31 秒 → 6 分 08 秒）。曾试 thin LTO + codegen-units = 16，实测链接更慢（4 分 21 秒 → 约 5 分 30 秒）且产物大 412 KiB，已回退。另修缓存作用域：tag 触发的运行保存缓存时 ref 会被写成畸形的 `refs/heads/refs/tags/vX`（npm 缓存同样如此），main 上的运行读不到，已加 `save-if` 只让 main 保存
- 0.1.41：工具箱独立成第 4 个标签页（游戏卡片可直接跳转并预选）；OptiScaler 改吃官方 `.7z` 包（旧版只认 `.zip`，导致一直装不上）
- 0.1.40：修设置页未使用变量导致 CI tsc 失败
- 0.1.39：浮层改 Game Bar 式（不隐藏主窗；断开 owner + TOPMOST）；设置页微调
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
