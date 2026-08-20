import { describe, expect, it } from "vitest";
import { parseCubeLut } from "../effects/cube-lut";
import { createEffect } from "../effects/registry";
import { createLayerForComposition } from "./layer-factory";
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

  it("validates source-time mapping and animated time remapping", () => {
    const project = createBlankProject();
    const layer = project.compositions[0].layers[0];
    layer.timeOffset = 2;
    layer.timeStretch = 0.5;
    layer.timeRemap = {
      mode: "animated",
      keyframes: [
        { id: "start", time: 0, value: 1, interpolation: "linear" },
        { id: "end", time: 4, value: 3, interpolation: "bezier", easing: [0.4, 0, 0.6, 1] },
      ],
    };
    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].timeRemap).toEqual(layer.timeRemap);

    layer.timeStretch = 0;
    expect(() => validateProjectDocument(project)).toThrow("timeStretch must be a positive number");
  });

  it("roundtrips GPU material and physical light settings", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const light = createLayerForComposition("light", composition);
    mesh.material = { metallic: 0.8, roughness: 0.2, emissive: 1.5 };
    light.light = { kind: "spot", intensity: 6, range: 3200, coneAngle: 70 };
    light.color = [1.4, 0.8, 0.5, 1];
    composition.layers.push(mesh, light);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    const layers = roundtrip.compositions[0].layers;
    expect(layers[layers.length - 2]?.material).toEqual(mesh.material);
    expect(layers[layers.length - 1]).toMatchObject({
      light: light.light,
      color: light.color,
    });
  });

  it("roundtrips perspective and orthographic camera settings", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const camera = createLayerForComposition("camera", composition);
    camera.camera = { projection: "orthographic", fieldOfView: 50, orthographicSize: 1400 };
    composition.layers.push(camera);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[1].camera).toEqual(camera.camera);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.fieldOfView = 180;
    expect(() => validateProjectDocument(project)).toThrow("between 0 and 180 degrees");
  });

  it("roundtrips bounded imported mesh buffers", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    mesh.mesh = {
      name: "Triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    composition.layers.push(mesh);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[1].mesh).toEqual(mesh.mesh);
    mesh.mesh.indices[2] = 99;
    expect(() => validateProjectDocument(project)).toThrow("reference missing vertices");
  });

  it("roundtrips bounded deterministic particle settings", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const particles = createLayerForComposition("particle", composition);
    particles.particle = {
      count: 500_000,
      seed: 42,
      lifetime: 4,
      speed: 0.25,
      acceleration: -0.08,
      startSize: 3,
      endSize: 0.2,
      startRotation: -45,
      endRotation: 270,
    };
    composition.layers.push(particles);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[1].particle).toEqual(particles.particle);
    if (!particles.particle) throw new Error("Expected particle settings");
    particles.particle.count = 1_000_001;
    expect(() => validateProjectDocument(project)).toThrow("at most 1000000");
  });

  it("roundtrips explicit vector shape styling", () => {
    const project = createBlankProject();
    const shape = project.compositions[0].layers[0];
    shape.shape = {
      kind: "ellipse",
      roundness: 24,
      strokeWidth: 12,
      strokeColor: [1, 0.5, 0.25, 0.8],
      fillMode: "radial",
      gradientColor: [0.1, 0.2, 0.8, 1],
      gradientAngle: 45,
      dashLength: 16,
      dashGap: 8,
      lineCap: "butt",
    };

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].shape).toEqual(shape.shape);
    shape.shape.strokeWidth = -1;
    expect(() => validateProjectDocument(project)).toThrow("must not be negative");
  });

  it("roundtrips multiline text typography", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    text.text = "GPU\nMOTION";
    text.textStyle = {
      fontFamily: "Inter, sans-serif",
      fontSize: 190,
      fontWeight: 800,
      alignment: "right",
      tracking: 24,
      leading: 220,
      strokeWidth: 7,
      strokeColor: [0.3, 0.4, 0.9, 1],
    };
    composition.layers.push(text);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[1]).toMatchObject({
      text: text.text,
      textStyle: text.textStyle,
    });
  });
});
