import { describe, expect, it } from "vitest";
import { parseCubeLut } from "../effects/cube-lut";
import { createEffect } from "../effects/registry";
import {
  createParticleLayerForComposition,
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "./bundled-particle";
import { createLayerForComposition } from "./layer-factory";
import { createDefaultParticleSettings } from "./particle-settings";
import { createBlankProject } from "./project";
import { serializeProject, storeRecoverySnapshot, validateProjectDocument } from "./project-file";
import type { ProjectFolder } from "./types";

describe("project document boundary", () => {
  it("roundtrips shared sources once and rejects invalid references or metadata", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:plate",
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    const first = createLayerForComposition("image", composition);
    const second = createLayerForComposition("image", composition);
    first.sourceId = source.id;
    second.sourceId = source.id;
    project.sources.push(source);
    composition.layers.push(first, second);
    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.sources).toEqual([source]);
    expect(roundtrip.compositions[0].layers.slice(-2).map((layer) => layer.sourceId)).toEqual([
      source.id,
      source.id,
    ]);

    first.sourceId = "missing";
    expect(() => validateProjectDocument(project)).toThrow("missing footage source");
    first.sourceId = source.id;
    source.width = 30_001;
    expect(() => validateProjectDocument(project)).toThrow("width must be an integer");
    source.width = 1920;
    source.interpretation.colorSpace = "acescg" as never;
    expect(() => validateProjectDocument(project)).toThrow("colorSpace is unsupported");
  });

  it("roundtrips canonical solid sources and transform-only null layers", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const solid = createLayerForComposition("solid", composition);
    const nullLayer = createLayerForComposition("null", composition);
    solid.parentId = nullLayer.id;
    nullLayer.threeDimensional = true;
    composition.layers = [nullLayer, solid];

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.schemaVersion).toBe(5);
    expect(roundtrip.compositions[0].layers).toEqual([nullLayer, solid]);
  });

  it("rejects missing, oversized, and internally inconsistent solid sources", () => {
    const project = createBlankProject();
    const solid = createLayerForComposition("solid", project.compositions[0]);
    project.compositions[0].layers = [solid];
    solid.solid = undefined;
    expect(() => validateProjectDocument(project)).toThrow("solid is required");

    solid.solid = { width: 30_001, height: 100, color: [1, 1, 1, 1] };
    solid.size = [30_001, 100];
    solid.color = [1, 1, 1, 1];
    expect(() => validateProjectDocument(project)).toThrow("solid.width must be an integer");

    solid.solid.width = 100;
    expect(() => validateProjectDocument(project)).toThrow("size must mirror");
    solid.size = [100, 100];
    solid.solid.color = [1, 1, 1, 2];
    solid.color = [1, 1, 1, 2];
    expect(() => validateProjectDocument(project)).toThrow("channels from 0 through 1");
  });

  it("reports recovery storage exhaustion for an unsaved browser project", async () => {
    const storage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    await expect(storeRecoverySnapshot(createBlankProject(), storage)).rejects.toThrow(
      "quota exceeded",
    );
  });

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

    const nestedParticle = createParticleLayerForComposition(nested);
    nested.layers.push(nestedParticle);
    const validatedNestedLayers = validateProjectDocument(project).compositions[1].layers;
    expect(validatedNestedLayers[validatedNestedLayers.length - 1]?.kind).toBe("generator");

    const secondWrapper = createLayerForComposition("precomposition", root);
    secondWrapper.sourceCompositionId = nested.id;
    secondWrapper.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    root.layers.unshift(secondWrapper);
    expect(validateProjectDocument(project).compositions[0].layers[0].cloner).toBeDefined();

    root.layers = root.layers.filter((layer) => layer.kind !== "precomposition");
    nested.layers.push(createParticleLayerForComposition(nested));
    expect(
      validateProjectDocument(project).compositions[1].layers.filter(
        (layer) => layer.kind === "generator",
      ),
    ).toHaveLength(2);
    nested.layers.pop();
    nestedParticle.cloner = {
      distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
      effectors: [],
    };
    expect(
      validateProjectDocument(project).compositions[1].layers.find(
        (layer) => layer.id === nestedParticle.id,
      )?.cloner,
    ).toBeDefined();
    nestedParticle.cloner = undefined;
    nested.layers = nested.layers.filter((layer) => layer.kind !== "generator");

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

  it("roundtrips project folders and rejects cyclic folder trees", () => {
    const project = createBlankProject();
    const parent: ProjectFolder = { id: crypto.randomUUID(), name: "Footage" };
    const child = { id: crypto.randomUUID(), name: "Selects", parentId: parent.id };
    project.folders = [parent, child];
    project.itemFolderIds[project.activeCompositionId] = child.id;

    expect(validateProjectDocument(JSON.parse(serializeProject(project)))).toMatchObject({
      folders: [parent, child],
      itemFolderIds: { [project.activeCompositionId]: child.id },
    });
    parent.parentId = child.id;
    expect(() => validateProjectDocument(project)).toThrow(
      "project folders cannot contain a cycle",
    );
  });

  it("hydrates project organization for v1 documents created before folders", () => {
    const legacy = structuredClone(createBlankProject()) as Partial<
      ReturnType<typeof createBlankProject>
    >;
    delete legacy.folders;
    delete legacy.itemFolderIds;
    expect(validateProjectDocument(legacy)).toMatchObject({ folders: [], itemFolderIds: {} });
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
    const layer = createLayerForComposition("audio", project.compositions[0]);
    const source = {
      id: crypto.randomUUID(),
      kind: "audio" as const,
      name: "voice.flac",
      mimeType: "audio/flac",
      contentIdentity: "sha256:voice",
      duration: 5,
      channels: 2,
      sampleRate: 48_000,
      streamIndex: 1,
      interpretation: { alpha: "ignore" as const, colorSpace: "srgb" as const },
    };
    project.sources.push(source);
    layer.sourceId = source.id;
    project.compositions[0].layers.unshift(layer);
    layer.audioEnabled = false;
    layer.audio = { levelsDb: [-9, -6], pan: 0.25, muted: true, reversed: true };
    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(roundtrip.compositions[0].layers[0]).toMatchObject({
      audioEnabled: false,
      audio: { levelsDb: [-9, -6], pan: 0.25, muted: true, reversed: true },
    });
    expect(roundtrip.sources[0]).toEqual(source);
    layer.audio.levelsDb[0] = 25;
    expect(() => validateProjectDocument(project)).toThrow("audio.levelsDb");
    layer.audio.levelsDb[0] = 0;
    source.streamIndex = 128;
    expect(() => validateProjectDocument(project)).toThrow("streamIndex is unsupported");
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

  it("roundtrips plugin-owned particle settings through the generic envelope", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const particles = createParticleLayerForComposition(composition);
    particles.generator = createParticleSceneGenerator({
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
    });
    composition.layers.push(particles);

    const roundtrip = validateProjectDocument(JSON.parse(serializeProject(project)));
    expect(particleSettingsFromGenerator(roundtrip.compositions[0].layers[1].generator)).toEqual(
      particleSettingsFromGenerator(particles.generator),
    );
    if (!particles.generator) throw new Error("Expected particle generator settings");
    particles.generator.parameters.count = 1_000_001;
    particles.generator.parameters.renderMode = "sprite";
    particles.generator.parameters.startSize = 257;
    particles.blendMode = "normal";
    particles.generator.parameters.lifetime = 3601;
    particles.generator.parameters.legacySpeed = 0.25;
    const pluginOwned = validateProjectDocument(project).compositions[0].layers[1];
    expect(pluginOwned.blendMode).toBe("normal");
    expect(pluginOwned.generator?.parameters).toMatchObject({
      count: 1_000_001,
      renderMode: "sprite",
      startSize: 257,
      lifetime: 3601,
      legacySpeed: 0.25,
    });

    (particles.generator.parameters.velocity as number[])[0] = Number.POSITIVE_INFINITY;
    expect(() => validateProjectDocument(project)).toThrow("velocity has an unsupported value");
    (particles.generator.parameters.velocity as number[])[0] = 0.25;
    particles.generator.parameters.renderMode = "x".repeat(257);
    expect(() => validateProjectDocument(project)).toThrow("renderMode is too long");
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
