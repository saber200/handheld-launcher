# 进度对照（v0.1.57）

> **发布基准：`v0.1.0` 稳定版** — 内容与内部构建 0.1.38 一致（见 `v0.1.0` 标签 / `release/0.1.0` 分支）。
> `0.1.31`–`0.1.55` 均为测试版，仅内部验证用，不作为发布版。

对照「已经能用 / 刚改完待打包验证 / 还没做」。掌机请以最新 Release 为准。

**这一版（0.1.57）装了四条**：都是 0.1.56 装到掌机上之后提的第一轮真机反馈（文件夹不显示大小 / 下探文件夹后焦点跑到最上面 / 多选后换盘变全选 / Steam 游戏静默启动）。本机门禁全过、Windows CI 也绿、**已发布 `v0.1.57`**（两个安装包挂在 Releases），但**真机一次都没装**，细则见下面「0.1.57 这一版（一）」。

**上一版（0.1.56）装了四件事**（下面「0.1.56 这一版」四节是那一版的内容，除文件管理器外都是 0.1.55 之后积压的）：① 文件管理器深度优化（功能 12 三批）；② 独立前端改成 Game Bar 小组件后台（**首次随包装出去**）；③ 驱动状态与窗口快照诊断补充；④ 输入链路与显示调度修正。这些**都没在真机上验过**，验证边界各节末尾都写了。

## 未发布（下一版）：小组件删掉「自启」行；设置页那行改名「安装前端」（2026-10-04，用户要求）

用户提的两条，都不动 Rust、也没验过真机。

- 小组件不再有自启开关：原来那行只在 UWP 本地设置里记一个 `disableAutostartRequested` 意图，真实自启是启动器的计划任务，小组件根本改不了 —— 用户原话「那个没用，不需要」。删掉的东西：`WidgetPage.xaml` 里整张卡片、`WidgetPage.xaml.cs` 的文案赋值与 `StartupClick`、`Strings.cs` 的 `Startup` / `StartupHint`；`using Windows.Storage;` 一并去掉（那两行是它在这个文件仅有的用处）；契约文档 `frontend/gamebar/HANDOFF.txt` 第 67 行同步改写。启动器自己设置页的「开机自启」（Rust `set_autostart` + 托盘开关）不受影响。
- 启动器设置页里装小组件那行改叫「**安装前端**」（英文 `Install frontend`），提示改成「前端界面就是 Game Bar 小组件；随启动器自动装，点这里重装一次」，预览提示里的「小组件」也改成「前端」—— 原来的「装 Game Bar 小组件」用户看不出是装什么。名字和工具箱那张「前端（独立程序）」卡片（装的是托盘常驻的后台 exe）有重叠，按用户要求就这么叫。
- 本机验证：`python3 frontend/gamebar/check-static.py` PASS（XAML 里 6 条事件处理器的名字都能在 `.cs` 里找到 —— 删掉 `StartupClick` 后没有悬空事件）；`npm run build` 通过。**C# / XAML 的真编只能靠 CI 的 `gamebar.yml`（本机 macOS 编不了），且这一版还没发。**

## 0.1.57 这一版（一）：装了 0.1.56 之后提的第一轮真机反馈（4 条）

本机全改完了（`npm run build` / `cargo clippy --workspace --all-targets` / `cargo test -p handheld-launcher --lib` 30 项全过），**Windows 上 CI 已真编过（见下面「状态」），但真机一次都没装** —— 0.1.56 就是「CI 全绿、装到掌机上才发现问题」，要装 0.1.57 的包复测。

- **状态：已随 `v0.1.57` 发布（2026-10-04）**。CI 三项全绿：**Lint**（`windows-latest`，`cargo clippy --workspace --all-targets --locked`）—— 这一关是**真的在 Windows 上编过**（本机 macOS 编不到 Windows 专属代码，Steam 那条新代码就是靠它验的类型，见下面第 4 条的边界写法）；**Game Bar (Windows)** 产出 `FantasyHub.GameBar.Widget_0.1.57.0_x64_Debug.msix`（`Package.appxmanifest` 那处手改的版本号确实生效了）；**Build Windows** 两个作业（`gamebar-payload` + `windows`）都 success，Release 里两个包齐了 —— 启动器 `FantasyHub_0.1.57_x64-setup.exe` **30.28 MB**（>7.8 MB 说明小组件 payload 带上了）与前端 `FantasyHubFrontend_0.1.57_x64-setup.exe` 3.19 MB。**装到掌机上这一步还没做。**

1. **文件夹不显示大小** → 新增 `file_dir_sizes`（见「0.1.56 这一版（一）」里的同名命令）：一次算一屏**直接**子文件夹的大小，所有子文件夹**共用 3 秒预算**、可取消、跳过 junction / 符号链接（跟进去可能指回自己、重复计入）；前端按**路径**缓存 60 秒（左右两栏共用），换目录立刻 `file_cancel` 掉上一批；没轮到的先写「文件夹」，算不完写「≥ x」（和属性面板一个口径，不装成准数）；「按大小排序」也改用这份数字，所以文件夹之间也能按大小排了。**「此电脑」那屏的盘符不算**（要扫整块盘，会长时间占着后台线程）。
2. **下探文件夹后焦点跑到最上面的「显示模式」** → 根因是**新目录的文件是异步读回来的**：换目录那一帧列表上还是上一级的行，自动聚焦把焦点落在一行马上要被删掉的旧行上；新行到位后旧行被删，焦点掉回 `body`，手柄下一次按方向键就从这个空白点重新找 —— 正好命中页面第一个按钮（显示模式）。修法：给每一栏加「这一栏现在显示的是哪一批行」的指纹（`rowsToken`，用**未排序**的行路径算，所以点排序键不会误触发聚焦），指纹变了才重新安顿焦点（第一行 / `pendingFocus` 指定的那行）；顺带「返回上一级」把焦点落回**刚出来的那个文件夹**，不再每次从第一行重新往下按。
3. **多选后换盘符会变成全选、而且一直保持多选状态** → 两个独立的坑：① Y 菜单那一项**写着「取消全选」、动作却是「全选」**（标签和动作相反），现在拆成「全选」「取消全选」两个各说各的，工具栏那颗按「有没有选中」换标签；② 换目录只清空选中、**没有退出选择模式**，于是新目录第一行被自动聚焦顺手选上，A 也不再是打开（用户以为文件打不开了）。现在换目录在**导航那一刻**（`setLocation` 之前，同步）清选中并退出选择模式 —— 等 `useEffect` 会晚一帧，那一帧正好够自动聚焦选中第一行。
4. **Steam 游戏改成静默启动（不弹 Steam 窗口）** → 以前一律把 `steam://rungameid/<appid>` 交给 shell，Steam 没在跑时会先把主窗口（没登录时还有登录框）弹到前台 —— 掌机上就是「点了游戏先跳出 Steam」。现在先找 `steam.exe`（注册表 `SteamExe` / `SteamPath` / `InstallPath` 三条 + 两个默认安装路径，且文件**必须真的存在、名字必须就是 `steam.exe`**），用 `steam.exe -silent -applaunch <appid>` 起；**找不到客户端或起不来才退回协议地址**（宁可弹一次窗口，也不能点了没反应）。appid 的校验抽成 `steam_appid`（它要拼进命令行，非数字一律不收），`protocol_url` 复用它，原有行为与用例不变。
   - **边界（真机上按这个口径看）**：`-silent` 只在「Steam 启动那一刻」有效。客户端**已经开着**主窗口时，这次调用等于给它发一条 applaunch，那个窗口该开着还开着 —— 我们**不强行最小化**它：那时弹出来的可能是登录框或更新提示，藏起来比多一个窗口更让人摸不着头脑。要「连已开的窗口也收起来」得另说（那属于对用户窗口动手）。
   - 两条纯函数用例（`steam_silent_args` / `pick_steam_exe`）：Windows 那半边本机编不了，`-silent` 被顺手删掉、或者挑错一个 exe，都没人看得出来，所以把「开关」和「挑 `steam.exe`」都抽成纯函数在本机盯住。

## 0.1.56 这一版（一）：文件管理器深度优化（`FUTURE.md` 功能 12，三批全做）

把「能用」做到「手柄上真的好用」。后端 `files.rs` 从 11 个命令扩到 17 个（`file_dir_sizes` 是发布后补的、随 0.1.57 走，现在一共 18 个），文件页整体重做。

- **状态：已随 `v0.1.56` 发布（2026-10-04）** —— Windows CI 的 Lint（clippy + 测试）与打包全绿，两个安装包已挂在 Releases。**但一次真机都没跑过**，下面写的都是本机与 CI 能证明的部分。

- **传输引擎（这批最要紧）**：`file_transfer` 分块复制（1 MiB）+ 每 100 ms 进度事件 + 随时可取消，命令**立刻返回**、活儿在独立线程 —— 原来的 `file_copy` / `file_move` 要等整个复制完才回话，拷一个 20 GB 游戏时前端连取消键都按不动（和 0.1.44 修过的是同一类卡死）。同名三选一（覆盖 / 跳过 / 保留两者，默认保留两者）；跨盘移动才退化成「先整份复制成功，再删源」；写目标先落 `.fantasyhub-part` 再改名，取消 / 断电不会留下顶着正式名字的半成品。
- **失败给原因**：新增 `FileError { reason, message }`，`reason` 是机器码（`denied` / `busy` / `space` / `toolong` / `missing` / `exists` / `name` / `rule` / `cancelled`），前端据此给「先关掉占用它的程序」「以管理员身份重开 FantasyHub」这类**具体**建议，而不是笼统一句失败。
- **新增命令**：`file_rename`（只改名不搬家）、`file_rename_many`（先全改临时名再落地 —— `1.txt` 和 `2.txt` 对调这种互相占位的换名才做得成；发现冲突整体拒绝，不做一半）、`file_properties`（大小 / 时间 / 只读 / **真的能不能写** / 系统目录提示）、`file_search`（可取消，深度 6 层、300 条、15 秒封顶）、`file_dir_sizes`（**发布后补的**：一次算一屏文件夹的大小，所有子文件夹共用 3 秒预算、可取消、不跟进链接）、`file_cancel`。前端文件夹那列因此是「后台补上来的数字」：没算出来先写「文件夹」，算不完写「≥ x」（和属性面板一个口径，不装成准数）。
- **前端**：可点面包屑；常用位置（桌面 / 下载 / 文档 / 图片 / 音乐 / 视频 / 用户文件夹 / 盘符）；排序（名称 / 大小 / 时间 / 类型，再按同一个键换升降序）；**选择模式 + 区间选择**（X 进入，之后移动焦点就选上）；Y 菜单（打开 / 编辑 / 复制 / 剪切 / 粘贴 / 重命名 / 批量重命名 / 删除 / 属性 / 全选）；进度条 + 取消；**双栏**（左源右目标，LT / RT 换栏，Y 里直接「复制 / 移动到另一栏」）；鼠标拖到文件夹即移动；搜索面板（A 跳到结果所在目录）与属性面板。
- **验证到哪一步（这一版发布那轮）**：本机 `cargo test -p handheld-launcher --lib` **26 个用例全过**（传输进度与字节数、三种同名策略、取消不留半截文件、批量换名与冲突、错误码映射）；`cargo clippy --workspace --all-targets` 无新警告；`npm run build`（tsc + vite）通过。传输引擎的进度改成**注入的 sink**，所以这些最容易出人命的路径在 macOS 上就能断言。发布后又加了文件页的文件夹大小 2 项、Steam 静默启动 2 项，现在一共 30 项（见「0.1.57 这一版（一）」）。
- **没验证的**：文件页整个没在 Windows 上跑过（本机只过了类型检查与构建）；**搜索 / 批量重命名的输入框要用系统键盘**（手柄没有文字输入，现有的数字键盘只够数字），真机才知道这条路够不够用；缩略图、复制到受保护目录的「一键提权重启」这一版没做（只在属性面板给提示）。
- **真机第一轮反馈（2026-10-04，用户装了这一版之后提的四条）**：四条都已改，随 `v0.1.57` 一起发，逐条细则见开头「0.1.57 这一版（一）」（三条文件页的 + Steam 静默启动）。
- 权限：6 个新命令都在 `src-tauri/permissions/files.toml` + `capabilities/default.json` 里登记 —— 漏一个就是运行期被拒，本机测不出来。

## 0.1.56 这一版（二）：独立前端转为 Game Bar 小组件后台（**本版首次随包发出去**，未验证）

- 独立前端不再创建窗口/WebView，界面交给 Xbox Game Bar 小组件：`frontend/gamebar` 是原生 UWP C#/XAML 小组件（`microsoft.gameBarUIExtension`）+ **同包全信任**的 Bridge。小组件经同包 AppService 把请求交给 Bridge，Bridge 现读 `%APPDATA%\handheld-launcher\widget-ipc.json` 并加 token 连回环 —— token 不进 UWP。前端进程只剩托盘 + 回环监听 + 更新握手，`main.rs` 不再 `mod overlay / chord / shot / topmost / library / games`。
- 顺手补一个契约缺口：`status` 响应缺 `locale`，小组件因此读不到语言（`set_locale` 只影响当次会话），已补。
- 本机验证：工作区 Clippy 退出 0；`python3 frontend/gamebar/check-static.py` PASS（XML/PNG/WAV/XAML handler/工程输入/NuGet 版本）。
- **CI 真编已过关（2026-10-03，`windows-2022`）**：Bridge 与 Widget 的 C# + XAML 都 `Build succeeded`，产出 `FantasyHub.GameBar.Widget_0.1.55.0_x64_Debug.msix`（31 个条目 / 10.6 MB）：`Bridge/FantasyHub.GameBar.Bridge.exe` + `.exe.config` 落在 `Bridge\`，`Assets\*.png`(4)、`Assets\Sounds\*.wav`(9)、`GameBar\index.txt`、`Properties\Default.rd.xml` 各一份且无重复。这一次真编暴露并修掉了一个只有 Windows 才能看见的打包错误（首次运行 `63414f7` 报 15 个 `APPX1111`：csproj 在 target 里对 `Content` 写了未限定的 `%(...)`，详见 `frontend/gamebar/Widget/FantasyHub.GameBar.Widget.csproj` 的注释），修完 `65728b6` 转绿 0 error。**本版（0.1.56）清单已改成 `0.1.56.0`，下次构建产出的包名随之变成 `FantasyHub.GameBar.Widget_0.1.56.0_x64_Debug.msix`。**

- **发布结果（2026-10-04，标签 `v0.1.56`）**：`gamebar-payload` 与 `windows` 两个作业都 success，Release 里两个安装包齐了 —— `FantasyHub_0.1.56_x64-setup.exe` **30.27 MB**（这个体积本身就是「小组件 payload 带上了」的判据：漏了会掉到约 7.8 MB，见上面 `continue-on-error` 那条教训）、`FantasyHubFrontend_0.1.56_x64-setup.exe` 3.19 MB。**装到掌机上这一步还没做。**
- **仍未验证**：包没签名（`AppxPackageSigningEnabled=false`，产物是 `_Test` 侧载目录）、没装过、没在真机跑过；Game Bar 里能否显示小组件、同包 AppService 能否通到 Bridge、以及 Rust↔C# 联调全部未做。另有 MSB3245 警告说 `System.Runtime.WindowsRuntime` 没被旧式解析器找到（csc 用了 NuGet 的 ref 副本，编译过；该程序集没进包，运行期是否够用未知）。
- 新增 `.github/workflows/gamebar.yml`（钉 `windows-2022`：工程要 SDK 10.0.22621.0，`windows-latest` 只有 26100）：静态检查是硬闸门；Debug 真编在 `65728b6` 首次全绿（`check-static.py` + 0 error 的 msix），**2026-10-03 已转硬闸门**（删掉 `continue-on-error`，见下面那条代价昂贵的教训）。
- **`continue-on-error` 的代价（2026-10-03，本轮）**：第三轮界面改动给 `Grid` 写了 `IsEnabled="False"`（`Grid` 是 `Panel`，UWP 的 `IsEnabled` 在 `Control` 上，只有 WPF 放在 `UIElement`），CI 报 `XamlCompiler WMC0011: Unknown member 'IsEnabled' on element 'Grid'`；可这一步带着 `continue-on-error`，作业照样报 **success**，于是 `Build Windows` 打出来的启动器包**整块少了小组件** —— 体积从 30.22 MB 掉到 7.8 MB，release 里也只有一条成功记录。**症状与根因**：安装包体积是「payload 有没有带上」的可靠信号（差 ~22 MB 就是 msix + 三个框架依赖）；`gamebar-payload` 作业上传的 artifact 大小同样能一眼看出来（正常十几 MB，空转时只有 885 字节）。**教训写进 workflow 注释**：带 `continue-on-error` 的构建步骤，绿颜色什么都说明不了；判断小组件到底编没编，得在日志里找 `Build succeeded` / `error WMC|CS|XLS`，或者看安装包体积。已改为硬闸门，并且 `SetPresetsEnabled` 改成逐个按钮设 `IsEnabled`（容器只负责变暗）。
- **尚未闭环**：~~Bridge 白名单没有 `set_autostart`，小组件的「自启」只存本地意图并提示手动关，不能称迁移完成~~ —— 2026-10-04 按用户要求把小组件那行自启**整行删掉**了（见开头「未发布（下一版）」一节），白名单里始终没有 `set_autostart` 也就不再有出口；旧界面代码（`overlay/chord/shot/topmost/library/games`、`src/frontend/*`、`frontend.html`）已接不上但全部保留，等真机验证后单独一次提交清理。
- 版本号多了第 6 处：`frontend/gamebar/Widget/Package.appxmanifest` 的 `Identity Version`（四段，如本版的 `0.1.56.0`），不在原五处联动里，发版必须手动跟上。
- **小组件改成「随启动器一起装」（本轮新做，未验证）**：CI 现打一张自签证书给 msix 签名，把「msix + 证书 + 三个框架依赖」摆进 `src-tauri/payload/gamebar/`，由启动器安装包带上；装的时候 NSIS 钩子跑一行等价命令、启动器每次启动再幂等补一次（`src-tauri/gamebar/register-widget.ps1`），设置页也加了「装 Game Bar 小组件」（2026-10-04 改名「安装前端」，见开头「未发布（下一版）」一节）。证书只进当前用户「受信任人」，所以目标机**不需要管理员、也不需要开发者模式**。没在真机验证：普通机器能否装上、Game Bar 重启后能否立刻看到、CI 的 `signtool verify /pa` 是否稳定。
- **真机第一轮（2026-10-03，x64 掌机，安装包 28.28 MiB）：证书这条路是通的，栽在依赖架构上**。启动器装上了，小组件没出现在 Win+G；`%APPDATA%\handheld-launcher\widget-last-error.txt` 给出根因：随包的 `Microsoft.NET.CoreRuntime.2.2` 与 `Microsoft.NET.CoreFramework.Debug.2.2` 是 **ARM 版**，`Add-AppxPackage` 报 `0x80073D10 此程序包需要体系结构 ARM，但此计算机是 x64`，紧接着小组件报 `0x80073CF3 找不到框架`。原因：MSBuild 的 `Dependencies\` 下 x64/ARM/ARM64 三份**同名**共存，而这两个包的文件名里不带架构，`package-payload.ps1` 按名字取第一个命中了 ARM（`Microsoft.VCLibs.x64.Debug.14.00.appx` 的名字自带 x64，所以只有它一直是对的 —— 这正好解释了为什么只有那两个包报错）。已改成读每个候选包内 `AppxManifest.xml` 的 `Identity/ProcessorArchitecture`，只收 x64/neutral，找不到 x64 就带着候选架构列表报错，另外每带一个依赖打一行 `arch=`、并把小组件清单声明的依赖一并打出来；`register-widget.ps1` 装依赖前也先比架构，不一致直接点名是 payload 带错了。**同一轮确认**：`Import-Certificate` 进当前用户「受信任人」成功、AppxDeployment 正常处理我们签的包，所以「不需要开发者模式、不需要管理员」这个前提成立；仍未验证的是 Game Bar 重启后是否立刻枚举到、以及 Debug 框架包会不会和目标机已装版本打架。

- 小组件 payload 由 `build-windows.yml` 新增的 `gamebar-payload` 作业（`windows-2022`）产出、以 artifact 交给主作业；主作业带 `if: always()`，**小组件编挂了照样发版**（资源路径上有 0 字节占位兜底，那个安装包只是不带小组件）。`gamebar.yml` 同样传一份 artifact，方便单独下载验证。
- **真机第二轮（2026-10-03，30.22 MB 启动器包）**：修复架构筛选后，小组件**已经能在 Win+G 里看到并打开** —— 第一轮的 `0x80073D10 需要 ARM` 与 `0x80073CF3 找不到框架`都没再出现。仍待验证：AppService→Bridge→Rust 往返、pin 后常驻表现、Game Bar 重启后枚举新小组件的时延。
- **小组件界面按原前端重做（本轮，未在 Windows 编译）**：原来是一堆裸控件（系统默认字号 + 系统蓝高亮），现按 `src/styles/global.css` 的 `:root` 变量对齐 —— `#0b1220→#121c2e` 对角渐变背景、圆角 16 卡片、28px 标题 + 胶囊工具按钮、预设 3 列网格、选中态 accent `#3dd6c6` 底 + 深字 `#06241f`。手段是**覆盖主题资源键**（`ToggleButton*`/`Slider*`）而不是重写控件模板：键名写错只是不生效，不会让 XAML 解析失败，风险最低。`Presets` 从「GridView 的选中项」换成 `PresetOption` 对象列表（`Models.cs`），因为容器选中态改不了内部文字颜色；`On` 的 setter **无条件**发通知，否则连点同一个预设时按钮会停在 ToggleButton 自己翻出来的错误状态上。清单磁贴底色也从 `#172030` 改成 `#0b1220` 与界面统一。本机只过了 `check-static.py`（PASS：XML=8、PNG=4、WAV=4、XAML handlers=8）。
- **第三轮：真机反馈后的界面修正（本轮，未在 Windows 编译）**。用户上手后的三条硬反馈逐条定位：① **预设按钮太小、文字被裁** —— 根因是 `GridView` 的 `ItemsWrapGrid` 给每项的宽度是「集合里最宽那项的期望宽度」，**不是容器三等分**：真机照片量过，卡片内宽约 384 逻辑像素，三个按钮只占了 168，右侧一大片空白，`10W` 的尾笔被裁得看着像 `10V`。改成**代码生成的 3 列 `Grid`**（列宽 `*`、行 `Auto`，`SyncPresets` 里建 `ToggleButton`），预设字号 16→18、高 44→56；`PresetOption`（上一轮为绑定而加的类）随之从 `Models.cs` 删除 —— 现在直接写 `button.IsChecked`，「连点同一个预设要复位」的语义比原来更直白（不必再给 `On` 无条件发通知）。② 头部按钮 `CornerRadius` 999（胶囊）→ 10（方块 + 小圆角），`MinHeight` 44、字号 14→16：用户要的就是方块，胶囊在这块面板里像两个大椭圆。③ 焦点视觉统一成 accent（`FocusVisualPrimaryBrush` + `FocusVisualSecondaryBrush=Transparent`）：系统默认是白色高对比框，和 checked 的 accent 底同时出现，真机照片里看着像「两个预设同时被选中」（原前端 `[data-focusable]:focus` 本来就是 accent 描边）。顺带收口：覆盖 `Button*` 主题键（UWP 默认模板的 hover/pressed/disabled 直接刷 `ContentPresenter`，Style 里设的 `Background` 会被盖掉 —— 真机照片里那条发亮的灰横条就是被禁用的「风扇控制 · 暂未开放」）、`ComboBox*` 主题键，正文小字各放大 1px，并去掉上一轮我额外加的 `Opacity 0.75/0.7`（原前端没有这一项，真机上那几行灰得看不清）。本机过了 `check-static.py`（PASS）与 XML 良构检查。另外把卡片里那行「CPU · vendor · backend」改回原前端的写法：**只显示 CPU 名**，拿不到才回退显示 vendor/backend（真机那行「Intel(R) Arc(TM) G3 Extreme · intel · intel-msr」一眼就不是原版的样子）。
- **常驻（pin）的机制结论**：Game Bar 只有「小组件」这一种扩展形态（官方 overview 原话是 widget = 渲染进 Game Bar UI 的 UWP XAML 视图），微星那类厂商面板同样是 widget —— 能不能常驻取决于清单里的 `<PinningSupported>true</PinningSupported>`（**我们已开**），剩下那一下只能由用户在小组件菜单里点图钉。`Microsoft.Gaming.XboxGameBar.winmd` 里只有 `Pinned`/`PinnedChanged`/`PinningSupported`/`get_Pinned`，**没有 `Pin()`/`Unpin()`**，所以程序无法自动固定。这条是从 SDK 元数据（`nuget` 包里的 winmd，`strings` 查符号）得出的，不是猜的。
- 第一次真跑 CI 就挂住：想让自签证书通过 `signtool verify /pa` 就得把根写进 Root 信任存储，而往 Root 写证书（`Import-Certificate` / `X509Store.Add` 同一个底层 API）会弹确认框，CI 上没人点 → 那一步永久挂着（实测卡十几分钟只能人工取消）。已改成 **CI 不建立信任 + `-SkipVerify` 跳过链验证**，签名有效性交给目标机安装时校验；脚本加了 `==> n/6` 分步日志用于定位。坑记在 FRONTEND.md。

## 已归档（0.1.56 起没有验证对象）：普通应用窗口显示候选

- 独立前端取消隐藏任务栏，呼出时清除工具窗样式、设置普通应用样式；保留原有置顶调用，不增加重试，不改变独立生命周期。显示期间进入任务栏/Alt+Tab 是本候选的预期变化。
- 此改动用于验证 FSE 的应用筛选是否影响前端显示，并非已定位根因。未改私有窗口带、系统 FSE 模式或启动器全屏策略。
- 本机网页构建、工作区 Clippy 和差异检查通过（已有 dead_code 警告）。Windows CI、安装包和 FSE/桌面实屏对照尚未完成，未提交、推送、升版，不宣称修复成功。
- **本节的窗口已由上一节取代**：前端不再创建窗口，`topmost.rs` 也不再被 `main.rs` 引用，此候选已无验证对象，仅作判据留档。

## 0.1.56 这一版（三）：驱动状态与窗口快照诊断补充

- 最新掌机反馈仍失败，不能用可见位、前台或 GDI 截图认定物理上屏。截图时序早于页面接收显示代数；驱动状态为空时的旧默认提示也会说“启动器没运行”，尚无证据认定 TDP 通信失败。
- 已区分驱动加载态与真实错误，增加前端驱动请求结果/耗时日志；窗口快照补客户区、DWM 框架、普通样式及 DPI，保留现有显示策略和生命周期。
- 本轮网页构建、工作区 Clippy、差异检查通过，存在已有 dead_code 警告。Windows 新增分支尚待 CI；未提交、推送或打包，FSE 根因和真机可见性仍未闭环。

## 0.1.56 这一版（四）：输入链路与显示调度修正

- 修正可复现的输入边界：触发手柄负责导航、断连回退、组合键完全释放后才重新触发；Start 单键不关闭。页面常驻监听、失败重试，监听恢复/换代/换控制者必须经过中性包，关闭入口可手柄聚焦。
- 本进程状态带显示代数，页面拒绝迟到查询；关闭与显示统一由 Rust 调度。后台抬升在主线程重新核验代数，避免关闭后旧重试复活；补限流的发送/注册/收包/动作/失败诊断。
- 验证：本机网页构建、工作区 Clippy、输入单测 8 项、库单测 20 项及差异检查通过（有 dead_code 警告）；真实前端组件内存模拟 25 个断言通过，不代表 WebView 或真实手柄验证。
- **尚未闭环**：Windows Lint、安装包构建及 FSE 真机可见性/操作未验证；没有可用的 Windows 远程执行入口，不以旧提交 CI 替代。FSE 肉眼不可见根因仍未确定，不据可见位/前台/截图反驳用户观察。保留独立生命周期、自启禁用意图、更新握手、托盘退出及受限 IPC；未推送或发布。

## 0.1.55 这一版（FSE 取证，不宣称修复）

- 用户已确认最新测试在 Xbox 全屏体验内。日志证明手柄触发、显示调用和窗口可见/置顶位成立，但用户仍看不见；截图不能反驳这一观察，根因仍未确定。
- 在开关决策前、任何定位/置顶/抢前台之前、显示后及短看护首尾新增只读快照：会话、窗口站、输入桌面、窗口线程桌面、DWM 遮蔽、显示器边界及相交 Z 序候选。记录毫秒时间、采样耗时和预期/实际代数；查不到记未知与错误，关闭后旧轮停止采样。
- 保留自启/禁用意图/更新握手/托盘退出/受限 IPC、手柄触发与窗口重试策略；新查询不切换桌面或显示模式，不增加置顶次数。同步诊断有耗时，不承诺时序完全不变。
- **纠正历史判读**：`on_top` 只是可见位与置顶样式；`above`/相交候选不等于确定遮挡，GDI 像素不等于 FSE 最终物理输出。下文旧版“已治好”“真的没被压住”等说法不作为本次结论。
- 验证：本机网页构建、工作区 Clippy、库单测（20 项）及差异检查已通过，存在原有 dead_code 警告；Windows Lint 和双安装包构建待该提交的 CI 验证，掌机可见性仍待真机取证。

## 0.1.54 这一版

本版集中修正自启状态、更新握手和文件操作反馈；下面是代码变更，不代表掌机实测已闭环。

- **前端自启**：通过 Task Scheduler COM 查询真实状态，区分任务缺失、禁用和查询失败。仅确认缺失才创建；已有任务迁移电池、空闲及超时限制，保留动作、主体、触发器及禁用状态。托盘操作读回确认，部分失败保留原目标供重试；旧 Run 和退出意图写入失败明确提示。
- **更新及启动入口**：更新退出请求按文件时间与进程启动时间区分新旧实例，避免安装后新前端被旧请求退出；后台第二实例不再自动显示浮层。启动器登录入口写入并读回成功后，才清理旧入口。
- **本地库与文件**：扫描共享在途请求及内存缓存，减少切页重复扫描，避免部分卸载后回写；保留复制、移动、删除的成功或部分失败提示；右键项不在选区时只操作该项。设置页移除“回到全屏”按钮。
- **合入已有加固**：本机 IPC 随机令牌、请求边界与退出清理，文件路径处理，以及所有已连接手柄触发组合键；第一只手柄仍负责界面导航。
- **验证边界**：本机网页构建、工作区 Clippy、库单测（20 项）及差异检查已通过，存在原有 dead_code 警告；Windows 编译以该提交的 GitHub Lint 和打包作业结果为准。本机交叉编译曾受工具链缺失阻断，不能代替 Windows 验证。
- **待真机验收**：电池登录/拔电、外部禁用任务及权限失败、旧任务迁移、更新后新实例驻留、FSE 浮层与手柄、TDP，以及文件交互。文件删除仍是永久删除；时间代际握手和同用户 IPC 权限边界未扩展，历史反馈尚未全部闭环。

## 0.1.53 这一版

0.1.52 那轮把「按 `Back+Start` 时前端根本不在」判出来了，而你补的两条现场观察把事情彻底定性 —— 也把这一版的方向全改了：

> 「桌面模式下前端可以正常启动唤出；在**全屏模式（FSE）**下无法唤出 —— 哪怕我已经在桌面模式把它启动了，再回到全屏模式一样无法唤醒；此时再切回桌面模式，就又可以了。」

- **结论一：FSE 会话里前端「不是被杀，是没被启动」。** 日志里我们自己的注册提示写着 `fse register: 已登记。请打开 Windows 设置 → 游戏 → Xbox 模式(全屏体验)，把主页应用选成「幻想枢纽」` —— 启动器是 **Win11「Xbox 模式（全屏体验）」的主页应用**，而那个会话里**没有桌面 shell（explorer）**。前端的开机自启用的是 **HKCU Run 键**，Run 键正是**由 explorer 在登录时处理**的 —— 于是 FSE 里它根本不会被执行。OneXConsole 那类厂商程序用的是**服务 / 计划任务**（任务计划程序拉起，不依赖 explorer），这就是它「死不了」的真正原因，不是它写了什么护身符。
- **结论二：你的第二条观察证明「前端其实活着」，只是浮层上不去。** 「桌面能、切到 FSE 不能、切回桌面又能」不可能发生在进程已死的情况下。日志里 10-01 那次测试把这个错演得很清楚：`frontend show end … is_visible=true` 紧跟一行 `frontend hide end … is_visible=false` —— 第二次按键把它**关掉**了，人却什么都没看见（0.1.33 记过的那条老账：全屏壳的前台锁让后台进程的 `show()` / `SetForegroundWindow` 静默失败，窗口永远压在壳下面）。
- **这一版改四条**：
  1. **自启改计划任务**（新模块 `crates/fh-core/src/autostart.rs`）：启动器启动时（前端装着、任务不在时）建一个名为 `FantasyHubFrontend` 的计划任务 —— 登录后延迟 10 秒、以当前用户、**不提权**运行 `FantasyHubFrontend.exe --autostart`；`MultipleInstances=IgnoreNew`；`ExecutionTimeLimit=PT0S`（**永不超时结束** —— 托盘常驻程序必须有这条，否则任务计划程序默认三天后把人结束掉）；`RestartOnFailure` 1 分钟 / 最多 2 次。于是：**崩溃或被杀会被拉回来，而托盘「退出前端」（exit code 0）不算失败、不会被重启** —— 「保命」和「尊重用户意图」用同一套机制拿到，不需要额外的开关。启动器的补启动也改成 `schtasks /run`（**普通权限**，不再继承启动器的管理员权限），并且这一轮登录里用户主动退过就不补启动（`frontend-stopped` 标记，下次登录由任务清掉）。托盘里的「开机自启」勾选框现在驱动这个任务，老的 HKCU Run 值顺手清掉（避免双启动）。
  2. **浮层开关追加置顶样式检查**（`frontend/src-tauri/src/overlay.rs::toggle`）：`visible && topmost::on_top` 才 hide。此判据不识别实际遮挡，不能保证第二次按键不隐藏肉眼不可见的窗口；0.1.55 补取证，不宣称修复。
  3. **大屏模式壳体常态让位**（`src-tauri/src/overlay_watch.rs`）：以前只在「看到浮层上屏」那一刻让位，现在 `enter_fullscreen` / 桌面模式切换会调 `set_big_screen()`，大屏模式里壳体**根本不进置顶层**（回到桌面模式按原样还回去）—— 浮层一出来就自然在上面，不用赌那 200 毫秒。前端侧同时补「最硬的一下」（`topmost::hard_raise` = 抢前台 + 再顶）与**短看护**：上屏后 8 × 350 ms 内发现被压回去就再顶，日志留下 `frontend buried again after show` / `frontend hard raise: on_top=…`。
  4. **托盘不再是致命依赖**（`frontend/src-tauri/src/main.rs`）：`tray::install(...)?` 改成失败只记一行继续跑 —— FSE / 无桌面 shell 的会话里 `Shell_NotifyIcon` 可能建不起来，而浮层、手柄、热键都不依赖托盘。以前托盘一失败，setup 返回 Err、整个前端立刻退出，日志里只剩一行看不懂的报错。
- **判读表（装 0.1.53 之后）**：
  - 启动器侧：`frontend autostart task: created user=… exe=…` = 自启任务建好了（首次）；`… task failed: …` = 建失败（后面跟着 `schtasks` 的原话，多半是 `UserId` 或权限），这时仍退回直接启动并记 `frontend ensure: started pid=…`。
  - `frontend ensure: started by autostart task (run ok)` = 由任务启动（普通权限）；`already running (skip start)` = 已经在跑；`用户这一轮登录里主动退出过前端（托盘菜单），不补启动` = 尊重意图，正常现象。
  - 前端侧：`frontend visible but buried → re-raise instead of hide` = 新判据生效（正是以前「忽不出来」的那一下）；`frontend hard raise: on_top=true` = 顶回来了；一直 `on_top=false` 且 `above=FantasyHub…` = 壳体还压着（切一次桌面模式再回大屏，看有没有 `overlay watch: big-screen mode = true` + `overlay yield: shell notopmost for big-screen ok=1`）。
  - 手工看任务（掌机上直接跑）：`schtasks /query /tn FantasyHubFrontend`、`schtasks /run /tn FantasyHubFrontend`。
- 验证：本机（macOS）`cargo clippy --workspace --all-targets` 零错误、未新增警告（新报的两条是原有 Windows-only 死代码）；Windows 侧用假 `llvm-rc` + `cargo check --workspace --all-targets --target x86_64-pc-windows-msvc` 覆盖全部新增的 `#[cfg(windows)]` 代码。

## 0.1.52 这一版

0.1.51 的日志终于把上一轮的「还是不行」判读出来了，而且结论很硬：**按 `Back+Start` 的那一刻，前端进程根本不在**（按键没有任何响应者，与 Z 序、渲染无关），**手柄本身是读得到的**。

- **0.1.51 那轮真机日志（`桌面\日志\fantasyhub.log`）读到的事实**：
  - `FantasyHubFrontend start pid=27664 v0.1.51` + `frontend ready (visible=false, autostart=true)` + `chord pad connected index=0` —— 前端起来过，而且**手柄读得到**（XInput 没问题）。
  - 76 秒后（就在用户按 `Back+Start` 前后）启动器自己写下 `overlay watch: frontend process down（前端没在跑：Back+Start 不会有反应）` —— 前端**已经不在了**。整份日志里没有 `panic (…)`、没有 `chord fired`、没有 `frontend show begin`。
  - 前端那边同样**一行退出记录都没有**：那个 pid 是安装包调 `--enable-autostart` 拉起来的，进程消失时日志干净得像什么都没发生 —— 于是「自己正常退 / 被外面杀了 / 原生崩溃」这三种情况在那份日志里长得一模一样。
- **这一版做三件事**：
  1. **前端正常退出也留一行**（`frontend/src-tauri/src/main.rs`）：`app.run(..)` 里记 `frontend exit requested (code=…)` / `frontend exit`。托盘退出、关掉最后一个窗口、安装器的「请退出」握手走的都是 `app.exit()` —— 有了这两行，「自己退的」才和「被杀 / 崩了」分得开。
  2. **「没查成」不再被读成「没在跑」**（`src-tauri/src/overlay_watch.rs`）：进程扫描改成三段 —— `overlay watch: frontend process up (pid=…)` / `… down（…；相关进程：FantasyHub.exe）` / `… scan failed: …（这一轮没查成，不代表它没在跑）`。报「没在跑」时把在场的关系进程一起写出来：真出现 `FantasyHubFrontend.exe` 就是判据看漏了，只有 `FantasyHub.exe`（启动器自己）才是前端确实不在。
  3. **启动器启动时补一次「前端在跑」**（`src-tauri/src/frontend_tool.rs::ensure_running`；这条**放宽了 §2 的边界**，见 `FRONTEND.md`）：更新完之后那一段空窗里谁都不管前端，而启动器是唯一确定在跑的一方 —— 现在它启动时若发现前端没在跑，就按前端自己报的路径（`frontend.json`，其次 `%LOCALAPPDATA%\FantasyHubFrontend\FantasyHubFrontend.exe`）把它拉起来，记一行 `frontend ensure: started pid=…`；在跑 / 没装 / 路径不存在都只记一行、什么都不动。**刻意不做看门狗**：用户从托盘「退出前端」是明确意图，不该过一会儿又被拉起来。
- **判读表（装 0.1.52 之后按一次 `Back+Start`）**：先看 `frontend ensure: …` —— `already running` / `started pid=…` = 这一轮前端肯定在跑（之后若又出现 `… process down`，那才是新问题）；`not running and not installed` = 前端压根没装（工具箱卡片的「安装 / 更新前端」）。再从 0.1.51 那张表往下走（`chord pad …` → `chord fired` → `frontend show begin/end` → `frontend layer …` → `frontend shot …`），并多一条退路：前端进程消失时若能见到 `frontend exit requested` / `frontend exit`，说明它是**自己退的**（接着查它为什么退）；两行都没有才是被杀 / 原生崩溃。
- 验证：本机（macOS）`cargo clippy --workspace --all-targets` 零错误、未新增警告；Windows 侧仍用假 `llvm-rc` + `cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（用一个故意写错的类型确认这次检查确实在查这份代码），启动器侧 0.1.52 新增的进程扫描与「启动前端」搬进 `/tmp/win-probe5`（只依赖 `windows-sys`）交叉编译通过。

## 0.1.51 这一版

0.1.50 的掌机验证**没能判读**（回传的日志里，0.1.50 的浮层代码一次都没执行）。这一版先不猜：把「谁没在跑、按键有没有进来」做成日志里一眼能看出来的东西；顺带确认 0.1.49 那处误判确实修好了。

- **0.1.50 那轮日志读出来的结论**：前端 v0.1.50 在 23:44:31 起过一次（`FantasyHubFrontend start pid=27872 v0.1.50` + `frontend ready (visible=false, autostart=true)`），此后到 01:10 用户复制日志为止**一行按键记录都没有** —— 没有 `chord`、没有 `frontend show begin`、没有 `frontend layer`，也没有 `overlay-shot.bmp`。所以「还是不行」这句话在这份日志里没法判读：新代码根本没走到。**反面证据也在同一份日志里**：0.1.49 那种「一开机就把手柄关掉」的 `overlay watch: frontend overlay visible → launcher pad off`（出现在任何按键**之前**）在 0.1.50 中**没有出现** —— 闸一的误判确实修好了。
- **「一片安静」原本有三种完全不同的原因，日志长得一模一样**：① 前端没在跑（装完启动器 / 重启之后前端没起来，`Back+Start` 没有任何响应者）；② 前端跑着但**崩了**（两个程序都是 GUI 子系统、没有控制台，panic 只进 stderr，日志一个字都不留）；③ 前端跑着、但**手柄没被读到**（XInput 读不到手柄时按键根本进不来，旧代码这种情况下一行都不写）。这一版把三条都补成可观测的：
  - **panic 进日志**：`crates/fh-core/src/logutil.rs` 新增 `install_panic_hook`，两个程序各在自己的 `main` 里装一次，留一行 `<tag> panic (<文件:行>, thread=…): <原文>`，随后照旧交给默认钩子（stderr 行为、debug 回溯都不变）。这是把 ② 从「无法区分」变成「一眼看得出」。
  - **启动器记录前端进程的生死**：`src-tauri/src/overlay_watch.rs` 新增 `frontend_process_alive`（`CreateToolhelp32Snapshot` 按可执行文件名找，不依赖「前端一定有窗口」），每 5 秒一次（200 ms × 25）、只在状态变化时记 `overlay watch: frontend process up` / `… process down（前端没在跑：Back+Start 不会有反应）`；**第一轮一定记**，所以「连这一行都没有」本身就是异常（观察线程没起来）。它和浮层可见性是两条独立的线：进程在 ≠ 浮层在屏上。
  - **前端记录手柄与按键**：`frontend/src-tauri/src/chord.rs` 第一轮**一定**打印 `chord pad connected index=0` 或 `chord pad none（读不到手柄：Back+Start 不会有反应）`（`pad_index` 初值特意给一个不可能的 `u32::MAX`，保证首轮必写），之后只在变化时记；和弦触发时多一行 `chord fired (Back+Start)` —— 它和后面的 `frontend show begin/end` 一起，把「没按」和「按了但没开」分开；每 5 分钟一行 `chord alive pad=index=0 visible=false` 证明轮询线程还活着（启动器那边另有 30 秒一次的心跳，日志本来就不是安静的）。
- **判读表（装 0.1.51 之后按一次 `Back+Start`）**：连 `overlay watch: frontend process up/down` 都没有 = 启动器的观察线程没起来（日志位置 / 提权问题）；`… process down` = 前端没在跑（从托盘或开始菜单把它启动起来，或重启一次再看）；`process up` 但没有 `chord pad …` = 前端起来就崩了（应有 `panic (…)`）；`chord pad none` = 手柄没被读到（这时按键注定没反应，与 Z 序无关）；`chord pad connected` + `chord fired` 但只有 `frontend show begin` 没有 `show end` = 卡在显示那一段（`settle` / 置顶）；`show end is_visible=true` 且 `frontend layer … topmost=false` 或 `above=FantasyHub…` = Z 序没拿到（**这时才做 B 组**：壳留 1 px 缝 / `DISABLEDXMAXIMIZEDWINDOWEDMODE` / OneXConsole 式透明整屏浮层）；`frontend shot ok … nonBlack=0%` = 根本没画上去（转渲染 / 合成层方向）。
- 验证：本机（macOS）`cargo clippy --workspace --all-targets` 零错误、未新增警告；Windows 侧这次**不换 build.rs** —— 给 `tauri-winres` 上一个假的 `llvm-rc`（temp 目录里一个只按 `/fo` 建空文件、退出 0 的脚本，本机不真编资源），`cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（`main.rs` / `chord.rs` / `overlay.rs` / `topmost.rs` / `shot.rs`）；启动器侧仍受 `ring` 的 C 代码限制（交叉编译不可行，见 0.1.47），新增的 `frontend_process_alive` 按老办法搬进 `/tmp/win-probe4`（只依赖 `windows-sys`，`Win32_System_Diagnostics_ToolHelp` 特性已加）交叉编译通过，其余胶水交给每次推送的 Windows Lint 作业。

## 0.1.50 这一版

修「**前端浮层打不开**」（其余功能正常）：先修掉 0.1.49 带回来的一处**误判**，再把「窗口说自己在屏上」和「屏上真有它」这两件事彻底分开取证 —— 这一次不再靠猜。

- **闸一误判（真 bug，日志已证实）**：`src-tauri/src/overlay_watch.rs` 原先只认「可见 + 属于 `FantasyHubFrontend.exe`」，而**前端进程里还有第二个窗口** —— `tauri-plugin-single-instance` 为了收「又启动了一次」的消息会建一个 0×0 的消息窗口（`WS_VISIBLE | WS_POPUP` + `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`）。它 `IsWindowVisible()` 为真、也属于前端程序，于是**前端一开机**启动器就把自己的手柄关掉（真机日志里 `overlay watch: frontend overlay visible → launcher pad off` 出现在任何按键之前 —— 浮层那时根本没开），而且是**永久**的。现在判据是**形状**：可见 + 没有 owner（`GetWindow(hwnd, GW_OWNER)` 为空）+ **不是点击穿透**（`WS_EX_TRANSPARENT`）+ **有真实尺寸**（≥160×160；浮层 660×1200，那个是 0×0），并在状态翻转时记一行 `overlay target: <类名 "标题"(pid) rect=WxH ex=0x…>` —— 判错窗口时这行就是全部证据
- **同一处：壳体让位，并替浮层顶到最前**：浮层真的上屏时，启动器 `SetWindowPos(自己的壳, HWND_NOTOPMOST)` 再 `SetWindowPos(浮层, HWND_TOPMOST)`，浮层收起后按原样还回去；每次记 `overlay yield: shell notopmost ok=… err=…` / `overlay raise: frontend topmost ok=… err=…`。**为什么由启动器动手**：UIPI 只允许「高完整性 → 低完整性」，开机自启时启动器提权（日志 `elevated=true`）、前端不提权 —— 前端自己那一下有可能根本排不上来，而且**失败不报错**；这也让「全屏壳压住浮层」（0.1.33 的老账）不再只有「抢前台」一条路
- **前端：句柄兜底 + 每步查返回值 + 自检**（`frontend/src-tauri/src/topmost.rs`）：
  - 0.1.48 里第一句是 `window.hwnd().ok()?`，拿不到句柄就整个返回 —— 置顶 / 清 owner / 抢前台**全部静默变成空操作**，日志里一个字都没有。现在兜底用 `EnumWindows` 枚举本进程顶层窗口（挑面积最大的那个），并且 `probe` 每次都写清楚句柄是从哪条路来的（`hwnd=tauri|enum|none`）
  - `SetWindowPos` / `SetWindowLongPtrW` 的返回值与 `GetLastError` 都进日志（`ok=false err=…`）；「成功就不读 `GetLastError`」—— 它不会被成功的调用清掉，无条件读只会写出自相矛盾的行
  - 新增 `on_top()`：问的是 `IsWindowVisible` + `WS_EX_TOPMOST`，**不是** Tauri 的 `is_visible()` —— 后者被整屏窗口压住时照样返回 true（0.1.48 的日志就是这么「一路正常」的）
- **前端：显示后自检 + 重试 + 现场取证**（`overlay.rs` 新增 `settle`，新增 `shot.rs`）：
  - 每次显示后每 120 ms 自检一次、最多 5 轮；没到位就 `retry_top`（只再顶一次，**不碰前台锁** —— 不带 `grab` 里那记 `VK_MENU` 补按），每轮记 `frontend show retry n/5 (…)`。这段跑在**后台线程**上（托盘菜单、第二实例的回调都在主线程，连等 600 ms 会冻住界面），并且显示 / 隐藏都会把代数 `GENERATION` 加一让上一轮作废 —— 否则它的 `SWP_SHOWWINDOW` 会把用户刚关掉的窗口又显示出来（0.1.45 的老坑）
  - `frontend layer …` 现在**无条件打印**：0.1.48 那条挂在 `if let Some(..)` 后面，而它在真机上一次都没出来过，于是既不知道 Z 序、也不知道前台，更没有像素
  - **新增截屏**：`GetDC(NULL)` + `BitBlt` 抓浮层那块区域 → 24 位 BMP 写 `%APPDATA%\handheld-launcher\overlay-shot.bmp`（每次显示覆盖上一张），日志记 `frontend shot ok overlay-shot.bmp 660x1200 nonBlack=…% path=…`。四种症状终于分得开：`above=FantasyHub…` = 被压住；`topmost=false` = 置顶没写进去；`hwnd=none` = 置顶那几步压根没做；`nonBlack=0%` = 那一片是黑的（没画上去，或者抓不到 —— 独占全屏 / 受保护内容也是黑的，要分开看）
- **日志带版本号**：`crates/fh-core/src/logutil.rs` 的首行改成 `<tag> start pid=… v<版本>`。这次排查卡住的正是「日志里从来没有版本号」—— 同一条 `frontend show end` 在 0.1.47 与 0.1.48 里逐字相同，分不出用户装的到底是哪一版
- 文档：FRONTEND.md §10 补「可见 ≠ 像浮层」与「壳体让位」两条，§3 补截图取证 / 自检重试 / 无条件打印的理由
- 验证：本机（macOS）`npm run build` 通过；`cargo clippy --workspace --all-targets` 零错误、未新增警告。**Windows 目标这次拿到了真正的类型检查**：把两个 `build.rs` 临时换成空壳绕过 `tauri-winres`（本机没有 `llvm-rc`），`cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 把 `main.rs / overlay.rs / topmost.rs / shot.rs` 整套编过；并且**用一个故意写错的类型验证过这次检查确实在检查这份代码**（E0308 当场被抓到，随后删掉）。启动器侧仍受 `ring` 的 C 代码限制（交叉编译不可行，见 0.1.47），`overlay_watch.rs` 的 Win32 部分另抽进 `/tmp/win-probe4`（只依赖 `windows-sys`）交叉编译通过，剩下的胶水由每次推送的 Windows Lint 作业兜底
- **掌机验证仍待做**：装 0.1.50 → 进大屏模式 → `Back+Start` **只按一次** → 回传 `%APPDATA%\handheld-launcher\fantasyhub.log` 末尾与 `overlay-shot.bmp`（有的话）。判读表：`overlay target: … rect=660x1200 …` = 认对了窗口；`overlay yield: shell notopmost ok=true` + `overlay raise: frontend topmost ok=true` = 权限方向没问题；`frontend layer … topmost=false` 或 `above=FantasyHub…` = Z 序没拿到（那时才做「壳留 1 px 缝 / 兼容标志 / 透明整屏浮层」B 组）；BMP 那一片全黑 = 根本没画上去（那是页面 / 合成层的问题，与 Z 序无关）

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
- 文件管理：功能 12 三批已做（双栏（左源右目标）· 可点面包屑 · 常用位置 · 选择模式与区间选择 · 带进度与取消的传输 · 搜索 · 批量重命名 · 属性 · 拖拽移动）。**真机未验证**，见开头「0.1.56 这一版（一）」

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
| 文件管理 | 可用（**功能 12 三批已做**，待真机验证：传输进度 / 双栏 / 搜索 / 批量重命名） |
| 工具箱 | **0.1.41** 独立成标签页；0.1.44 起只留运行库，OptiScaler 走游戏卡片菜单；实机装包待掌机验证 |
| 前端浮层 | **0.1.46** 起是独立程序（托盘常驻 + 贴右置顶浮层，`Ctrl+H` / 手柄 `Back+Start`）；**0.1.47** 修正式包里加载错页面（启动器整屏界面）与可见性日志说谎；**0.1.48** 补回大屏模式（FSE）下的置顶/抢前台手法与 Z 序现场日志；**0.1.49** 手柄归属两道闸（浮层在屏上时启动器不消费手柄、设置键改双击）；**0.1.50** 修闸一误判（别把系统给前端的 0×0 消息窗口当成浮层）+ 壳体让位 + 显示后自检重试与截屏取证；**0.1.51** 把「谁没在跑 / 按键有没有进来」也变成日志（panic 钩子、启动器记前端进程生死、前端记手柄与 `chord fired` + 心跳）—— 0.1.50 那轮真机日志里浮层代码一次都没执行过，先解决「看不见」；**0.1.52** 那份新日志直接判读出了「按键时前端进程不在」，于是补上「启动器启动时前端没在跑就拉起来」（更新完那段空窗）+ 前端退出也记一行 + 进程扫描区分「没在跑 / 没查成」；掌机冒烟仍是最后一道关 |

## 待完成 / 已知缺口

1. **FSE**：已被识别为主应用（0.1.28+）；0.1.29 修开机找不到 `FantasyHub.exe`
2. **前端手柄**：0.1.28 修开即关；掌机验证 D-pad / A / B
3. **OptiScaler**：**0.1.41** 起吃官方 `.7z`（含 BCJ2），此前只认 `.zip` 所以一直装不上；游戏内 hook 与 Insert 菜单待掌机验证；版本 / hook 选型以后对表再做
4. **扫描**：GOG、Game Pass、微软商店应用等
5. **风扇 / Game++**：明确延后（见 `FUTURE.md`）
6. 无代码签名（SmartScreen）；无自动化测试（**0.1.47 起有 lint 门**：编辑器 / pre-commit / 每次推送的 Windows lint 作业 / 打包前编译检查；单元测试仍未做）
7. **全屏回库**：0.1.44 起主窗不再隐藏 / 让出，退出游戏后直接就是启动器；游戏里按 Back+Start 呼出浮层可直接「退出游戏」（探不到进程时会提示没找到，库页面卡片菜单里也能退）
8. **冰箱（重点 → `FUTURE.md` 功能 11）**：游戏里锁屏 / 息屏 → **静默**冻结当前游戏 + 休眠断电，唤醒后接着玩，且**不被误唤醒**（包里不空转）。关键在三个 Win32 动作（挂起进程 / `SetSuspendState(TRUE,TRUE,TRUE)` / 关掉能唤醒的设备）与「先拿事件再动手」的顺序，需要掌机上一轮轮试；参考壹号本冰箱
9. **文件管理器深度优化（重点 → `FUTURE.md` 功能 12）**：三批已落地（见开头「0.1.56 这一版（一）」），**真机未验证**。这一版没做：手柄上的文字输入（搜索 / 批量重命名要借系统键盘）、缩略图、复制到受保护目录的一键提权重启（只在属性面板提示）。
10. **界面改版：向 Steam 大屏看齐（重点 → `FUTURE.md` 功能 13）**：固定导航条 + 横版货架（最近游玩 hero）+ 卡片焦点动效 + 常驻按键提示条 + 游戏详情页；先做「外壳 + 游戏库」，其余页随后对齐

## 近期改动备忘

- 0.1.57：**修装了 0.1.56 之后真机提的四条** —— 文件夹显示大小（`file_dir_sizes`，3 秒共用预算 + 可取消 + 不跟进链接，前端按路径缓存 60 秒、按大小排序改用它）、下探文件夹后焦点跑到最上面（`rowsToken` 指纹，行真换了才安顿焦点）、多选后换盘变全选 / 一直保持多选（Y 菜单标签与动作相反拆成两颗，换目录在导航那一刻清选中并退出选择模式）、Steam 游戏静默启动（`steam.exe -silent -applaunch`，找不到客户端才退回协议地址）。**已发布**：`v0.1.57`，启动器包 30.28 MB / 前端包 3.19 MB，CI 全绿（Lint 在 Windows 上真编过），**真机未验**，见开头「0.1.57 这一版（一）」。

- 0.1.56：**文件管理器按 `FUTURE.md` 功能 12 三批全做** —— 传输引擎（进度 + 取消 + 同名策略 + 失败原因分类）、改名 / 批量改名 / 属性 / 搜索、双栏与选择模式。细节与「验证到哪一步 / 没验证什么」见开头那一节。同版还第一次把 Game Bar 小组件后台打进安装包（见「0.1.56 这一版（二）」）。**已发布**：`v0.1.56`，启动器包 30.27 MB / 前端包 3.19 MB，等真机装包。

- 0.1.53：**「FSE 里前端不是被杀，是没被启动」+「前端其实活着，是浮层上不去」—— 两条结论都是你的真机观察给的**。你补的现场是：「桌面模式能正常唤出；全屏模式（FSE）唤不出，**哪怕先在桌面模式把它启动了**再回全屏也一样；切回桌面模式又好了」。前半句的解释在日志里现成：启动器是 **Win11「Xbox 模式（全屏体验）」的主页应用**（`fse register: 已登记。请打开 Windows 设置 → 游戏 → Xbox 模式(全屏体验)…`），而那个会话里**没有桌面 shell（explorer）**；前端的开机自启用的是 **HKCU Run 键**，Run 键正是由 explorer 在登录时处理的 —— 于是 FSE 里它根本不会被执行（OneXConsole 那类厂商程序用**服务/计划任务**，任务计划程序拉起、不依赖 explorer，这就是它「死不了」的真正原因）。后半句更有价值：进程若已死，切回桌面不可能自己恢复 —— 所以是**浮层上不去**；日志里 10-01 那次测试演得清清楚楚：`frontend show end … is_visible=true` 紧跟 `frontend hide end … is_visible=false`（第二次按键把它**关掉**了，人什么都没看见）。四条改动：**一、自启改计划任务**（新模块 `crates/fh-core/src/autostart.rs`，用 Windows 自带的 `schtasks /create /xml`：登录后延迟 10 秒、**普通权限**运行 `--autostart`、`IgnoreNew`、`ExecutionTimeLimit=PT0S`（**永不超时结束** —— 托盘常驻程序缺这条会被任务计划程序三天后杀掉）、`RestartOnFailure` 1 分钟×2 次 —— 于是「崩溃/被杀会被拉回、托盘退出（exit code 0）不重启」，保命与尊重用户意图用同一套机制拿到；启动器启动时建任务（不存在才建）、补启动改成 `schtasks /run`（**不再继承启动器的管理员权限**）、这一轮登录里用户主动退过就不补启动（`frontend-stopped` 标记，下次登录由任务清掉）；托盘「开机自启」勾选框改为驱动任务并清掉老的 Run 值）；**二、浮层判据从「系统说可见」改成「真的没被压住」**（`overlay.rs::toggle` 用 `visible && topmost::on_top`，可见但被压住 → **再顶一次、绝不 hide**）；**三、大屏模式壳体常态让位**（`overlay_watch::set_big_screen`，由 `startup.rs` 的进/出大屏模式与 `lib.rs` 启动处调用：大屏里壳体根本不进置顶层、回桌面按原样还回；前端侧加 `topmost::hard_raise`（抢前台+再顶）与上屏后 8×350ms 的短看护 `keep_on_top`）；**四、托盘不再是致命依赖**（`tray::install(...)?` → 失败只记一行继续跑；FSE/无 shell 的会话里 `Shell_NotifyIcon` 可能建不起来，而浮层、手柄、热键都不依赖它）。验证：本机 `cargo clippy --workspace --all-targets` 零错误、未新增警告；Windows 侧 `cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（含 `fh_core::autostart` 的 schtasks 实现），启动器侧新代码搬进 `/tmp/win-probe5`（补 `Win32_UI_WindowsAndMessaging`）交叉编译通过 —— 启动器整包仍受 `ring` 的 C 代码限制（见 0.1.47）

- 0.1.52：**0.1.51 那轮真机日志判读出了 0.1.50/0.1.51 两次「还是不行」的直接原因：按 `Back+Start` 的时候前端进程不在**。证据链（同一份 `fantasyhub.log`）：① `FantasyHubFrontend start pid=27664 v0.1.51` + `frontend ready (visible=false, autostart=true)` + `chord pad connected index=0` —— 前端起来过、且**手柄读得到**（XInput 没问题，0.1.51 新加的 `chord pad` 判据第一时间给了正面结果）；② 76 秒后（用户按键前后）启动器写下 `overlay watch: frontend process down（前端没在跑：Back+Start 不会有反应）`；③ 同一时间窗内 `panic (…)` 没有、`chord fired` 没有、`frontend show begin` 没有，前端那边也**一行退出记录都没有**（那个 pid 是安装包调 `--enable-autostart` 拉起来的）—— 于是「自己正常退 / 被外面杀了 / 原生崩溃」三者不可分，这正是这一版要补的三件事：**一、前端正常退出也留一行**（`frontend/src-tauri/src/main.rs` 改 `builder.run()` 为 `build()` + `app.run(..)`，记 `frontend exit requested (code=…)` 与 `frontend exit`；托盘退出 / 关最后一个窗口 / 安装器握手都走 `app.exit()`）；**二、进程扫描三段式**（`src-tauri/src/overlay_watch.rs` 的 `frontend_process_alive() -> frontend_scan() -> Scan{frontend,related,error}`：`up (pid=…)` / `down（…；相关进程：FantasyHub.exe）` / `scan failed: …（这一轮没查成，不代表它没在跑）`，快照失败时**不动状态**只记一次原因，报 down 时把镜像名带 `fantasyhub` 的在场进程一起写出来 —— 真出现 `FantasyHubFrontend.exe` 就是判据看漏了）；**三、启动器启动时补一次「前端在跑」**（`src-tauri/src/frontend_tool.rs::ensure_running`，从 `lib.rs` 的 setup 里调；前端没在跑才动，按 `frontend.json` 的 exe 路径、其次 `%LOCALAPPDATA%\FantasyHubFrontend\FantasyHubFrontend.exe` 拉起来并记 `frontend ensure: started pid=…`；**不做看门狗**，只在启动时一次，也不结束任何进程）。第三条是 0.1.46 以来第一次放宽 FRONTEND.md §2 的边界（那里原本写死「不起进程」）：更新完之后那一段空窗里谁都不管前端，而启动器是唯一确定在跑的一方 —— 补上它，`Back+Start` 才有个能接按键的人。验证：本机 `cargo clippy --workspace --all-targets` 零错误、未新增警告（新代码在 macOS 上不编译，特意把两个平台都照顾到：`Scan` / `frontend_scan` / `frontend_process_alive` / `default_exe` 都 `#[cfg(windows)]`，`ensure_running` 留非 Windows 空实现）；Windows 侧假 `llvm-rc` + `cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（并用故意写错的类型确认这次检查确实在查 `main.rs`），启动器侧新代码搬进 `/tmp/win-probe5` 交叉编译通过
- 0.1.51：**不改行为，先修「看不见」**。0.1.50 那轮掌机验证回传的日志里，**0.1.50 的浮层代码一次都没执行**：前端 v0.1.50 在 23:44:31 起过一次（`FantasyHubFrontend start pid=27872 v0.1.50` + `frontend ready`），此后到用户复制日志为止没有 `chord`、没有 `frontend show begin`、没有 `frontend layer`、也没有截图 —— 也就是说这一轮什么都没测到；同一份日志反而证明了 0.1.49 那处「一开机就把手柄关掉」的误判（`overlay watch: frontend overlay visible → launcher pad off`，出现在任何按键**之前**）没再出现。问题在于「日志一片安静」原本对应三种完全不同的原因、长得一模一样：① 前端没在跑（`Back+Start` 没有任何响应者）；② 前端跑着但崩了（两个程序都是 GUI 子系统，没有控制台，panic 只进 stderr，日志一字不留）；③ 前端跑着但 XInput 读不到手柄（旧代码这种情况一行都不写）。三样都补成可观测的：`crates/fh-core/src/logutil.rs` 新增 `install_panic_hook`（两个程序各在自己的 `main` 里装一次，留 `<tag> panic (文件:行, thread=…): 原文`，随后照旧交给默认钩子，stderr 与 debug 回溯都不变）；`src-tauri/src/overlay_watch.rs` 新增 `frontend_process_alive`（`CreateToolhelp32Snapshot` 按影像名找进程，不依赖「前端一定有窗口」；每 5 秒一次、只在变化时记 `overlay watch: frontend process up/down（前端没在跑：Back+Start 不会有反应）`，**第一轮必记** —— 连它都没有就说明观察线程没起来）；`frontend/src-tauri/src/chord.rs` 首轮必打 `chord pad connected index=0` / `chord pad none（读不到手柄：Back+Start 不会有反应）`（`pad_index` 初值给不可能的 `u32::MAX`，保证首轮必写）、和弦触发多一行 `chord fired (Back+Start)`（它 + `show begin` 才能把「按了但没开」与「没按」分开）、每 5 分钟一行 `chord alive pad=… visible=…`。下次「还是不行」的日志能直接指出卡在哪一环。验证：`cargo clippy --workspace --all-targets` 零错误、未新增警告；Windows 侧这次**不换 build.rs**，改为给 `tauri-winres` 上一个假的 `llvm-rc`（临时目录里只按 `/fo` 建空文件、退出 0 的脚本，本机不真编资源），`cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（并用一个故意写错的类型确认这次检查确实在查这份代码），启动器侧新增的 Toolhelp 调用按老办法进 `/tmp/win-probe4`（补 `Win32_System_Diagnostics_ToolHelp` 特性）交叉编译通过 —— 启动器整包仍受 `ring` 的 C 代码限制，交叉编译不可行（见 0.1.47）
- 0.1.50：修「**前端浮层打不开**」。两件事。**一、0.1.49 的闸一认错了窗口**：它只认「可见 + 属于 `FantasyHubFrontend.exe`」，而前端进程里**还有第二个窗口** —— `tauri-plugin-single-instance` 为了收「又启动了一次」会建一个 0×0 的消息窗口（`WS_VISIBLE | WS_POPUP`，样式上 `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`）。`IsWindowVisible()` 对它为真、它也属于前端程序 —— 于是**前端一开机**启动器就把自己的手柄关掉（真机日志：`overlay watch: frontend overlay visible → launcher pad off` 出现在任何按键之前），而且是永久的。判据改成**形状**：可见 + 无 owner（`GetWindow(hwnd, GW_OWNER)`）+ 不是点击穿透（`WS_EX_TRANSPARENT`）+ 有真实尺寸（≥160×160：浮层 660×1200，那个是 0×0），状态翻转时多记一行 `overlay target: <类名 "标题"(pid) rect=WxH ex=0x…>`；**二、把「窗口说自己在屏上」和「屏上真有它」分开取证**（0.1.48 的前端现场快照挂在 `if let Some(..)` 后面，真机上一次都没打印出来，于是只能猜）：`frontend/src-tauri/src/topmost.rs` 给 `window.hwnd()` 加了不依赖 Tauri 运行时的兜底（`EnumWindows` 枚举本进程顶层窗口挑最大的，`probe` 每次都写 `hwnd=tauri|enum|none`）、每个 Win32 调用失败都记 `err=`、新增 `on_top()`（`IsWindowVisible` + `WS_EX_TOPMOST`，不用被压住也说 true 的 `is_visible()`）；`overlay.rs` 显示后每 120 ms 自检、最多 5 轮，没到位就 `retry_top`（**不碰前台锁**，不带 `grab` 那记 Alt），跑在后台线程并用代数让过期的一轮作废（否则它的 `SWP_SHOWWINDOW` 会把刚关掉的窗口又显示出来），`frontend layer …` 无条件打印；新增 `shot.rs` 用 `GetDC(NULL)` + `BitBlt` 把浮层那块区域抓成 `%APPDATA%\handheld-launcher\overlay-shot.bmp`（`frontend shot ok … nonBlack=…%`）。启动器的观察线程还顺手做「壳体让位」：浮层上屏时 `SetWindowPos(壳, HWND_NOTOPMOST)` + `SetWindowPos(浮层, HWND_TOPMOST)`（UIPI 只允许高完整性动低完整性的窗口，开机自启时提权的是启动器），浮层收起按原样还回去，每次记 `overlay yield:` / `overlay raise:` 的成败与错误码。日志首行现在带版本号（`<tag> start pid=… v0.1.50`）。验证：本机 `npm run build` 通过、`cargo clippy --workspace --all-targets` 零错误未新增警告；Windows 侧这次拿到**真的类型检查** —— 两个 `build.rs` 临时换成空壳绕过 `tauri-winres`（本机没有 `llvm-rc`）后 `cargo check -p fantasyhub-frontend --target x86_64-pc-windows-msvc` 编过整套前端（并用一个故意写错的类型确认这次检查确实在检查代码），启动器的 Win32 部分抽进只依赖 `windows-sys` 的探针 crate 交叉编译通过，余下胶水交给 Windows Lint 作业
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
