import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../layers/layer-factory";
import { activeComposition, createBlankProject, createDemoProject } from "../project/project";
import type { Lut3dResource } from "../types";
import { applyOperations, type Operation } from "./operations";

describe("operations", () => {
  it("rejects locked-layer writes while preserving monitor switches and unlock", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const audio = createLayerForComposition("audio", composition);
    const camera = createLayerForComposition("camera", composition);
    const solid = createLayerForComposition("solid", composition);
    const text = createLayerForComposition("text", composition);
    for (const layer of [audio, camera, solid, text]) layer.locked = true;
    composition.layers = [audio, camera, solid, text];
    if (!audio.audio || !camera.camera || !solid.solid || !text.textStyle)
      throw new Error("Expected specialized layer settings");

    const writes: Operation[] = [
      {
        type: "setLayerAudioSettings",
        layerId: audio.id,
        audio: { ...audio.audio, muted: true },
      },
      {
        type: "setCameraSettings",
        layerId: camera.id,
        camera: { ...camera.camera, zoom: { mode: "static", value: 4200 } },
      },
      {
        type: "setSolidSettings",
        layerId: solid.id,
        solid: { ...solid.solid, width: 640 },
      },
      { type: "setTextContent", layerId: text.id, text: "LOCK BYPASS" },
      { type: "toggleLayer", layerId: text.id, field: "motionBlur" },
    ];
    for (const operation of writes)
      expect(() => applyOperations(project, [operation])).toThrow("Layer is locked");

    const monitored = applyOperations(project, [
      { type: "toggleLayer", layerId: text.id, field: "visible" },
      { type: "toggleLayer", layerId: text.id, field: "solo" },
    ]);
    const monitoredText = activeComposition(monitored).layers.find((layer) => layer.id === text.id);
    expect(monitoredText).toMatchObject({ locked: true, visible: false, solo: true });

    const unlocked = applyOperations(project, [
      { type: "toggleLayer", layerId: text.id, field: "locked" },
      { type: "setTextContent", layerId: text.id, text: "EDITABLE" },
    ]);
    expect(activeComposition(unlocked).layers.find((layer) => layer.id === text.id)).toMatchObject({
      locked: false,
      text: "EDITABLE",
    });
    expect(text).toMatchObject({ locked: true, text: "NEW TEXT" });
  });

  it("updates dedicated solid settings atomically and preserves them through copy-safe snapshots", () => {
    const project = createBlankProject();
    const composition = activeComposition(project);
    const solid = createLayerForComposition("solid", composition);
    solid.transform.anchor[0] = {
      mode: "animated",
      keyframes: [{ id: "custom-anchor", time: 0, value: 123, interpolation: "linear" }],
    };
    const customAnchor = structuredClone(solid.transform.anchor);
    composition.layers = [solid];
    const updated = applyOperations(project, [
      {
        type: "setSolidSettings",
        layerId: solid.id,
        solid: { width: 40_000, height: 0, color: [-1, 0.25, 2, 0.5] },
      },
    ]);
    expect(activeComposition(updated).layers[0]).toMatchObject({
      solid: { width: 30_000, height: 1, color: [0, 0.25, 1, 0.5] },
      size: [30_000, 1],
      color: [0, 0.25, 1, 0.5],
    });
    expect(activeComposition(updated).layers[0].transform.anchor).toEqual(customAnchor);
    const recolored = applyOperations(updated, [
      { type: "setLayerColor", layerId: solid.id, color: [0.1, 0.2, 0.3, 0.4] },
    ]);
    expect(activeComposition(recolored).layers[0].solid?.color).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(activeComposition(recolored).layers[0].transform.anchor).toEqual(customAnchor);
  });

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

  it("normalizes the composition shutter and toggles supported layer motion blur", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const layer = composition.layers[0];
    const edited = applyOperations(source, [
      {
        type: "setCompositionMotionBlur",
        compositionId: composition.id,
        motionBlur: {
          enabled: true,
          shutterAngle: 999,
          shutterPhase: -999,
          samplesPerFrame: 12,
          adaptiveSampleLimit: 4,
        },
      },
      { type: "toggleLayer", layerId: layer.id, field: "motionBlur" },
    ]);
    expect(activeComposition(edited).motionBlur).toEqual({
      enabled: true,
      shutterAngle: 720,
      shutterPhase: -720,
      samplesPerFrame: 12,
      adaptiveSampleLimit: 12,
    });
    expect(activeComposition(edited).layers[0].motionBlur).toBe(true);
    expect(layer.motionBlur).toBe(false);

    const audio = createLayerForComposition("audio", composition);
    composition.layers.push(audio);
    expect(() =>
      applyOperations(source, [{ type: "toggleLayer", layerId: audio.id, field: "motionBlur" }]),
    ).toThrow("do not support motion blur");
  });

  it("rejects operations that target a missing layer", () => {
    const source = createDemoProject();
    expect(() =>
      applyOperations(source, [{ type: "renameLayer", layerId: "missing", name: "Nope" }]),
    ).toThrow("Layer does not exist");
  });

  it("unlocks focus when timeline operations edit Zoom or Focus Distance", () => {
    const source = createDemoProject();
    const camera = activeComposition(source).layers.find((layer) => layer.kind === "camera");
    if (!camera?.camera) throw new Error("Expected demo camera");
    expect(camera.camera.lockFocusToZoom).toBe(true);
    const zoomEdited = applyOperations(source, [
      { type: "setProperty", layerId: camera.id, path: "camera.zoom", value: 2000 },
    ]);
    expect(
      activeComposition(zoomEdited).layers.find((layer) => layer.id === camera.id)?.camera
        ?.lockFocusToZoom,
    ).toBe(false);
    const focusEdited = applyOperations(source, [
      { type: "setProperty", layerId: camera.id, path: "camera.focusDistance", value: 1800 },
    ]);
    expect(
      activeComposition(focusEdited).layers.find((layer) => layer.id === camera.id)?.camera
        ?.lockFocusToZoom,
    ).toBe(false);
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
    const composition = activeComposition(source);
    const layer = createLayerForComposition("video", composition);
    composition.layers.unshift(layer);
    const louder = applyOperations(source, [
      { type: "setLayerAudioGain", layerId: layer.id, gain: 8 },
    ]);
    const silent = applyOperations(source, [
      { type: "setLayerAudioGain", layerId: layer.id, gain: -1 },
    ]);
    expect(activeComposition(louder).layers[0].audio?.levelsDb).toEqual([0, 0]);
    expect(activeComposition(silent).layers[0].audio?.levelsDb).toEqual([-192, -192]);
    expect(layer.audio?.levelsDb).toEqual([0, 0]);
  });

  it("sets bounded stereo audio controls only on audio-capable layers", () => {
    const source = createDemoProject();
    const composition = activeComposition(source);
    const audio = createLayerForComposition("audio", composition);
    composition.layers.unshift(audio);
    const next = applyOperations(source, [
      {
        type: "setLayerAudioSettings",
        layerId: audio.id,
        audio: { levelsDb: [-300, 40], pan: 2, muted: true, reversed: true },
      },
    ]);
    expect(activeComposition(next).layers[0].audio).toEqual({
      levelsDb: [-192, 24],
      pan: 1,
      muted: true,
      reversed: true,
    });
    expect(audio.audio).toEqual({ levelsDb: [0, 0], pan: 0, muted: false, reversed: false });
    expect(() =>
      applyOperations(source, [
        {
          type: "setLayerAudioSettings",
          layerId: composition.layers[1].id,
          audio: { levelsDb: [0, 0], pan: 0, muted: false, reversed: false },
        },
      ]),
    ).toThrow("does not contain audio");
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
    expect(movedOpacity.keyframes.every((entry) => entry.easing?.[0] === 1 / 3)).toBe(true);
    expect(movedOpacity.keyframes.every((entry) => entry.easing?.[2] === 2 / 3)).toBe(true);

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
