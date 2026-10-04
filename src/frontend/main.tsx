// 独立前端的 Web 入口。
//
// 这就是**另一个程序**的界面本体（外壳 + 面板），它只用本程序自己的命令：
// TDP 经本地 IPC 转给启动器，进程检测 / 退出游戏 / 读库清单都在本程序里完成。
// 不依赖任何「启动器是否在前台 / 前端是开是关」的共享状态 —— 那种耦合正是 0.1.45
// 「开机就出现、还关不掉」的根因（见仓库根 FRONTEND.md）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../i18n";
import { FrontendShell } from "./FrontendShell";
// tokens.css 与 global.css 共用（global.css 里的 :root 只剩别名，颜色/圆角值都在 tokens.css）。
// **不调用 watchUiScale()**：前端的画布是 440×620（K8），不是 1280×720，--dp 保持 1px ——
// 440 宽的窗口 1:1 就是设计稿尺寸。浮层自己的缩放规则等 M5 重做 K8 时再定。
import "../styles/tokens.css";
import "../styles/global.css";
import "./frontend.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <FrontendShell />
    </I18nProvider>
  </StrictMode>,
);

