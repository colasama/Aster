export const UI_SCALE_FACTORS = [0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2] as const;

export type UiScaleFactor = (typeof UI_SCALE_FACTORS)[number];
export type UiScale = "auto" | UiScaleFactor;

export function isUiScale(value: unknown): value is UiScale {
  return value === "auto" || UI_SCALE_FACTORS.includes(value as UiScaleFactor);
}

export function parseUiScale(value: unknown): UiScale {
  if (value === "auto") return value;
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return isUiScale(numeric) ? numeric : "auto";
}

export function uiScaleFactor(scale: UiScale): number {
  return scale === "auto" ? 1 : scale;
}
