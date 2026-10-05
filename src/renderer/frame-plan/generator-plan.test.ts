import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { generatorFixtures } from "./generator-fixture";
import { readGeneratorSlice, validateGeneratorResources } from "./generator-plan";

describe("generator FPLN", () => {
  it("preserves supplied executable descriptors, ABI bytes and resource identities", () => {
    for (const f of generatorFixtures()) {
      const resources = new Map(f.generator.program.shaders.map((r) => [r.message.hash, r]));
      const decoded = readGeneratorSlice(decodeFramePlan(f.bytes), resources);
      expect(decoded).toEqual(f.generator);
      expect(() => validateGeneratorResources(decoded)).not.toThrow();
      expect(() => readGeneratorSlice(f.plan, new Map())).toThrow();
      const source = f.plan.blobs[0];
      const original = decoded.context[0];
      source[0] ^= 1;
      expect(decoded.context[0]).toBe(original);
    }
  });
  it("rejects inconsistent counts, dispatches, resource references and malformed metadata", () => {
    const f = generatorFixtures()[0];
    for (const fault of [
      "dispatch",
      "resource",
      "count",
      "workgroup",
      "variant",
      "unknown",
      "audio",
    ]) {
      const p = structuredClone(f.plan);
      const s = p.metadata.slices[0];
      if (s.kind !== "scene_generator") throw Error("Wrong fixture");
      if (fault === "dispatch") s.dispatches[0][0]++;
      if (fault === "resource") p.metadata.resources = [];
      if (fault === "count") p.blobs[0][24] ^= 1;
      if (fault === "workgroup") s.program.graph.compute_passes[0].workgroup_size[0] = 0;
      if (fault === "variant") s.variant_index = 10;
      if (fault === "unknown")
        Object.assign(s.program.graph.render_variants[0], { selector_value: "forbidden" });
      if (fault === "audio") s.has_audio = true;
      expect(() => encodeFramePlan(p.metadata, p.blobs), fault).toThrow();
    }
  });
});
