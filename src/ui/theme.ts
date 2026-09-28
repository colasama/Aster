/**
 * User-facing theme colors. `accent` drives every focus/selection/primary surface;
 * `app`, `panel`, and `text` re-derive the neutral surfaces so sections stay readable.
 *
 * This module stays DOM-free: `desktop/preferences.ts` is shared with the Electron
 * main process, so storage and style application live in `./theme-dom.ts`.
 */
export interface ThemeColors {
  accent: string;
  app: string;
  panel: string;
  text: string;
}

export const THEME_STORAGE_KEY = "aster.theme";

export const DEFAULT_THEME_COLORS: ThemeColors = {
  accent: "#805ff5",
  app: "#181818",
  panel: "#1f1f1f",
  text: "#e1e1e1",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function normalizeThemeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return HEX_COLOR.test(normalized) ? normalized : fallback;
}

export function normalizeThemeColors(value: unknown): ThemeColors {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  return {
    accent: normalizeThemeColor(record?.accent, DEFAULT_THEME_COLORS.accent),
    app: normalizeThemeColor(record?.app, DEFAULT_THEME_COLORS.app),
    panel: normalizeThemeColor(record?.panel, DEFAULT_THEME_COLORS.panel),
    text: normalizeThemeColor(record?.text, DEFAULT_THEME_COLORS.text),
  };
}
