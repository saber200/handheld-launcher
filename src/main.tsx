import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
// tokens.css 必须在 global.css 之前：global.css 的 :root 只剩别名（--muted → --ink-3 等），
// 真正的颜色/圆角/间距值都在 tokens.css 里。
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/shell.css";
// 画板 K1（游戏库）的样式：新页面按里程碑逐页迁，旧的 .library-* 还在 global.css 里，
// 所以必须排在 global.css 之后，同优先级的覆盖才有效（见 styles/games.css 顶部说明）。
import "./styles/games.css";
// 画板 K2（软件库）的样式：6 列卡片网格 + 每张卡自己的四段结构，和 K1 的 hero/卡片条差得远，
// 单开一个文件。同样排在 global.css 之后（软件库换完之后 global.css 里那套 .library-* 就只剩
// 弹窗在用）。
import "./styles/apps.css";
// 画板 K7（文件页）的样式：面包屑行 + 位置栏 + 文件表 + 底部操作条。旧 `.file-*` 现在只剩
// 「选择程序」对话框（FilePicker）在用，所以这一份也是整页独立的。同样排在 global.css 之后。
import "./styles/files.css";
// 文件管理增强（任务入口 / 四步向导 / 预览面板 / 任务中心 / 重命名对照）的样式。
// 与 files.css 分开：那一份是「通用文件管理器」的 K7 形状，这一份是任务层新增的 ft-*。
import "./styles/filestasks.css";
// 画板 K4（工具箱）的样式：主卡 + 四张卡。旧 `.toolbox-*` **不能删** —— 独立前端程序
// （src/frontend/）也在用其中几个类，它 import 的是同一份 global.css。
import "./styles/toolbox.css";
// 画板 K3（设置抽屉）的样式：标题行 + 设置行 + 底部提示。同样，旧 `.setting-*` / `.switch`
// 不能删 —— 独立前端的面板（FrontendPanel）也 import 了 global.css 并在用它们。
import "./styles/settings.css";
import { watchUiScale } from "./styles/scale";

// 设计画布是 1280×720，--dp 决定 1dp 等于几个物理 px（1080p→1.5、1440p→2.0）。
// 必须在挂载前先算一次，否则首帧会用 1px 渲染再跳一下。
watchUiScale();

// 前端（幻想前端）自 0.1.46 起是**另一个程序**，有自己的入口 `frontend.html`
// （见 src/frontend/main.tsx），不再靠 sessionStorage / hash 在同一份 bundle 里
// 冒充第二个窗口 —— 那套做法正是 0.1.45「开机就出现、还关不掉」的成因之一。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);

