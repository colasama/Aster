// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { applyReducedMotionPreference } from "./reduced-motion";

describe("applyReducedMotionPreference", () => {
  it("restores the saved preference before the interface renders", () => {
    const root = document.createElement("div");
    applyReducedMotionPreference(root, { getItem: () => "true" });
    expect(root.classList.contains("reduced-motion")).toBe(true);
    applyReducedMotionPreference(root, { getItem: () => "false" });
    expect(root.classList.contains("reduced-motion")).toBe(false);
  });

  it("falls back safely when storage is unavailable", () => {
    const root = document.createElement("div");
    root.classList.add("reduced-motion");
    applyReducedMotionPreference(root, {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(root.classList.contains("reduced-motion")).toBe(false);
  });
});
