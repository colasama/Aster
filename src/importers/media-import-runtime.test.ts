import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaImportRuntime } from "./media-import-runtime";

afterEach(() => mediaImportRuntime.clear());

describe("media import runtime ownership", () => {
  it("atomically replaces and disposes project-owned runtime entries once", () => {
    const disposeOld = vi.fn();
    const disposeNext = vi.fn();
    mediaImportRuntime.register("old", svgRuntime(1), disposeOld);

    mediaImportRuntime.replace([{ sourceId: "next", value: svgRuntime(2), dispose: disposeNext }]);
    expect(disposeOld).toHaveBeenCalledOnce();
    expect(mediaImportRuntime.has("old")).toBe(false);
    expect(mediaImportRuntime.has("next")).toBe(true);

    mediaImportRuntime.clear();
    mediaImportRuntime.clear();
    expect(disposeNext).toHaveBeenCalledOnce();
  });

  it("rejects duplicate hydration before disturbing the current project", () => {
    const dispose = vi.fn();
    mediaImportRuntime.register("current", svgRuntime(1), dispose);

    expect(() =>
      mediaImportRuntime.replace([
        { sourceId: "duplicate", value: svgRuntime(2) },
        { sourceId: "duplicate", value: svgRuntime(3) },
      ]),
    ).toThrow("duplicate source id");
    expect(mediaImportRuntime.has("current")).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
  });
});

function svgRuntime(size: number) {
  return {
    kind: "svg" as const,
    parsed: {
      width: size,
      height: size,
      viewBox: [0, 0, size, size] as const,
      sanitized: `<svg viewBox="0 0 ${size} ${size}"/>`,
      nodeCount: 1,
    },
  };
}
