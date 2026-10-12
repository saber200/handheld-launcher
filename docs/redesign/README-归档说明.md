# 改造包归档说明（2026-10-04）

这个目录是用户给的**界面改造材料原样归档**（来自桌面 `FantasyHub-改造包`），改代码时以它为设计依据。内容与来源一一对应，没有改过一个字：

- `FantasyHub-改造实现规格书.md` —— 主交付物，17 节（§0 不许丢的 10 项能力、§1 导航、§2 圆角与间距、§3…§10 各页、§11 缩放、§12 令牌、§13 焦点与手柄、§14 自动校验、§15 里程碑、§16 验收、§17 画板索引）。
- `README-先读我.md` —— 用户给的入口说明（含「三个最容易做错的地方」）。
- `artboards/K1…K9.png` —— 9 张高保真画板，逻辑画布 **1280×720**（K8 是 440×620），2× 渲染。
- `reference/design-tokens.json` —— 颜色 / 圆角 / 间距 / 字阶 / 布局 / 焦点 / 图标 / 按键。**`src/styles/tokens.css` 与它一一对应**。
- `reference/mock-data.json`、`ui-strings.json` —— 开发期假数据与提示条文案（**只作参考**：真正要显示的数据必须来自后端，不摆假数据）。
- `tools/audit_radius.py`、`audit_spacing.py`、`verify_geometry.py` —— ⚠️ **这三个脚本跑不起来**：它们 `import ds2` / `boards2`（设计工具内部的渲染库），包里没带，本机实测 `ModuleNotFoundError: No module named 'ds2'`。检查思路照搬，实现换成仓库里的零依赖版本 `scripts/audit-ui.mjs`（禁胶囊 / 禁椭圆 / 圆角六档 / 颜色与 design-tokens.json 对表 / 手写数值报告），已接进 pre-commit 与 CI 的 Lint 作业。

## 与本仓库的对应关系

| 材料 | 落点 |
| --- | --- |
| 规格书 §1 导航 / §2 圆角间距 / §12 令牌 / §13 焦点 | `src/styles/tokens.css`、`src/styles/shell.css`、`src/types.ts`、`src/App.tsx`（M0 已完成）。**§1 的「左侧竖排侧栏」在 2026-10-12 被用户改回顶部页签条**（换页只有 LB/RB 与 Q/E、整条不可聚焦）——规格书原样归档不改，改动理由与取舍记在 `FRONTEND.md` 的「未发布（0.1.72）」 |
| §11 缩放 | `src/styles/scale.ts`（**没有照抄表里的物理 px**，理由见该文件顶部注释） |
| §3 游戏库 K1 | M1，落点 `src/components/LibraryShelf.tsx` + `src/pages/GamesPage.tsx` |
| §4 软件库 K2 | M2（「预置可安装」需要新数据源，先只做已装来源） |
| §5 首页 K5 / §6 下载 K6 | 等数据源（最近启动记录、存储容量、统一任务模型）；当前是排期占位页 |
| §7 文件 K7 | M3，落点 `src/pages/FilesPage.tsx` + `src/files/*`（**逻辑不动，只换视觉**） |
| §8 工具箱 K4 | M4，落点 `src/pages/ToolboxPanel.tsx`（顺带给启动器补 TDP 卡） |
| §9 设置 K3 | M4，落点 `src/pages/SettingsPage.tsx` |
| §10 前端浮层 K8 | M5，落点 `src/frontend/*` + `frontend/gamebar/Widget/WidgetPage.xaml` |
| §14 自动校验 | `scripts/audit-ui.mjs`（.py 不可用） |

进度与验证边界记在仓库根的 `STATUS.md`「界面大改 M0」，设计与坑记在 `FRONTEND.md`。
