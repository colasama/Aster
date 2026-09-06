import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "./layer-factory";
import { createDefaultParticleSettings } from "./particle-settings";
import { createBlankProject } from "./project";
import { CURRENT_PROJECT_SCHEMA_VERSION, cloneCurrentProjectDocument } from "./project-schema";

describe("project schema migration gate", () => {
  it("clones the current schema without sharing mutable state", () => {
    const project = createBlankProject();
    const clone = cloneCurrentProjectDocument(project);
    expect(clone).toEqual(project);
    expect(clone).not.toBe(project);
    expect(clone.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
  });

  it("rejects a historical schema without a registered migration", () => {
    expect(() => cloneCurrentProjectDocument({ schemaVersion: 0 })).toThrow(
      "migration is registered from v0 to v1",
    );
  });

  it("migrates v1 documents to the current schema", () => {
    const legacy = createBlankProject() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    const layer = (legacy.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.kind = "particle";
    layer.particle = createDefaultParticleSettings();
    const migrated = cloneCurrentProjectDocument(legacy) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.compositions[0].layers[0]).toMatchObject({
      kind: "generator",
      generator: { pluginId: "org.aster.builtin.particles", nodeType: "particle_system" },
    });
    expect(migrated.compositions[0].layers[0].particle).toBeUndefined();
  });

  it("validates the legacy particle contract before wrapping it as a plugin instance", () => {
    const legacy = createBlankProject() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    const layer = (legacy.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.kind = "particle";
    layer.particle = { ...createDefaultParticleSettings(), count: 1_000_001 };
    expect(() => cloneCurrentProjectDocument(legacy)).toThrow(
      "legacy particle settings.count must be between 1 and 1000000",
    );
  });

  it("migrates v2 documents through v10 without rewriting source-free layers", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 2;
    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<Record<string, unknown>>;
    };
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.compositions[0]).toMatchObject({
      motionBlur: {
        enabled: false,
        shutterAngle: 180,
        shutterPhase: -90,
        samplesPerFrame: 8,
        adaptiveSampleLimit: 32,
      },
    });
  });

  it("deduplicates repeated v3 nested assets by exact content identity", () => {
    const previous = createBlankProject();
    const composition = previous.compositions[0];
    const first = createLayerForComposition("image", composition);
    const second = createLayerForComposition("image", composition);
    const asset = {
      name: "plate.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,QUJD",
      width: 640,
      height: 360,
    };
    const raw = structuredClone(previous) as unknown as Record<string, unknown>;
    raw.schemaVersion = 3;
    delete raw.sources;
    const rawLayers = (raw.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers;
    rawLayers.push(
      { ...(first as unknown as Record<string, unknown>), asset: { ...asset } },
      { ...(second as unknown as Record<string, unknown>), asset: { ...asset } },
    );

    const migrated = cloneCurrentProjectDocument(raw) as {
      schemaVersion: number;
      sources: Array<Record<string, unknown>>;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.sources).toHaveLength(1);
    expect(migrated.compositions[0].layers.slice(-2).map((layer) => layer.sourceId)).toEqual([
      migrated.sources[0].id,
      migrated.sources[0].id,
    ]);
    expect(migrated.compositions[0].layers.slice(-2).every((layer) => !layer.asset)).toBe(true);
  });

  it("migrates normalized video gain into stereo dB audio settings", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 4;
    const layer = (previous.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.kind = "video";
    layer.audioEnabled = false;
    layer.audioGain = 0.5;
    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    const audio = migrated.compositions[0].layers[0].audio as {
      levelsDb: [number, number];
      pan: number;
      muted: boolean;
      reversed: boolean;
    };
    expect(audio.levelsDb[0]).toBeCloseTo(-6.0206, 4);
    expect(audio.levelsDb[1]).toBeCloseTo(-6.0206, 4);
    expect(audio).toMatchObject({ pan: 0, muted: true, reversed: false });
    expect(migrated.compositions[0].layers[0].audioGain).toBeUndefined();
  });

  it("migrates legacy FOV cameras into a physical Zoom lens without hiding the comp plane", () => {
    const previous = createBlankProject();
    const composition = previous.compositions[0];
    const camera = createLayerForComposition("camera", composition) as unknown as Record<
      string,
      unknown
    >;
    camera.camera = { projection: "perspective", fieldOfView: 60, orthographicSize: 1080 };
    camera.transform = {
      ...(camera.transform as Record<string, unknown>),
      position: [
        { mode: "static", value: 960 },
        { mode: "static", value: 540 },
        { mode: "static", value: 0 },
      ],
    };
    const raw = structuredClone(previous) as unknown as Record<string, unknown>;
    raw.schemaVersion = 5;
    (raw.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0].layers = [camera];

    const migrated = cloneCurrentProjectDocument(raw) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    const migratedCamera = migrated.compositions[0].layers[0].camera as Record<string, unknown>;
    const zoom = 1080 / (2 * Math.tan(Math.PI / 6));
    const position = (
      migrated.compositions[0].layers[0].transform as {
        position: Array<{ value: number }>;
      }
    ).position;

    expect(migrated.schemaVersion).toBe(10);
    expect(migratedCamera).toMatchObject({
      mode: "oneNode",
      zoom: { mode: "static", value: zoom },
      filmSize: { mode: "static", value: 36 },
      focusDistance: { mode: "static", value: zoom },
      lockFocusToZoom: true,
    });
    expect(position[2].value).toBeCloseTo(-zoom);
    expect(migratedCamera.fieldOfView).toBeUndefined();
  });

  it("migrates v6 camera documents to the two-switch motion-blur model", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 6;
    const composition = (previous.compositions as Array<Record<string, unknown>>)[0];
    delete composition.motionBlur;
    const layers = composition.layers as Array<Record<string, unknown>>;
    for (const layer of layers) delete layer.motionBlur;

    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<{
        motionBlur: Record<string, unknown>;
        layers: Array<Record<string, unknown>>;
      }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.compositions[0].motionBlur).toEqual({
      enabled: false,
      shutterAngle: 180,
      shutterPhase: -90,
      samplesPerFrame: 8,
      adaptiveSampleLimit: 32,
    });
    expect(migrated.compositions[0].layers.every((layer) => layer.motionBlur === false)).toBe(true);
  });

  it("migrates v7 staggered text reveals into deterministic animator groups", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 7;
    const composition = (
      previous.compositions as Array<{ layers: Array<Record<string, unknown>> }>
    )[0];
    const text = createLayerForComposition("text", composition as never) as unknown as Record<
      string,
      unknown
    >;
    text.id = "legacy-title";
    text.textAnimator = {
      enabled: true,
      delay: 0.25,
      stagger: 0.1,
      duration: 0.5,
      position: [20, 80],
      scale: 75,
      opacity: 0,
    };
    composition.layers.push(text);

    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    const layers = migrated.compositions[0].layers;
    expect(layers[layers.length - 1]?.textAnimator).toMatchObject({
      enabled: true,
      groups: [
        {
          id: "legacy-title:animator:1",
          selectors: [
            {
              id: "legacy-title:selector:1",
              kind: "expression",
              expression:
                "100 * pow(1 - clamp((time - 0.25 - (textIndex - 1) * 0.1) / 0.5, 0, 1), 3)",
            },
          ],
        },
      ],
    });
  });

  it("migrates v8 camera scalars to authoritative animated tracks without redundant optics", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 8;
    const composition = (
      previous.compositions as Array<{ layers: Array<Record<string, unknown>> }>
    )[0];
    const camera = createLayerForComposition("camera", composition as never) as unknown as Record<
      string,
      unknown
    >;
    camera.visible = false;
    camera.camera = {
      mode: "twoNode",
      projection: "perspective",
      zoom: 2400,
      filmSize: 48,
      focalLength: 60,
      orthographicSize: 1080,
      pointOfInterest: [
        { mode: "static", value: 960 },
        { mode: "static", value: 540 },
        { mode: "static", value: 0 },
      ],
      orientation: [
        { mode: "static", value: 0 },
        { mode: "static", value: 0 },
        { mode: "static", value: 0 },
      ],
      depthOfField: true,
      focusDistance: 2200,
      lockFocusToZoom: false,
      aperture: 30,
      fStop: 2,
      blurLevel: 75,
      focusAreaWidth: 120,
      nearBlurLevel: 20,
      farBlurLevel: 90,
      renderQuality: 80,
    };
    composition.layers.push(camera);

    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<{ layers: Array<Record<string, unknown>> }>;
    };
    const migratedLayers = migrated.compositions[0].layers;
    const migratedCamera = migratedLayers[migratedLayers.length - 1]?.camera as Record<
      string,
      unknown
    >;
    expect(migrated.schemaVersion).toBe(10);
    expect(migratedCamera).toMatchObject({
      zoom: { mode: "static", value: 2400 },
      filmSize: { mode: "static", value: 48 },
      aperture: { mode: "static", value: (60 / 2) * (72 / 25.4) },
      focusDistance: { mode: "static", value: 2200 },
      irisShape: "fastRectangle",
      irisRoundness: { mode: "static", value: 0 },
      irisAspectRatio: { mode: "static", value: 1 },
    });
    expect(migratedLayers[migratedLayers.length - 1]?.visible).toBe(false);
    expect(migratedCamera.focalLength).toBeUndefined();
    expect(migratedCamera.fStop).toBeUndefined();
  });

  it("centers v9 anchors so enabling anchor-aware rendering preserves existing pixels", () => {
    const previous = createBlankProject() as unknown as Record<string, unknown>;
    previous.schemaVersion = 9;
    const layer = (previous.compositions as Array<{ layers: Array<Record<string, unknown>> }>)[0]
      .layers[0];
    layer.size = [640, 360];
    const transform = layer.transform as Record<string, unknown>;
    transform.anchor = [
      { mode: "static", value: 0 },
      { mode: "static", value: 0 },
      { mode: "static", value: 0 },
    ];

    const migrated = cloneCurrentProjectDocument(previous) as {
      schemaVersion: number;
      compositions: Array<{
        layers: Array<{ transform: { anchor: Array<{ value: number }> } }>;
      }>;
    };
    expect(migrated.schemaVersion).toBe(10);
    expect(migrated.compositions[0].layers[0].transform.anchor).toEqual([
      { mode: "static", value: 320 },
      { mode: "static", value: 180 },
      { mode: "static", value: 0 },
    ]);
  });

  it.each([11, undefined, 1.5])("rejects unsupported schema %s", (schemaVersion) => {
    expect(() => cloneCurrentProjectDocument({ schemaVersion })).toThrow("Aster project schema");
  });
});
