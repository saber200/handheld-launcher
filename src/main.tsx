import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { FrontendShell } from "./FrontendShell";
import { I18nProvider } from "./i18n";
import "./styles/global.css";

const isFrontend = window.location.hash.replace(/^#\/?/, "") === "frontend";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>{isFrontend ? <FrontendShell /> : <App />}</I18nProvider>
  </StrictMode>,
);
