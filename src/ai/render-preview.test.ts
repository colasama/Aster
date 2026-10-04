import { describe, expect, it } from "vitest";
import { measurePreviewPixels, previewSnapshotIdentity } from "./render-preview";

describe("agent render preview metrics", () => {
  it("retains workspace identity for crop/scale and separates isolated project snapshots", () => {
    const source = { snapshotScope: "workspace:one:7", projectRevision: 2 };
    expect(previewSnapshotIdentity(source, { maxDimension: 128 })).toEqual(source);
    const isolated = previewSnapshotIdentity(source, { layerIds: ["layer"] });
    expect(isolated.snapshotScope).toMatch(/^isolated:/);
    expect(isolated.snapshotScope).not.toBe(source.snapshotScope);
    expect(isolated.projectRevision).toBe(2);
    expect(previewSnapshotIdentity(source, { layerIds: ["other"] }).snapshotScope).not.toBe(
      isolated.snapshotScope,
    );
    source.projectRevision = 9;
    expect(isolated.projectRevision).toBe(2);
    expect(() =>
      previewSnapshotIdentity(
        { snapshotScope: "x".repeat(256), projectRevision: 7 },
        { layerIds: ["layer"] },
      ),
    ).not.toThrow();
  });

  it("detects empty frames and computes bounded luminance", () => {
    const metrics = measurePreviewPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(metrics.emptyFrame).toBe(true);
    expect(metrics.averageLuminance).toBe(0);
    expect(metrics.visiblePixelRatio).toBe(0);
  });

  it("computes frame difference without claiming subjective quality", () => {
    const previous = new Uint8ClampedArray([0, 0, 0, 255]);
    const metrics = measurePreviewPixels(new Uint8ClampedArray([255, 255, 255, 255]), previous);
    expect(metrics.emptyFrame).toBe(false);
    expect(metrics.averageLuminance).toBeCloseTo(1);
    expect(metrics.differenceFromPrevious).toBeCloseTo(0.75);
  });
});
