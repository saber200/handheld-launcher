# 前端独立化（0.1.46 起）

> 状态：**独立前端已改成无窗口的 Game Bar 后台（未验证），界面由 `frontend/gamebar` 的原生小组件承担**。这一套已经随 **0.1.56** 的安装包第一次发出去（0.1.57 原样带着；**0.1.58 删了小组件的「自启」行、设置页那行改名「安装前端」**，见下面第一节），真机上一次都没验过。下文保留最初拆分设计与 0.1.46–0.1.55 的浮层排查记录；那些窗口已经从代码里接不上，历史归因不能替代本节的验证边界。
> 相关文档：`STATUS.md`（当前进度）、`FUTURE.md`（功能 2 / 功能 3 是本前端的由来）。

## 未发布：界面大改 M0（设计令牌 + 左侧栏外壳，2026-10-04）

设计材料归档在 `docs/redesign/`（规格书 + 9 张画板 + design-tokens / mock-data / ui-strings）。**外壳这层已落地，页面内部按里程碑逐页迁** —— 所以现在库里同时有「新令牌写法」和「旧 px 写法」，这是有意为之，不是漏改。

- **一份令牌**：`src/styles/tokens.css` 是唯一落点（与 `reference/design-tokens.json` 对表，`scripts/audit-ui.mjs` 逐项比）。`global.css` 的 `:root` 只剩别名（`--muted` → `--ink-3`、`--radius` → `--radius-shell`）。**别在页面里再写一份颜色值**。
- **几何走 `--dp`**：写成 `calc(N * var(--dp))`，`--dp` 由 `src/styles/scale.ts` 按窗口算（设计画布 1280×720）。为什么不用规格书 §11 表里那个公式，见 `scale.ts` 顶部注释。前端的画布是 440×620（K8），所以 `src/frontend/main.tsx` **不调用** `watchUiScale()`，`--dp` 保持 1px，只共用令牌与别名。
- **页面迁移顺序**：旧页面先原样放在新壳里（旧 px 在新壳里仍然能看能用），轮到那一页时把视觉与令牌一起换。别为了「整齐」提前改 —— 那会让功能回归和视觉改动混在一起，出问题分不清是谁的锅。
- **旧代码里的胶囊**（`.library-tool` / `.switch` / `.group-switch` / `.group-name-input` / `.file-pane-tag` 的 `border-radius: 999px`）：规格书 §2.1 要求全仓清零，但它们是各页面的活，跟那一页一起改。`audit-ui.mjs` 现在把它们列在「待迁移」，改完一个删一个 `LEGACY` 条目，最后切 `--strict`。
- **改造包的 `tools/*.py` 不能跑**：依赖设计工具的 `ds2` / `boards2`（包里没带，本机实测 ModuleNotFoundError）。要加界面校验就扩 `scripts/audit-ui.mjs`，别再引那两个模块。
- **两种校验分工**：`scripts/audit-ui.mjs` 扫源码（颜色 / 圆角 / 手写数值，进 pre-commit 与 CI）；`scripts/probe-ui.mjs` 是**真渲染探针**（要本机 Chrome + 一个跑着的 `npm run dev`，**不进 CI**）—— 它按指定窗口尺寸渲染、跟画板坐标对几何、扫「焦点环有没有被 overflow 容器裁掉」、可选存截图。逐页迁移时先跑它，改完再跑一次。已知待迁的裁切名单在脚本顶部的 `KNOWN_RING_CLIP` 里（只许变短）。
- **锁定态（商店 / 社区）**：能不能被手柄走到由 `src/types.ts` 的 `NAV_ROUTES` 决定，`App.tsx` 里锁定项不给 `data-focusable`。加新区块时**别把它塞进 `NAV_ROUTES`**，否则 LB/RB 会停在禁用项上。
- **焦点域**：侧栏是 `data-focus-zone="shell-rail"`。`moveDirectionalFocus` 里 **`dy` 是「上下跨域」**（在侧栏一直往下按会从最后一行进到内容区），**`dx` 也跨域了**（2026-10-04 起：先找同域同一行的邻居，到边界就按几何跨到 dx 那一侧、优先「当前选中项」）—— 规则与两个坑见下面「M1 修正」一节。

## 未发布：界面大改 M1 游戏库（K1，2026-10-04）

M0 定的顺序里的第一页：游戏库换成画板 K1 的横向卡片条。**样式全在新文件 `src/styles/games.css`**，`global.css` 里那套旧 `.library-*` 只被覆盖、没有被改（软件库还走旧网格，K2 才动它）。两条渲染路径靠 `LibraryShelf` 的 `layout="shelf" | "grid"` 分，卡片本身靠 `variant="shelf" | "picker"` 分 —— 选择对话框里还是旧卡片，别把它们一起改。

- **几何**：一律 `calc(N * var(--dp))`，数字取自改造包 §3.1（标题 62 / chip 行 174 / 卡 116×146 在 300、聚焦 158×190 在 278 / 面板 430×138 在 482、面板顶后来按「M1 修正二」挪到 **494** / 操作区 x=712 / 主按钮 178×46 / 状态行 566）。画板原文写「放大 1.36×」但 146→190 只有 1.30，**以绝对尺寸为准**（`games.css` 里注明了）。K1 专用的两个时长（180ms 卡片放大、160ms hero 淡入）是 `games.css` 里的局部变量 `--k1-grow` / `--k1-fade`，**不是通用令牌，别挪进 `tokens.css`**；其中 `--k1-fade` 必须和 `LibraryShelf.tsx` 里 `useHeroCrossFade` 的 160ms 一致。
- **两个布局坑**（以后加横向滚动页面会再遇到）：① CSS grid 里靠自动排列时，**DOM 顺序决定行**：K1 的分组行夹在标题和工具栏之间，工具栏会被顶到第三行（实测头部高出 50dp）→ 三块都写显式 `grid-area`；② `flex: 1` 的自动最小尺寸是 **min-content**，横向滚动内容的 min-content 会把内容区顶宽（实测 `tab-panel` 从 1044px 顶到 1662px，1280 窗口下整个壳横向溢出）→ `.tab-panel` 与 `.k1-page` / `.k1-strip-wrap` 都补 `min-width: 0`。
- **焦点域**：卡片条 `data-focus-zone="library-grid"`、分组行 `library-groups`、工具栏 `library-tools`、K1 新增的操作区 `library-actions`。`LibraryShelf` 那个「自动把焦点安顿到第一张卡」的 effect 只认这三个旧域 —— 加新区块时**必须一起加进它的白名单**，否则操作区里的按钮会被反复抢走焦点（按不动）。上下跨域、左右域内走的规则没改。
- **hero 的图从哪来由页面定**（`renderHero`），`LibraryShelf` 只负责换图时的交叉淡入与压暗；页面侧的回退链是 Steam 宽图 → 本地封面 → 渐变占位。宽图没有本地缓存（`cache_covers` 只存 600×900 竖封面），断网时自动退回封面。
- **不摆假数据**：画板里有、本地没数据源的（时长·体积 / 四格数据 / 收藏 / 筛选 / 排序 / 网格列表切换）一律不做，右上角那一格放的是真按钮（新建分组 / 添加游戏 / 从扫描添加 / 重新扫描）。

## 未发布：Rust 元数据（体积 / 时长 / 版本）—— 2026-10-04

- **约定：`0` = 不知道，不是「0 字节 / 0 分钟」。** Rust 那四个新字段（`ScannedGame.sizeBytes` / `playtimeMinutes`、`ScannedApp.version` / `sizeBytes`）都按这个来；前端 `src/library/format.ts` 里 `formatSize` / `formatPlaytime` 见到 0/undefined 返回**空串**，调用方据此不画那一格 —— 别在别处自己判 0 然后显示「0 MB」。
- **数据源**（不新增下载、不新增权限）：Steam 体积 = `appmanifest_*.acf` 的 `SizeOnDisk`；Steam 时长 = `<Steam>/userdata/<账号>/config/localconfig.vdf` 的 `apps → <appid> → Playtime`（分钟，多账号取最大）；Epic 体积 = manifest 的 `InstallSize`；软件版本/体积 = 注册表 `DisplayVersion` / `EstimatedSize`（KB）。
- **localconfig 为什么要单独解析**：`scan.rs` 里那个 `vdf_pairs` 是**扁平**的（只认 key/value、不看 `{}`），而 localconfig 里 `apps` 下面每个 appid 一个块、多个 appid 都有 `Playtime` —— 扁平解析得到一串无主的 Playtime。`playtimes_from_localconfig` 是一台认 `{` `}` 的小状态机，只认「`apps` 的子块里的 Playtime」这一种形状（少认几层，Steam 换层级也不会整个失效）；4 个单测在本机跑（纯函数），读文件/读注册表那几行是 `#[cfg(windows)]`，只能靠 CI 编。
- **K1 上怎么摆**：只有**聚焦卡**露第二行「时长 · 体积」（`CardOptions.focused` 由 `LibraryShelf` 传下来）；卡片上加 `has-facts` 时才把 `.library-name` 抬到 `bottom: 24dp`、第二行贴底 —— 名称是 `-webkit-line-clamp` 的多行块，直接塞进文档流会让聚焦/未聚焦两态封面高度不一致。信息面板只是多两行 dt/dd（占用空间 / 总时长），面板高度因此 138 → 168dp（画板四格那种紧凑排法我们没照抄）。
- **`scripts/probe-ui.mjs` 的两条新断言**：聚焦卡第二行必须在卡内且不压住名称；信息面板的 dt/dd 必须成对。改卡片底部这一块之后跑它，比肉眼可靠。
- **扫描结果存在 localStorage，键里带 schema 版本（`handheld-launcher.scan.v2.<命令>`）**：加了字段就得把这个版本号 +1，否则升级后老缓存没有新字段、界面上那几格永远空着，用户会当成坏了（`useLocalLibrary.ts` 的 `scanCacheKey` 上写着这条）。

## 未发布：界面大改 M1 修正（2026-10-04，用户截图反馈）

三条都改完了，**Rust 一行没动**；改完先在 1280×720 与 1920×1080 下重量过再重截的自检图。

- **hero 的盒子比卡片条短**：画板把 hero 画到 y=440（396dp），而聚焦卡底边在 468 —— 卡片下缘探出大图 28dp；更要紧的是纵向压暗在 440 处只到 0.894 不透明，**亮色宽图会留一条齐刷刷的硬边**（像素实测：改前 y=436→437 一行亮度掉 41，改后那一带每行落差都在 3 以内）。现在 hero 铺到卡片条那个盒子的底边（480 → 437dp；多出的 1dp 是给 1080p 下 `--dp=1.5` 攒出来的亚像素零头，hero 从顶栏量起、不跟着漂），纵向压暗改成三段 `268→0 / 440→0.894 / 480→1`：图在卡片那一带就化进背景，盒底正好收干净。**卡片条的坐标一个没动**（卡条盒 266..480、聚焦卡 278..468；面板按画板是 482，后来按「M1 修正二」挪到 494），只有 hero 与压暗层变高。
- **焦点环外扩 7dp，别让 overflow 容器吃掉**：`--focus-offset`(4) + `--focus-stroke`(3) = 环画在盒子**外** 7dp，而 `overflow` 是按**内边距盒**裁的。侧栏那一列（`.rail-items`）内边距原先是 0 → 环的左右两边和首尾行的上下全被切（用户图 2 报的就是这个）。修法是「补内边距 + 同值负外边距」：盒子大一圈把环装进去，内容的位置、宽度、列间距一个像素不变。同类修了两处：`.group-strip-scroll`（分组 chip 行，原来只有 2px；它把行高从 32 收成 28，K1 在 `.k1-strip-wrap` 的 margin-top 里补回 4dp）、`.drawer .settings-body`（设置抽屉满宽行，**只补左右** —— 它是 `flex: 1` 的滚动体，加纵向内边距会把盒子撑出抽屉 7dp，透明那一条会盖住页脚点击）。**以后加滚动容器照这个套路**；`.library-grid`（旧网格：软件库 / 文件页网格）和文件页的 `.file-list`、顶部按钮行仍会裁，跟着 M2 / M3 一起改（自动巡检脚本已经能报出来）。
- **左右键现在会跨域**（原来的规则是「左右在域内走」）：`moveDirectionalFocus` 的 `dx` 走三步 —— ① 同域、**同一行**的几何邻居（卡片条 / chip 行 / 工具栏 / 文件网格同一行都走这条，数值上跟原来一致）；② 到边界就跨域，候选按「先只留当前选中项（`.is-current` / `[aria-selected]`）→ 其中优先本域里上次停过的那一项（`lastInZone`）→ 再按同一行横向距离 → 再按垂直中心距离」逐级收窄 —— 从侧栏按右回内容区落回**刚才那张卡**，从卡片条按左进侧栏落在**当前页那一行**；③ 兜底只在多列域保留旧的池顺序（文件网格换行），单列域（侧栏）左右不动 —— 旧行为「在侧栏按右 = 焦点往下跳一行」正是用户实测报上来的那条。`dy` 一个字没改。**「上次停过的那一项」只在过滤过一轮的候选里挑**，不是全局覆盖几何：不然从操作区按左会跑到侧栏最上面那行去。

## 未发布：界面大改 M1 修正二（侧栏行距 / 卡片条—面板的距离 / hero 底边，2026-10-04，用户截图反馈）

用户第二轮的图还是「画个框指哪儿丑」，三条全是间距与边，**Rust 与功能一行没动**。这一轮的教训：**画板的固定坐标只在 1280×720 下成立** —— 用户的窗口是 1493×1225（`--dp=1.166`），三个问题里有两个是「超出画布尺寸才看得见」的。

- **图 1「没有距离」= 卡片条贴着信息面板**：聚焦卡的焦点环画在盒子外面（`--focus-offset` 4 + `--focus-stroke` 3 = 7dp），环的底边落在 475dp，离画板的 482dp 只剩 **7dp**。`.k1-foot` 的 `margin-top` 由 2dp 改成 **12dp**（面板顶 494dp），环下面是 19dp。顶到 720dp 的下限也量过：面板高 168dp，494 + 168 = **662**，提示条从 672 起，还剩 10dp（1280×720 实测 659 vs 672；1080p 985 vs 1008）。`probe-ui.mjs` 里「信息面板顶边」的期望值跟着从 482 改成 494。
- **图 2「紧紧贴在一起甚至产生了覆盖」= 侧栏行距放不下焦点环**：画板写「行高 40、步进 42」，那 2dp 的行间距装不下 7dp 的环 —— 当前页那一行与焦点停的那一行**同时高亮时会连成一坨**，环还压到下一行的背景上（用户截的就是 游戏库 / 软件库 这两行）。直接加大行距不行：720dp 高的窗口里侧栏只剩 **344dp** 给 8 行，40×8 + 8×7 = 376dp 会顶出滚动。所以从行高里让 6dp：`--h-rail-row` **40 → 34**、`.rail-items` 的 `gap` **2 → 8**，**步进仍是 42dp**（`--step-rail-row` 不用改），8 行的高度预算与首行位置全都不变（`166dp` 那条断言原样过）。实测两行高亮之间隔 10px、3px 的环正落在中间（改之前是 0px）。
- **图 3「整个边没过渡」= hero 底边是 1px 硬边**：压暗渐变的最后一档是**不透明**的 `bg-deep`，等于把 hero 的底边钉死成 `#0a101b`；而背后是 `global.css` 那层 160deg 全局渐变，**只有在 1280×720 画布上那一带才刚好也是 `#0a101b`**。用户窗口里页面背景在那里是 `#121a2c`，hero 底边就成了一条硬边（实测那一行 RGB 从 `(10,16,27)` 跳到 `(18,28,45)`）。修法是在 hero 底下垫一层 `.k1-page::after`（`top: 436dp`、高 48dp、`bg-deep → transparent`、`pointer-events: none`，层在 `.k1-head` / `.k1-strip-wrap` / `.k1-foot` 的 `z-index: 1` 之下）—— 只补底边这一条，卡片条一个数没动；画布尺寸下这层与页面背景同色、等于看不见。改后实测每行落差 ≤ 3（原来单行 15），从 hero 底边起 56px 之内平顺收完。**以后再有「图/底色压暗到某个固定坐标」的写法，都要想到这一条**。
- **`probe-ui.mjs` 新增一条断言**：侧栏「当前行与其下一行之间的间距 ≥ 焦点环的 7dp」。这是用户图 2 那条的几何版本，比肉眼可靠 —— 以后谁把行高/行距改回去它就会红。
- **本机验证**：`npx tsc --noEmit` / `npm run build` / `node scripts/audit-ui.mjs`（阻塞项 0；`games.css` / `shell.css` / `tokens.css` 都没有新增「待迁移」条目）；探针在 **1493×1225（照用户窗口尺寸）+ 1280×720 + 1920×1080** 三档全绿（含新断言），并在 1493×1225 下逐像素量了 hero 底边那一段。**CI**：`Lint` 在 `windows-latest` 上已绿（run 37206846909）。**没做的**：真机（Windows 掌机）没装过；这一轮是纯 CSS，Rust 与逻辑零改动。

## 未发布：界面大改 M2 软件库（K2，2026-10-04）

画板 K2：标题 + 工具栏 + 分组 chip + **6 列卡片网格** + 底部操作条。样式在**新文件 `src/styles/apps.css`**；页面靠 `LibraryShelf` 的新 prop `skin="k2"` 走这条路（`skin` 只影响头部与内容区的 class，逻辑一行没动 —— 分组 / 隐藏 / 改名 / 从扫描添加 / 卡片菜单 / 选择对话框全都照旧）。

- **几何（画板 K2 实测，全部写进 `apps.css` 的注释）**：卡片 **152.7×176**（6×152.7 + 5×16 = 996 = 内容区安全宽，所以列宽是 `repeat(6, minmax(0, 1fr))` 自动算的）、间隙 16、**第一行顶 134**、chip 行顶 **86**（K1 是 174 —— 那 88dp 是 hero 让出来的）、底部操作条高 **48**。
- **卡片的四段（§4.1）**：包头行 20（状态点 8 + 状态字）→ 距 8 → 图标区 58（sunken 底、圆角 12、图标 30）→ 距 12 → 名称（12dp Semibold，单行省略）→ `margin-top: auto` → 底部行（距下缘 16）。176 = 16×2 内边距 + 20 + 8 + 58 + 12 + 名称行 + 底部行，底部行吃掉余量，所以名称再长也顶不高卡片。实测各段起点：图标区 179、名称字形 252..262、底部行 279 ✓。
- **只写真字段**：底部行 = 注册表的 `DisplayVersion` + `EstimatedSize`（`版本 · 体积`），缺的那半边自己消失，两边都没有就整行不渲染；包头行 = 扫描出来的写「已安装」、用户自己挑文件加进来的写「手动添加」。**两处偏离画板、都是有意的**：① 画板底部行写的是「有新版本 / 已是最新 · 体积」——更新检查我们没有这个数据源，不摆假状态；② 软件这边没有进程探测，所以标不出「运行中」（游戏库那边有 `useRunningGameIds`，软件没有）。
- **底部操作条右边那两颗按钮是照形状放的**：画板里那颗 accent 填充（约 99×31）+ 那颗 panel-3（约 110×31）我**没能逐字读出来**（这一轮图片读取额度用完了，只能按像素解出「左半边一段文字、右边两颗按钮、一颗 accent 一颗 panel-3」），所以放的是两个现成能力：「重新扫描」（accent，主）+「添加软件」（panel-3）。左边是页面自己的状态行（原来在头部那行 `preview-note`）。**如果画板那两颗是别的东西，说一下就换**。
- **没做的（能力，不是视觉）**：`ui-strings.json` 里软件库的空状态写着「没有找到软件 · 换个关键词」，说明画板头部右侧那个 365×32 的 `panel-2` 长条大概是**搜索框** —— 那是新能力（关键词过滤），这一轮是视觉迁移、逻辑不动，所以头部右上仍是那排真工具栏（新建分组 / 添加软件 / 从扫描添加 / 重新扫描）。预置软件（`source: 'preset'`）也还没有数据源，所以画板里的 `[官方]/[推荐]/[基础]` 角标一处都没画。
- **坑：安全边和焦点环位要一起算**。网格要装 7dp 的焦点环就得比安全边宽一圈，但直接写 `margin: 0 -7dp` 会把网格撑到内容区整宽（实测卡片被撑到 160.66 而不是 152.7，最后一列的环还会被 `.k2-page` 裁掉）。正确写法是 **`margin: 0 calc(24 - 7 = 17)dp` + `padding: 7dp`**：盒子宽 14dp、内边距收回 7dp，卡片宽度回到 996/6，环也装得进去。探针现在会拦这条。
- **选择对话框没被带变**：卡片现在按 `variant` 分三种（`"shelf"` K1 卡片条 / `"grid"` K2 页面卡 / `"picker"` 旧卡）。`CardOptions.variant` 三处共用同一个类型（`CardOptions["variant"]`），页面网格传 `"grid"`、两个选择对话框仍传 `"picker"`，所以「添加卡片 / 从扫描添加」里还是原来那种紧凑卡。
- **`scripts/probe-ui.mjs`**：新增 10 条 K2 断言（6 列 / 卡 152.7×176 / 第一行 134 / 列行间隙 16 / 包头行 16+20 / 图标区 44+58 / 名称 114 / 底部行距下缘 16 / 操作条 48 / 头部有标题），并在六页签巡检里**顺手给每个页签存一张 `tab-<页>-<尺寸>.png`**（以前只有游戏库那一张，逐页迁移时看不到别的页）。自检图 `docs/redesign/preview/m2-k2-apps-1280.png` 就是这张。
- **本机验证**：`npx tsc --noEmit` / `npm run build` / `node scripts/audit-ui.mjs`（阻塞 0，待迁移仍是 46 处 —— 软件库换掉之后 `global.css` 那套 `.library-*` 只剩文件页在用，M3 一起收）；探针在 1280×720 与 1920×1080 全绿（含 K2 的 10 条），并逐像素核对了卡片四段的起点与底部操作条（note 行 + accent 按钮 96×32 + panel-3 按钮 96×32）。**CI**：`Lint` 在 `windows-latest` 上已绿（run 37208942966）。**真机（Windows 掌机）没装过**（这一轮没动 Rust）。

## 未发布：界面大改 M3 文件页（K7，2026-10-04）

画板 K7：**面包屑行 + 左「位置」栏 + 右文件表（三列表头）+ 底部操作条**。样式在**新文件 `src/styles/files.css`**（`global.css` 里那套 `.file-*` 现在只剩「选择程序」对话框 `FilePicker` 在用，一行没删）；**文件管理的逻辑一行没动**。

- **结构（`FilesPage.tsx` + `files/FilePane.tsx`）**：`.k7-head`（面包屑 + 工具）→ `.k7-body`（`.k7-places` 左栏 | `.k7-main` = 表单 + 列表 + 操作条）。单栏时面包屑渲染在页面头部（画板这样），双栏时每栏各带自己的面包屑与「左栏 / 右栏」标签（栏宽 490，行的三列用 `minmax()` 收窄）。`FilePane` 新增两个 prop：`sortKey`（表头要标出当前排序列）与 `dual`（单栏时不再渲染面包屑 —— 它已经在头部了）。
- **几何（画板实测，逐条写进 `files.css` 注释）**：面包屑 chip 顶边 52 / 高 30 / 圆角 8 / 片间 20（中间放「›」）；位置栏 260..460 × 98..652、行步进 **32**；表头 y=98..132、三列 x=**492 / 872 / 982**、下面 1px 分隔线；行盒 476..1256、首行顶 **146**、**步进 46**、图标 +13 / 名称 +45.5（都从行左算）；操作条 476..1256 × 610..656（高 46）、chip 高 28 圆角 6。
  - 三条「画板 vs 规范书」的取舍：① 行盒 **39 + 间距 7**（画板是 40+6）：环要 7dp，行挨行会环压环（侧栏行同一个坑），步进 46 不变；位置栏同理 25+7=32。② 操作条宽度**以画板为准 = 780**（= 文件栏宽、左缘 476），规范书 §7 写的 996 是错的。③ 行描边画板是 1px 银色（0.5dp 渲染），令牌里没有，取最接近的 `--line-strong`。
- **头部多出四颗 30dp 小按钮**：画板只有「搜索 104×30 + 排序 96×30」，但视图切换 / 显示隐藏 / 软键盘 / 返回上级都是既有能力，收成同高小按钮排在搜索左边（面包屑与搜索之间本来就有 ~400dp 空白）。四个排序键 + 升降序改成点「排序」**展开一行**（`.k7-sort-row`，形状沿用分组 chip 那套），`B` 会先把它收起来（`back()` 里排在弹窗前面）。
- **位置栏 vs 双栏**：位置栏是画板的常驻左栏，双栏时没地方放 —— 那时隐藏它，头部出现一颗「位置」按钮走原来的弹窗。两者取数分开存（`places` 常驻 / `placesDialog` 弹窗），单栏进页面取一次、切回单栏再取一次（不跟当前目录重取：六个位置是固定的，换目录只影响「哪个高亮」，那是本地 `samePath()` 比一下 path 的事）。
- **操作条作用于「选中项」，不作用于「焦点项」**：焦点变化不触发 React 重渲染，跟焦点会让按钮的可用状态停在上一帧（看着是亮的、点了没反应）。所以没选东西时复制 / 移动 / 重命名 / 删除是灰的，新建 / 粘贴 / 全选一直可用；左边那行字 = 「已选 N 项 · 名字」，没选时才是原来那行提示。
- **chip 上不写按键角标**：画板画的是 `X 复制 / Y 剪切 / ☰ 粘贴 / 长按 A 重命名 / B 长按 删除 / LB 新建文件夹`，但这轮只换视觉、**手柄绑定一个字没改**（X 还是「多选」、Y 还是「菜单」），挂角标就是假提示。要按 §13.2 改绑定是单独一轮。同理「剪切」文案用的是现有的「移动」（语义就是剪切，改文案会跟 Y 菜单不一致）。
- **坑：`<button>` 的 UA 默认内边距是 `1px 6px`**。新写的 `.k7-row` 没写 `padding: 0`，整行内容右移 7dp（图标 496 而不是 489、大小列 879 而不是 872），表头与行就不齐。旧的 `.file-row` 自己写了 padding 所以没暴露过。**以后新写按钮类记得显式写 `padding`**（`.k7-check` 同样中招）。
- **图标**：`NavIcons.tsx` 新增 `FolderIcon`（文件夹，accent）、`FileIcon`（「田」字，ink-3）、`SortIcon` / `KeyboardIcon` / `UpIcon` / `EyeIcon`；文件行不再用「夹 / 文」两个汉字。选择模式的勾选框改成**只在选择模式里出现**（常驻会把图标从 +13 顶到 +43、跟表头错位），鼠标多选没丢（Ctrl / Shift 单击）。
- **`scripts/probe-ui.mjs`**：新增 **17 条 K7 几何断言** + 3 条交互冒烟（「排序」展开 4 键再收起 / 操作条 8 个 chip / 选中一项后提示与可用性跟着变）；`KNOWN_RING_CLIP` 从 `["library-grid","file-list","page"]` 收成 `["library-grid"]`（旧的弹窗网格），六个页签实测「环都完整」。另补一条**左右键跨域**的回归网：逐页把每个可聚焦元素都试一遍，一直按左必须能进侧栏、侧栏每行一直按右必须能出到内容区（六页全过；首页 / 下载是占位页、没有可聚焦内容，按右留在侧栏不算失败）。自检图 `docs/redesign/preview/m3-k7-files-1280.png`。
- **本机验证**：`npx tsc --noEmit` / `npm run build` / `node scripts/audit-ui.mjs`（阻塞 0，待迁移 46 处 —— `files.css` 一处手写 px 都没有）；探针 1280×720 + 1920×1080 全绿；另逐像素核对了行盒 145..184 / 191..230 / 237..276（步进 46）、表头分隔线 131，并截图看过双栏与「位置」弹窗。**真机（Windows 掌机）没装过**（这一轮没动 Rust）。

## 0.1.58（一）：小组件删掉「自启」行；设置页那行改名「安装前端」（2026-10-04，已随 `v0.1.58` 发布）

- 小组件不再提供自启开关：那行只在 UWP 本地设置里记 `disableAutostartRequested`，真实自启（启动器的计划任务）它改不了，用户说「没用、不需要」。删了 `WidgetPage.xaml` 的整张卡片、`WidgetPage.xaml.cs` 的文案赋值与 `StartupClick`、`Strings.cs` 的 `Startup` / `StartupHint`；`using Windows.Storage;` 一并去掉（那两行是它在本文件仅有的用处）。契约文档 `frontend/gamebar/HANDOFF.txt` 第 67 行同步改写。启动器设置页自己的「开机自启」不受影响（那是 Rust `set_autostart` 在管）。
- 启动器设置页里装小组件那行改名「安装前端」（英文 `Install frontend`），提示改成「前端界面就是 Game Bar 小组件；随启动器自动装，点这里重装一次」，预览提示的「小组件」也改成「前端」。原来的名字用户看不出是装什么。名字与工具箱那张「前端（独立程序）」卡片（装托盘常驻的后台 exe）有重叠，是用户点的名，保留。
- 本机验证：`python3 frontend/gamebar/check-static.py` PASS（XAML 里 6 条事件处理器都能在 `.cs` 找到，删掉 `StartupClick` 后没有悬空事件）；`npm run build` 通过。**C# / XAML 的真编只能靠 CI 的 `gamebar.yml`，本机 macOS 编不了；这一版还没发。**

## 未发布：小组件改成「随启动器一起装」（已随 0.1.56 发出去，没在真机验证过）

- 目标：用户只装**一个**启动器安装包，装完按 Win+G 就能看到小组件 —— 不用自己开开发者模式、不用手动 `Add-AppxPackage`、也不用（更不能）双击那个未签名的 `.msix`。
- 怎么走通的：CI 现打一张自签证书（`frontend/gamebar/package-payload.ps1`，Code Signing EKU，Subject 必须**逐字等于**清单里的 Publisher `CN=FantasyHub`）→ `build-windows.ps1 -CertificateThumbprint` 签名并 `signtool verify /pa` → 把「签好名的 `widget.msix` + 公钥 `widget.cer` + 三个框架依赖」摆进 `src-tauri/payload/gamebar/`（启动器 `bundle.resources` 带上它们；仓库里另有 0 字节占位兜底，见 `src-tauri/build.rs`）。目标机上由 `src-tauri/gamebar/register-widget.ps1` 完成：证书进当前用户「受信任人」→ 装依赖 → 注册小组件 → 重启 Game Bar。**不需要管理员、也不需要开发者模式**（有签名 + 证书受信任就够）。
- 两个执行时机、一套实现：① `nsis/installer.nsh` 的 `NSIS_HOOK_POSTINSTALL` 跑一行等价的内联 PowerShell（只为「装完不打开启动器也能看到」，失败只打日志，**绝不阻塞启动器安装**）② 启动器每次启动在后台跑 `register-widget.ps1`（幂等：标记文件记「包 hash + 版本 + 证书指纹」，hash 没变就不动手；换证书签的新包先卸再装，因为同一个 identity 换证书不能覆盖安装）③ 设置页「安装前端」手动重装一次（2026-10-04 从「装 Game Bar 小组件」改名，原名用户看不出是装什么）。为什么不把脚本当资源交给 NSIS 调：PS 5.1 读没有 BOM 的 UTF-8 脚本会按系统代码页解，注释里的中文会乱码 —— Rust 侧写脚本一律 UTF-8 with BOM（`include_str!` + 预置 BOM），这个坑不再复制第三遍。
- 卸载：`NSIS_HOOK_PREUNINSTALL` 用一行 PowerShell 卸掉 `FantasyHub.GameBar`（那时 `$INSTDIR` 可能已被清空，所以它不依赖任何随包文件）。三个框架包与证书都不动 —— 证书主题 `CN=FantasyHub` 和 FSE 身份证书**一样**，按主题删会误伤，所以脚本只删「自己上一次装进去的那张」（标记文件里的指纹）。
- 工具链：`.github/workflows/build-windows.yml` 新增 `gamebar-payload` 作业（`windows-2022`，因为要 10.0.22621 SDK），产出 artifact 交给主作业下载进 `src-tauri/payload/gamebar`；主作业 `needs` 它但带 `if: always()`，所以**小组件编挂了照样发版**（那个安装包只是不带小组件，启动器会明说「这个版本没带小组件」）。`gamebar.yml` 也传一份同名 artifact，方便手动下载验证。
- **真机第一轮（2026-10-03，x64 掌机，28.28 MiB 安装包）**：自签证书这条路**通了** —— 证书能被 `Import-Certificate` 装进当前用户「受信任人」、AppxDeployment 也正常处理我们签的包，所以「不用开发者模式、不用管理员」成立。但小组件没出现在 Win+G，根因是**依赖带错了架构**：`Dependencies\` 下 x64/ARM/ARM64 三份**同名**共存，`Microsoft.NET.CoreRuntime.2.2.appx` 与 `Microsoft.NET.CoreFramework.Debug.2.2.appx` 文件名里不带架构 → 按名字取第一个拿到 ARM 版 → 目标机报 `0x80073D10 需要体系结构 ARM`、小组件随后报 `0x80073CF3 找不到框架`（这两句报错都看不出是 payload 的问题）。现在 `package-payload.ps1` 读每个候选包内 `AppxManifest.xml` 的 `Identity/ProcessorArchitecture` 来筛，只收 x64/neutral；找不到 x64 就带着候选架构列表报错；每带一个依赖打一行 `arch=`，并把小组件清单声明的依赖一并打出来。`register-widget.ps1` 装依赖前也先比架构，不一致直接点名「payload 带错了架构」。**教训**：同名多架构的产物，靠目录名或文件名猜架构迟早会错，读包内清单才是事实。仍未验证：Game Bar 重启后是否立刻枚举到新小组件、三个 Debug 框架包会不会和目标机已装版本打架。
- **真机第二轮（2026-10-03）**：架构筛选后小组件**出现在 Win+G 里了**，第一轮那两个报错（`0x80073D10` / `0x80073CF3`）消失。用户随即提了两条：① 界面丑，要跟原来网页版长得一样 ② 它只能待在「小组件」栏，不能像微星那样常驻。
- **界面重做（本轮，未在 Windows 编译）**：`WidgetPage.xaml` 整个按 `src/styles/global.css` 的 `:root` 换算 —— 对角渐变背景（`#0b1220 → #121c2e 55% → #0a101b`）、圆角 16 卡片（对齐 `.tdp-panel` / `.setting-row`）、28px 标题 + 胶囊工具按钮（`.library-tool`）、预设 3 列网格。做法是**覆盖主题资源键**（`ToggleButtonBackground*` / `ToggleButtonForeground*` / `ToggleButtonBorderBrush*` / `SliderTrack*` / `SliderThumb*`）而不是重写控件模板：键名写错只是不生效，不会让 XAML 解析失败，这是本机编不了 Windows 时最稳的改法。预设按钮因此从「GridView 选中项」换成 `ToggleButton` + `PresetOption`（`IsChecked` 单向绑 `On`），因为容器选中态改不了内部文字颜色；`On` 的 setter 无条件通知，否则连点同一个预设会停在 ToggleButton 自己翻出来的状态上。驱动信息、语言选择（移到页脚）、刷新/关闭（移到头部）都保留，功能与原来一致。
- **界面第三轮（真机反馈后，本轮，未在 Windows 编译）**：上一版有三个上真机就立刻暴露的问题，都已修。① **预设按钮撑不满宽度**：`GridView` 的 `ItemsWrapGrid` 决定每项宽度用的是「集合里最宽那项的期望宽度」，不是容器三等分 —— 真机照片实测卡片内宽约 384 逻辑像素、三个按钮只占 168，右侧空一大片，`10W` 的尾笔被裁得像 `10V`（用户原话「按键贼小、文字显示不全」）。改成**代码生成的 3 列 `Grid`**（`SyncPresets` 里建 `ToggleButton`，列宽 `*`、行 `Auto`），字号 16→18、高 44→56；`PresetOption` 随之删除（它只为 `IsChecked` 单向绑定存在，现在直接赋值，连点同一个预设的复位语义反而更清楚）。② 头部按钮 `CornerRadius` 999 → 10：用户要的是「方块 + 小圆角」，胶囊在这块面板里像两个大椭圆。③ 覆盖 `Button*` 主题键：UWP 默认模板的 hover / pressed / disabled 状态是直接刷 `ContentPresenter` 的，Style 里设的 `Background` 会被盖掉 —— 真机上「风扇控制 · 暂未开放」被禁用后就是那条发亮的灰横条、字几乎看不见。顺带：`ComboBox*` 主题键统一深色、焦点视觉统一成 accent（`FocusVisualPrimaryBrush`；系统默认白框会和 checked 的 accent 底打架，看着像两个预设同时被选中，而原前端 `[data-focusable]:focus` 本来就是 accent 描边）、小字放大 1px 并去掉上一轮多加的 `Opacity 0.75/0.7`（原前端没这一项）。④ 卡片里的设备行改回原前端 `.tdp-cpu` 的写法：只显示 CPU 名，拿不到才回退到 vendor/backend（真机那行「… · intel · intel-msr」把内部字段露在外面，一眼就不是原版）。
- **为什么不直接嵌网页**：UWP 的 `WebView` 是 EdgeHTML，Win11 上已经不能用；WebView2 要额外运行时且 UWP 支持面受限，而小组件窗口只有 440×620 —— 所以走 XAML 还原视觉，不搬 React 那套。
- **常驻怎么来**：清单里 `<PinningSupported>true</PinningSupported>` 就是开关（已开，`HomeMenuVisible` 也已开）；但 winmd 里**没有 `Pin()` 方法**，只有 `Pinned` 属性和 `PinnedChanged` 事件 —— 固定这个动作只能由用户在小部件菜单里点图钉完成，程序替不了。pin 的具体入口还没在真机上亲眼确认，以用户反馈为准。
- 踩过的坑（第一次跑 CI 就撞上，两轮才定位到根因）：想让 `signtool verify /pa` 通过，就得把自签根写进 Root 信任存储；而在 Windows 上往 Root 写证书（`Import-Certificate` 和 `X509Store.Add` 底层是同一个 API，换写法不换行为）会弹「安全警告」等用户点确认 —— **CI 上没人点，这一步就永久挂着**（实测卡十几分钟，只能人工取消；而且作业没结束前 `gh` 拿不到日志，只能靠脚本自己打的 `==> n/6` 进度定位到具体是哪一步）。最终修法：**CI 不建立信任**，`widget.cer` 只用 .NET `Export` 写文件、完全不碰证书存储，`build-windows.ps1 -SkipVerify` 跳过链验证，签名有效性交给目标机安装时 AppxDeployment 的校验（那才是权威裁判）。`build-result.json` / `widget-payload.json` 因此多了 `chainVerified` 字段（CI 上恒为 false）。
- 后续可选：把签名证书固定下来（PFX 存 GitHub secret，`package-payload.ps1` 优先用它）→ 版本更新时证书不变，可以省掉「先卸再装」；框架依赖从 Debug 换成 Release（那时依赖清单要同步改 `build.rs` 与 `tauri.conf.json` 里的路径）。

## 0.1.56：独立前端改做 Game Bar 后台，界面交给原生小组件（首次随包发出去，未验证）

- 独立前端**不再创建窗口**：`frontend/src-tauri/tauri.conf.json` 的 `windows` 为空，`main.rs` 只起托盘 + 回环监听 + 更新握手，不再 `mod overlay / chord / shot / topmost / library / games`。界面改由 `frontend/gamebar` 承担：原生 UWP C#/XAML 小组件（`microsoft.gameBarUIExtension`）+ **同包全信任**的 Bridge `FantasyHub.GameBar.Bridge.exe`。
- 这一刀为什么能了结 0.1.33–0.1.55 那串「浮层在屏上却看不见、关不掉」的旧账：窗口不再由我们显示 / 置顶 / 抢前台，而是 Game Bar 显示它自己的小组件宿主。**这是结构性判断，还没有任何真机证据**。
- 密钥不进 UWP：小组件把请求发给同包 AppService，Bridge 每次请求**现读** `%APPDATA%\handheld-launcher\widget-ipc.json`（proto / port / token / pid / version），加上 token 再连 `127.0.0.1`。小组件既不读发现文件也不接触 token。
- Rust 侧（本轮唯一真正验证过的部分）：`widget.rs` 只绑回环、一连接一请求、令牌定长逐字节比较（不提前返回）、请求行 4096 字节上限、读 / 工作 / 总预算分开计时；`widget_protocol.rs` 用 `deny_unknown_fields` 拒绝多余字段，并校验 proto=1、id≤64 UTF-16、watts 1..1000、gameId≤512、locale 只认两种；`widget_discovery.rs` 用 ACL + 原子替换，失败时把临时文件截到 0 字节（不把密钥留在盘上）。`cargo clippy --workspace --all-targets` 退出 0。
- **本轮修的一个真缺口**：`status.data` 少了 `locale`，小组件因此永远读不到语言（`set_locale` 只影响当次会话，重启后又回系统语言）。契约文档（`frontend/gamebar/HANDOFF.txt` 第 50 行）本来就要求这个字段，现已补上。
- 契约对不上的三处，**记录但没改**（① 后来用「删行」解决，② ③ 仍未改）：① ~~Rust 实现了 `set_autostart`，Bridge 白名单却只有 status / set_tdp / quit_game / set_locale（`Loopback.cs` 里 `extra == null` 直接拒），所以小组件发不出去 —— 那边的「自启」开关只存本地意图、提示用户手动关，**不能描述成迁移已完成**~~：2026-10-04 按用户要求把小组件那行自启**整行删掉**（见本文第一节），白名单里始终没有 `set_autostart` 这件事也就不再有出口；Rust 的 `set_autostart` 只服务启动器自己的设置页与托盘；② Rust 响应上限是 24000 UTF-16，HANDOFF 写 1 MiB、Bridge 按 48000 收（Rust 更严，属偏安全的文档漂移）；③ `driver` 多一个 `elevated` 字段，C# 侧是逐键带默认值的容错取值（`Models.cs`），多字段无害。
- **旧界面已经接不上，但代码全部保留**（等真机验证后再单独一次提交清理）：`frontend/src-tauri/src/` 下的 `overlay.rs` / `chord.rs` / `shot.rs` / `topmost.rs` / `library.rs` / `games.rs` 已不在 `mod` 列表；`src/frontend/*`、`frontend.html` 与 `vite.config.ts` 的 `frontend` 入口没有任何窗口加载。**下面三节记录（窗口显示候选 / 加载态诊断 / 输入链路）描述的都是这套旧界面**，其中 `topmost.rs` 那个「普通应用窗口显示候选」已不可能生效。
- 本机只跑了 Rust（clippy 退出 0）与源码静态检查（`python3 frontend/gamebar/check-static.py` PASS：XML / PNG / WAV / XAML handler / 工程输入 / NuGet 版本）。
- **C# 与 XAML 已经真编过（2026-10-03，CI 的 `windows-2022`）**：Bridge、Widget 两个工程都 `Build succeeded`，打包也过，产出 `FantasyHub.GameBar.Widget_0.1.55.0_x64_Debug.msix`（31 个条目 / 10.6 MB）。核对过包里内容：`Bridge\FantasyHub.GameBar.Bridge.exe` 与 `.exe.config` 在 `Bridge\` 下、`Assets\*.png`(4) + `Assets\Sounds\*.wav`(9) + `GameBar\index.txt` + `Properties\Default.rd.xml` 各只有一份 —— 小组件能取到全部素材，且没有把 Bridge 产物的路径搬到素材名上。
- **第一次真编确实抓住了东西**：`63414f7` 的 C# 编过了，倒在 AppX 打包的 15 个 `APPX1111`（同一目标路径两份不同大小的文件）。根因是 `FantasyHub.GameBar.Widget.csproj` 的 `BuildBridge` 在 target 里对 `Content` 写未限定的 `<Link>Bridge\%(Filename)%(Extension)</Link>`：`%(...)` 按整个 `Content` 集合分批，把 Bridge 输出那 2 个匹配复制成了 15 个既有素材名。改成先收进独立项目类型 `BridgePayload` 再用 `%(BridgePayload.*)` 限定，`65728b6` 转绿。这类只能在 Windows 上看见的错误，正是这个作业存在的理由。
- **验证边界（别把上面读成能用）**：包**没有签名**（`AppxPackageSigningEnabled=false`，产物是带 `Install.ps1` 的 `_Test` 侧载目录），装不上也不能装；Game Bar 里到底能不能显示这块小组件、同包 AppService 能否把请求送到 Bridge、Rust↔C# 的请求往返，全部**没在真机上跑过一次**。Bridge 还留着 `MSB3245: System.Runtime.WindowsRuntime` 未解析的警告（编译用的是 NuGet ref 副本，该程序集没进包），运行期是否够用未知。第 8–13 行那些「没有真机证据」的话仍然有效。
- 新增 `.github/workflows/gamebar.yml`，钉 `windows-2022`（工程写死 `TargetPlatformVersion=10.0.22621.0`，而 `windows-latest` 只有 26100 SDK）：静态检查是硬闸门；Debug 真编已在 `65728b6` 首次全绿（0 error 的 msix），**2026-10-03 已转硬闸门**。
- **别再被 `continue-on-error` 骗（2026-10-03）**：小组件界面的第三轮改动里给 `Grid` 写了 `IsEnabled="False"` —— `Grid` 是 `Panel`，UWP 的 `IsEnabled` 在 `Control` 上（只有 WPF 把它放在 `UIElement`，所以凭记忆写就会错），XAML 编译器直接报 `WMC0011: Unknown member 'IsEnabled' on element 'Grid'`。麻烦的是这一步带 `continue-on-error: true`，**作业照样报 success**，于是 `Build Windows` 的 release 里，启动器安装包整块少了小组件：**30.22 MB → 7.8 MB**，而 release 页面看不出任何异常。识别方法有三条，都比"CI 绿了"可靠：① 安装包体积（差 ~22 MB 就是 msix + 三个框架依赖没带上）② `gamebar-payload` 上传的 artifact 大小（正常十几 MB；空转时只有 885 字节）③ 日志里搜 `Build succeeded` / `error WMC|CS|XLS`。现在这步已改成硬闸门，`SetPresetsEnabled` 也改成逐个 `ToggleButton` 设 `IsEnabled`（外层 Grid 只负责变暗）。


## 未发布：普通应用窗口显示候选

- 前端取消 `skipTaskbar`，呼出时明确清除 `WS_EX_TOOLWINDOW` 并设置 `WS_EX_APPWINDOW`；不再手写置顶位，仍由原有 `SetWindowPos(HWND_TOPMOST)` 完成置顶。样式变化时随同刷新窗口框架，不增加抬升或抢前台次数。
- 这是验证 FSE 应用筛选的最小候选，不是已证根因或已证修复。可见时前端会进入任务栏和 Alt+Tab；隐藏启动、关闭后隐藏、独立生命周期、自启禁用意图、更新握手及受限 IPC 不变。
- 本机网页构建、工作区 Clippy 与差异检查通过（已有 dead_code 警告）；Windows 分支未编译验证，尚未打包或实机对照。验收须分别确认 FSE 应用切换器列出前端、呼出后实屏可见可操作，以及桌面模式回归；窗口状态与 GDI 截图不能代替。
- **本节已失去验证对象**（见上一节）：这里说的窗口已经不由前端创建，`topmost.rs` 也不再被 `main.rs` 引用 —— 留下这节只为记录当时的判据，不再是待验证项。

## 本轮未发布：排除加载态误判，补齐尺寸诊断

- 最新实测仍不可见、不可操作，根因未确定。截图日志早于页面收到显示代数；旧界面在驱动状态尚为空时也显示“启动器没运行”，因此截图不能证明 IPC 失败。发现文件的端口/PID 与本次启动器监听记录一致，但不证明请求成功。
- 加载态改为“正在读取”，失败保留实际错误；前端 Rust 记录驱动请求开始、结果及耗时，不输出发现文件或密钥。
- 窗口快照追加普通样式、客户区本地坐标、DWM 框架边界及窗口 DPI；用于核对外框超出 22×56 的原因，不认定它造成整页不可见。不改定位、置顶次数或独立生命周期。
- 本轮网页构建、工作区 Clippy 和差异检查通过（已有 dead_code 警告）；新增 Windows API 尚待 Windows CI，未提交、推送或打包，不以先前测试包 CI 替代。

## 0.1.56：输入链路与显示调度修正

- 组合键触发者取得导航所有权，断连才回退；组合键部分释放不再重触发，参与手柄全部中性后才重新解锁。Start 单键不关闭，保留 B / Esc / 关闭按钮。
- 页面常驻监听本进程 `frontend-pad`；显示代数拒绝迟到状态，`overlay_state` 每次查询完成后 400 ms 串行兜底。注册失败重试；监听建立、换代、换手柄或隔离之后，须收到未隔离中性包才接受输入。关闭按钮可用手柄聚焦。
- 窗口开关及后台抬升统一排到主线程，执行抬升前检查代数和可见位，防止旧重试复活已隐藏窗口；每次开关只发布一次新代数。页面通过本进程 `overlay_hide` 关闭，不直接隐藏窗口。
- 新增限流的手柄发送/状态变化、页面注册/收包/动作/失败记录；各页面阶段独立限流，异步抬升区分排队与执行。关闭命令返回仅表示调用结束，不是实际隐藏成功回执，执行失败仍以 Rust 日志及后续状态为准。
- 本机网页构建、工作区 Clippy、8 项输入单测、20 项库单测与差异检查通过；前端真实组件内存模拟 25 个断言通过，但不等于 WebView/Windows 联调。Windows Lint、安装包与 FSE 真机可见性/操作仍未验证，物理不可见根因未确定；未推送、升版或发布。

## 0.1.55：FSE 呼出前后只读取证

- 用户已确认最新日志末尾操作发生在 Xbox 全屏体验内；按键、显示调用、可见位及置顶位正常，仍不能证明用户能看见。根因未确定，本版不改自启、手柄触发、显示策略及重试次数。
- 新增 `frontend snapshot`：`before-toggle` 在开关决策前，`before-show` 在定位/置顶/抢前台前，`after-show` 在显示流程后；短看护第 1、8 轮即使置顶位正常也记录。毫秒时间、采样耗时、预期代数与实际首尾代数用于辨别快速开关和并发交错；采样并非原子快照，短时间关闭会取消旧轮延迟采样。
- 记录当前进程会话/窗口站/输入桌面，以及自身、前台和最多 4 个上方相交候选窗口的 PID、线程所属桌面、会话、矩形、置顶位、DWM 遮蔽标志、显示器设备/边界/工作区。遍历最多 256 个窗口，截断明确标记；无法读矩形时保留未知候选，失败记录未知及错误码。输入桌面只读打开并关闭，不切换桌面；同进程窗口不读取标题，避免同步消息阻塞 UI/手柄线程。
- **判读边界覆盖下文历史描述**：`on_top` 仍只是 `IsWindowVisible && WS_EX_TOPMOST`，不是无遮挡判据；即便都为真，第二次按键仍可能 hide。相交 Z 序、同名桌面、DWM 未遮蔽都不能单独证明 FSE 最终输出可见；GDI 截图有面板或非黑像素也不能反驳用户观察。主显示器定位策略保持不变，不能预先认定放错屏。
- 同步采样和日志写入有耗时，不宣称时序完全不变；原有置顶/抢前台动作保留，“只读”指新增查询。Windows 编译、安装包构建与掌机实际可见性分别验收。

## 0.1.54：自启与更新边界

- 自启以系统任务的真实状态为准，不再将查询失败当作任务缺失；已有任务被禁用时不补启动。迁移只调整电池、空闲和超时条件，保留现有主体、动作、触发器及禁用状态。
- 托盘切换需要完成任务启停、意图标记、旧 Run 清理和读回；部分失败显示错误，并保留原目标供重试，避免下一次点击反向操作。仅独立安装且没有任务时仍使用 Run 回退，不擅自创建任务。
- 内层安装器先启动新前端，外层才清理更新退出请求。因此请求不能仅判断“文件存在”：现在按请求修改时间与进程启动时间区分代际，只退出请求之前的实例。它不是严格会话/PID绑定，时钟精度和并行安装仍有边界。
- 后台参数的第二实例不再无条件显示浮层；普通无参数启动仍可唤出。退出意图写入失败不退出，清理握手失败明确报错。
- 本机构建和单测、Windows CI 编译、掌机实测分别验收；自启权限、禁用迁移、电池/FSE会话、更新后驻留、手柄与 TDP 的实际效果仍待 Windows 真机确认。

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
| 能对另一方做的动作 | **什么都不能**：不起进程、不杀进程、不发生命、不注册它的快捷键。**0.1.52 起有一处例外**：「启动器启动时发现前端没在跑 → 把它拉起来一次」（`frontend_tool::ensure_running`）。理由是更新完之后那一段空窗里谁都不管前端，而启动器是唯一确定在跑的一方 —— 但**只在这一刻、只做这一次**：不做看门狗（用户从托盘点「退出前端」是明确意图），也不结束任何进程 | 仅通过本地 IPC 请求 TDP 读写 |
| 快捷键 | **全部移除**（Back+Start 监听、Ctrl+H 全局热键、Start 键绑定全删）；手柄侧只保留「设置」键，且改成**双击** View / Share（理由见 §10） | 只有两个：`Back+Start`、`Ctrl+H`，都是开/隐藏切换 |
| 窗口 | 主窗（无边框全屏 FSE） | 无边框浮窗 440×800、置顶、贴右、`skip_taskbar` + `toolwindow` |
| 常驻 | 现状 | 托盘常驻；「关闭」= 隐藏，进程不退，秒开 |
| 自启 | 现状（自己管） | 自己管：**计划任务** `FantasyHubFrontend`（登录后延迟 10 秒、普通权限、失败重启；0.1.53 起，不依赖 explorer）；HKCU Run 只作兜底，托盘菜单可切换 |
| FSE 稀疏包身份 | 归启动器 | **不注册**（它不是全屏壳） |

启动器里唯一保留的前端入口：**工具箱 → 「前端」卡片，只做文件级安装/更新/状态**，没有任何「打开/关闭前端」按钮。

> **0.1.52 的唯一例外**：启动器**启动时**发现前端进程没在跑，会把它拉起来一次（`src-tauri/src/frontend_tool.rs::ensure_running`，在 `lib.rs` 的 setup 里调用一次）。这不是恢复「启动器管前端」：判据只读进程表，动作只有「按 `frontend.json` 报的路径 spawn 一次」，不做看门狗、不结束任何进程。为什么必须补这一下：0.1.51 的真机日志里，安装包替用户启动过一次前端（`FantasyHubFrontend start pid=27664 v0.1.51`），它随后无声消失，用户接着按 `Back+Start` —— 按键没有任何响应者，而这段时间里**只有启动器在跑**。日志里表现为 `frontend ensure: already running (skip start)` / `started pid=…` / `not running and not installed`。

## 3. 前端软件自己的能力

- **进程检测 / 退出游戏：前端自己实现**。纯用户态即可（`CreateToolhelp32Snapshot` 枚举 + `TerminateProcess` 结束），**不需要提权**，所以脱离启动器也能用。
- **TDP：走本地 IPC 问启动器**（见 §4）。启动器没跑时，TDP 区显示「启动器未运行」/「需要管理员」，其余功能照常，绝不阻塞打开。
- 手柄输入：自带 XInput 轮询（不依赖窗口焦点），所以在游戏里、在启动器全屏上都能唤出。
- **大屏模式（FSE）下的层级**：全屏的启动器是**前台窗口**，而 `set_always_on_top` 只保证窗口**属于**置顶层 —— 同层里谁压谁看**激活顺序**，后台进程的 `show()` / `set_focus()` 又会被 Windows 的前台锁静默挡掉（不报错）。三件事凑一起就是「窗口已显示、位置也对、`is_visible()` 也是 true，人却看不见」。0.1.39–0.1.45 的解法是 `detach_owner` + `force_topmost` + `steal_foreground` 这三件 Win32 手法，0.1.46 拆成独立程序时漏掉了（只剩一句 `set_always_on_top`），0.1.48 补回。现在它们住在 `frontend/src-tauri/src/topmost.rs`，由 `overlay.rs::show()` 在显示前后各调一次，**不要删**。桌面模式看不出差别（启动器只是窗口化的普通窗口），只有大屏模式会露。
- **排查层级问题**：0.1.55 的快照字段与边界见顶部。窗口在上方仅是 Z 序候选，不证明遮挡；启动器的大屏/桌面日志是应用状态，不是系统 FSE 会话的独立证明。
- **0.1.53 起：大屏模式壳体常态让位**。保留壳体降层、前端抢前台与短看护；开关判据为可见位与置顶样式，而非实际遮挡检查，因此仍可能 hide 肉眼不可见的窗口。旧版将此称为修复的结论已撤回，0.1.55 只补取证。
  - **这一行必须永远出现（0.1.50）**：0.1.48 的现场快照挂在 `if let Some(..)` 后面，而它在真机上一次都没打印出来 —— 于是既不知道 Z 序、也不知道前台、更没有像素。现在无论成功失败都写（`hwnd=none visible=? — no handle` 也是一种结论）。
  - **截图取证（0.1.50）**：显示及自检后用 `GetDC(NULL)` + `BitBlt` 保存 `overlay-shot.bmp`，每次覆盖。只证明 GDI 可读到的像素；有面板或非黑像素不保证 FSE 物理输出可见，黑图也不能区分未渲染与抓取限制。
  - **自检 + 重试（0.1.50）**：显示之后每 120 ms 问一次 `IsWindowVisible` + `WS_EX_TOPMOST`（`topmost::on_top`，**不是** Tauri 的 `is_visible()` —— 那个被压住时照样 true），最多 5 轮；没到位就再顶一次（`retry_top`，**不碰前台锁**，不像 `grab` 那样补按 Alt），每次重试记 `frontend show retry n/5 (…)`。这段跑在**后台线程**上（托盘菜单与第二实例的回调都在主线程，连等 600 ms 会冻住界面），并且每次显示 / 隐藏都会把代数 `GENERATION` 加一，让上一轮作废 —— 否则它的 `SetWindowPos(..., SWP_SHOWWINDOW)` 会把用户刚关掉的窗口又显示出来。
  - **「谁在跑 / 按键到没到」也要可观测（0.1.51）**：`chord.rs` 第一轮**一定**打印一条手柄状态（`chord pad connected index=0` / `chord pad none（读不到手柄：Back+Start 不会有反应）`，`pad_index` 初值给不可能的 `u32::MAX` 以保证必写），之后只在变化时记；和弦触发多一行 `chord fired (Back+Start)`（它 + `frontend show begin` 才是「按了、也进来了，卡在显示」）；每 5 分钟一行 `chord alive pad=… visible=…`，证明 XInput 轮询线程没死。启动器那边同步记前端**进程**的生死（`overlay watch: frontend process up/down`，第一轮必记），两个程序也都会把 panic 写进同一份日志（`<tag> panic (文件:行, thread=…): 原文`，见 `fh_core::logutil::install_panic_hook`）。**为什么值得单列**：0.1.50 的真机日志里前端起来之后一行按键记录都没有，而「前端没在跑 / 崩了 / 手柄没读到」这三种情况在那份日志里长得一模一样，排查成本全花在了猜上。
  - **「进程没了」也要说清是谁的锅（0.1.52）**：0.1.51 那轮的日志给出了第一种确凿情形 —— 前端起来过、手柄也读到了（`chord pad connected index=0`），可**按 `Back+Start` 时前端进程已经不在**（启动器自己记的 `overlay watch: frontend process down`），而两边都没有一行退出记录。三处补齐：① **前端自己记退出**（`main.rs` 用 `build()` + `app.run(..)`）：`frontend exit requested (code=…)` 与 `frontend exit` —— 托盘退出 / 关掉最后一个窗口 / 安装器握手走的都是 `app.exit()`，有这两行才能说清它是「自己退的」；两行都没有才是被杀或原生崩溃。② **启动器的进程扫描分三段**（`overlay_watch.rs`）：`frontend process up (pid=…)` / `… down（…；相关进程：…）` / `… scan failed: …（这一轮没查成，不代表它没在跑）` —— 报 down 时把镜像名带 `fantasyhub` 的在场进程一起写出来（真出现 `FantasyHubFrontend.exe` 就是判据看漏了），快照失败时不动状态、只记一次原因。③ **启动时补一次「前端在跑」**（`frontend_tool::ensure_running`，见 §2 的例外说明），并记 `frontend ensure: started pid=…`。
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
- **自启的落点（0.1.53 起改）**：前端自己的开关仍然由前端的安装钩子触发（`FantasyHubFrontend.exe --enable-autostart` → 托盘菜单里那个勾选项，走同一个值名，状态必然一致；前端程序本身不偷偷写注册表）。但**落点从 HKCU Run 换成计划任务** `FantasyHubFrontend`（`crates/fh-core/src/autostart.rs`）：Run 键由桌面 shell（explorer）在登录时处理，而 Win11「Xbox 模式（全屏体验）」的会话里**没有 explorer** —— 于是 FSE 里前端压根不会被启动（真机上表现为「开机后前端不在」）。任务由任务计划程序拉起，任何会话都在，且能配「失败后重启」（崩溃/被杀会回来；托盘退出是 exit code 0，不算失败，不会被重启）。**建任务这件事由启动器做**（它提权，且启动时本来就要补一次「前端在跑」，见 `frontend_tool::ensure_running`）：任务不在才建、不覆盖已存在的（用户可能在托盘关过自启）；启动时优先 `schtasks /run` —— 任务写的是普通权限，而直接 spawn 会继承启动器的管理员权限，同一个前端两种权限会让 UIPI 在不同会话下表现不一致。这一条**又一次放宽了 §2 的边界**（启动器碰了前端的自启任务），理由同上一条：没人管的那一段空窗只能由唯一确定在跑的一方补上。`frontend-stopped` 标记则保证「用户主动退出」在这一轮登录里被尊重（下次登录由任务启动时清掉）。
- 卸载：前端由它自己的安装包卸载（Tauri 生成的卸载流程本来就会处理"自己的程序还在跑"）；启动器卸载只删自己的目录/payload，**不杀前端进程**。
- **Game Bar 小组件走同一条路（未验证）**：启动器安装包还带 `payload/gamebar/`（签好名的 msix + 证书公钥 + 三个框架依赖），`NSIS_HOOK_POSTINSTALL` 里一行 PowerShell 把它注册到当前用户，`NSIS_HOOK_PREUNINSTALL` 再卸掉；完整逻辑在 `src-tauri/gamebar/register-widget.ps1`，启动器每次启动幂等补一次（见文首「小组件改成随启动器一起装」）。

## 6. 代码组织（阶段 1 已落地）

- 仓库根 `Cargo.toml` 是工作区根：成员 `src-tauri`（启动器）、`frontend/src-tauri`（独立前端）、`crates/fh-core`（共享内核）。**cargo 的目标目录因此变成仓库根的 `target/`**，不再是 `src-tauri/target`；CI 的 rust-cache 与产物路径已同步成 `". -> target"`。
- 三个 crate 的版本号取自根 `[workspace.package] version`。发版时改这一处 + `package.json` + 两个 `tauri.conf.json`，并让 `Cargo.lock` 跟上（本地跑一次 `cargo metadata` 即可，不必编译）。注意 `[profile.release]` 只能写在根：写在成员里 cargo 会忽略（只告警）。**Game Bar 小组件是第 6 处**：`frontend/gamebar/Widget/Package.appxmanifest` 的 `Identity Version`（四段，如 `0.1.55.0`）不在上面这套联动里，漏改会让新包沿用旧版本号、装上去被系统当成同一个包。
- **`fh-core` 铁律：只放不带 `#[tauri::command]` 的纯逻辑。** Tauri 的 `allow-<命令名>` 权限是构建时按 app 自己的 crate 源码生成的，命令搬进依赖 crate 会扫不到、capability 直接报错。所以命令留在各自 app 里，`tdp` / 进程 / IPC 的**实现**放 `fh-core`，由 app 的命令薄薄包一层。阶段 1 只搬了 `logutil`（启动器侧用 `pub use fh_core::logutil;` 保住所有既有调用点）；Rust 侧 `i18n` 暂不共享，UI 文案继续靠共享的 `i18n/catalog.ts`。
- 两个 app 各自一份 `tauri.conf.json`：启动器（FSE 全屏窗 + `requireAdministrator` 清单）、前端（`visible: false` 的置顶贴右窗 + 无清单、不提权）。**（迁移后前端那份只剩 `windows: []` 加一个回环服务，不再有窗口；它现在服务的是 Game Bar 小组件，见文首未发布节。）** **`tauri build --config` 是「与默认配置合并」语义，不能用来切项目**：第二个 app 必须在自己目录里跑 CLI（`projectPath: frontend`）。前端那份配置因此不写 `beforeBuildCommand`，Web 产物由启动器那次 `npm run build` 一次构建、两边共用。
- Web 侧：同一 Vite 工程多入口 —— `index.html`（启动器，`src/main.tsx`）、`frontend.html`（前端，`src/frontend/main.tsx`）；共享 `i18n/catalog.ts`、`audio/sfx`、需要的样式。
  - **前端那份 `tauri.conf.json` 的窗口必须写 `"url": "frontend.html"`。** Tauri 的 `WebviewUrl` 默认值是 `index.html`，不是「跟着入口页走」；漏写的后果是正式包里前端窗口加载**启动器**的整屏界面（dev 下 `devUrl` 已经带了 `/frontend.html`，所以只在安装包里露出来）。0.1.46 就是这个情况，0.1.47 修。**（迁移后前端那份已经没有窗口，「前端窗口」整个概念取消，这条只对历史版本有效。）**
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
- `tray.rs`：托盘菜单「显示 / 隐藏前端」「开机自启（勾选项）」「退出前端」；左键单击图标也是开关；图标直接用 `default_window_icon()`；自启**0.1.53 起优先驱动计划任务**（`fh_core::autostart`），任务不在时才退回 `tauri-plugin-autostart`（HKCU Run，值名取各自的 productName，与启动器的自启互不覆盖）。托盘安装失败**不再让前端起不来**（只记一行 `tray install failed: …` 继续跑）—— FSE / 无桌面 shell 的会话里 `Shell_NotifyIcon` 可能建不起来，而浮层、手柄、热键都不依赖它。
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
- `chord.rs`：浮层可见时每 40 ms 推送导航状态；隐藏时推送变化与约 400 ms 中性心跳。`frontend-pad` 另带可见位、代数、控制手柄和隔离位，仅发往本进程 main 页面。
- 权限：`frontend/src-tauri/permissions/frontend.toml` 声明业务命令及仅限本进程的状态/关闭/诊断命令，capabilities 逐条放行；保留 `core:window:allow-set-title`（i18n 切语言时会设窗口标题）。
- Web：`src/frontend/FrontendShell.tsx`（外壳）、`FrontendPanel.tsx`（TDP 面板 + 运行中游戏 + 退出游戏，从 0.1.45 的 `FrontendPage.tsx` 搬来）、`library.ts`（库/进程访问）、`frontend.css`（`.frontend-shell*` 样式从启动器 global.css 搬来）。外壳使用本进程 Rust 发布的带代数显示状态：常驻事件监听配合 400 ms 串行查询兜底，不依赖 Web 层 `isVisible()`，不监听跨程序状态。该状态不代表用户实际能看见。

**这一阶段删掉的两处旧逻辑**：①"游戏退出就把前端收起来"（前端现在只属于用户）；②前端的"安装 TDP 驱动"按钮（要管理员，入口留在启动器工具箱，前端只显示状态与去哪装）。

### 阶段 5：安装与更新（**代码已写，未编译、未提交**）

- `crates/fh-core/src/handshake.rs`：更新前"请前端退出"的一次性握手（标记文件 `quit-for-update`；`POLL_MS = 2s`，安装器等 `WAIT_MS = 6s`）。
- `crates/fh-core/src/presence.rs`：前端启动时写 `frontend.json`（自身 exe 路径 + 版本 + 时间），启动器读它显示安装状态。
- 前端：`main.rs` 启动时 `presence::record()`，并起一个线程每 2 秒看握手标记，看到就 `app.exit(0)`（真正退出，不是隐藏）。
- 启动器：`frontend_tool.rs` 新增 `frontend_status` / `frontend_install` 两个命令（只看状态 + 跑随包安装包，**不含任何启动/结束前端的调用**），权限与 capability 已加；工具箱 `ToolboxPanel.tsx` 顶部多一张「前端（独立程序）」卡片；catalog 补 6 个键（中/英）。
- NSIS：启动器 `src-tauri/nsis/installer.nsh` 的 `NSIS_HOOK_POSTINSTALL` 写标记 → 等 6 秒 → `ExecWait ... /S` 装 payload 前端 → 删标记（用 `Push/Pop` 保护寄存器）；前端 `frontend/src-tauri/nsis/installer.nsh` 装完调 `--enable-autostart`。两个 `tauri.conf.json` 都加了 `windows.nsis.installerHooks`，启动器 `resources` 加了 `payload/frontend-setup.exe`。
- 启动器 `build.rs`：给 `payload/frontend-setup.exe` 补一个空占位（和 FSE 身份文件同一套做法），本地/dev 构建不会因为 bundler 找不到资源而失败；`.gitignore` 忽略 `src-tauri/payload/`。
- CI：新增显式 `npm run build`（Web 只构建一次、两个程序共用）；顺序改成 **前端安装包 → stage 成 payload → 启动器安装包**；Artifacts 与 Release 依旧同时带两个安装包。

## 10. 手柄归属（谁在什么时候吃手柄；0.1.49 立规矩，0.1.50 修误判）

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

1. **稳态：浮层在屏上 → 启动器不吃手柄**。`src-tauri/src/overlay_watch.rs` 每 200 ms **只读**观察「有没有属于 `FantasyHubFrontend.exe`、**而且长得像浮层**的顶层窗口」（`EnumWindows` + 影像名比对 + 形状判据；找到的句柄缓存，每轮再确认「还在、**还属于前端程序**」—— 窗口句柄会被系统回收，只认句柄可能盯上别的窗口 —— 前端重启才重找），状态变化时记一行 `overlay watch: frontend overlay visible → launcher pad off`、一行 `overlay target: <类名 "标题"(pid) rect=WxH ex=0x…>`（**认的是哪个窗口**，判错的现场全靠它回看），并 `emit("overlay-state", open)`；`src/App.tsx` 据此 `useGamepadNav({ enabled: intro === "done" && !overlayOpen })`，挂载时用 `overlay_open` 命令先问一次。
   - **「可见」不等于「像浮层」（0.1.50 修的一个真问题）**：前端进程里还有**系统给的另一个窗口** —— `tauri-plugin-single-instance` 为了收「又启动了一次」的消息，会创建那个 0×0 的 `-sic` 消息窗口（`WS_VISIBLE | WS_POPUP` + `WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`）。它 `IsWindowVisible()` **为真**、也属于前端程序，于是 0.1.49 的两条判据在前端一开机就成立：浮层明明没开，启动器却把手柄让出去，而且是**永久**让出去（那个窗口不会消失）。真机日志里的样子很好认：`overlay watch: frontend overlay visible → launcher pad off` 出现在任何按键**之前**。所以判据必须是**形状**：`IsWindowVisible` + 没有 owner（`GetWindow(hwnd, GW_OWNER)` 为空）+ **不是点击穿透**（`WS_EX_TRANSPARENT`）+ **有真实尺寸**（≥160×160；浮层是 660×1200，那个是 0×0）。
   - **同一处顺带「壳体让位」（0.1.50）**：浮层真的上屏时，启动器把自己的窗口退出置顶层（`SetWindowPos(shell, HWND_NOTOPMOST)`）并**替浮层**再顶一次（`SetWindowPos(overlay, HWND_TOPMOST)`），浮层收起后按原样还回去；每次记 `overlay yield: shell notopmost ok=… err=…` / `overlay raise: frontend topmost ok=… err=…`。**为什么由启动器动手**：UIPI 规定低完整性进程不能动高完整性进程的窗口（反过来可以），而开机自启时启动器是提权的（日志 `elevated=true`）、前端是普通权限 —— 前端自己那一下有可能根本排不上来，而且失败**不报错**。这仍然只用「有个窗口在屏上」这一个事实，动的只有两个窗口的 Z 序（§2 的边界不变）。
   - 停的只是**手柄消费**：键鼠、Esc、点击照旧。键盘事件只进焦点窗口，浮层抢了焦点就不会漏回启动器。
   - 重新启用时 `useGamepadNav` 的 `seedHeld()` 会把按着的键记为已按住，所以关浮层那一下不会顺手触发一次动作（这段是 0.1.45 为「浮层刚显示时 Start 还按着」写的，正好复用）。
   - 判定用**可见性**而不是焦点：§3 说 `TAKE_FOCUS` 以后要变成设置项，浮层「不抢焦点」时焦点判断正好会失灵；「浮层在屏上」才是「谁该用手柄」的语义。
   - **为什么由启动器自己看窗口，而不是让前端上报**（新 IPC 命令 / 写进 `frontend.json`）：后者要动前端 → 两个程序必须同时升级，老前端不写就没信号；前端被杀 / 崩了状态还会「卡在开着」，启动器的手柄就永久失灵。看窗口对**已经装好的前端立刻生效**，前端退出即自动复位，也不给「前端 → 启动器」加新通道（§2 的边界）：这里只读窗口列表，不读写对方任何东西。代价是启动器多知道一件「前端有个窗口」的事实，理由就在这里。
2. **瞬态：和弦那一下不许漏进启动器**。启动器的设置键从「单击 View / Share」改成**双击**（`useGamepadNav` 的 `viewGesture: "double"`，450 ms 内两次点按），单击什么都不做；`App.tsx` 里 `onView` 那串「收起文件菜单 / 关对话框 / 开关设置」整体搬到双击上。另外双击模式下 Menu 也跟着守：第一次点按之后的一小段时间里 Menu 不算独立按下，第二次点按时若 Menu 还按着就整串吞掉（那正是和弦）。
   - 为什么不用「押后判定」（按下后等 40–160 ms 看 Menu 是否也按下）：那会让设置键**肉眼可见地变慢**；而和弦是**按住两个键**，不可能出现两次点按，双击零延迟且天然分得开。
   - 键盘 Esc 仍是按一次开/关设置（键盘不走手柄这条路）。
   - **已知边界**：两次点按间隔超过 450 ms 就变成两次单击，设置不开 —— 预期如此。

前端侧一行未改（`chord.rs` 只更新了说明它为什么现在仍然需要两边配合的注释）。

## 11. 文件管理器（功能 12）：设计与坑

启动器壳里的文件页（不是独立前端）。写在这里是因为它属于「掌机手柄体验」这一层的设计记录。**随 0.1.56 首发，真机未验证。**

### 传输：命令立刻回来，进度走事件
- `file_transfer(id, items, destDir, mode, conflict)` 只做**能立刻拒绝**的检查（目标是不是文件夹、清单空不空），登记一个可取消的 token、`std::thread::spawn` 干重活，自己马上返回。
- **为什么不用 `off_main`**：它是「丢进 blocking pool 再 `.await` 等结果」的，拷 20 GB 时前端还是只能干等（正是 0.1.44 修过的那类卡死）；而这条路径要活到拷完，还得能中途取消。
- 进度事件 `files-transfer`，payload 带 `id`：同一时间可能有两个任务（双栏各一个），前端按 id 认领。**最多每 100 ms 报一次** —— 按块报的话一堆小文件就能把事件塞爆，而每条事件都会唤醒一次前端。
- 总量（`total_bytes`）是**先扫一遍算出来的**：没有总量，进度条只能一直转圈，用户看不出「还要 3 分钟还是 30 分钟」。扫的时候照常可取消。
- 写目标先落 `.<名字>.fantasyhub-part` 再 `rename`：拷到一半被取消 / 断电时，目标目录里不会留下一个**顶着正式名字**的半截文件（那会让人以为已经拷好了）。
- 跨卷移动 = 先整份复制成功 → 再删源；中途断电最多「两边各一份」，绝不会「两边都没有」。同卷仍然是瞬时的 `rename`。
- 失败用 `FileError { reason, message }`（`impl Serialize`，Tauri 把对象直接交给前端）。**为什么不继续用 `Err(String)`**：前端只能把整句原文照贴，而占用 / 权限 / 盘满该给的建议完全不同。`reason` 取值：`denied` / `busy` / `space` / `toolong` / `missing` / `exists` / `name` / `notdir` / `notempty` / `big` / `binary` / `rule`（业务规则拒绝）/ `cancelled` / `other`。
- Windows 的原始错误码比 `ErrorKind` 细：占用(32/33)、盘满(39/112)、路径过长(206) 全落在 `Other` 里 → `io_reason()` 先看 `raw_os_error()` 再看 `kind()`。

### 批量改名的两步落地
新名字由**前端算**（预览和执行必须是同一份算法，免得「预览 X、执行成 Y」），Rust 只负责安全落地：
1. 整体校验（只改名、新名合法、没有两个源撞同一个目标、目标没被外人占着）；
2. 全部先改成 `.fantasyhub-rename-<pid>-<n>` 临时名，再改成目标名 —— `1.txt` 和 `2.txt` **对调**这种互相占位的换名，按顺序直接改是改不动的；
3. 中途失败就把还没落地的改回原名，并如实报出是哪个、为什么（失败之前已经改好的保持新名字，不假装全部回滚）。

### 前端（`src/files/`、`src/pages/FilesPage.tsx`）
- `useFileBrowser({ cacheKey })`：**每栏一份**（`left` / `right`），会话缓存也按栏分开 —— 双栏时两栏各看各的目录，共用一个 key 会互相覆盖（0.1.44 那套「回页即出」的缓存原来只有一份）。
- 任务状态放在 `useFileJobs.ts` 的**模块级** store（`useSyncExternalStore`）：拷 20 GB 时按 LB 去看游戏库是正常的，文件页一切标签就被卸载（`App.tsx` 的 `key={tab}`），状态放组件里那一趟回来进度就没了 —— 而后端线程还在老老实实拷。
- 手柄选择模式：X 进模式并把当前项选上（一个动作做两件事 —— 手柄上拆成两次按键是纯负担）；**之后移动焦点就自动选上**，手柄没有 Shift，这就是「区间选择」；A 在模式里是「单选 / 取消」；B 退出并清空；选择模式里 `blocksTabs` 返回 true，免得误按 LB 把选好的丢了。
  - **换目录 = 选中作废 + 退出选择模式**，而且必须在**导航那一刻**做（`useFileBrowser` 的 `onNavigate`，`jump` 在 `setLocation` 之前同步回调），不能等 `useEffect`：新目录的第一行会自动拿到焦点，那时若还在选择模式，`focusRowFor` 会顺手把它选上（真机第一轮反馈的「一直保持多选状态」就有这一半）。留在模式里还有个更坏的结果 —— A 只切换选中、不再打开文件，用户会以为文件打不开了。
  - **标签和动作必须说同一件事**：Y 菜单原来只有一项，写着「取消全选」而动作是 `selectAll`（全选），两个以上选中时按下去就把整个目录选中了 —— 真机反馈的「换盘符就变成全选了」。现在菜单里「全选」「取消全选」各一项、工具栏那颗按钮按「有没有选中」切标签和动作。
- **文件夹大小是后台补上来的**（真机第一轮反馈后加的）：文件夹的大小只能走一遍盘，所以 `file_dir_sizes` 一次算一屏的直接子文件夹，**所有子文件夹共用 3 秒预算**（`DIR_SIZE_BUDGET`，超了的标 `complete: false`，界面写「≥ x」，和属性面板一个口径）、可取消（换目录时前端 `file_cancel`）、不跟进 junction（同一份数据别算两遍、也别指回自己）。前端按**路径**缓存 60 秒（左右两栏看同一个目录共用），「按大小排序」也用这份数字。选程序的对话框（`FilePicker`）传 `measureDirSizes: false` —— 那里满屏文件夹而它只要 .exe，走盘纯属白干。
- 双栏：`LT / RT` 换栏（`fileActions().switchPane`），Y 菜单给「复制 / 移动到另一栏」；焦点池按栏分开（`files-list` / `files-target`）。
- 同名冲突**先在前端比一次**（拿当前列表比名字），有冲突才弹「覆盖 / 跳过 / 保留两者」；后端还会独立再判一次。拖到文件夹上的移动看不见目标目录里的同名，所以直接用「保留两者」—— 宁可多出「副本」，也不覆盖。
- **焦点别抢**：hook 每次渲染都返回新对象，所以自动聚焦的 `useEffect` 依赖里**不能放整个 browser 对象**（否则每次渲染都跑一遍，用户按排序按钮时焦点被拉走，看起来像按键没反应）。依赖只写 `activePane` / `dialogOpen` / `location` / `pendingFocus` / **`rowsToken`** 这些真会改变焦点的东西，并且「焦点已经在任何 `[data-focus-zone]` 里」就直接返回。
- **`rowsToken` 为什么必须在依赖里（真机第一轮的头号坑）**：换目录时 `location` 立刻就变了，但**新目录的文件是异步读回来的** —— 那一帧列表上还是上一级的行。只依赖 `location` 的话，effect 把焦点落到一行马上要被删掉的旧行上；新行到位后那行被删，浏览器把焦点丢回 `body`，而手柄导航（`moveDirectionalFocus`）在「没有焦点」时的兜底是 `focusWithSfx(nodes[0])` —— 也就是**页面第一个 `[data-focusable]`，正好是最上面那个「显示模式」按钮**。于是用户每次下探文件夹都得从页面最上面一路按下来。`rowsToken`（目录 + 每行路径拼起来的指纹）在行真的换了之后变化，effect 才会再跑一次把焦点安顿到新目录的第一行；指纹取的是**未排序**的行，所以点排序键不会误触发。既然此时 `activeElement` 是 `body`（不在任何焦点池里），上面那条「已在池里就别抢」的守卫也不会把它挡住 —— 两者是配套的，缺一不可。顺带：`up()` 现在把上一级要聚焦的名字传成 `baseName(location)`，返回上一级会落回刚出来的那个文件夹。
- **已知缺口**：搜索 / 批量重命名的输入框要借系统键盘（手柄没有文字输入）；`GamepadKeyboard.tsx` 现在只够数字（TDP 滑条那套），要文字得另加一套字母键盘。文件夹大小也只算「真实目录里的直接子文件夹」：盘符列表（`location == null` 的「此电脑」）不算 —— 那要扫整块盘。

### 本机怎么验证
- `cargo test -p handheld-launcher --lib`：`Runner` 的进度改成**注入的 sink**（`&mut dyn FnMut(&TransferProgress)`），于是复制 / 移动 / 三种同名策略 / 取消这些最容易出人命的路径在 macOS 上就能断言，不必等 Windows 真机。
- 单测的临时目录要带唯一序号：并行跑的用例拿到同一个目录会互相删文件（新用例 `hl-move-<pid>` 正好撞上老的 `moves_a_file_into_another_folder`，报出来的错像是「移动」本身坏了）。
- **本机没有 Windows 目标检查**：`cargo check --target x86_64-pc-windows-msvc` 会卡在 `ring` 的 C 代码（要 Windows SDK / clang-cl），不是缺 `llvm-rc` 的问题 —— 所以 `cfg(windows)` 的东西越少越好：这轮只动了 `is_hidden` / `is_reparse` 三个小分支，用的都是文件里已有的 API 形状。

