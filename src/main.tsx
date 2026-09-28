import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { FrontendShell } from "./FrontendShell";
import { I18nProvider } from "./i18n";
import "./styles/global.css";

const params = new URLSearchParams(window.location.search);
const shellFlag = (() => {
  try {
    return sessionStorage.getItem("fantasyhub-shell") === "frontend";
  } catch {
    return false;
  }
})();
const isFrontend =
  params.get("shell") === "frontend" ||
  shellFlag ||
  Boolean((window as Window & { __FANTASYHUB_FRONTEND__?: boolean }).__FANTASYHUB_FRONTEND__) ||
  window.location.hash.replace(/^#\/?/, "") === "frontend";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>{isFrontend ? <FrontendShell /> : <App />}</I18nProvider>
  </StrictMode>,
);
