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
import "../styles/global.css";
import "./frontend.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <FrontendShell />
    </I18nProvider>
  </StrictMode>,
);

