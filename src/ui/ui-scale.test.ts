// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { applyBrowserUiScale } from "./browser-ui-scale";
import { isUiScale, parseUiScale, UI_SCALE_FACTORS, uiScaleFactor } from "./ui-scale";

afterEach(() => {
  document.documentElement.style.zoom = "";
});

describe("UI scale", () => {
  it("accepts only the bounded supported scale set", () => {
    expect(UI_SCALE_FACTORS).toEqual([0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2]);
    expect(isUiScale("auto")).toBe(true);
    expect(isUiScale(1.25)).toBe(true);
    expect(isUiScale(0.5)).toBe(false);
    expect(isUiScale(Number.NaN)).toBe(false);
  });

  it("parses select and persisted values with a deterministic auto fallback", () => {
    expect(parseUiScale("1.125")).toBe(1.125);
    expect(parseUiScale(2)).toBe(2);
    expect(parseUiScale("1.2")).toBe("auto");
    expect(parseUiScale(undefined)).toBe("auto");
    expect(uiScaleFactor("auto")).toBe(1);
  });

  it("applies browser fallback scaling without leaving an auto override", () => {
    applyBrowserUiScale(1.5);
    expect(document.documentElement.style.zoom).toBe("1.5");
    applyBrowserUiScale("auto");
    expect(document.documentElement.style.zoom).toBe("");
  });
});
