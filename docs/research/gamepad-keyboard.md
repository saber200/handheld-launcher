# 手柄键盘（中英文输入）：难度调研

> 调研日期：2026-10-13　范围：Windows 掌机 + 本仓库（FantasyHub，Tauri 2 + Rust + React）
> 结论先行：**这件事的难度不在「键盘」上，在「把字送进别人的输入框」上。** 键盘 UI 与手柄操作是本仓库已经趟过的路（手柄层与控制层大半现成），中英文字上屏才是真正的分水岭。

---

## 1. 一句话结论

| 想做到什么 | 难度 | 说明 |
| --- | --- | --- |
| 启动器**自己的**输入框（搜索 / 重命名 / 新建文件名）用手柄打中英文 | ★★☆☆☆ | 纯前端 + 手柄轮询，**不碰任何 Win32 注入**，几百行 |
| 手柄唤出的**悬浮键盘**，字进 Steam / 浏览器 / 记事本的输入框 | ★★★★☆ | 多出一个置顶不抢焦点的窗口 + 跨进程文本注入；注入这条路有硬边界 |
| 真正的**系统级中文输入法**（出现在语言栏、任何程序任何输入框都能用） | ★★★★★ | 要写 TSF 文本服务（COM 进程内 DLL），等于从零做一个输入法 |

---

## 2. 这件事拆成四层，难度差得很远

```
① 手柄输入  →  ② 键盘 UI + 焦点  →  ③ 把字送进目标程序  →  ④ 中文候选（拼音→汉字）
   已解决          本仓库大半现成          真正的难点                最容易被低估
```

**先说一个现实参照**：连 Valve 都没把这件事做圆。Steam Deck 的屏幕虚拟键盘**打不了中文**是个长期状态——SteamOS 3.7 之后仍有「更新到 3.7.21 后屏幕键盘无法输入中文」的用户报告（[Steam 社区讨论](https://steamcommunity.com/app/1675200/discussions/0/838375260162098493/)），社区的标准解法是在桌面模式里自己装 Fcitx5 + 雾凇拼音/Rime 这类**完整输入法**。这说明两件事：**③④ 两层确实是行业公认的难点**；而**想省事就复用现成的输入法引擎，而不是自己写**。

### ① 手柄读键：这一层基本不用做

本仓库已经有完整实现：`src/hooks/useGamepadNav.ts`（802 行）用 **WebView 的 Gamepad API**（`navigator.getGamepads()`）每帧轮询，处理了死区、边沿触发、LB/RB、双击 View/Share、`seedHeld()` 等一堆细节，还有 `src/settings/prefs.ts` 里的死区设置。

**但有一条硬边界（**待真机确认，但值得按最坏情况设计**）**：Chromium 系（含 WebView2）的手柄 API 一向以「页面/窗口不聚焦时不给数据」著称（Chromium 有专门的相关 issue）。悬浮键盘的关键恰恰是「不能抢焦点」，所以：

> **悬浮键盘的手柄轮询应当搬到 Rust 侧**（`gilrs` 或 XInput 轮询 → Tauri 事件推给前端），不要依赖 `navigator.getGamepads()`。`gilrs` 0.11.2（2026-05 更新，下载量 900 万+）是这条路上现成的选择，Windows 下会走 XInput / DirectInput 后端。

这一条是本方案最容易踩的坑：如果直接复用 `useGamepadNav`，可能出现「键盘弹出来了、但摇杆怎么推都没反应」。**搬到 Rust 侧还有两个附带好处**：不经过 WebView 就不受它的焦点语义影响；而且启动器已经有一套「自己看窗口、自己决定谁该用手柄」的仲裁先例（`FRONTEND.md` §10），轮询放 Rust 更容易接进同一套判断。

### ② 键盘 UI + 焦点：UI 不难，焦点要小心

- **UI 本身**：`src/components/GamepadKeyboard.tsx` 现在就有一把**数字键盘**（54 行，3×3 数字 + 退格 + 确定），是给路径 / 文件名输入用的。要扩成全键盘 + 拼音候选条，本质是同一套东西放大（布局、翻页、候选高亮）。
- **必须先认清现状**：`FUTURE.md` 功能 12 的「这一版仍缺」里写着「**手柄上的文字输入**（搜索与批量重命名要借系统键盘；现有数字键盘只够数字）」。所以这不是从零开始，是**补一个已知欠账**。
- **浮层代码不存在了**：`FUTURE.md` 功能 14 第 12 条写明，那个带托盘 / 贴右浮层的独立前端程序在 0.1.62 被删掉、小组件在 0.1.65 被删掉，「**现在这个仓库里没有任何浮层 / 覆盖窗口的代码。浮层要回来的话，得重新设计一套显示窗口、抢焦点、跟手柄让路的机制**」。悬浮键盘正是这样一个浮层，所以这部分要从零写。
- **不抢焦点是可行的，而且 Tauri 2 原生支持**：`WebviewWindow::set_focusable(false)`（以及构建时的 `focusable` 选项）在 Windows 上映射到 `WS_EX_NOACTIVATE`([docs.rs](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindow.html)、[tauri PR #13564](https://github.com/tauri-apps/tauri/pull/13564))。微软对 `WS_EX_NOACTIVATE` 的官方定义正是我们要的语义：「用户点击它时，这个顶层窗口**不会变成前台窗口**」([Extended Window Styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles))。
- **推论**：既然点击不抢焦点，那么 **WebView 里的键盘按钮用鼠标点也是安全的**（鼠标事件照收，前台不动）——这一条让「手柄优先、鼠标也顺手」同时成立。
- **一个要补的细节**：`WS_EX_NOACTIVATE` 只保证「不自动激活」，子控件仍可能通过 `WM_MOUSEACTIVATE` 请求激活。稳妥做法是自己处理这个消息返回 `MA_NOACTIVATE`；Tauri 侧可以用 `windows` crate 拿到 HWND 后挂窗口子类化（本仓库对 Win32 已经不陌生，`src-tauri/src/files.rs`、`scan.rs` 里都有直接调 Win32 的先例）。
- **本仓库已有的两条相关教训可以直接抄**：`FRONTEND.md` 记着「对**隐藏窗**问 `current_monitor()` 在独占全屏下会卡住」；以及「浮层在屏上时，启动器要停止消费手柄」（手柄归属仲裁，见 `FRONTEND.md` §10）。悬浮键盘必须接进同一套仲裁，否则会出现「打字的时候背后的启动器也在响应方向键」。

### ③ 把字送进目标程序：**这一层才是难度所在**

（详见第 3 节）

### ④ 中文候选：想省力就别自己写引擎

（详见第 4 节）

---

## 3. 文本注入：三条路，只有第三条是「哪儿都能用」

前提事实（已查官方文档确证）：**合成按键只能送进「前台线程」的消息队列**。`SendInput` + `KEYEVENTF_UNICODE` 的官方描述是「向**前台线程**的消息队列投递一条 `WM_KEYDOWN` / `WM_KEYUP`，`wParam` 为 `VK_PACKET`，过 `TranslateMessage` 后变成带该 Unicode 字符的 `WM_CHAR`」([KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput))。

**这句话决定了整个方案的形状**：目标程序必须是前台窗口。所以悬浮键盘**绝不能抢焦点**——这正好和第 ② 层的要求是同一件事。

### 路线 A：`SendInput` + `KEYEVENTF_UNICODE` 直接送汉字（最省力）

不碰输入法，直接把「已选定的汉字」当一个 Unicode 字符发出去。

- **优点**：代码量极小（几十行）；不需要打包任何引擎；中文能上屏。
- **缺点 / 硬边界**：
  - 依赖目标程序**走标准消息循环**。记事本、浏览器、Steam 客户端、多数 Win32/UWP 编辑框可以；**用 Raw Input / DirectInput 自己读键盘的程序（很多游戏）、独占全屏（exclusive fullscreen）基本收不到**（合成按键不产生 `WM_INPUT`）。
  - **高权限程序收不到，而且失败是静默的**。官方原文：`SendInput` 受 UIPI 约束，「只允许向**同等或更低**完整性级别的应用注入输入」，并且「**`GetLastError` 和返回值都不会告诉你失败是 UIPI 拦的**」([SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput))。而本仓库**自己就是会提权的那个**（工具箱要装驱动 / 运行库），这个组合一定会遇到——出问题时日志里什么都看不到，得靠「注入前先比对目标进程完整性级别」来自证。
  - 目标程序若正处于**输入法组字状态**，直接塞字符可能把组字串弄乱。
- **判断**：**MVP 就该走这条**。覆盖「启动器自己的框 + 浏览器 + Steam + 记事本 + 大多数设置界面」这些真实场景，成本最低。

### 路线 A+：消息直投（能跨提权边界的那条小路，值得单独记住）

和路线 A 并列、但**关键性质完全不同**的一条：用 `PostMessage` 把 `WM_CHAR`（或对标准编辑框用 `WM_SETTEXT` / `EM_REPLACESEL`）直接投给目标窗口。

官方文档写着：**「值小于 `WM_USER` 的消息被要求无视过滤器设置直接放行」**（`WM_CHAR` = 0x0102、`WM_SETTEXT` = 0x000C、`EM_REPLACESEL` = 0x00C2 都在此列）([ChangeWindowMessageFilterEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-changewindowmessagefilterex))。

三个推论，都是路线 A 做不到的：

1. **它不需要目标窗口是前台窗口**（不依赖输入队列，所以那条「必须前台」的前提在这里不成立）。
2. **它是少数能穿到提权程序里的路**——`SendInput` 和 UI Automation 都没有这个豁免。
3. 代价是覆盖面反而更窄：只对**标准 Win32 编辑框**有效；浏览器的输入面没有原生 `EDIT` 子窗口，**消息直投全废**（浏览器得用 UIA 的 `put_accValue`，或者干脆走剪贴板）。

**所以真实工程做法不是「选一条路」，而是排一条降级链**：`SendInput(UNICODE)` → 失败则消息直投（标准编辑框 / 提权目标）→ 再失败则剪贴板 + `Ctrl+V` → 还不行就如实告诉用户「这个窗口打不进去」。剪贴板那条虽然粗暴（会被覆盖、大文本慢、在非文本框里会把内容粘成附件），但对 CEF / Electron 系（Steam 客户端就是）反而是最稳的。

### 路线 B：键盘只产生**拼音字母**，让系统自带输入法去做候选（很巧，但脆弱）

思路：游戏手柄软键盘上敲的是 `nihao`，把字母用 **虚拟键**（不是 Unicode）注入，交给系统已装的微软拼音，候选窗口由系统弹在目标程序的光标处。

- **优点**：**中文候选、词库、自学习、模糊音全部白嫖系统输入法**，自己一行引擎代码都不用写；候选窗位置天然正确。
- **缺点 / 硬边界**：
  - 候选**选字**同样要靠注入按键（数字键 / 空格 / `-` `=` 翻页 / 方向键），于是候选列表的状态变成「自己猜的」——一旦目标程序或系统输入法有自己的状态（比如已经在组字），就会错位。
  - 候选条画在**目标程序**那边，**手柄玩家看不到「现在选到第几个了」**；要自己再画一份候选条就得反过来去问系统输入法当前状态（这条路在 TSF 之外没有干净接口）。
  - 系统输入法在独占全屏的游戏里通常根本不工作时，这条路一起失效。
- **判断**：**可以做一个「省力开关」**（设置里让用户选「用系统输入法」还是「用内置候选」），但不要把它当主力——它的状态不透明，出问题时最难查。

### 路线 C：写一个 TSF 文本服务（Text Services Framework）——「真正的输入法」

这就是**系统级**的做法，也正是 Windows 自己的触摸键盘走的路。

**已确证的关键事实**：Windows 11 的屏幕键盘（`textinputhost.exe`）**就是通过 TSF 把文本送进聚焦的应用**的——据微软 Q&A 的解释，输入管线是「控件通过 TSF 注册文本上下文 → `explorer.exe` 检测焦点变化决定是否弹键盘 → `tabtip.exe` 只是旧的兼容启动器（不渲染、不送字）→ `inputapp.exe` 是策略引擎 → `textinputhost.exe` 才是渲染键盘并通过 **TSF** 送字的那个」([Microsoft Q&A](https://learn.microsoft.com/en-nz/answers/questions/5856372/windows-11-osk-infrastructure))。

**顺带一个对本仓库很实际的信息**（同上来源）：**现代触摸键盘依赖 Explorer 外壳**。启动器是掌机全屏前端，如果目标是**替换掉 Explorer 的 FSE / kiosk 场景**，现代 OSK 不会出现，只剩旧的 TabTip。而 `src-tauri/src/files.rs` 的 `files_show_keyboard()` 现在正是**拉 `TabTip.exe` / `osk.exe`** ——这条既有路径在「Explorer 被换掉」的机器上到底还剩多少可用性，值得真机核一次（也是「为什么要有自己的手柄键盘」的一条硬理由）。

**代价**（为什么说它 ★★★★★）：

- 要写一个**进程内 COM 服务器 DLL**（`ITfTextInputProcessor` 等一整套接口），注册进 `HKLM\SOFTWARE\Microsoft\CTF\TIP`，并处理 x64 / 进程位数匹配、安装与卸载、签名与误报。
- **代码量有实测参照**：拿小狼毫的 `WeaselTSF/` 目录量一下，33 个文件、扣掉 vendored 的 `ctffunc.h`(97 KB)、`.rc`、`.vcxproj` 之后 C++ 源码约 120 KB ≈ **3–5k 行**（纯 TSF 胶水层）；加上拼音引擎 1–2k + 安装注册 ~500 → **最小可用（全拼 + 候选 + 上屏、无自学习）约 5–8k 行**。这是「多年工程」的骨架，不是能顺手抄的一段代码。
- **两条硬性交付约束**（都不是「注意一下」级别，是「不做就不工作」）：
  1. **必须 x86 + x64 各编一份并分别注册**——否则 64 位程序里根本不出现这个输入法。
  2. **DLL 必须落在 `C:\Windows` 或 `C:\Program Files`**——否则 Win8+ 的商店 / Metro 应用访问不到它；`regsvr32` 还要管理员权限。这一条直接和「安装包怎么装、要不要提权」绑在一起。
- **打进游戏 / 独占全屏必须实现 UILess 模式**：官方原文是「TIP **应该**支持 UI less 模式，如果它想运行在**不允许 TIP 显示自己界面的应用**下，**比如游戏应用或全屏应用**」；而且**不实现 `ITfTextInputProcessorEx` 的 TIP 在 UILess 线程上根本不会被激活**([UILess Mode Overview](https://learn.microsoft.com/en-us/windows/win32/tsf/uiless-mode-overview))。反过来说：**这是唯一有可能把中文打进独占全屏游戏的路线**，路线 A / A+ 在那类场景里是死路。
- 其它要点：候选窗要么用系统预定义的 `ITfCandidateListUIElement`（UILess 下由宿主代绘，还免了自己跟随光标），要么自绘——而官方要求**支持 UIELEMENT 的 TIP 必须经 `ITfUIElementMgr` 展示一切 UI**；另外要留意 Win11 把候选窗搬到了 `TextInputHost.exe`，自绘候选的观感会和系统不一致。
- 现成的参照实现就是成熟输入法本身：**`SampleIME`（最好读的官方骨架）> 小狼毫的 `WeaselTSF/`（生产级，注册与 UILess 可直接抄）> PIME（「TSF DLL + 外部后端进程」的分层范例）> `khiin-rs`（Rust 实现）**。
- 好处也是独一份的：**任何程序**（含 UWP / WinUI / 商店应用）的**任何输入框**都能用；能进系统语言栏、能被切换、组字有系统级支持。<br>**顺带纠正两个常见误解**：`InputPane` 只管「键盘挡住了多少屏幕」，**不负责送字**；`CoreTextEditContext` 是给**自绘文本控件接入输入栈**用的，**不是外部注入通道**。

---

## 4. 中文输入引擎：先想清楚「要不要自己带引擎」

三个层次，工作量差一个数量级：

1. **不要引擎（推荐起步）**：候选由**自己写的小词库**给（几百个常用词 + 拼音表），或者干脆只做「英文 + 数字 + 符号」，中文留到下一阶段。**这是唯一能在几天内看到东西的路**，也是 P0 / P1 应该选的。
2. **借系统输入法**（第 3 节的路线 B）：零引擎代码，但候选状态不透明（见上）。
3. **自带引擎**：就绕不开 **librime**。生态现状（crates.io 实查）：
   - `rime-api` 0.12.2 —— librime `rime_api.h` 的 Rust 包装，仓库 `bczhc/librime-rs`，**最后更新 2024-09**，下载量 1.8 万；
   - `rime_api-sys` 0.3.1 —— FFI 绑定，**最后更新 2023-02**。
   - 结论：**绑定存在但偏旧**，真要上要么接受它、要么自己维护一份 FFI；此外还要**打包 librime 的动态库 + 词库数据**（体积按方案从几 MB 到几十 MB 不等）。
   - 注意区分：`pinyin` 这类 crate 是「汉字 → 拼音」的**单向**转换（给索引 / 注音用的），**不能**做「拼音 → 候选汉字」，别选错。
   - 另有较新的纯 Rust 尝试（如 `inputx-pinyin`，自称输入法引擎，含分词与模糊音，2026-05 更新），但下载量很小、未经大规模验证，只能当备选。

**我的建议**：中文引擎**放到第三阶段**，而且优先「用户自己装了 Rime / 微软拼音就用系统的」（路线 B），把「自带引擎」当成一个可选档位。

---

## 5. 工作量估算（按本仓库的实际尺度）

参照物：本仓库 `src-tauri/src/files.rs` 3111 行、`toolbox.rs` 2816 行、前端共约 1.9 万行。一个「三个阶段都能用」的功能模块，在这里大致是 1000–2500 行的量级。

| 阶段 | 内容 | 估工 | 风险 |
| --- | --- | --- | --- |
| **P0** 启动器内键盘 | 全键盘 UI + 中英切换按钮 + 走路线 A 只注入**自己**的窗口（其实连注入都不用，就是改 React 输入框的值）+ 手柄轮询改 Rust 侧 | **3–5 人日** | 低 |
| **P1** 悬浮键盘 | 新建不可聚焦置顶窗口（`set_focusable(false)` + `always_on_top` + 无边框）、手柄轮询与启动器手柄仲裁、`GetForegroundWindow` 记忆与恢复、注入降级链（路线 A → A+ → 剪贴板）、英文 + 符号 + 数字 | **7–12 人日** | **中高**：WebView2 在不可激活窗口里的输入表现要真机验；游戏内成功率天生有限 |
| **P2** 中文候选 | 拼音表 + 小词库 + 候选条 UI + 翻页 / 选字的手柄映射；或接系统输入法（路线 B） | **5–10 人日** | 中：候选排序与手感要反复调；想「好用」会显著超出这个数 |
| **P3** 真输入法（可选） | TSF 文本服务 DLL、注册与安装、候选窗、x64/x86 | **20–40 人日** | 高：COM/TSF 学习曲线 + 部署与杀软误报（**裸代码量 5–8k 行**，且 C++ 而非 Rust） |

**合计**：
- 只做「启动器自己能用手柄打中英文」：**约 1 周**，低风险。
- 做到「任何程序里都能打中英文」：**约 3–5 周**，且有一处必须先验证的技术风险（见下）。
- 做到「系统级输入法」：**1.5–3 个月**，且是另一个量级的工程。

---

## 6. 必须先验证的一件事（决定 P1 能不能按计划走）

**在 `WS_EX_NOACTIVATE`（`focusable: false`）的 Tauri 窗口里，WebView2 能不能正常收到指针与键盘事件？**

- 官方文档只保证「点击不会把窗口变成前台」，**没有**承诺 WebView2 内部仍能正常处理输入。
- 已知的相关坑：`WS_EX_NOACTIVATE` 的窗口在某些情况下「还是会被激活」（[Raymond Chen, 2024](https://infocon.org/mirrors/vx%20underground%20-%202025%20June/Archive/The%20Old%20New%20Thing/2024/2024-09-19%20-%20My%20window%20has%20the%20WS_EX_NOACTIVATE%20extended%20style%20but%20it%20got%20activated%20anyway.pdf)）；Wails 也有过 `WS_EX_NOACTIVATE` 与 `WS_EX_TOOLWINDOW` 组合导致的点击穿透问题（[wails PR #5371](https://github.com/wailsapp/wails/pull/5371)）。
- **验证方法**（半天的事）：一个最小 Tauri 窗口，`focusable: false` + `always_on_top: true`，里面放一排按钮，开一个记事本在它前面；用**鼠标点按钮**看能不能触发、用**手柄**看 Rust 侧轮询能不能收到。这一步过了，P1 才有意义。
- **如果过不了**，退路有三条：① 键盘不用 WebView，改用 Rust 侧原生窗口自绘（放弃 React 复用，工程量上升）；② 让键盘窗口**短暂抢焦点**再还回去（每次按键闪一下焦点，注入前把焦点 `SetForegroundWindow` 还回去——延迟与闪烁都难看，但能跑）；③ 键盘做成启动器**自己全屏窗口**的一部分，只在启动器内用（回到 P0 的范围，但失去了「任何程序里都能打字」）。

---

## 7. 已知的天花板与边界（先说清楚，免得做完了失望）

**逐类目标程序的现实预期**（这是「做完到底能用在哪」的答案）：

| 目标程序 | 路线 A（`SendInput`） | 路线 A+（消息直投） | 路线 C（TSF） |
| --- | --- | --- | --- |
| 记事本（经典 Win32 编辑框） | ✅ | ✅ | ✅ |
| 记事本（Win11 新版，已 WinUI 化） | ✅ | ❌ 取不到 `Edit` 子窗口 | ✅ |
| 浏览器 / Electron / CEF（含 **Steam 客户端**） | ✅ | ❌ 没有原生编辑子窗口 | ✅ |
| 设置类 Win32 对话框、开始菜单搜索 | ✅ | 视控件而定 | ✅ |
| **WinUI 3 / UWP 商店应用** | ✅ | ❌ 无子 HWND，消息被丢弃 | ✅ |
| **以管理员运行的程序** | ❌ 静默失败 | ✅（靠 `< WM_USER` 豁免） | ✅（随宿主完整性级别） |
| **独占全屏游戏** | ❌ | ❌ | ⚠️ 只有实现 UILess 才可能（官方明说 UILess 就是为游戏/全屏应用准备的） |
| 带内核反作弊的联机游戏 | ❌ | ❌ | ⚠️ 可能被判异常，需单独评估 |

**另外三条边界**：

1. **别指望干掉系统输入法**：路线 A / A+ / C 是叠加关系，不是替代关系。用户自己装了 Rime、微软拼音的场景，路线 B（借系统输入法）反而最舒服。**现实做法就是排一条降级链**，而不是赌某一条路全知全能。
2. **路线 A 的失败是静默的**（UIPI 拦截时 `GetLastError` 与返回值都不报错），所以**日志必须自己造**：注入前记录「目标进程名 + 完整性级别 + 走的哪条降级路」。
3. **本仓库自己会提权**（工具箱要装驱动 / 运行库）。「提权的启动器 → 普通目标」和「普通键盘进程 → 提权目标」是两种不同的组合，第二类才是会失败的那个；设计时最好让**键盘与注入走一个不提权的常驻进程**，把提权只留在装驱动那一步。

---

## 8. 建议的落地顺序

1. **先做 P0**（启动器内全键盘 + 中英 + 数字符号）。这一步不依赖任何 Windows 注入，纯前端 + 手柄轮询，**能立刻把「搜索 / 批量重命名 / 新建文件名只能借系统键盘」这条欠账还掉**，而且是后续所有工作的地基（键盘 UI、候选条、手柄映射全在这里定型）。
2. **再做焦点验证**（第 6 节那半天）。这是 P1 的 go / no-go 闸门，**先花半天，别先花两周**。
3. **然后 P1**：不可聚焦悬浮窗 + 路线 A 注入，只保证「英文 + 数字 + 符号 + 已选定的汉字」。
4. **最后 P2**：中文候选。优先路线 B（借系统输入法），把自带引擎当可选档。
5. **P3（TSF）只在出现真实需求时做**——比如「必须进系统语言栏」或「必须在 UWP / 商店应用里可用」。

---

## 9. 参考来源

- [KEYBDINPUT 结构（`KEYEVENTF_UNICODE` / `VK_PACKET` / 前台线程）](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
- [INPUT 结构（`KEYEVENTF_UNICODE` 的用途说明）](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-input)
- [SendInput（UIPI 只允许同级或更低完整性级别；**拦截时静默失败**；触摸键盘用 winnls.h 代理宏）](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [ChangeWindowMessageFilterEx（**值小于 `WM_USER` 的消息强制放行**）](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-changewindowmessagefilterex)
- [Extended Window Styles（`WS_EX_NOACTIVATE` 定义）](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)
- [UILess Mode Overview（TIP 在游戏 / 全屏应用下的 UILess 要求；`ITfTextInputProcessorEx` 必需；`ITfCandidateListUIElement`）](https://learn.microsoft.com/en-us/windows/win32/tsf/uiless-mode-overview)
- [Text Services Framework 总览](https://learn.microsoft.com/en-us/windows/win32/tsf/text-services-framework)
- [Text Service Registration（`ITfInputProcessorProfiles::Register` / `AddLanguageProfile` / `ITfCategoryMgr`）](https://learn.microsoft.com/en-us/windows/win32/tsf/text-service-registration)
- [WinApp CLI：UI Automation 写入降级链（`ValuePattern` → `RangeValuePattern` → `LegacyIAccessible`；WinUI3 `RichEditBox` 与 WPF `RichTextBox` 不支持程序化写入）](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation)
- [Windows 11 OSK 基础设施（`textinputhost.exe` 通过 TSF 送字；现代 OSK 依赖 Explorer；`InputApp.exe` 已弃用）](https://learn.microsoft.com/en-nz/answers/questions/5856372/windows-11-osk-infrastructure)
- [Tauri `WebviewWindow`（`set_focusable`）](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewWindow.html)
- [Tauri PR #13564：webview window focusable 属性](https://github.com/tauri-apps/tauri/pull/13564)
- [SampleIME（最好读的官方 TSF 骨架）](https://github.com/ChineseInputMethod/SampleIME)
- [rime/weasel 的 `WeaselTSF/`（生产级 TSF 实现，代码量参照来源）](https://github.com/rime/weasel/tree/master/WeaselTSF)
- [PIME：TSF DLL + 外部后端进程的分层范例（双架构与安装目录要求）](https://github.com/EasyIME/PIME)
- [khiin-rs：Rust 写的 TSF 输入法](https://github.com/aiongg/khiin-rs)
- [librime 的 Rust 绑定 `rime-api`](https://crates.io/crates/rime-api) / [`rime_api-sys`](https://crates.io/crates/rime_api-sys)
- [DirectXInput：手柄 + 屏幕键盘的开源实现（可作 UI 参考）](https://github.com/dumbie/DirectXInput)
- [SteamlessKeyboard：脱离 Steam 的 Steam Controller 键盘](https://github.com/PietPetGit/SteamlessKeyboard)
- [Raymond Chen：带 `WS_EX_NOACTIVATE` 的窗口为什么还是被激活了](https://infocon.org/mirrors/vx%20underground%20-%202025%20June/Archive/The%20Old%20New%20Thing/2024/2024-09-19%20-%20My%20window%20has%20the%20WS_EX_NOACTIVATE%20extended%20style%20but%20it%20got%20activated%20anyway.pdf)

### 本仓库内的相关记录

- `src/hooks/useGamepadNav.ts`（802 行，手柄轮询 / 焦点 / 数字键盘状态机）
- `src/components/GamepadKeyboard.tsx`（现有数字键盘，54 行）
- `src-tauri/src/files.rs` 的 `files_show_keyboard()`（拉 `TabTip.exe` / `osk.exe`）
- `FUTURE.md` 功能 12「这一版仍缺：手柄上的文字输入」、功能 14 第 12 条「浮层代码已删空」
- `FRONTEND.md` §3 / §10（浮层焦点策略 `TAKE_FOCUS`、手柄归属仲裁）、§11（文件管理器）
