import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { precompositionBundleFixtures } from "./precomposition-bundle-fixture";
import { readPrecompositionBundle } from "./precomposition-bundle-read";

describe("precomposition payload bundles", () => {
  it("owns nested scene, effect, LUT, generator and shader dependencies", () => {
    for (const fixture of precompositionBundleFixtures()) {
      const decoded = readPrecompositionBundle(
        decodeFramePlan(fixture.bytes),
        fixture.bundle.resources,
      );
      expect(decoded.plans).toEqual(fixture.plans);
      expect(decoded.mediaPixels).toEqual(fixture.mediaPixels);
      if (!decoded.plans.length) continue;
      expect(decoded.plans[0].effects.size).toBeGreaterThan(0);
      expect(decoded.plans[0].generators).toHaveLength(1);
      fixture.plans[0].scene.blobs[0].fill(0);
      expect(readPrecompositionBundle(fixture.bundle.plan, fixture.bundle.resources).plans).toEqual(
        decoded.plans,
      );
    }
  });

  it("rejects duplicate media frames, missing pixels and invalid frame layouts", () => {
    const { bundle } = precompositionBundleFixtures()[0];
    const pixel = bundle.plan.metadata.slices[0];
    if (pixel.kind !== "precomposition_bundle") throw Error("Missing bundle");
    expect(pixel.media_pixels).toHaveLength(1);
    const record = pixel.media_pixels[0];
    expect(() =>
      readPrecompositionBundle(
        bundle.plan,
        bundle.resources.filter((r) => r.message.hash !== record.pixels),
      ),
    ).toThrow(/Missing declared/);
    pixel.media_pixels.push({ ...record });
    expect(() => encodeFramePlan(bundle.plan.metadata, bundle.plan.blobs)).toThrow(
      /Duplicate surface media/,
    );
    pixel.media_pixels.pop();
    const graphResource = bundle.resources.find((r) => r.message.hash === pixel.graph);
    if (!graphResource) throw Error("Missing graph");
    record.pixels = graphResource.message.hash;
    bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter(
      (hash) => hash !== bundle.resources.find((r) => r.bytes.length === 12288)?.message.hash,
    );
    expect(() => readPrecompositionBundle(bundle.plan, bundle.resources)).toThrow(/frame layout/);
  });

  it("rejects missing, corrupted and cross-linked payloads before execution", () => {
    const { bundle } = precompositionBundleFixtures()[0];
    expect(() => readPrecompositionBundle(bundle.plan, bundle.resources.slice(1))).toThrow();
    const corrupt = structuredClone(bundle.resources);
    const packet = corrupt.find((r) => r.bytes.length > 0);
    if (!packet) throw Error("Fixture has no payload");
    packet.bytes[0] ^= 1;
    expect(() => readPrecompositionBundle(bundle.plan, corrupt)).toThrow(/hash mismatch/);
    const changed = structuredClone(bundle.plan);
    const slice = changed.metadata.slices[0];
    if (slice.kind !== "precomposition_bundle") throw Error("Missing bundle");
    slice.scenes[0].scene = slice.scenes[1].scene;
    expect(() => readPrecompositionBundle(changed, bundle.resources)).toThrow();
    const mapping = structuredClone(bundle.plan);
    new DataView(mapping.blobs[0].buffer).setUint32(16, 65535, true);
    expect(() => readPrecompositionBundle(mapping, bundle.resources)).toThrow(/geometry/);
    const count = structuredClone(bundle.plan);
    count.blobs[0][0]++;
    expect(() => encodeFramePlan(count.metadata, count.blobs)).toThrow(/count mismatch/);
  });
});
