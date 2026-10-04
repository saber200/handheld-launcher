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

