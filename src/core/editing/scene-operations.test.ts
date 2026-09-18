import { describe, expect, it } from "vitest";
import { createEffect } from "../../effects/registry";
import { createLayerForComposition } from "../layers/layer-factory";
import {
  activeComposition,
  createBlankComposition,
  createBlankProject,
  createDemoProject,
} from "../project/project";
import {
  createParticleLayerForComposition,
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../scene/bundled-particle";
import { createDefaultParticleSettings } from "../scene/particle-settings";
import { applyOperations } from "./operations";

describe("scene operations", () => {
  it("supports multiple cloned scene generators and bounds adjustment and LUT resources", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const secondGenerator = createParticleLayerForComposition(composition);
    const withSecondGenerator = applyOperations(project, [
      { type: "addLayer", layer: secondGenerator },
    ]);
    expect(
      activeComposition(withSecondGenerator).layers.filter((layer) => layer.kind === "generator"),
    ).toHaveLength(2);
    const generator = composition.layers.find((layer) => layer.kind === "generator");
    if (!generator) throw new Error("Expected demo scene generator layer");
    const cloned = applyOperations(project, [
      {
        type: "setClonerSettings",
        layerId: generator.id,
        cloner: {
          distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
          effectors: [],
        },
      },
    ]);
    expect(
      activeComposition(cloned).layers.find((layer) => layer.id === generator.id)?.cloner,
    ).toBeDefined();

    const layer = composition.layers[0];
    layer.effects = [];
    const firstLut = createEffect("lut");
    const secondLut = createEffect("lut");
    secondLut.enabled = false;
    const withDisabled = applyOperations(project, [
      { type: "addEffect", layerId: layer.id, effect: firstLut },
      { type: "addEffect", layerId: layer.id, effect: secondLut },
    ]);
    expect(() =>
      applyOperations(withDisabled, [
        { type: "toggleEffect", layerId: layer.id, effectId: secondLut.id },
      ]),
    ).toThrow("at most one enabled 3D LUT");

    const nested = createBlankComposition("Referenced");
    const wrapper = createLayerForComposition("precomposition", composition);
    wrapper.sourceCompositionId = nested.id;
    composition.layers.unshift(wrapper);
    project.compositions.push(nested);
    project.activeCompositionId = nested.id;
    expect(() =>
      applyOperations(project, [
        { type: "addLayer", layer: createLayerForComposition("adjustment", nested) },
      ]),
    ).not.toThrow();
  });

  it("allows adjustment precompositions on both 2D and 3D surface routes", () => {
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const nested = createBlankComposition("Adjusted source");
    nested.layers.unshift(createLayerForComposition("adjustment", nested));
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    root.layers = [wrapper];
    project.compositions.push(nested);

    expect(() =>
      applyOperations(project, [
        { type: "toggleLayer", layerId: wrapper.id, field: "threeDimensional" },
      ]),
    ).not.toThrow();

    nested.layers = nested.layers.filter((layer) => layer.kind !== "adjustment");
    const flattened = applyOperations(project, [
      { type: "toggleLayer", layerId: wrapper.id, field: "threeDimensional" },
    ]);
    expect(flattened.compositions[0].layers[0].threeDimensional).toBe(false);
  });

  it("allows GPU scene generators in nested and cloned precompositions", () => {
    const project = createBlankProject(true);
    const root = project.compositions[0];
    const nested = createBlankComposition("Particle source");
    nested.layers = [createParticleLayerForComposition(nested)];
    project.compositions.push(nested);

    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    const withWrapper = applyOperations(project, [{ type: "addLayer", layer: wrapper }]);
    expect(withWrapper.compositions[0].layers.some((layer) => layer.id === wrapper.id)).toBe(true);

    const referenced = createBlankComposition("Referenced later");
    const unresolvedWrapper = createLayerForComposition("precomposition", root);
    unresolvedWrapper.sourceCompositionId = referenced.id;
    root.layers.unshift(unresolvedWrapper);
    referenced.layers = [createParticleLayerForComposition(referenced)];
    const withReferenced = applyOperations(project, [
      { type: "addComposition", composition: referenced, activate: false },
    ]);
    expect(
      withReferenced.compositions.some((composition) => composition.id === referenced.id),
    ).toBe(true);

    const referencedRoot = createBlankProject(true);
    const referencedComposition = createBlankComposition("Referenced");
    referencedRoot.compositions.push(referencedComposition);
    const validWrapper = createLayerForComposition(
      "precomposition",
      referencedRoot.compositions[0],
    );
    validWrapper.sourceCompositionId = referencedComposition.id;
    referencedRoot.compositions[0].layers.unshift(validWrapper);
    referencedRoot.activeCompositionId = referencedComposition.id;
    const updatedReferencedRoot = applyOperations(referencedRoot, [
      {
        type: "addLayer",
        layer: createParticleLayerForComposition(referencedComposition),
      },
    ]);
    expect(updatedReferencedRoot.compositions[1].layers[0].kind).toBe("generator");

    root.layers = [wrapper];
    const cloned = applyOperations(project, [
      {
        type: "setClonerSettings",
        layerId: wrapper.id,
        cloner: {
          distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
          effectors: [],
        },
      },
    ]);
    expect(cloned.compositions[0].layers[0].cloner).toBeDefined();
  });

  it("sets normalized cloner settings through a replayable operation", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const next = applyOperations(source, [
      {
        type: "setClonerSettings",
        layerId: layer.id,
        cloner: {
          distribution: { kind: "grid", count: [0, 2.9, 1], spacing: [80, 40, 0] },
          effectors: [
            {
              id: "scale",
              kind: "scale",
              enabled: true,
              strength: 2,
              value: [150, 150, 150],
            },
          ],
        },
      },
    ]);

    expect(activeComposition(next).layers[0].cloner).toMatchObject({
      distribution: { kind: "grid", count: [1, 2, 1] },
      effectors: [{ kind: "scale", strength: 2 }],
    });
    expect(layer.cloner).toBeUndefined();
  });

  it("updates bounded GPU material and light settings without mutating the source", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const mesh = composition.layers.find((layer) => layer.kind === "mesh") ?? composition.layers[0];
    const light =
      composition.layers.find((layer) => layer.kind === "light") ?? composition.layers[1];
    const next = applyOperations(source, [
      {
        type: "setMaterial3d",
        layerId: mesh.id,
        material: {
          metallic: 1.4,
          roughness: -0.2,
          emissive: 3,
          alphaMode: "mask",
          alphaCutoff: 2,
        },
      },
      {
        type: "setLightSettings",
        layerId: light.id,
        light: {
          kind: "spot",
          intensity: 8,
          range: 3600,
          coneAngle: 52,
          shadowQuality: "high",
        },
      },
      { type: "setLayerColor", layerId: light.id, color: [1.2, 0.7, 0.3, 1] },
    ]);

    expect(activeComposition(next).layers.find((layer) => layer.id === mesh.id)?.material).toEqual({
      metallic: 1,
      roughness: 0.04,
      emissive: 3,
      alphaMode: "mask",
      alphaCutoff: 1,
    });
    expect(activeComposition(next).layers.find((layer) => layer.id === light.id)).toMatchObject({
      light: {
        kind: "spot",
        intensity: 8,
        range: 3600,
        coneAngle: 52,
        shadowQuality: "high",
      },
      color: [1.2, 0.7, 0.3, 1],
    });
    expect(mesh.material).toBeUndefined();
    expect(light.light).toBeUndefined();
  });

  it("updates bounded camera projection settings through an undoable operation", () => {
    const source = createDemoProject();
    const camera = activeComposition(source).layers.find((layer) => layer.kind === "camera");
    if (!camera?.camera) throw new Error("Expected demo camera");
    const next = applyOperations(source, [
      {
        type: "setCameraSettings",
        layerId: camera.id,
        camera: {
          ...camera.camera,
          projection: "orthographic",
          zoom: { mode: "static", value: 2_000_000 },
          orthographicSize: { mode: "static", value: 0 },
        },
      },
    ]);

    expect(
      activeComposition(next).layers.find((layer) => layer.id === camera.id)?.camera,
    ).toMatchObject({
      projection: "orthographic",
      zoom: { mode: "static", value: 1_000_000 },
      orthographicSize: { mode: "static", value: 1 },
    });
    expect(camera.camera.projection).toBe("perspective");
  });

  it("keyframes camera point of interest through the shared graph property path", () => {
    const source = createDemoProject();
    const camera = activeComposition(source).layers.find((layer) => layer.kind === "camera");
    if (!camera?.camera) throw new Error("Expected demo camera");
    const next = applyOperations(source, [
      {
        type: "addKeyframe",
        layerId: camera.id,
        path: "camera.pointOfInterest.0",
        keyframe: {
          id: "camera-poi-x",
          time: 2,
          value: 1500,
          interpolation: "bezier",
          easing: [0.42, 0, 0.58, 1],
        },
      },
    ]);

    expect(
      activeComposition(next).layers.find((layer) => layer.id === camera.id)?.camera
        ?.pointOfInterest[0],
    ).toMatchObject({ mode: "animated", keyframes: [{ value: 1500 }] });
    expect(camera.camera.pointOfInterest[0]).toMatchObject({ mode: "static" });
  });

  it("keyframes authoritative camera optics through shared timeline operations", () => {
    const source = createDemoProject();
    const camera = activeComposition(source).layers.find((layer) => layer.kind === "camera");
    if (!camera?.camera) throw new Error("Expected demo camera");
    const next = applyOperations(source, [
      {
        type: "addKeyframe",
        layerId: camera.id,
        path: "camera.aperture",
        keyframe: { id: "camera-fstop", time: 1, value: 5.6, interpolation: "linear" },
      },
    ]);
    const result = activeComposition(next).layers.find((layer) => layer.id === camera.id)?.camera;
    expect(result?.aperture).toEqual({
      mode: "animated",
      keyframes: [{ id: "camera-fstop", time: 1, value: 5.6, interpolation: "linear" }],
    });
    const bounded = applyOperations(next, [
      {
        type: "updateKeyframe",
        layerId: camera.id,
        path: "camera.aperture",
        keyframeId: "camera-fstop",
        time: 1,
        value: 50_000,
        interpolation: "linear",
      },
    ]);
    expect(
      activeComposition(bounded).layers.find((layer) => layer.id === camera.id)?.camera?.aperture,
    ).toMatchObject({ keyframes: [{ value: 10_000 }] });
  });

  it("bounds bundled particle generator parameters through the generic operation", () => {
    const source = createDemoProject();
    const particles = activeComposition(source).layers.find((layer) => layer.kind === "generator");
    if (!particles) throw new Error("Expected demo scene generator layer");
    const next = applyOperations(source, [
      {
        type: "setSceneGenerator",
        layerId: particles.id,
        generator: createParticleSceneGenerator({
          ...createDefaultParticleSettings(),
          renderMode: "mesh",
          count: 2_000_000,
          seed: -20,
          startRotation: -80_000,
          endRotation: 80_000,
          emitterPosition: [Number.NaN, -20, 20],
        }),
      },
    ]);

    expect(
      particleSettingsFromGenerator(
        activeComposition(next).layers.find((layer) => layer.id === particles.id)?.generator,
      ),
    ).toEqual({
      ...createDefaultParticleSettings(),
      renderMode: "mesh",
      count: 1_000_000,
      seed: 0,
      startRotation: -36_000,
      endRotation: 36_000,
      emitterPosition: [0, -4, 4],
    });
    expect(particleSettingsFromGenerator(particles.generator)).toMatchObject({
      count: 100_000,
      seed: 13_337,
    });

    const billboardWithNormalBlend = applyOperations(source, [
      { type: "setBlendMode", layerId: particles.id, blendMode: "normal" },
    ]);
    expect(
      activeComposition(billboardWithNormalBlend).layers.find((layer) => layer.id === particles.id)
        ?.blendMode,
    ).toBe("normal");

    const meshWithNormalBlend = applyOperations(source, [
      {
        type: "setSceneGenerator",
        layerId: particles.id,
        generator: createParticleSceneGenerator({
          ...createDefaultParticleSettings(),
          renderMode: "mesh",
        }),
      },
      { type: "setBlendMode", layerId: particles.id, blendMode: "normal" },
    ]);
    const billboardWithPreservedBlend = applyOperations(meshWithNormalBlend, [
      {
        type: "setSceneGenerator",
        layerId: particles.id,
        generator: createParticleSceneGenerator(),
      },
    ]);
    expect(
      activeComposition(billboardWithPreservedBlend).layers.find(
        (layer) => layer.id === particles.id,
      )?.blendMode,
    ).toBe("normal");

    const shape = activeComposition(source).layers.find((layer) => layer.kind === "shape");
    if (!shape) throw new Error("Expected demo shape layer");
    expect(() =>
      applyOperations(source, [
        {
          type: "setSceneGenerator",
          layerId: shape.id,
          generator: createParticleSceneGenerator(),
        },
      ]),
    ).toThrow("Scene generator settings require a generator layer");
  });
});
