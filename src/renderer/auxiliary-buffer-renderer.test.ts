import { describe, expect, it } from "vitest";
import type { Layer } from "../core/types";
import { auxiliarySurfaceShader, buildAuxiliaryBatchIds } from "./auxiliary-buffer-renderer";

const layer = (id: string, roughness: number): Layer =>
  ({
    id,
    kind: "shape",
    material: { metallic: 0, roughness, emissive: 0 },
  }) as Layer;

describe("auxiliary MRT identities", () => {
  it("keeps object IDs per instance and material IDs per material", () => {
    const ids = buildAuxiliaryBatchIds([
      { instanceId: "clone:a", layer: layer("a", 0.5) },
      { instanceId: "clone:b", layer: layer("b", 0.5) },
      { instanceId: "clone:c", layer: layer("c", 0.8) },
    ]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[3]).not.toBe(ids[5]);
    expect([...ids].every((id) => id !== 0)).toBe(true);
  });

  it("writes signed previous-to-current UV motion and avoids unstable particle vectors", () => {
    expect(auxiliarySurfaceShader).toContain("@location(4) motion_vector: vec2f");
    expect(auxiliarySurfaceShader).toContain(
      "(position.xy - previous_position.xy) * vec2f(0.5, -0.5)",
    );
    expect(auxiliarySurfaceShader).toContain("output.motion_vector = vec2f(0.0)");
  });
});
