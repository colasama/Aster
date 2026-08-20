import { describe, expect, it } from "vitest";
import { createEffect } from "../effects/registry";
import { createLayerForComposition } from "./layer-factory";
import { applyOperations } from "./operations";
import { createDefaultParticleSettings } from "./particle-settings";
import { planPrecomposition } from "./precomposition";
import {
  activeComposition,
  createBlankComposition,
  createBlankProject,
  createDemoProject,
} from "./project";
import type { Lut3dResource } from "./types";

describe("structured project operations", () => {
  it("adds strict adjustment layers and rejects source-layer mutations", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const adjustment = createLayerForComposition("adjustment", composition, 1);
    const added = applyOperations(source, [{ type: "addLayer", layer: adjustment }]);
    const result = activeComposition(added).layers[0];

    expect(result).toMatchObject({
      kind: "adjustment",
      name: "Adjustment Layer",
      color: [0, 0, 0, 0],
      size: [composition.width, composition.height],
      inPoint: 1,
      blendMode: "normal",
      threeDimensional: false,
    });
    expect(() =>
      applyOperations(added, [{ type: "setLayerColor", layerId: result.id, color: [1, 0, 0, 1] }]),
    ).toThrow("not supported for adjustment layers");
    expect(() =>
      applyOperations(added, [{ type: "setBlendMode", layerId: result.id, blendMode: "screen" }]),
    ).toThrow("require normal blend mode");
    expect(() =>
      applyOperations(added, [
        { type: "setProperty", layerId: result.id, path: "position.0", value: 12 },
      ]),
    ).toThrow("has no visual meaning for adjustment layers");
    expect(() =>
      applyOperations(added, [
        { type: "setLayerTimeMapping", layerId: result.id, offset: 2, stretch: 0.5 },
      ]),
    ).toThrow("has no visual meaning for adjustment layers");
  });

  it("enforces bounded adjustment, particle, and LUT render resources", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const secondParticle = createLayerForComposition("particle", composition);
    expect(() => applyOperations(project, [{ type: "addLayer", layer: secondParticle }])).toThrow(
      "at most one GPU particle layer",
    );
    const particle = composition.layers.find((layer) => layer.kind === "particle");
    if (!particle) throw new Error("Expected demo particle layer");
    expect(() =>
      applyOperations(project, [
        {
          type: "setClonerSettings",
          layerId: particle.id,
          cloner: {
            distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
            effectors: [],
          },
        },
      ]),
    ).toThrow("GPU particle layers cannot use cloners");

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
    ).toThrow("Adjustment layers in precomposition sources require a 3D texture surface wrapper");
  });

  it("keeps adjustment precompositions on the isolated 3D surface route", () => {
    const project = createBlankProject();
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
    ).toThrow("Adjustment layers in precomposition sources require a 3D texture surface wrapper");

    nested.layers = nested.layers.filter((layer) => layer.kind !== "adjustment");
    const flattened = applyOperations(project, [
      { type: "toggleLayer", layerId: wrapper.id, field: "threeDimensional" },
    ]);
    expect(flattened.compositions[0].layers[0].threeDimensional).toBe(false);
  });

  it("rejects every operation that could nest or clone a GPU particle source", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = createBlankComposition("Particle source");
    nested.layers = [createLayerForComposition("particle", nested)];
    project.compositions.push(nested);

    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    expect(() => applyOperations(project, [{ type: "addLayer", layer: wrapper }])).toThrow(
      "Precomposition sources cannot contain GPU particle layers",
    );

    const referenced = createBlankComposition("Referenced later");
    const unresolvedWrapper = createLayerForComposition("precomposition", root);
    unresolvedWrapper.sourceCompositionId = referenced.id;
    root.layers.unshift(unresolvedWrapper);
    referenced.layers = [createLayerForComposition("particle", referenced)];
    expect(() =>
      applyOperations(project, [
        { type: "addComposition", composition: referenced, activate: false },
      ]),
    ).toThrow("Precomposition sources cannot contain GPU particle layers");

    const referencedRoot = createBlankProject();
    const referencedComposition = createBlankComposition("Referenced");
    referencedRoot.compositions.push(referencedComposition);
    const validWrapper = createLayerForComposition(
      "precomposition",
      referencedRoot.compositions[0],
    );
    validWrapper.sourceCompositionId = referencedComposition.id;
    referencedRoot.compositions[0].layers.unshift(validWrapper);
    referencedRoot.activeCompositionId = referencedComposition.id;
    expect(() =>
      applyOperations(referencedRoot, [
        {
          type: "addLayer",
          layer: createLayerForComposition("particle", referencedComposition),
        },
      ]),
    ).toThrow("Precomposition sources cannot contain GPU particle layers");

    root.layers = [wrapper];
    expect(() =>
      applyOperations(project, [
        {
          type: "setClonerSettings",
          layerId: wrapper.id,
          cloner: {
            distribution: { kind: "grid", count: [2, 1, 1], spacing: [100, 0, 0] },
            effectors: [],
          },
        },
      ]),
    ).toThrow("Precomposition sources cannot contain GPU particle layers");
  });

  it("does not mutate the source project", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const result = applyOperations(source, [
      { type: "renameLayer", layerId: layer.id, name: "Renamed" },
      { type: "setProperty", layerId: layer.id, path: "opacity", value: 42 },
    ]);
    expect(activeComposition(source).layers[0].name).toBe("ASTER");
    expect(activeComposition(result).layers[0].name).toBe("Renamed");
    expect(activeComposition(result).layers[0].transform.opacity).toEqual({
      mode: "static",
      value: 42,
    });
  });

  it("creates and edits compositions through replayable project operations", () => {
    const source = createDemoProject();
    const composition = createBlankComposition("Second");
    const result = applyOperations(source, [
      { type: "addComposition", composition, activate: true },
      {
        type: "setCompositionSettings",
        compositionId: composition.id,
        name: "Delivery",
        width: 7680,
        height: 4320,
        frameRate: { numerator: 60_000, denominator: 1001 },
        duration: 30,
      },
    ]);
    expect(result.activeCompositionId).toBe(composition.id);
    expect(activeComposition(result)).toMatchObject({
      name: "Delivery",
      width: 7680,
      height: 4320,
      frameRate: { numerator: 60_000, denominator: 1001 },
      duration: 30,
    });
    expect(source.compositions).toHaveLength(1);
    const navigated = applyOperations(result, [
      { type: "setActiveComposition", compositionId: source.activeCompositionId },
    ]);
    expect(navigated.activeCompositionId).toBe(source.activeCompositionId);
  });

  it("creates project folders and moves compositions and media between them", () => {
    const source = createBlankProject();
    const folder = { id: crypto.randomUUID(), name: "Footage" };
    const nestedFolder = { id: crypto.randomUUID(), name: "Selects", parentId: folder.id };
    const image = createLayerForComposition("image", activeComposition(source));
    image.asset = {
      name: "plate.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AA==",
      width: 1,
      height: 1,
    };
    const organized = applyOperations(source, [
      { type: "addLayer", layer: image },
      { type: "addProjectFolder", folder },
      { type: "addProjectFolder", folder: nestedFolder },
      { type: "moveProjectItem", itemId: source.activeCompositionId, folderId: folder.id },
      { type: "moveProjectItem", itemId: image.id, folderId: nestedFolder.id },
    ]);

    expect(organized.folders).toEqual([folder, nestedFolder]);
    expect(organized.itemFolderIds).toEqual({
      [source.activeCompositionId]: folder.id,
      [image.id]: nestedFolder.id,
    });
    const returnedToRoot = applyOperations(organized, [
      { type: "moveProjectItem", itemId: image.id },
    ]);
    expect(returnedToRoot.itemFolderIds[image.id]).toBeUndefined();
    expect(source.folders).toEqual([]);
  });

  it("persists frame-aligned work areas and normalizes them when duration shrinks", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const edited = applyOperations(source, [
      {
        type: "setCompositionWorkArea",
        compositionId: composition.id,
        start: 2.019,
        end: 5.011,
      },
    ]);
    expect(activeComposition(edited).workArea).toEqual({
      start: 121 / 60,
      end: 301 / 60,
    });

    const resized = applyOperations(edited, [
      {
        type: "setCompositionSettings",
        compositionId: composition.id,
        name: composition.name,
        width: composition.width,
        height: composition.height,
        frameRate: composition.frameRate,
        duration: 3,
      },
    ]);
    expect(activeComposition(resized).workArea).toEqual({ start: 121 / 60, end: 3 });
  });

  it("precomposes with stable IDs through a deterministic operation", () => {
    const source = createDemoProject();
    const layerId = activeComposition(source).layers[0].id;
    const plan = planPrecomposition(source, [layerId]);
    expect(plan).toBeDefined();
    if (!plan) return;
    const operation = { type: "precomposeLayers" as const, ...plan };
    const first = applyOperations(source, [operation]);
    const replay = applyOperations(source, [structuredClone(operation)]);
    expect({ ...first, updatedAt: "" }).toEqual({ ...replay, updatedAt: "" });
    expect(activeComposition(first).layers[plan.insertionIndex].id).toBe(plan.wrapper.id);
    expect(first.compositions.some((entry) => entry.id === plan.nestedComposition.id)).toBe(true);
  });

  it("rejects operations that target a missing layer", () => {
    const source = createDemoProject();
    expect(() =>
      applyOperations(source, [{ type: "renameLayer", layerId: "missing", name: "Nope" }]),
    ).toThrow("Layer does not exist");
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

  it("toggles an effect without mutating the source project", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers.find((entry) => entry.effects.length > 0);
    expect(layer).toBeDefined();
    const effect = layer?.effects[0];
    expect(effect).toBeDefined();

    const next = applyOperations(source, [
      { type: "toggleEffect", layerId: layer?.id ?? "", effectId: effect?.id ?? "" },
    ]);

    const toggled = activeComposition(next).layers.find((entry) => entry.id === layer?.id);
    expect(toggled?.effects[0].enabled).toBe(!effect?.enabled);
    expect(effect?.enabled).toBe(true);
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
    if (!camera) throw new Error("Expected demo camera");
    const next = applyOperations(source, [
      {
        type: "setCameraSettings",
        layerId: camera.id,
        camera: { projection: "orthographic", fieldOfView: 220, orthographicSize: 0 },
      },
    ]);

    expect(activeComposition(next).layers.find((layer) => layer.id === camera.id)?.camera).toEqual({
      projection: "orthographic",
      fieldOfView: 179,
      orthographicSize: 1,
    });
    expect(camera.camera?.projection).toBe("perspective");
  });

  it("bounds GPU particle count and deterministic seed settings", () => {
    const source = createDemoProject();
    const particles = activeComposition(source).layers.find((layer) => layer.kind === "particle");
    if (!particles) throw new Error("Expected demo particle layer");
    const next = applyOperations(source, [
      {
        type: "setParticleSettings",
        layerId: particles.id,
        particle: {
          ...createDefaultParticleSettings(),
          renderMode: "mesh",
          count: 2_000_000,
          seed: -20,
          startRotation: -80_000,
          endRotation: 80_000,
          emitterPosition: [Number.NaN, -20, 20],
        },
      },
    ]);

    expect(
      activeComposition(next).layers.find((layer) => layer.id === particles.id)?.particle,
    ).toEqual({
      ...createDefaultParticleSettings(),
      renderMode: "mesh",
      count: 1_000_000,
      seed: 0,
      startRotation: -36_000,
      endRotation: 36_000,
      emitterPosition: [0, -4, 4],
    });
    expect(particles.particle).toMatchObject({ count: 100_000, seed: 13_337 });

    expect(() =>
      applyOperations(source, [
        { type: "setBlendMode", layerId: particles.id, blendMode: "normal" },
      ]),
    ).toThrow("require add blend mode");

    const meshWithNormalBlend = applyOperations(source, [
      {
        type: "setParticleSettings",
        layerId: particles.id,
        particle: { ...createDefaultParticleSettings(), renderMode: "mesh" },
      },
      { type: "setBlendMode", layerId: particles.id, blendMode: "normal" },
    ]);
    expect(() =>
      applyOperations(meshWithNormalBlend, [
        {
          type: "setParticleSettings",
          layerId: particles.id,
          particle: createDefaultParticleSettings(),
        },
      ]),
    ).toThrow("require add blend mode");

    const shape = activeComposition(source).layers.find((layer) => layer.kind === "shape");
    if (!shape) throw new Error("Expected demo shape layer");
    expect(() =>
      applyOperations(source, [
        {
          type: "setParticleSettings",
          layerId: shape.id,
          particle: createDefaultParticleSettings(),
        },
      ]),
    ).toThrow("Particle settings require a GPU particle layer");
  });

  it("updates bounded vector fill and stroke settings", () => {
    const source = createDemoProject();
    const shape = activeComposition(source).layers.find((layer) => layer.kind === "shape");
    if (!shape) throw new Error("Expected demo shape");
    const next = applyOperations(source, [
      {
        type: "setShapeSettings",
        layerId: shape.id,
        shape: {
          kind: "ellipse",
          roundness: -10,
          strokeWidth: 18,
          strokeColor: [2, 0.5, 0.25, 1.5],
          fillMode: "linear",
          gradientColor: [0.1, 0.2, 20, 1.5],
          gradientAngle: 80_000,
          dashLength: -5,
          dashGap: 24,
          lineCap: "butt",
          lineJoin: "bevel",
        },
      },
    ]);

    expect(activeComposition(next).layers.find((layer) => layer.id === shape.id)?.shape).toEqual({
      kind: "ellipse",
      roundness: 0,
      strokeWidth: 18,
      strokeColor: [2, 0.5, 0.25, 1],
      fillMode: "linear",
      gradientColor: [0.1, 0.2, 16, 1],
      gradientAngle: 36_000,
      dashLength: 0,
      dashGap: 24,
      lineCap: "butt",
      lineJoin: "bevel",
    });
    expect(shape.shape?.kind).toBe("rectangle");
  });

  it("updates multiline text and bounded typography settings", () => {
    const source = createDemoProject();
    const text = activeComposition(source).layers.find((layer) => layer.kind === "text");
    if (!text?.textStyle) throw new Error("Expected styled demo text");
    const next = applyOperations(source, [
      { type: "setTextContent", layerId: text.id, text: "GPU\nMOTION" },
      {
        type: "setTextStyle",
        layerId: text.id,
        textStyle: {
          ...text.textStyle,
          fontWeight: 950,
          alignment: "right",
          tracking: 24,
          strokeWidth: 7,
        },
      },
    ]);
    const updated = activeComposition(next).layers.find((layer) => layer.id === text.id);
    expect(updated?.text).toBe("GPU\nMOTION");
    expect(updated?.textStyle).toMatchObject({
      fontWeight: 900,
      alignment: "right",
      tracking: 24,
      strokeWidth: 7,
    });
    expect(text.text).not.toBe("GPU\nMOTION");
  });

  it("sets bounded preview audio gain without mutating the source", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const louder = applyOperations(source, [
      { type: "setLayerAudioGain", layerId: layer.id, gain: 8 },
    ]);
    const silent = applyOperations(source, [
      { type: "setLayerAudioGain", layerId: layer.id, gain: -1 },
    ]);
    expect(activeComposition(louder).layers[0].audioGain).toBe(1);
    expect(activeComposition(silent).layers[0].audioGain).toBe(0);
    expect(layer.audioGain).toBeUndefined();
  });

  it("reorders effects through a bounded operation", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    expect(layer.effects.length).toBeGreaterThan(1);
    const firstId = layer.effects[0].id;
    const moved = applyOperations(source, [
      { type: "moveEffect", layerId: layer.id, effectId: firstId, toIndex: 99 },
    ]);

    const movedEffects = activeComposition(moved).layers[0].effects;
    expect(movedEffects[movedEffects.length - 1]?.id).toBe(firstId);
    expect(layer.effects[0].id).toBe(firstId);
  });

  it("sets and removes an effect-local mask without mutating the source", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const effect = layer.effects[0];
    const masked = applyOperations(source, [
      {
        type: "setEffectMask",
        layerId: layer.id,
        effectId: effect.id,
        mask: {
          shape: "ellipse",
          center: [50, 50],
          size: [60, 40],
          feather: 24,
          opacity: 85,
          invert: false,
        },
      },
    ]);

    expect(activeComposition(masked).layers[0].effects[0].mask?.size).toEqual([60, 40]);
    expect(effect.mask).toBeUndefined();
    const unmasked = applyOperations(masked, [
      { type: "setEffectMask", layerId: layer.id, effectId: effect.id, mask: undefined },
    ]);
    expect(activeComposition(unmasked).layers[0].effects[0].mask).toBeUndefined();
  });

  it("retimes, eases, and removes keyframes through operations", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const opacity = layer.transform.opacity;
    expect(opacity.mode).toBe("animated");
    if (opacity.mode !== "animated") return;
    const keyframe = opacity.keyframes[0];
    const moved = applyOperations(source, [
      {
        type: "moveKeyframe",
        layerId: layer.id,
        path: "opacity",
        keyframeId: keyframe.id,
        time: 0.25,
      },
      { type: "easeLayer", layerId: layer.id },
    ]);
    const movedOpacity = activeComposition(moved).layers[0].transform.opacity;
    expect(movedOpacity.mode).toBe("animated");
    if (movedOpacity.mode !== "animated") return;
    expect(movedOpacity.keyframes.find((entry) => entry.id === keyframe.id)?.time).toBe(0.25);
    expect(movedOpacity.keyframes.every((entry) => entry.interpolation === "bezier")).toBe(true);

    const removed = applyOperations(moved, [
      { type: "removeKeyframe", layerId: layer.id, path: "opacity", keyframeId: keyframe.id },
    ]);
    const removedOpacity = activeComposition(removed).layers[0].transform.opacity;
    expect(removedOpacity.mode === "animated" && removedOpacity.keyframes).toHaveLength(3);
  });

  it("updates keyframe value, temporal easing, and spatial handles atomically", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers.find((entry) => entry.name === "ASTER");
    if (!layer) throw new Error("Expected ASTER layer");
    const position = layer.transform.position[1];
    if (position.mode !== "animated") throw new Error("Expected animated Y position");
    const keyframe = position.keyframes[1];
    const next = applyOperations(source, [
      {
        type: "updateKeyframe",
        layerId: layer.id,
        path: "position.1",
        keyframeId: keyframe.id,
        time: 1.5,
        value: 840,
        interpolation: "bezier",
        easing: [0.2, 0.1, 0.8, 0.9],
        spatialIn: -120,
        spatialOut: 80,
      },
    ]);
    const updated = activeComposition(next).layers.find((entry) => entry.id === layer.id);
    const updatedPosition = updated?.transform.position[1];
    expect(updatedPosition?.mode).toBe("animated");
    if (updatedPosition?.mode !== "animated") throw new Error("Expected animated Y position");
    expect(updatedPosition.keyframes.find((entry) => entry.id === keyframe.id)).toMatchObject({
      time: 1.5,
      value: 840,
      easing: [0.2, 0.1, 0.8, 0.9],
      spatialIn: -120,
      spatialOut: 80,
    });
  });

  it("validates parenting cycles", () => {
    const source = createDemoProject();
    const [first, second] = activeComposition(source).layers;
    const parented = applyOperations(source, [
      { type: "setParent", layerId: second.id, parentId: first.id },
    ]);
    expect(activeComposition(parented).layers[1].parentId).toBe(first.id);
    expect(() =>
      applyOperations(parented, [{ type: "setParent", layerId: first.id, parentId: second.id }]),
    ).toThrow("cycle");
  });

  it("attaches LUT resources through an undoable typed operation", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const effect = layer.effects.find((entry) => entry.type === "lut") ?? {
      id: crypto.randomUUID(),
      type: "lut",
      name: "3D LUT",
      enabled: true,
      parameters: { intensity: 100, interpolation: 0 },
    };
    if (!layer.effects.includes(effect)) layer.effects.push(effect);
    const resource: Lut3dResource = {
      kind: "lut3d",
      name: "identity.cube",
      size: 2,
      data: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      checksum: "deadbeef",
    };

    const next = applyOperations(source, [
      { type: "setEffectLut", layerId: layer.id, effectId: effect.id, resource },
    ]);

    expect(
      activeComposition(next).layers[0].effects.find((entry) => entry.id === effect.id)?.resource,
    ).toEqual(resource);
    expect(effect.resource).toBeUndefined();
  });

  it("upserts and removes effect parameter keyframes without mutating the source", () => {
    const source = createDemoProject();
    const layer = activeComposition(source).layers[0];
    const effect = layer.effects[0];
    const keyed = applyOperations(source, [
      {
        type: "addEffectParameterKeyframe",
        layerId: layer.id,
        effectId: effect.id,
        parameter: "exposure",
        keyframe: { id: "first", time: 1, value: 2, interpolation: "linear" },
      },
      {
        type: "setEffectParameterAtTime",
        layerId: layer.id,
        effectId: effect.id,
        parameter: "exposure",
        time: 1,
        value: 3,
        keyframeId: "updated",
      },
    ]);
    const keyedEffect = activeComposition(keyed).layers[0].effects[0];
    expect(keyedEffect.parameterKeyframes?.exposure).toEqual([
      expect.objectContaining({ id: "updated", time: 1, value: 3 }),
    ]);
    expect(effect.parameterKeyframes).toBeUndefined();

    const moved = applyOperations(keyed, [
      {
        type: "moveEffectParameterKeyframe",
        layerId: layer.id,
        effectId: effect.id,
        parameter: "exposure",
        keyframeId: "updated",
        time: 2,
      },
    ]);
    expect(activeComposition(moved).layers[0].effects[0].parameterKeyframes?.exposure[0].time).toBe(
      2,
    );

    const removed = applyOperations(moved, [
      {
        type: "removeEffectParameterKeyframe",
        layerId: layer.id,
        effectId: effect.id,
        parameter: "exposure",
        keyframeId: "updated",
      },
    ]);
    const removedEffect = activeComposition(removed).layers[0].effects[0];
    expect(removedEffect.parameterKeyframes?.exposure).toBeUndefined();
    expect(removedEffect.parameters.exposure).toBe(3);
  });
});
