import {
  DEFAULT_THEME_COLORS,
  normalizeThemeColors,
  THEME_STORAGE_KEY,
  type ThemeColors,
} from "./theme";

export function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return DEFAULT_THEME_COLORS;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored ? normalizeThemeColors(JSON.parse(stored)) : DEFAULT_THEME_COLORS;
  } catch {
    return DEFAULT_THEME_COLORS;
  }
}

export function persistThemeColors(colors: ThemeColors): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // Preferences still apply to this session when persistent storage is unavailable.
  }
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mix(from: string, toward: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(toward);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

export function applyThemeColors(colors: ThemeColors): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const accent = colors.accent;
  const app = colors.app;
  const panel = colors.panel;
  const text = colors.text;
  const entries: [string, string][] = [
    ["--blue", accent],
    ["--blue-bright", mix(accent, "#ffffff", 0.32)],
    ["--violet", accent],
    ["--control-primary-bg", mix(accent, "#000000", 0.06)],
    ["--control-primary-hover", mix(accent, "#ffffff", 0.1)],
    ["--menu-highlight", mix(accent, app, 0.42)],
    ["--selection-bg", mix(accent, app, 0.68)],
    ["--bg-deep", mix(app, "#000000", 0.12)],
    ["--bg-app", app],
    ["--bg-panel", panel],
    ["--bg-raised", mix(panel, "#ffffff", 0.035)],
    ["--bg-hover", mix(panel, "#ffffff", 0.07)],
    ["--border", mix(panel, "#ffffff", 0.1)],
    ["--border-soft", mix(panel, "#ffffff", 0.055)],
    ["--control-bg", app],
    ["--control-border", mix(panel, "#ffffff", 0.16)],
    ["--control-border-hover", mix(panel, "#ffffff", 0.32)],
    ["--control-button-bg", mix(panel, "#ffffff", 0.065)],
    ["--control-button-hover", mix(panel, "#ffffff", 0.115)],
    ["--text", text],
    ["--control-text", mix(text, app, 0.13)],
    ["--text-secondary", mix(text, app, 0.28)],
    ["--muted", mix(text, app, 0.42)],
    ["--faint", mix(text, app, 0.58)],
  ];
  for (const [property, value] of entries) root.setProperty(property, value);
}
