import { describe, expect, it } from "vitest";
import { parseCubeLut } from "../effects/cube-lut";
import { createEffect } from "../effects/registry";
import { createBlankProject } from "./project";
import { serializeProject, validateProjectDocument } from "./project-file";

describe("project document boundary", () => {
  it("roundtrips a valid editor project", () => {
    const project = createBlankProject();
    expect(validateProjectDocument(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it("rejects a missing active composition", () => {
    const project = createBlankProject();
    project.activeCompositionId = crypto.randomUUID();
    expect(() => validateProjectDocument(project)).toThrow("Active composition does not exist");
  });

  it("rejects duplicate layer identifiers", () => {
    const project = createBlankProject();
    project.compositions[0].layers.push(structuredClone(project.compositions[0].layers[0]));
    expect(() => validateProjectDocument(project)).toThrow("duplicate layer id");
  });

  it("roundtrips bounded LUT resources and rejects malformed voxel counts", () => {
    const project = createBlankProject();
    const lut = createEffect("lut");
    lut.resource = parseCubeLut(
      "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1",
      "identity.cube",
    );
    project.compositions[0].layers[0].effects.push(lut);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    const roundtripEffects = roundtrip.compositions[0].layers[0].effects;
    expect(roundtripEffects[roundtripEffects.length - 1]?.resource?.checksum).toBe(
      lut.resource.checksum,
    );

    lut.resource.data.pop();
    expect(() => validateProjectDocument(project)).toThrow("invalid length");
  });

  it("roundtrips bounded effect-local masks", () => {
    const project = createBlankProject();
    const effect = createEffect("exposure");
    effect.mask = {
      shape: "rectangle",
      center: [45, 55],
      size: [70, 35],
      feather: 18,
      opacity: 90,
      invert: true,
    };
    project.compositions[0].layers[0].effects.push(effect);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].effects[0].mask).toEqual(effect.mask);
    effect.mask.opacity = 101;
    expect(() => validateProjectDocument(project)).toThrow("opacity is out of range");
  });
});
