import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createTranslator,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
  resolveLocale,
  type Translate,
} from "./core";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const defaultContext: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: createTranslator(DEFAULT_LOCALE),
};

const I18nContext = createContext<I18nContextValue>(defaultContext);

export function readInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage may be disabled; language detection still works offline.
  }
  return resolveLocale(stored, window.navigator.languages);
}

export function persistLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // A private or locked-down browser can reject storage without blocking localization.
  }
}

export function syncDocumentLocale(
  locale: Locale,
  target: Pick<Document, "documentElement"> | undefined = typeof document === "undefined"
    ? undefined
    : document,
): void {
  if (target) target.documentElement.lang = locale;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);
  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    persistLocale(nextLocale);
  }, []);
  useEffect(() => {
    syncDocumentLocale(locale);
  }, [locale]);
  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
