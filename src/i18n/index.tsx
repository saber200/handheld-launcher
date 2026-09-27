import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { en, zh, type Catalog, type Locale } from "./catalog";

const STORAGE_KEY = "handheld-launcher.locale";

let locale: Locale = "zh";
let catalog: Catalog = zh;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* private mode */
  }
  const lang = typeof navigator === "undefined" ? "zh" : navigator.language.toLowerCase();
  return lang.startsWith("zh") ? "zh" : "en";
}

export function applyLocale(next: Locale) {
  locale = next;
  catalog = next === "en" ? en : zh;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    document.title = catalog.productName;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  if (inTauri()) {
    void invoke("set_locale", { locale: next }).catch(() => {});
    void getCurrentWindow().setTitle(catalog.productName).catch(() => {});
  }
}

export function text(): Catalog {
  return catalog;
}

export function currentLocale(): Locale {
  return locale;
}

applyLocale(readLocale());

export function useI18n() {
  const [value, setValue] = useState(locale);
  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<Locale>).detail;
      if (next === "zh" || next === "en") setValue(next);
    };
    window.addEventListener("handheld-locale", onChange);
    return () => window.removeEventListener("handheld-locale", onChange);
  }, []);
  return {
    locale: value,
    m: value === "en" ? en : zh,
    setLocale(next: Locale) {
      applyLocale(next);
      window.dispatchEvent(new CustomEvent("handheld-locale", { detail: next }));
    },
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  useI18n();
  return children;
}
