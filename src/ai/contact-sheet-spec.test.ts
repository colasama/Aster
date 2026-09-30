import { describe, expect, it } from "vitest";
import { contactSheetLayout, contactSheetTimes, formatSheetTime } from "./contact-sheet-spec";

describe("contact sheet sampling", () => {
  it("samples explicit times, fixed intervals and evenly spaced counts", () => {
    expect(contactSheetTimes({ times: [3, 1] }, [0, 10])).toEqual([3, 1]);
    expect(contactSheetTimes({ interval: 5 }, [0, 20])).toEqual([0, 5, 10, 15]);
    expect(contactSheetTimes({ start: 1, end: 2, count: 4 }, [0, 10])).toEqual([
      1, 1.25, 1.5, 1.75,
    ]);
    expect(contactSheetTimes({}, [0, 12])).toHaveLength(12);
    expect(() => contactSheetTimes({ interval: 1 }, [0, 301])).toThrow("more than 64");
    expect(() => contactSheetTimes({ start: 5, end: 5 }, [0, 10])).toThrow("later than start");
  });

  it("keeps sheets inside 4096 px and labels times as m:ss.ss", () => {
    const layout = contactSheetLayout({ cellWidth: 320 }, 64, 9 / 16);
    expect(layout.columns * 322).toBeLessThanOrEqual(4098);
    expect(layout.rows * layout.columns).toBeGreaterThanOrEqual(64);
    expect(() => contactSheetLayout({ cellWidth: 640, columns: 1 }, 64, 9 / 16)).toThrow("4096");
    expect(formatSheetTime(65.5)).toBe("1:05.50");
  });
});
