import { describe, expect, it } from "vitest";
import type { Lut3dResource } from "../../core/types";
import { createEffect } from "../../effects/registry";
import { analyzeEffectFusion } from "./effect-fusion";

describe("effect fusion eligibility", () => {
  it("groups adjacent pixel effects around multi-pass barriers", () => {
    const analysis = analyzeEffectFusion([
      createEffect("exposure"),
      createEffect("vibrance"),
      createEffect("gaussian-blur"),
      createEffect("tint"),
    ]);
    expect(analysis.groups.map((group) => [group.kind, group.effectIds.length])).toEqual([
      ["fused", 2],
      ["barrier", 1],
      ["fused", 1],
    ]);
    expect(analysis).toMatchObject({
      fusedEffectCount: 3,
      fusedGroupCount: 2,
      barrierCount: 1,
      operationCount: 4,
    });
  });

  it("reports missing providers and bounded-program overflow", () => {
    const missing = createEffect("exposure");
    missing.id = "missing";
    missing.type = "org.example.missing";
    const effects = [missing, ...Array.from({ length: 65 }, () => createEffect("exposure"))];
    const analysis = analyzeEffectFusion(effects);
    expect(analysis.groups[0]).toMatchObject({ kind: "unsupported", execution: "missing" });
    expect(analysis.groups[analysis.groups.length - 1]).toMatchObject({
      kind: "unsupported",
      execution: "overflow",
    });
    expect(analysis.operationCount).toBe(64);
  });

  it("does not fuse distinct LUT resources into one sampler group", () => {
    const first = createEffect("lut");
    const second = createEffect("lut");
    const resource: Lut3dResource = {
      kind: "lut3d",
      name: "a",
      title: "A",
      size: 2,
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      data: Array(24).fill(0),
      checksum: "a",
    };
    first.resource = resource;
    second.resource = { ...resource, name: "b", title: "B", checksum: "b" };
    expect(analyzeEffectFusion([first, second]).fusedGroupCount).toBe(2);
  });
});
