import { describe, expect, it } from "vitest";
import { resolveBundledDev } from "./vite.config";

describe("resolveBundledDev", () => {
  it("enables full-bundle development by default", () => {
    expect(resolveBundledDev("serve", "development")).toBe(true);
    expect(resolveBundledDev("serve", "development", "")).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off"])(
    "disables full-bundle development for %s",
    (configuredValue) => {
      expect(resolveBundledDev("serve", "development", configuredValue)).toBe(false);
    },
  );

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "explicitly enables full-bundle development for %s",
    (configuredValue) => {
      expect(resolveBundledDev("serve", "development", configuredValue)).toBe(true);
    },
  );

  it("never enables the development experiment in other modes", () => {
    expect(resolveBundledDev("serve", "test", "true")).toBe(false);
    expect(resolveBundledDev("serve", "production", "true")).toBe(false);
    expect(resolveBundledDev("build", "development", "true")).toBe(false);
  });

  it("rejects mistyped switch values", () => {
    expect(() => resolveBundledDev("serve", "development", "disabled")).toThrow(
      "ASTER_BUNDLED_DEV must be one of",
    );
  });
});
