import type { UiScale } from "./ui-scale";

export function applyBrowserUiScale(scale: UiScale): void {
  document.documentElement.style.zoom = scale === "auto" ? "" : String(scale);
}
