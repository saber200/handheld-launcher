import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./styles/global.css";

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

