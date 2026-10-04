import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { temporalPassFixtures } from "./temporal-pass-fixture";
import { readTemporalPassSlice } from "./temporal-pass-plan";

describe("temporal pass transport", () => {
  it("preserves exact weights, ordered hashes and transparent exposure", () => {
    for (const fixture of temporalPassFixtures()) {
      const decoded = decodeFramePlan(fixture.bytes);
      expect(readTemporalPassSlice(structuredClone(decoded))).toEqual(fixture.passes);
      expect(encodeFramePlan(decoded.metadata, decoded.blobs)).toEqual(fixture.bytes);
    }
  });
  it.each(["dependency", "duplicate", "format", "weight", "exposure"])(
    "rejects invalid %s",
    (failure) => {
      const plan = decodeFramePlan(temporalPassFixtures()[0].bytes);
      const slice = plan.metadata.slices[0];
      if (slice.kind !== "temporal_text_passes") throw new Error("Missing fixture passes");
      if (failure === "dependency") plan.metadata.resources.pop();
      if (failure === "duplicate") slice.samples[0] = slice.output;
      if (failure === "format") Object.assign(slice, { accumulation_format: "rgba8unorm-srgb" });
      const bytes = plan.blobs[0];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (failure === "weight") view.setFloat64(8, Number.NaN, true);
      if (failure === "exposure") view.setFloat64(0, 0.5, true);
      expect(() => readTemporalPassSlice(plan)).toThrow();
    },
  );
});
