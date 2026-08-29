// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { parseSvgSource } from "./svg";

describe("SVG importer", () => {
  it("normalizes physical dimensions and preserves a scalable viewBox", () => {
    const parsed = parseSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" width="25.4mm" height="1in" viewBox="0 0 100 100"><path d="M0 0h100v100z"/></svg>',
    );
    expect(parsed.width).toBeCloseTo(96);
    expect(parsed.height).toBe(96);
    expect(parsed.viewBox).toEqual([0, 0, 100, 100]);
    expect(parsed.sanitized).toContain("<svg");
  });

  it("derives missing dimensions from the viewBox", () => {
    const parsed = parseSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -20 640 360"><circle cx="20" cy="20" r="5"/></svg>',
    );
    expect(parsed).toMatchObject({ width: 640, height: 360, viewBox: [-10, -20, 640, 360] });
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path onclick="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>@import url(https://example.com/a.css)</style></svg>',
  ])("rejects active or externally fetched content", (source) => {
    expect(() => parseSvgSource(source)).toThrow(/not allowed|unsafe URL/);
  });
});
