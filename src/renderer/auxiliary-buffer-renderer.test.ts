import { describe, expect, it } from "vitest";
import type { Layer } from "../core/types";
import {
  auxiliarySurfaceShader,
  buildAuxiliaryBatchIds,
  buildAuxiliaryParticleIdentity,
} from "./auxiliary-buffer-renderer";
import { encodeRenderId } from "./render-buffers";

const layer = (id: string, roughness: number): Layer =>
  ({
    id,
    kind: "shape",
    material: { metallic: 0, roughness, emissive: 0 },
  }) as Layer;

describe("auxiliary MRT identities", () => {
  it("shares root selection IDs across clones and material IDs across materials", () => {
    const ids = buildAuxiliaryBatchIds([
      { selectionId: "source", layer: layer("a", 0.5) },
      { selectionId: "source", layer: layer("b", 0.5) },
      { selectionId: "other", layer: layer("c", 0.8) },
    ]);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[2]).not.toBe(ids[4]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[3]).not.toBe(ids[5]);
    expect([...ids].every((id) => id !== 0)).toBe(true);
  });

  it("writes signed previous-to-current UV motion for geometry and GPU particles", () => {
    expect(auxiliarySurfaceShader).toContain("@location(4) motion_vector: vec2f");
    expect(auxiliarySurfaceShader).toContain(
      "(position.xy - previous_position.xy) * vec2f(0.5, -0.5)",
    );
    expect(auxiliarySurfaceShader).toContain(
      "(record.current.xy - record.previous.xy) * vec2f(0.5, -0.5)",
    );
    expect(auxiliarySurfaceShader).toContain("output.motion_vector = input.motion_vector");
  });

  it("rebuilds previous mesh vertices and keeps auxiliary depth identical to Beauty", () => {
    expect(auxiliarySurfaceShader).toContain("let previous_size = mix");
    expect(auxiliarySurfaceShader).toContain("let previous_rotation = mix");
    expect(auxiliarySurfaceShader).toContain("particle_mesh_clip(");
    expect(auxiliarySurfaceShader).toContain("particle_streak_vertex");
    expect(auxiliarySurfaceShader).toContain("output.position = vec4f(clip, 1.0)");
    expect(auxiliarySurfaceShader).toContain("(clip.xy - previous_clip.xy) * vec2f(0.5, -0.5)");
  });

  it("matches Beauty coverage independently for billboard, streak, and mesh particles", () => {
    expect(auxiliarySurfaceShader).toContain("@fragment fn particle_billboard_fragment");
    expect(auxiliarySurfaceShader).toContain("if (length(input.local) >= 1.0) { discard; }");
    expect(auxiliarySurfaceShader).toContain("@fragment fn particle_streak_fragment");
    expect(auxiliarySurfaceShader).toContain("if (abs(input.local.y) >= 1.0) { discard; }");
    expect(auxiliarySurfaceShader).toContain("@fragment fn particle_mesh_fragment");
    expect(auxiliarySurfaceShader).not.toContain("input.local * vec2f(0.64, 1.0)");
  });

  it("gives the particle surface its selectable root layer ID", () => {
    const identity = buildAuxiliaryParticleIdentity("particle-layer", 1920, 1080);
    expect([...new Uint32Array(identity, 0, 2)]).toEqual([
      encodeRenderId("particle-layer"),
      encodeRenderId("material:particle"),
    ]);
    expect([...new Float32Array(identity, 16, 2)]).toEqual([1920, 1080]);
  });
});
