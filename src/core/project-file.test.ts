import { describe, expect, it } from "vitest";
import { parseCubeLut } from "../effects/cube-lut";
import { createEffect } from "../effects/registry";
import { createLayerForComposition } from "./layer-factory";
import { createDefaultParticleSettings } from "./particle-settings";
import { createBlankProject } from "./project";
import { serializeProject, validateProjectDocument } from "./project-file";

describe("project document boundary", () => {
  it("rejects render states the bounded flat renderer cannot represent", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.layers[0].id = crypto.randomUUID();
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    root.layers.unshift(wrapper);
    project.compositions.push(nested);

    nested.layers.unshift(createLayerForComposition("adjustment", nested));
    expect(() => validateProjectDocument(project)).toThrow(
      "Adjustment layers in precomposition sources require a 3D texture surface wrapper",
    );
    wrapper.threeDimensional = true;
    expect(validateProjectDocument(project).compositions[1].layers[0].kind).toBe("adjustment");
    wrapper.threeDimensional = false;
    nested.layers.shift();

    const nestedParticle = createLayerForComposition("particle", nested);
    nested.layers.push(nestedParticle);
    expect(() => validateProjectDocument(project)).toThrow(
      "Precomposition sources cannot contain GPU particle layers",
    );

    const secondWrapper = createLayerForComposition("precomposition", root);
    secondWrapper.sourceCompositionId = nested.id;
    secondWrapper.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    root.layers.unshift(secondWrapper);
    expect(() => validateProjectDocument(project)).toThrow(
      "Precomposition sources cannot contain GPU particle layers",
    );

    root.layers = root.layers.filter((layer) => layer.kind !== "precomposition");
    nested.layers.push(createLayerForComposition("particle", nested));
    expect(() => validateProjectDocument(project)).toThrow("at most one GPU particle layer");
    nested.layers.pop();
    nestedParticle.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    expect(() => validateProjectDocument(project)).toThrow(
      "GPU particle layers cannot use cloners",
    );
    nestedParticle.cloner = undefined;
    nested.layers = nested.layers.filter((layer) => layer.kind !== "particle");

    const firstLut = createEffect("lut");
    const secondLut = createEffect("lut");
    firstLut.resource = parseCubeLut(
      "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1",
      "first.cube",
    );
    secondLut.resource = parseCubeLut(
      "LUT_3D_SIZE 2\n0 0 0\n0.8 0 0\n0 0.8 0\n0.8 0.8 0\n0 0 0.8\n0.8 0 0.8\n0 0.8 0.8\n0.8 0.8 0.8",
      "second.cube",
    );
    nested.layers[0].effects = [firstLut, secondLut];
    expect(() => validateProjectDocument(project)).toThrow("at most one enabled 3D LUT");
    secondLut.enabled = false;
    expect(validateProjectDocument(project).compositions[1].layers[0].effects).toHaveLength(2);
  });

  it("roundtrips strict adjustment layers and rejects unknown or source-backed kinds", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const adjustment = createLayerForComposition("adjustment", composition);
    composition.layers.unshift(adjustment);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0]).toMatchObject({
      kind: "adjustment",
      color: [0, 0, 0, 0],
      blendMode: "normal",
      threeDimensional: false,
    });

    adjustment.transform.opacity = { mode: "static", value: 99 };
    expect(() => validateProjectDocument(project)).toThrow(
      "transform must be canonical for adjustment layers",
    );
    adjustment.transform.opacity = { mode: "static", value: 100 };

    adjustment.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    expect(() => validateProjectDocument(project)).toThrow(
      "cloner is not supported for adjustment layers",
    );
    adjustment.cloner = undefined;
    adjustment.kind = "unsupported" as typeof adjustment.kind;
    expect(() => validateProjectDocument(project)).toThrow("kind is unsupported");
  });

  it("roundtrips a valid editor project", () => {
    const project = createBlankProject();
    expect(validateProjectDocument(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it("requires a strict frame-aligned composition work area", () => {
    const project = createBlankProject();
    project.compositions[0].workArea = { start: 1, end: 3 };
    expect(
      validateProjectDocument(JSON.parse(serializeProject(project))).compositions[0].workArea,
    ).toEqual({ start: 1, end: 3 });

    const missing = structuredClone(project) as unknown as {
      compositions: Array<{ workArea?: unknown }>;
    };
    delete missing.compositions[0].workArea;
    expect(() => validateProjectDocument(missing)).toThrow("workArea must be an object");
    project.compositions[0].workArea = { start: 1.01, end: 3 };
    expect(() => validateProjectDocument(project)).toThrow("frame-aligned composition range");
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

  it("roundtrips bounded preview audio state", () => {
    const project = createBlankProject();
    const layer = project.compositions[0].layers[0];
    layer.audioEnabled = false;
    layer.audioGain = 0.35;
    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0]).toMatchObject({
      audioEnabled: false,
      audioGain: 0.35,
    });
    layer.audioGain = 1.1;
    expect(() => validateProjectDocument(project)).toThrow("audioGain must be between 0 and 1");
  });

  it("roundtrips GPU material and physical light settings", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const light = createLayerForComposition("light", composition);
    mesh.material = {
      metallic: 0.8,
      roughness: 0.2,
      emissive: 1.5,
      alphaMode: "blend",
      alphaCutoff: 0.35,
    };
    light.light = {
      kind: "spot",
      intensity: 6,
      range: 3200,
      coneAngle: 70,
      shadowQuality: "high",
    };
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

  it("roundtrips bounded normal maps and Radiance HDR environment lighting", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    mesh.mesh = {
      name: "Normal mapped triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      materialTextures: {
        normal: {
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AA==",
          texCoord: 0,
          scale: 1.5,
        },
      },
    };
    composition.environment = {
      enabled: true,
      intensity: 2,
      rotation: -45,
      source: {
        name: "studio.hdr",
        mimeType: "image/vnd.radiance",
        dataUrl: "data:image/vnd.radiance;base64,AA==",
      },
    };
    composition.layers.push(mesh);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].environment).toEqual(composition.environment);
    expect(roundtrip.compositions[0].layers[1].mesh?.materialTextures).toEqual(
      mesh.mesh.materialTextures,
    );
    const normalMap = mesh.mesh.materialTextures?.normal;
    if (!normalMap) throw new Error("Expected normal map fixture");
    normalMap.scale = 9;
    expect(() => validateProjectDocument(project)).toThrow("scale must be between -8 and 8");
  });

  it("rejects unsafe mesh tangent frames", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    mesh.mesh = {
      name: "Triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    };
    composition.layers.push(mesh);

    const tangents = mesh.mesh.tangents;
    if (!tangents) throw new Error("Expected tangent fixture");
    tangents[0] = Number.NaN;
    expect(() => validateProjectDocument(project)).toThrow("finite number");
    tangents[0] = 0;
    expect(() => validateProjectDocument(project)).toThrow("must not be near zero");
    tangents[0] = 1;
    tangents[3] = 0;
    expect(() => validateProjectDocument(project)).toThrow("handedness must be -1 or 1");
  });

  it("roundtrips bounded deterministic particle settings", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const particles = createLayerForComposition("particle", composition);
    particles.particle = {
      ...createDefaultParticleSettings(),
      renderMode: "mesh",
      count: 500_000,
      seed: 42,
      lifetime: 4,
      emitterShape: "ring",
      velocity: [0.25, 0.1, -0.05],
      gravity: [0, -0.08, 0],
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
    expect(() => validateProjectDocument(project)).toThrow("between 1 and 1000000");
    particles.particle.count = 500_000;
    (particles.particle as { renderMode: string }).renderMode = "sprite";
    expect(() => validateProjectDocument(project)).toThrow("renderMode");
    particles.particle.renderMode = "mesh";
    particles.particle.velocity[0] = Number.POSITIVE_INFINITY;
    expect(() => validateProjectDocument(project)).toThrow("velocity[0] must be a finite number");
    particles.particle.velocity[0] = 0.25;
    particles.particle.startSize = 257;
    expect(() => validateProjectDocument(project)).toThrow(
      "startSize must be between 0.01 and 256",
    );
    particles.particle.startSize = 3;
    particles.particle.renderMode = "billboard";
    particles.blendMode = "normal";
    expect(() => validateProjectDocument(project)).toThrow("require add blend mode");
    particles.particle.renderMode = "mesh";
    particles.blendMode = "normal";
    particles.particle.lifetime = 3601;
    expect(() => validateProjectDocument(project)).toThrow(
      "lifetime must be between 0.05 and 3600",
    );
    particles.particle.lifetime = 4;
    (particles.particle as unknown as Record<string, unknown>).legacySpeed = 0.25;
    expect(() => validateProjectDocument(project)).toThrow("legacySpeed is not supported");
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
      lineJoin: "miter",
    };

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].shape).toEqual(shape.shape);
    shape.shape.strokeWidth = -1;
    expect(() => validateProjectDocument(project)).toThrow("must not be negative");
  });

  it("roundtrips bounded cubic Bezier anchors and handles", () => {
    const project = createBlankProject();
    const shape = project.compositions[0].layers[0];
    if (!shape.shape) throw new Error("Expected shape settings");
    shape.shape.kind = "bezier";
    shape.shape.strokeWidth = 8;
    shape.shape.lineJoin = "round";
    shape.shape.path = {
      closed: false,
      vertices: [
        { position: [-0.5, 0], inTangent: [0, 0], outTangent: [0.25, -0.4] },
        { position: [0.5, 0], inTangent: [-0.25, 0.4], outTangent: [0, 0] },
      ],
    };

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].shape?.path).toEqual(shape.shape.path);
    shape.shape.path.vertices[0].position[0] = 17;
    expect(() => validateProjectDocument(project)).toThrow("out of range");
  });

  it("roundtrips finite spatial keyframe handles", () => {
    const project = createBlankProject();
    const opacity = {
      mode: "animated" as const,
      keyframes: [
        {
          id: "spatial-start",
          time: 0,
          value: 0,
          interpolation: "linear" as const,
          spatialOut: 40,
        },
        {
          id: "spatial-end",
          time: 1,
          value: 100,
          interpolation: "linear" as const,
          spatialIn: -20,
        },
      ],
    };
    project.compositions[0].layers[0].transform.opacity = opacity;

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].transform.opacity).toEqual(opacity);
    opacity.keyframes[0].spatialOut = Number.NaN;
    expect(() => validateProjectDocument(project)).toThrow("spatialOut must be finite");
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

  it("roundtrips bounded cloners and rejects oversized grids", () => {
    const project = createBlankProject();
    const layer = project.compositions[0].layers[0];
    layer.cloner = {
      distribution: {
        kind: "radial",
        count: 12,
        radius: 320,
        startAngle: -90,
        endAngle: 270,
        axis: "z",
        alignRotation: true,
      },
      effectors: [
        {
          id: "random",
          kind: "random",
          enabled: true,
          strength: 0.5,
          seed: 7,
          position: [10, 20, 0],
          scale: [15, 15, 0],
          rotation: [0, 0, 30],
        },
      ],
    };

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0].cloner).toEqual(layer.cloner);
    layer.cloner = {
      distribution: { kind: "grid", count: [512, 512, 2], spacing: [1, 1, 1] },
      effectors: [],
    };
    expect(() => validateProjectDocument(project)).toThrow("exceeds 65536 instances");
  });
});
