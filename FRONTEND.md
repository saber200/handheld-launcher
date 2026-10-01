# 前端独立化（0.1.46 起）

> 状态：**设计已定，代码未动**。`v0.1.45` 冻结，本文描述的工作全部进 `0.1.46`。
> 相关文档：`STATUS.md`（当前进度）、`FUTURE.md`（功能 2 / 功能 3 是本前端的由来）。

## 1. 为什么要拆

`0.1.45` 掌机实测两个症状：**开机就看到前端**、**前端关不掉**。根因不是哪一行的笔误，而是做法本身：

- 启动器进程在 `setup()` 里 `preload()` 出一个隐藏的第二 WebView（label `frontend`），再用一堆全局状态（`FRONTEND_OPEN`、`frontend-state` 事件）和主窗协调「谁在前台」。
- `create_hidden()` 先 `force_topmost()`（内部是 `SetWindowPos(..., SWP_SHOWWINDOW)`，**这会把窗口显示出来**），随后才 `hide()`；两步跨线程异步，一旦那次 `hide()` 没落地，就得到「窗口在屏上、状态却是关的」：`close_frontend()` 只 `emit` 不隐藏，主窗判定「启动器在前台」还会吞掉 Back+Start → 谁也关不掉。
- 前端/启动器共用一份 `sessionStorage` 判断该渲染哪个页面，两个窗口互相污染。

**结论**：第二个 WebView 住在启动器进程里、靠全局状态同步前台，注定和 Windows 的前台窗口管理打架。拆成两个独立进程后，这一整类 bug 结构上不再存在。

## 2. 边界：谁都不碰谁

| | 启动器 `FantasyHub.exe` | 前端 `FantasyHubFrontend.exe`（独立软件） |
| --- | --- | --- |
| 对另一方的了解 | 只有「前端装没装」（读文件存在性） | **完全不知道启动器存在**（除 TDP 请求，见 §4） |
| 能对另一方做的动作 | **什么都不能**：不起进程、不杀进程、不发生命、不注册它的快捷键 | 仅通过本地 IPC 请求 TDP 读写 |
| 快捷键 | **全部移除**（Back+Start 监听、Ctrl+H 全局热键、Start 键绑定全删）；手柄侧只保留「设置」键，且改成**双击** View / Share（理由见 §10） | 只有两个：`Back+Start`、`Ctrl+H`，都是开/隐藏切换 |
| 窗口 | 主窗（无边框全屏 FSE） | 无边框浮窗 440×800、置顶、贴右、`skip_taskbar` + `toolwindow` |
| 常驻 | 现状 | 托盘常驻；「关闭」= 隐藏，进程不退，秒开 |
| 自启 | 现状（自己管） | 自己管（HKCU Run，托盘菜单可切换，装好默认开） |
| FSE 稀疏包身份 | 归启动器 | **不注册**（它不是全屏壳） |

启动器里唯一保留的前端入口：**工具箱 → 「前端」卡片，只做文件级安装/更新/状态**，没有任何「打开/关闭前端」按钮。

## 3. 前端软件自己的能力

- **进程检测 / 退出游戏：前端自己实现**。纯用户态即可（`CreateToolhelp32Snapshot` 枚举 + `TerminateProcess` 结束），**不需要提权**，所以脱离启动器也能用。
- **TDP：走本地 IPC 问启动器**（见 §4）。启动器没跑时，TDP 区显示「启动器未运行」/「需要管理员」，其余功能照常，绝不阻塞打开。
- 手柄输入：自带 XInput 轮询（不依赖窗口焦点），所以在游戏里、在启动器全屏上都能唤出。
- **大屏模式（FSE）下的层级**：全屏的启动器是**前台窗口**，而 `set_always_on_top` 只保证窗口**属于**置顶层 —— 同层里谁压谁看**激活顺序**，后台进程的 `show()` / `set_focus()` 又会被 Windows 的前台锁静默挡掉（不报错）。三件事凑一起就是「窗口已显示、位置也对、`is_visible()` 也是 true，人却看不见」。0.1.39–0.1.45 的解法是 `detach_owner` + `force_topmost` + `steal_foreground` 这三件 Win32 手法，0.1.46 拆成独立程序时漏掉了（只剩一句 `set_always_on_top`），0.1.48 补回。现在它们住在 `frontend/src-tauri/src/topmost.rs`，由 `overlay.rs::show()` 在显示前后各调一次，**不要删**。桌面模式看不出差别（启动器只是窗口化的普通窗口），只有大屏模式会露。
- **排查层级问题**：每次显示都会记一行 `frontend layer (...) fg=<前台窗口> | ours topmost=.. fg=.. rect=.. | above=<压在我们上面的可见窗口>`。`above` 里出现 `FantasyHub` = 被全屏启动器压住；`topmost=false` = 置顶没写进去；`fg=true` = 前台也抢到了。启动器那边另有 `big-screen mode (fill screen)` / `desktop mode (leave fullscreen + start explorer)` 标明当时是哪种模式 —— 否则日志根本看不出按下快捷键时身处哪一屏。
- 键盘输入：`Ctrl+H` 是系统级全局热键（不依赖焦点）；浮窗内的方向键/AB 需要焦点，因此提供设置项「打开时抢焦点（默认）/ 不抢焦点（只用手柄）」。

## 4. TDP 的本地 IPC 约定

- 通道：**127.0.0.1 回环 TCP + 一次性 token**。原先写的是"命名管道首选"，实做时改了：启动器是提权进程，它创建的命名管道默认带高完整性级别标签，未提权的前端写不进去（MIC 的 no-write-up），要么自己写 SDDL 放宽、要么就得提权 —— 这两种都容易在真机上静默失败，而且远程排查成本极高。回环 socket 不受这套限制，纯 `std`、无 unsafe。门口改由随机端口（监听 `127.0.0.1:0`）+ 32 位随机 token 守住，端口与 token 写在 `%APPDATA%\handheld-launcher\tdp-ipc.json` 里供前端发现。
- 协议：一行一个 JSON 请求/响应，只暴露三个能力：`tdp_status`、`set_tdp`、`tdp_driver_status`（**不暴露任何窗口/进程控制命令**；装驱动这种要提权的事也不在通道里，前端只显示"去启动器工具箱装"）。
- 启动器侧：常驻监听任务；TDP 需要管理员 + WinRing0，所以**提权永远留在启动器**，前端不提权（避免每次开机 UAC）。
- 版本协商：握手带协议版本 + 启动器版本；不匹配就在前端显示「启动器版本不匹配，请更新启动器」，不静默失败。
- 实现注意：`windows-sys` 需补 `Win32_System_Pipes` 特性（或引入异步管道封装），细节在阶段 2 定。

## 5. 安装与更新

- CI 一次产出两个安装包并在**同一次运行**里按顺序构建：先出前端 NSIS（它顺手建 Release），再把它拷成启动器的 `src-tauri/payload/frontend-setup.exe`（固定文件名，NSIS 脚本不用猜带版本号的名字），最后打启动器 NSIS —— 启动器的 `bundle.resources` 带上这个 payload，装完的 `NSIS_HOOK_POSTINSTALL` 会静默把它装上去。
- 工具箱「前端」卡片读**前端自己写的** `%APPDATA%\handheld-launcher\frontend.json`（exe 路径 + 版本）来显示"已安装/没装过"，然后运行随包的安装包做**安装 / 更新**。为什么不猜 NSIS 的安装目录：安装位置随安装模式变，猜错就会显示错误状态；由前端自己上报最准。（以前写的"从这里下载前端安装包"改成了用随包的那份：离线可用，掌机上更靠谱。）
- 覆盖正在运行的前端会因 exe 被占用而失败：走一次性「请退出」握手 —— 安装器写标记文件 `%APPDATA%\handheld-launcher\quit-for-update`，前端每 2 秒看一眼、看到就**真正退出进程**，安装器等 6 秒后覆盖安装、最后删掉标记。**用文件而不是命名事件**：握手一端是 NSIS，读写文件比打开 Windows 命名事件简单可靠得多（也不必上 unsafe 或额外插件）。**这是安装时的一次性握手，不是运行时耦合。**
- 前端开机自启由**前端安装包**的 post-install 钩子调它自己的开关（`FantasyHubFrontend.exe --enable-autostart`）来完成：走同一套插件写的值名，托盘菜单里的勾选状态必然与注册表一致。前端程序本身仍然不会偷偷写注册表。
- 卸载：前端由它自己的安装包卸载（Tauri 生成的卸载流程本来就会处理"自己的程序还在跑"）；启动器卸载只删自己的目录/payload，**不杀前端进程**。

## 6. 代码组织（阶段 1 已落地）

- 仓库根 `Cargo.toml` 是工作区根：成员 `src-tauri`（启动器）、`frontend/src-tauri`（独立前端）、`crates/fh-core`（共享内核）。**cargo 的目标目录因此变成仓库根的 `target/`**，不再是 `src-tauri/target`；CI 的 rust-cache 与产物路径已同步成 `". -> target"`。
- 三个 crate 的版本号取自根 `[workspace.package] version`。发版时改这一处 + `package.json` + 两个 `tauri.conf.json`，并让 `Cargo.lock` 跟上（本地跑一次 `cargo metadata` 即可，不必编译）。注意 `[profile.release]` 只能写在根：写在成员里 cargo 会忽略（只告警）。
- **`fh-core` 铁律：只放不带 `#[tauri::command]` 的纯逻辑。** Tauri 的 `allow-<命令名>` 权限是构建时按 app 自己的 crate 源码生成的，命令搬进依赖 crate 会扫不到、capability 直接报错。所以命令留在各自 app 里，`tdp` / 进程 / IPC 的**实现**放 `fh-core`，由 app 的命令薄薄包一层。阶段 1 只搬了 `logutil`（启动器侧用 `pub use fh_core::logutil;` 保住所有既有调用点）；Rust 侧 `i18n` 暂不共享，UI 文案继续靠共享的 `i18n/catalog.ts`。
- 两个 app 各自一份 `tauri.conf.json`：启动器（FSE 全屏窗 + `requireAdministrator` 清单）、前端（`visible: false` 的置顶贴右窗 + 无清单、不提权）。**`tauri build --config` 是「与默认配置合并」语义，不能用来切项目**：第二个 app 必须在自己目录里跑 CLI（`projectPath: frontend`）。前端那份配置因此不写 `beforeBuildCommand`，Web 产物由启动器那次 `npm run build` 一次构建、两边共用。
- Web 侧：同一 Vite 工程多入口 —— `index.html`（启动器，`src/main.tsx`）、`frontend.html`（前端，`src/frontend/main.tsx`）；共享 `i18n/catalog.ts`、`audio/sfx`、需要的样式。
  - **前端那份 `tauri.conf.json` 的窗口必须写 `"url": "frontend.html"`。** Tauri 的 `WebviewUrl` 默认值是 `index.html`，不是「跟着入口页走」；漏写的后果是正式包里前端窗口加载**启动器**的整屏界面（dev 下 `devUrl` 已经带了 `/frontend.html`，所以只在安装包里露出来）。0.1.46 就是这个情况，0.1.47 修。
- 语言：共享配置文件（`%APPDATA%\handheld-launcher\settings.json` 的 `locale`），两边各自读写，「最后写入生效」，不做实时同步。
- CI：`tauri-action` 跑两次（`projectPath: .` 与 `frontend`），产物都落在同一个 `target/release/bundle/nsis/`，用同一个 tag 传进同一个 Release（两个安装包）；前端那步必须排在启动器之后（Web 先构建）。

## 7. 启动器侧删除清单（0.1.46 第一刀）

- 删整个 `src-tauri/src/frontend.rs`（`preload`、`toggle/open/close/focus_frontend`、`install_hotkeys`、`start_chord_watch`、`hide_overlay`、`show/hide/place/force_topmost/steal_foreground`、`shell_is_foreground` 全走）。
- `src-tauri/src/lib.rs`：`mod frontend;`、`frontend::preload()`、`frontend::install_hotkeys()`、handler 里的 4 个 `frontend::*`，以及 `0.1.45` 引入的 `WindowEvent::Focused(true) → hide_overlay`。
- `src-tauri/Cargo.toml`：移除 `tauri-plugin-global-shortcut`（全仓库只有 `frontend.rs` 用它）。
- `src/App.tsx`：`frontendOpen` / `frontendSurface` / `frontend-state` 监听、`openFrontend` / `closeFrontend` / `toggleFrontend`、Ctrl+H 分支、`previewFrontend` 抽屉、`floatFrontend` 对 `useGamepadNav.enabled` 的判断、`onStart` 绑定、`mainLocked` 里的 `frontendOpen`，以及各处 `if (frontendOpen) return;` 守卫。
- `src/main.tsx`：删掉按 `sessionStorage` / hash 判断渲染哪个页面的分支。
- 删 `src/FrontendShell.tsx`、`src/pages/FrontendPage.tsx`（搬进前端软件）、`src/styles/global.css` 里 `.frontend-preview` / `.frontend-shell*` 相关块。
- `src/i18n/catalog.ts` 的 `frontend.*`、`src/library/useLocalLibrary.ts` 的 `useRunningLibraryGame`：随页面迁入前端（catalog 作为共享文件保留）。
- `src/pages/ToolboxPanel.tsx`：前端卡片改成文件级安装/更新 + 版本/安装状态。

## 8. 阶段与验证

1. **阶段 1**：workspace + `fh-core` + 第二个 Tauri app 骨架 + Vite 多入口 + CI 出两个 exe。
2. **阶段 2**：前端软件（托盘、两个快捷键、浮窗显示/隐藏、自启、页面迁移、进程/退游戏、TDP IPC 客户端）。
3. **阶段 3**：按 §7 清空启动器侧，并把 `STATUS.md` / `FUTURE.md` 的功能 2、3 备注改成解耦后的行为。
4. **阶段 4**：双安装包 + payload + 安装退出握手 + 工具箱卡片。
5. **阶段 5 设备验证清单**（本机无 Windows，必须真机过）：
   - 开机不再出现任何前端窗口；启动器进程内没有第二个 WebView。
   - `Ctrl+H` / `Back+Start` 在启动器全屏上、在游戏里都能开/隐藏；再按一次必关（这是本次回归的正题）。
   - 浮窗能盖在 FSE 全屏的启动器和无边框全屏游戏上；**独占全屏游戏浮不起来**（Windows 限制，预期如此）。
   - 前端关掉后启动器手柄/键盘完全正常；两边同时操作互不干扰 —— 判据见 §10：和弦只开浮层（不弹设置）、浮层开着时启动器不吃手柄、浮层关掉后手柄自动回到启动器。
   - 升级覆盖：前端运行中触发升级 → 握手退出或明确提示。
   - 卸载残留：托盘快捷方式、自启项、管道、残留进程。

## 9. 进展

### 阶段 1：代码已写（**未编译、未提交**）

- 新增工作区根 `Cargo.toml`：成员三个、`[workspace.package] version = "0.1.45"`、`[profile.release]` 从 `src-tauri` 搬上来（profile 写在成员里会被 cargo 忽略）。
- `src-tauri/Cargo.toml`：版本号改成继承工作区、`tauri`/`serde`/`serde_json` 走工作区依赖、新增 `fh-core` 依赖；`src-tauri/Cargo.lock` 提到仓库根 `Cargo.lock`。
- 新增 `crates/fh-core`：目前只有 `logutil`（多了个 `init_for(tag)`，启动器沿用 `init()`，日志首行格式不变）；启动器 `src-tauri/src/lib.rs` 用 `pub use fh_core::logutil;` re-export，全仓 `crate::logutil::...` 调用点一个字都没动；`src-tauri/src/logutil.rs` 已删。
- 新增独立前端骨架 `frontend/src-tauri/`：`FantasyHubFrontend.exe`、`identifier com.handheld.frontend`、窗口 `visible: false`（开机绝不显示）、无管理员清单、无 `requireAdministrator`；带 `--show` 参数便于真机手动看一眼。托盘 / 热键 / XInput / TDP IPC 留给阶段 2。
- Web：新增 `frontend.html` + `src/frontend/main.tsx`（占位页，页面自述"用 `--show` 启动才会看到"）；`vite.config.ts` 改双入口。
- CI：rust-cache 改 `". -> target"`；新增「Build standalone frontend (Windows)」一步；Artifacts 与 Release 同时带两个安装包（`target/release/bundle/nsis/*.exe`）。
- 本机开发：启动器照旧 `npm run tauri:dev`；前端先 `npm run dev`（Vite 起在 1420）再 `npm run tauri:dev:frontend`；出前端安装包 `npm run tauri:build:frontend`（内部先 `npm run build`）。

**阶段 1 之后设备上的预期行为**（重要）：启动器侧的解耦代码还没动（阶段 3 才做），所以 0.1.45 那两个毛病**仍然存在**。这一阶段要看的只有：开机不出现前端窗口、前端 exe 能用 `--show` 显示并盖在全屏启动器上、两个安装包都能装。

**真机冒烟清单（需要你）**：两个安装包都装 → 开机确认没有前端窗口 → `FantasyHubFrontend.exe --show` 看到占位页、且浮窗在无边框全屏启动器之上 → 托盘/任务栏不出现前端图标 → 关掉前端后启动器一切照旧。

### 阶段 2：前端可用（**代码已写，未编译、未提交**）

新增 `frontend/src-tauri/src/{overlay,tray,chord,text}.rs`：

- `overlay.rs`：显示/隐藏/切换、贴右定位（逻辑宽 440 × 缩放系数、整屏高、先问 `primary_monitor()` 再问窗口自己 —— 对隐藏窗问 `current_monitor()` 在独占全屏下会卡住，这坑启动器里踩过）、`set_always_on_top(true)`、默认抢焦点（常量 `TAKE_FOCUS`，等共享设置文件落地再做成开关）、关窗只隐藏（`CloseRequested` → `prevent_close` + hide）。日志行沿用启动器的措辞：`frontend show begin (reason)` / `frontend shown` / `frontend hidden (reason)`，其中 `reason` 是 `hotkey Control+H`、`chord Back+Start`、`tray click`、`tray menu`、`second instance`、`argv --show`。
- `tray.rs`：托盘菜单「显示 / 隐藏前端」「开机自启（勾选项）」「退出前端」；左键单击图标也是开关；图标直接用 `default_window_icon()`；自启走 `tauri-plugin-autostart`（HKCU Run，值名取各自的 productName，与启动器的自启互不覆盖）。
- `chord.rs`：XInput 轮询 0→3 号手柄，`XINPUT_GAMEPAD_BACK | XINPUT_GAMEPAD_START` 同时按下且边沿触发才切换，40 ms 一轮（与启动器现成实现同节奏）；托盘退出时线程自己收工。
- `text.rs`：托盘文案中/英按系统 UI 语言（`GetUserDefaultUILanguage`，LANGID 低 10 位 == 9 即英文）。**这是过渡方案**，阶段 3/4 接上共享 `settings.json` 的 `locale` 后只剩 `pick`。
- `main.rs`：注册顺序 `single-instance`（第二实例只叫出现有窗口）→ `autostart`（注册项带 `--autostart`）→ `setup`（参数 → 窗口事件 → 托盘 → 热键 → 手柄轮询）。参数：`--show`、`--enable-autostart` / `--disable-autostart`（安装包用，前端绝不偷偷写注册表）、`--autostart`（由插件注入，只记日志）。
- 能力集：`core:default` + 阶段 3 界面要用的窗口权限 + `global-shortcut:default` + `autostart:allow-*`（托盘/热键都在 Rust 侧，不依赖 JS IPC）。

**已知的过渡期冲突（阶段 3 结束即消失）**：启动器那一侧此时**还在**跑它自己的 Back+Start 和弦监听并注册着 Ctrl+H，所以：

- 按 Back+Start 会**两边都响应**（两个浮层同时出来）—— 阶段 3 删掉启动器的监听后就只剩前端；
- `Ctrl+H` 是一个**系统级唯一**热键，谁先注册谁拥有：启动器先启动时前端会注册失败（此时日志里是 `global shortcut unavailable: ...`，前端**不会**因此起不来），于是 Ctrl+H 可能落在启动器的浮层上 —— 想验证前端的 Ctrl+H，就先退出启动器再试。

阶段 2 想在真机上单独验证前端，最省事的办法是**先只装前端的安装包**（或先不启动启动器），这样托盘、Ctrl+H、Back+Start、贴右定位都不会被启动器抢。前端界面仍是占位页：真界面（TDP 面板、运行中游戏、退出游戏）在阶段 3 接。

### 阶段 3：启动器侧连根删掉（**代码已写，未编译、未提交**）

- 删 `src-tauri/src/frontend.rs` 整个文件（预创建隐藏窗、四个命令、Ctrl+H 注册、Back+Start 轮询、`force_topmost` / `steal_foreground` / `shell_is_foreground` 等全部随之消失）。
- `src-tauri/src/lib.rs`：`mod frontend;`、`frontend::preload()`、`install_hotkeys()`、handler 里 4 个 `frontend::*`、`WindowEvent::Focused(true) → hide_overlay`、`reveal_shell` 里的 `hide_overlay` 全删（原处留注释说明这段为何永远删掉）。
- `src-tauri/Cargo.toml`：删掉 `tauri-plugin-global-shortcut` 依赖（全仓只有 `frontend.rs` 用它）；`src-tauri/capabilities/default.json`：`windows` 只剩 `main`，删 `global-shortcut:default` 与 `allow-toggle/open/close/focus-frontend` 四个权限。
- Web：删 `src/FrontendShell.tsx`、`src/pages/FrontendPage.tsx`；`src/main.tsx` 去掉 sessionStorage / hash 判断（启动器只剩一个入口）；`src/App.tsx` 去掉 `frontendOpen` / `frontendSurface` 状态、`frontend-state` 监听、`openFrontend` / `closeFrontend` / `toggleFrontend`、Ctrl+H 与 End 键、`previewFrontend` 抽屉、`floatFrontend` 对 `useGamepadNav` 的判断、`onStart`（Start 键在启动器里现在是空操作）、以及各处 `if (frontendOpen)` 守卫；`src/styles/global.css` 删 `.frontend-shell*` / `.frontend-preview` / `.frontend-section-title` / `.frontend-lead`，并在原处留注释写明搬去哪、怎么取回。
- 文档：`STATUS.md` 的「前端浮层（Start）」整节改写为「前端（0.1.46 起独立成软件）」；`FUTURE.md` 功能 2 / 功能 3 的备注改成解耦后的行为；catalog 的页脚提示改为「前端是独立软件：装好后托盘常驻，Ctrl+H / 手柄 Back+Start 开关」。

**删除不等于丢失**：前端界面本体仍在 git 里（`git show v0.1.45:src/pages/FrontendPage.tsx`、`git show v0.1.45:src/FrontendShell.tsx`、`git show v0.1.45:src-tauri/src/frontend.rs`），下一阶段把界面搬进独立前端程序并接上 TDP 本地 IPC。

**已知的历史遗留（不急着动）**：`src/library/useLocalLibrary.ts` 的 `useRunningLibraryGame` 现在启动器侧已无人使用（留着给前端程序搬过去）；catalog 里 `text().frontend` 这组键名是历史命名（`ToolboxPanel` 只是借用其中的运行库/状态文案），等界面搬完后可以改成更中性的名字。

### 阶段 4：前端真界面与能力层（**代码已写，未编译、未提交**）

共享内核（`crates/fh-core`）新增，两个程序都用同一份：

- `tdp`：`TdpInfo` / `TdpDriverStatus` 数据结构（启动器的 `tdp.rs`、`toolbox.rs` 改成 re-export，形状不变）。
- `i18n`：`apply` / `pick` 搬进来（各 app 自己保留 `#[tauri::command] set_locale` 薄壳，命令必须留在 app 里）。
- `library`：`LibraryGame` + `library.json` 的原子读写。**库清单为什么要落文件**：库存在启动器自己的 localStorage 里，而 WebView2 的 user-data 目录按 app identifier 分开，前端读不到。
- `ipc`：TDP 协议、发现文件、客户端 `request()` / 服务端 `parse_request()`、token 生成。
- `process`：`running_ids` / `pids_for_game` / `kill_game` / `belongs_to_game` / `normalize_path` 从启动器的 `scan.rs` **原样搬来**；`scan.rs` 现在只剩薄壳调用（`windows::game_pids`、`process_belongs_to_game`、`normalize_win_path`），原来那套重复的 ToolHelp/`OpenProcess` 代码已删，一份实现两边用。

启动器侧：

- `tdp_ipc.rs`（新）：回环 TCP 服务端，串行一问一答，只认 `tdp_status` / `set_tdp` / `tdp_driver_status`，其它命令明确拒绝并记日志；启动时写 `tdp-ipc.json`。
- `library.rs`（新）：`library_publish` 命令，把库清单落盘（`allow-library-publish` 权限已加）。前端在 `useLocalGames` 的清单变化时调用它。
- `i18n.rs` / `tdp.rs` / `toolbox.rs`：改成复用内核类型，行为不变。

前端侧：

- `tdp_client.rs`：`tdp_status` / `set_tdp` / `toolbox_tdp_driver_status` —— 命令名与启动器一致，界面代码基本不用改；失败信息归一成"启动器没在运行"这一类。
- `games.rs`：`running_games` / `quit_game` **本进程自己实现**（免提权），候选表来自 `library_read`。
- `library.rs`：`library_read`（只读 `library.json`）。
- `chord.rs`：除了开关，浮层可见时每 40 ms 把摇杆/AB/Start 通过 `frontend-pad` 事件推给界面（与旧版浮层载荷同形状）。
- 权限：`frontend/src-tauri/permissions/frontend.toml` 声明这 7 个命令，capabilities 逐条放行 + 补 `core:window:allow-set-title`（i18n 切语言时会设窗口标题）。
- Web：`src/frontend/FrontendShell.tsx`（外壳）、`FrontendPanel.tsx`（TDP 面板 + 运行中游戏 + 退出游戏，从 0.1.45 的 `FrontendPage.tsx` 搬来）、`library.ts`（库/进程访问）、`frontend.css`（`.frontend-shell*` 样式从启动器 global.css 搬来）。外壳的可见性**只看自己窗口的 `isVisible()`**（400 ms 轮询），不再听任何跨程序事件。

**这一阶段删掉的两处旧逻辑**：①"游戏退出就把前端收起来"（前端现在只属于用户）；②前端的"安装 TDP 驱动"按钮（要管理员，入口留在启动器工具箱，前端只显示状态与去哪装）。

### 阶段 5：安装与更新（**代码已写，未编译、未提交**）

- `crates/fh-core/src/handshake.rs`：更新前"请前端退出"的一次性握手（标记文件 `quit-for-update`；`POLL_MS = 2s`，安装器等 `WAIT_MS = 6s`）。
- `crates/fh-core/src/presence.rs`：前端启动时写 `frontend.json`（自身 exe 路径 + 版本 + 时间），启动器读它显示安装状态。
- 前端：`main.rs` 启动时 `presence::record()`，并起一个线程每 2 秒看握手标记，看到就 `app.exit(0)`（真正退出，不是隐藏）。
- 启动器：`frontend_tool.rs` 新增 `frontend_status` / `frontend_install` 两个命令（只看状态 + 跑随包安装包，**不含任何启动/结束前端的调用**），权限与 capability 已加；工具箱 `ToolboxPanel.tsx` 顶部多一张「前端（独立程序）」卡片；catalog 补 6 个键（中/英）。
- NSIS：启动器 `src-tauri/nsis/installer.nsh` 的 `NSIS_HOOK_POSTINSTALL` 写标记 → 等 6 秒 → `ExecWait ... /S` 装 payload 前端 → 删标记（用 `Push/Pop` 保护寄存器）；前端 `frontend/src-tauri/nsis/installer.nsh` 装完调 `--enable-autostart`。两个 `tauri.conf.json` 都加了 `windows.nsis.installerHooks`，启动器 `resources` 加了 `payload/frontend-setup.exe`。
- 启动器 `build.rs`：给 `payload/frontend-setup.exe` 补一个空占位（和 FSE 身份文件同一套做法），本地/dev 构建不会因为 bundler 找不到资源而失败；`.gitignore` 忽略 `src-tauri/payload/`。
- CI：新增显式 `npm run build`（Web 只构建一次、两个程序共用）；顺序改成 **前端安装包 → stage 成 payload → 启动器安装包**；Artifacts 与 Release 依旧同时带两个安装包。

## 10. 手柄归属（谁在什么时候吃手柄，0.1.49）

手柄是**共享资源**：XInput 每个进程都能只读轮询，Windows 不给「独占」，所以只能在**逻辑上**仲裁。两边读的是同一份状态，谁都不设闸，一次按键就会有两个响应者 —— 0.1.48 之前同时存在两个症状：

- 用 `Back+Start` 呼出浮层时，和弦里的 `Back`（View / 8 号键）正好是启动器的设置键 → **浮层出来的同时，设置抽屉也被拉开**；
- 浮层开着时启动器的方向键 / A 键仍在身后生效（A 甚至会在身后把游戏启动起来）。

规则（按一次键只有一个响应者）：

| 时刻 | 手柄归谁 |
| --- | --- |
| 浮层**不在**屏上 | 启动器。前端这时本来就不读方向键/按键（`chord.rs` 只在 `is_visible()` 时读），天然成立 |
| 浮层**在**屏上 | 浮层。启动器**完全停止消费手柄**（方向键、A、LB/RB、LB/RT 全部停） |
| `Back+Start` 和弦 | 永远归前端。它是浮层的开关，前端必须能独立工作（游戏里、启动器没跑时都要能用） |

两道闸：

1. **稳态：浮层在屏上 → 启动器不吃手柄**。`src-tauri/src/overlay_watch.rs` 每 200 ms **只读**观察「有没有属于 `FantasyHubFrontend.exe` 的**可见**顶层窗口」（`EnumWindows` + `IsWindowVisible` + 取影像名比对；找到的句柄缓存，每轮再确认「还在、**还属于前端程序**」—— 窗口句柄会被系统回收，只认句柄可能盯上别的窗口 —— 前端重启才重找），状态变化时记一行 `overlay watch: frontend overlay visible → launcher pad off` 并 `emit("overlay-state", open)`；`src/App.tsx` 据此 `useGamepadNav({ enabled: intro === "done" && !overlayOpen })`，挂载时用 `overlay_open` 命令先问一次。
   - 停的只是**手柄消费**：键鼠、Esc、点击照旧。键盘事件只进焦点窗口，浮层抢了焦点就不会漏回启动器。
   - 重新启用时 `useGamepadNav` 的 `seedHeld()` 会把按着的键记为已按住，所以关浮层那一下不会顺手触发一次动作（这段是 0.1.45 为「浮层刚显示时 Start 还按着」写的，正好复用）。
   - 判定用**可见性**而不是焦点：§3 说 `TAKE_FOCUS` 以后要变成设置项，浮层「不抢焦点」时焦点判断正好会失灵；「浮层在屏上」才是「谁该用手柄」的语义。
   - **为什么由启动器自己看窗口，而不是让前端上报**（新 IPC 命令 / 写进 `frontend.json`）：后者要动前端 → 两个程序必须同时升级，老前端不写就没信号；前端被杀 / 崩了状态还会「卡在开着」，启动器的手柄就永久失灵。看窗口对**已经装好的前端立刻生效**，前端退出即自动复位，也不给「前端 → 启动器」加新通道（§2 的边界）：这里只读窗口列表，不读写对方任何东西。代价是启动器多知道一件「前端有个窗口」的事实，理由就在这里。
2. **瞬态：和弦那一下不许漏进启动器**。启动器的设置键从「单击 View / Share」改成**双击**（`useGamepadNav` 的 `viewGesture: "double"`，450 ms 内两次点按），单击什么都不做；`App.tsx` 里 `onView` 那串「收起文件菜单 / 关对话框 / 开关设置」整体搬到双击上。另外双击模式下 Menu 也跟着守：第一次点按之后的一小段时间里 Menu 不算独立按下，第二次点按时若 Menu 还按着就整串吞掉（那正是和弦）。
   - 为什么不用「押后判定」（按下后等 40–160 ms 看 Menu 是否也按下）：那会让设置键**肉眼可见地变慢**；而和弦是**按住两个键**，不可能出现两次点按，双击零延迟且天然分得开。
   - 键盘 Esc 仍是按一次开/关设置（键盘不走手柄这条路）。
   - **已知边界**：两次点按间隔超过 450 ms 就变成两次单击，设置不开 —— 预期如此。

前端侧一行未改（`chord.rs` 只更新了说明它为什么现在仍然需要两边配合的注释）。
