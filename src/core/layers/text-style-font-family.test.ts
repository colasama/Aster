import { describe, expect, it } from "vitest";
import { cssFontFamily } from "./text-style";

describe("canvas font family tokens", () => {
  it("quotes plain family names so names with digits or spaces resolve exactly", () => {
    expect(cssFontFamily("江城月湖体 400W")).toBe('"江城月湖体 400W"');
    expect(cssFontFamily("XinYuGongPinBoTi")).toBe('"XinYuGongPinBoTi"');
    expect(cssFontFamily('"Already Quoted"')).toBe('"Already Quoted"');
    expect(cssFontFamily("Inter, sans-serif")).toBe("Inter, sans-serif");
    expect(cssFontFamily("serif")).toBe("serif");
    expect(cssFontFamily("  ")).toBe("sans-serif");
  });
});
