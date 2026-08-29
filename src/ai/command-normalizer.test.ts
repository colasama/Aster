import { describe, expect, it } from "vitest";
import {
  createParticleLayerForComposition,
  createParticleSceneGenerator,
  particleSettingsFromGenerator,
} from "../core/bundled-particle";
import { createLayerForComposition } from "../core/layer-factory";
import { createDefaultParticleSettings } from "../core/particle-settings";
import { createBlankComposition, createBlankProject } from "../core/project";
import { normalizeAiCommands } from "./command-normalizer";

describe("AI command normalization", () => {
  it("adds, assigns, and interprets a versioned footage source", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const image = createLayerForComposition("image", composition);
    composition.layers.push(image);
    const source = {
      id: crypto.randomUUID(),
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: "test:ai-plate",
      dataUrl: "data:image/png;base64,AA==",
      width: 1920,
      height: 1080,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    const result = normalizeAiCommands(
      [
        { type: "addSource", source },
        { type: "setLayerSource", layerId: image.id, sourceId: source.id },
        {
          type: "interpretSource",
          sourceId: source.id,
          interpretation: { alpha: "premultiplied", colorSpace: "linear" },
        },
      ],
      project,
      0,
    );
    expect(result.project.sources[0].interpretation).toEqual({
      alpha: "premultiplied",
      colorSpace: "linear",
    });
    expect(
      result.project.compositions[0].layers.find((layer) => layer.id === image.id)?.sourceId,
    ).toBe(source.id);
  });

  it("creates and updates bounded solid sources while keeping nulls source-free", () => {
    const project = createBlankProject();
    const added = normalizeAiCommands(
      [
        {
          type: "addLayer",
          kind: "solid",
          solid: { width: 1920, height: 1080, color: [0.1, 0.2, 0.3, 1] },
        },
        { type: "addLayer", kind: "null" },
      ],
      project,
      0,
    );
    const solid = added.project.compositions[0].layers.find((layer) => layer.kind === "solid");
    const nullLayer = added.project.compositions[0].layers.find((layer) => layer.kind === "null");
    expect(solid?.solid).toEqual({ width: 1920, height: 1080, color: [0.1, 0.2, 0.3, 1] });
    expect(nullLayer?.solid).toBeUndefined();
    if (!solid) throw new Error("Expected solid layer");
    const updated = normalizeAiCommands(
      [
        {
          type: "setSolidSettings",
          layerId: solid.id,
          solid: { width: 800, height: 600, color: [0.8, 0.7, 0.6, 0.5] },
        },
      ],
      added.project,
      0,
    );
    expect(
      updated.project.compositions[0].layers.find((layer) => layer.id === solid.id),
    ).toMatchObject({
      solid: { width: 800, height: 600, color: [0.8, 0.7, 0.6, 0.5] },
      size: [800, 600],
    });
  });

  it("normalizes first-class audio controls and rejects visual layers", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const audio = createLayerForComposition("audio", composition);
    composition.layers.unshift(audio);
    const result = normalizeAiCommands(
      [
        {
          type: "setLayerAudioSettings",
          layerId: audio.id,
          audio: { levelsDb: [-12, -9], pan: -0.4, muted: false, reversed: true },
        },
      ],
      project,
      0,
    );
    expect(result.project.compositions[0].layers[0].audio).toEqual({
      levelsDb: [-12, -9],
      pan: -0.4,
      muted: false,
      reversed: true,
    });
    expect(() =>
      normalizeAiCommands(
        [
          {
            type: "setLayerAudioSettings",
            layerId: composition.layers[1].id,
            audio: { levelsDb: [0, 0], pan: 0, muted: false, reversed: false },
          },
        ],
        project,
        0,
      ),
    ).toThrow("audio-capable layer");
  });

  it("validates and atomically applies a typed command batch", () => {
    const project = createBlankProject();
    const layer = project.compositions[0].layers[0];
    const result = normalizeAiCommands(
      [
        { type: "renameLayer", layerId: layer.id, name: "Agent title" },
        { type: "setProperty", layerId: layer.id, path: "opacity", value: 0.5 },
      ],
      project,
      0,
    );
    expect(result.project.compositions[0].layers[0].name).toBe("Agent title");
    expect(project.compositions[0].layers[0].name).not.toBe("Agent title");
    expect(result.changedObjectIds).toEqual([layer.id]);
  });

  it("rejects unknown, non-finite, and semantically invalid commands", () => {
    const project = createBlankProject();
    const layer = project.compositions[0].layers[0];
    expect(() => normalizeAiCommands([{ type: "runShell" }], project, 0)).toThrow(
      "Unknown Aster command",
    );
    expect(() =>
      normalizeAiCommands(
        [{ type: "setProperty", layerId: layer.id, path: "opacity", value: Number.NaN }],
        project,
        0,
      ),
    ).toThrow("must be finite");
    expect(() =>
      normalizeAiCommands([{ type: "renameLayer", layerId: "missing", name: "Nope" }], project, 0),
    ).toThrow("Layer does not exist");
  });

  it("rejects an entire batch before returning a partially changed project", () => {
    const project = createBlankProject();
    const originalName = project.compositions[0].layers[0].name;
    expect(() =>
      normalizeAiCommands(
        [
          {
            type: "renameLayer",
            layerId: project.compositions[0].layers[0].id,
            name: "Would change",
          },
          { type: "removeEffect", layerId: project.compositions[0].layers[0].id, effectId: "none" },
        ],
        project,
        0,
      ),
    ).toThrow("Effect does not exist");
    expect(project.compositions[0].layers[0].name).toBe(originalName);
  });

  it("normalizes project, composition, and precomposition commands", () => {
    const project = createBlankProject();
    const added = normalizeAiCommands(
      [
        {
          type: "addComposition",
          name: "Agent Comp",
          width: 1280,
          height: 720,
          frameRateNumerator: 60,
          frameRateDenominator: 1,
          duration: 5,
          activate: false,
        },
        { type: "addProjectFolder", name: "Generated" },
      ],
      project,
      0,
    );
    expect(added.project.compositions).toHaveLength(2);
    expect(added.project.folders).toHaveLength(1);
    const layerId = added.project.compositions[0].layers[0].id;
    const precomposed = normalizeAiCommands(
      [{ type: "precomposeLayers", layerIds: [layerId], name: "Nested" }],
      added.project,
      0,
    );
    expect(precomposed.project.compositions).toHaveLength(3);
    expect(precomposed.project.compositions[0].layers[0]).toMatchObject({
      kind: "precomposition",
      name: "Nested",
    });
  });

  it("creates adjustment and referenced precomposition layers through the same typed command", () => {
    const project = createBlankProject();
    const source = createBlankComposition("Source");
    project.compositions.push(source);
    const result = normalizeAiCommands(
      [
        { type: "addLayer", kind: "adjustment", name: "Grade" },
        {
          type: "addLayer",
          kind: "precomposition",
          name: "Source Instance",
          sourceCompositionId: source.id,
        },
      ],
      project,
      0,
    );
    expect(result.project.compositions[0].layers.slice(0, 2).map((layer) => layer.kind)).toEqual([
      "precomposition",
      "adjustment",
    ]);
  });

  it("normalizes specialized layer domains through full project validation", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    const particle = createParticleLayerForComposition(composition);
    const camera = createLayerForComposition("camera", composition);
    const light = createLayerForComposition("light", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    composition.layers.push(text, particle, camera, light);
    const particleSettings = { ...createDefaultParticleSettings(), count: 2048 };
    const result = normalizeAiCommands(
      [
        { type: "setTextContent", layerId: text.id, text: "Agent typography" },
        {
          type: "setTextStyle",
          layerId: text.id,
          textStyle: { ...text.textStyle, fontSize: 96 },
        },
        {
          type: "setSceneGenerator",
          layerId: particle.id,
          generator: createParticleSceneGenerator(particleSettings),
        },
        {
          type: "setCameraSettings",
          layerId: camera.id,
          camera: { ...camera.camera, projection: "orthographic", orthographicSize: 720 },
        },
        {
          type: "setLightSettings",
          layerId: light.id,
          light: {
            kind: "point",
            intensity: 3,
            range: 3000,
            coneAngle: 45,
            shadowQuality: "high",
          },
        },
        {
          type: "setShapeSettings",
          layerId: composition.layers[0].id,
          shape: {
            ...composition.layers[0].shape,
            trim: { start: 10, end: 90, offset: 5 },
          },
        },
      ],
      project,
      0,
    );
    const layers = result.project.compositions[0].layers;
    expect(layers.find((layer) => layer.id === text.id)?.text).toBe("Agent typography");
    expect(
      particleSettingsFromGenerator(layers.find((layer) => layer.id === particle.id)?.generator)
        ?.count,
    ).toBe(2048);
    expect(layers[0].shape?.trim).toEqual({ start: 10, end: 90, offset: 5 });
  });

  it("toggles an existing text animator without replacing its ordered stack", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    const group = text.textAnimator?.groups[0];
    if (!group) throw new Error("Expected the default text animator group");
    group.name = "Custom reveal";
    composition.layers.push(text);

    const result = normalizeAiCommands(
      [{ type: "setTextAnimator", layerId: text.id, enabled: false }],
      project,
      0,
    );

    const updated = result.project.compositions[0].layers.find((layer) => layer.id === text.id);
    expect(updated?.textAnimator?.enabled).toBe(false);
    expect(updated?.textAnimator?.groups[0]?.name).toBe("Custom reveal");
  });

  it("validates ownership for transform and effect keyframe commands", () => {
    const project = createBlankProject();
    const layerId = project.compositions[0].layers[0].id;
    const withTracks = normalizeAiCommands(
      [
        { type: "addKeyframe", layerId, path: "opacity", time: 1, value: 0.5 },
        {
          type: "addEffect",
          layerId,
          effectType: "glow",
          parameters: { radius: 24, intensity: 1.5 },
        },
      ],
      project,
      0,
    );
    const keyframeOperation = withTracks.operations[0];
    const effectOperation = withTracks.operations[1];
    if (keyframeOperation.type !== "addKeyframe" || effectOperation.type !== "addEffect")
      throw new Error("Unexpected normalized operations");
    const edited = normalizeAiCommands(
      [
        {
          type: "updateKeyframe",
          layerId,
          path: "opacity",
          keyframeId: keyframeOperation.keyframe.id,
          time: 1.25,
          value: 0.75,
          interpolation: "linear",
        },
        {
          type: "setEffectMask",
          layerId,
          effectId: effectOperation.effect.id,
          mask: {
            shape: "ellipse",
            center: [0.5, 0.5],
            size: [0.4, 0.4],
            feather: 12,
            opacity: 1,
            invert: false,
          },
        },
        {
          type: "addEffectParameterKeyframe",
          layerId,
          effectId: effectOperation.effect.id,
          parameter: "radius",
          time: 1,
          value: 48,
        },
      ],
      withTracks.project,
      0,
    );
    expect(edited.project.compositions[0].layers[0].effects[0].mask?.shape).toBe("ellipse");
    expect(
      edited.project.compositions[0].layers[0].effects[0].parameterKeyframes?.radius,
    ).toHaveLength(1);
    expect(() =>
      normalizeAiCommands(
        [
          {
            type: "moveEffectParameterKeyframe",
            layerId,
            effectId: effectOperation.effect.id,
            parameter: "radius",
            keyframeId: "missing",
            time: 2,
          },
        ],
        edited.project,
        0,
      ),
    ).toThrow("Effect keyframe does not exist");
  });
});
