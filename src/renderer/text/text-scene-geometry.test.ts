import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { type FlattenedSceneLayer, flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { staticValue } from "../../core/types";
import { buildSceneGeometry, FLOATS_PER_VERTEX } from "../geometry/geometry";
import type { MediaTextureCache } from "../media/media-texture-cache";
import { evaluateSceneCamera } from "../scene/scene-camera";
import type { TextRasterBounds } from "./text-raster-bounds";
import { expandTextSceneGeometry } from "./text-scene-geometry";
import { prepareTextSceneRasters } from "./text-scene-preparation";

function fixture() {
  const project = createBlankProject();
  const composition = project.compositions[0];
  const first = createLayerForComposition("text", composition);
  const mesh = createLayerForComposition("mesh", composition);
  const last = createLayerForComposition("text", composition);
  first.size = [140, 70];
  last.size = [210, 100];
  first.transform.scale = [staticValue(-130), staticValue(170), staticValue(100)];
  first.transform.rotation[2] = staticValue(23);
  last.transform.position[0] = staticValue(400);
  composition.layers = [first, mesh, last];
  return { project, composition, first, last };
}

function bytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function boundsFor(scenes: FlattenedSceneLayer[]) {
  const bounds = new Map<string, TextRasterBounds>();
  for (const [index, scene] of scenes.entries()) {
    if (scene.layer.kind !== "text") continue;
    bounds.set(scene.resourceInstanceId, {
      x: -40 - index,
      y: -17 + index,
      width: 190 + index * 13,
      height: 95 + index * 7,
    });
  }
  return (id: string) => bounds.get(id);
}

describe("text geometry expansion", () => {
  it("matches direct geometry bytes for interleaved text and mesh without mutating the cache", () => {
    const { project, composition } = fixture();
    const scenes = flattenSceneLayers(composition, project, 0);
    const readBounds = boundsFor(scenes);
    const cached = buildSceneGeometry(composition, scenes);
    const before = bytes(cached.data).slice();
    const actual = expandTextSceneGeometry(composition, scenes, cached, undefined, readBounds);
    const expected = buildSceneGeometry(composition, scenes, undefined, readBounds);
    expect(bytes(actual.data)).toEqual(bytes(expected.data));
    expect(bytes(cached.data)).toEqual(before);
    expect(actual.batches).toBe(cached.batches);
  });

  it("writes only the first matching batch and lets the last duplicate scene win", () => {
    const { project, composition, first, last } = fixture();
    composition.layers = [first, last];
    const scenes = flattenSceneLayers(composition, project, 0);
    scenes[1].instanceId = scenes[0].instanceId;
    const cached = buildSceneGeometry(composition, scenes);
    const readBounds = boundsFor(scenes);
    const expected = cached.data.slice();
    const lastWriter = buildSceneGeometry(composition, [scenes[1]], undefined, readBounds);
    expected.set(lastWriter.data, cached.batches[0].firstVertex * FLOATS_PER_VERTEX);
    const firstWriter = buildSceneGeometry(composition, [scenes[0]], undefined, readBounds);
    expect(bytes(lastWriter.data)).not.toEqual(bytes(firstWriter.data));
    const actual = expandTextSceneGeometry(composition, scenes, cached, undefined, readBounds);
    expect(bytes(actual.data)).toEqual(bytes(expected));
    const untouchedStart = cached.batches[1].firstVertex * FLOATS_PER_VERTEX;
    expect(bytes(actual.data.subarray(untouchedStart))).toEqual(
      bytes(cached.data.subarray(untouchedStart)),
    );
  });

  it("prepares every shared resource instance before using its final bounds", () => {
    const { project, composition, first } = fixture();
    composition.layers = [first];
    const original = flattenSceneLayers(composition, project, 0)[0];
    const clone = structuredClone(original);
    clone.instanceId = `${original.instanceId}:clone`;
    clone.transform.scale = [250, 200, 100];
    clone.transform.position[0] += 300;
    const scenes = [original, clone];
    const cached = buildSceneGeometry(composition, scenes);
    const prepared: number[] = [];
    let finalBounds: TextRasterBounds | undefined;
    const media = {
      prepareText(_layer: unknown, id: string, _time: number, _rate: number, scale: number) {
        expect(id).toBe(original.resourceInstanceId);
        prepared.push(scale);
        finalBounds = { x: -20, y: -10, width: 120 * scale, height: 60 * scale };
      },
      textBounds(id: string) {
        expect(prepared).toHaveLength(2);
        expect(id).toBe(original.resourceInstanceId);
        return finalBounds;
      },
    } as unknown as MediaTextureCache;
    const captured = prepareTextSceneRasters(composition, scenes, media, 1, new Map());
    const actual = expandTextSceneGeometry(composition, scenes, cached, undefined, (id) =>
      captured.get(id),
    );
    expect(prepared[1]).toBeGreaterThan(prepared[0]);
    const expected = buildSceneGeometry(composition, scenes, undefined, () => finalBounds);
    expect(bytes(actual.data)).toEqual(bytes(expected.data));
    if (!finalBounds) throw new Error("Expected prepared bounds");
    finalBounds.width *= 2;
    const replay = expandTextSceneGeometry(composition, scenes, cached, undefined, (id) =>
      captured.get(id),
    );
    expect(bytes(replay.data)).toEqual(bytes(actual.data));
    expect(prepared).toHaveLength(2);
  });

  it.each(["perspective", "orthographic"] as const)(
    "matches %s camera bytes at random-access shutter times",
    (projection) => {
      const { project, composition, first, last } = fixture();
      first.threeDimensional = true;
      last.threeDimensional = true;
      first.transform.rotation[1] = staticValue(19);
      last.transform.position[2] = staticValue(350);
      const camera = createLayerForComposition("camera", composition);
      if (!camera.camera) throw new Error("Expected camera settings");
      camera.camera.projection = projection;
      camera.transform.position[0] = {
        mode: "animated",
        keyframes: [
          { id: "left", time: 0, value: 300, interpolation: "linear" },
          { id: "right", time: 2, value: 800, interpolation: "linear" },
        ],
      };
      composition.layers.push(camera);
      const snapshots = new Map<number, Uint8Array>();
      for (const time of [1, 0.98, 1.02, 0.98, 1]) {
        const scenes = flattenSceneLayers(composition, project, time);
        const evaluated = evaluateSceneCamera(composition, time);
        const readBounds = boundsFor(scenes);
        const cached = buildSceneGeometry(composition, scenes, evaluated);
        const actual = expandTextSceneGeometry(composition, scenes, cached, evaluated, readBounds);
        const expected = buildSceneGeometry(composition, scenes, evaluated, readBounds);
        expect(bytes(actual.data)).toEqual(bytes(expected.data));
        const previous = snapshots.get(time);
        if (previous) expect(bytes(actual.data)).toEqual(previous);
        snapshots.set(time, bytes(actual.data).slice());
      }
      expect(snapshots.get(0.98)).not.toEqual(snapshots.get(1.02));
    },
  );

  it("observes in-place layer, transform, camera, composition and bounds edits", () => {
    const { project, composition, first, last } = fixture();
    first.threeDimensional = true;
    last.threeDimensional = true;
    const camera = createLayerForComposition("camera", composition);
    composition.layers = [first, last, camera];
    const scenes = flattenSceneLayers(composition, project, 0);
    const evaluated = evaluateSceneCamera(composition, 0);
    if (!evaluated) throw new Error("Expected evaluated camera");
    const cached = buildSceneGeometry(composition, scenes, evaluated);
    const bounds = { x: -12, y: -20, width: 200, height: 90 };
    const readBounds = () => bounds;
    const render = () => {
      const actual = expandTextSceneGeometry(composition, scenes, cached, evaluated, readBounds);
      const expected = buildSceneGeometry(composition, scenes, evaluated, readBounds);
      expect(bytes(actual.data)).toEqual(bytes(expected.data));
      return bytes(actual.data).slice();
    };
    const original = render();
    first.color[3] = 0.37;
    first.material = {
      metallic: 0.8,
      roughness: 0.2,
      emissive: 0.6,
      alphaMode: "blend",
      alphaCutoff: 0.1,
    };
    scenes[0].transform.anchor[0] += 13;
    scenes[0].transform.rotation[2] += 21;
    evaluated.pose.position[0] += 120;
    evaluated.projection.zoom *= 1.2;
    composition.width += 100;
    bounds.x -= 7;
    bounds.width += 50;
    expect(render()).not.toEqual(original);
  });

  it("leaves missing bounds and missing batches untouched", () => {
    const { project, composition, first, last } = fixture();
    composition.layers = [first, last];
    const scenes = flattenSceneLayers(composition, project, 0);
    const cached = buildSceneGeometry(composition, scenes);
    expect(expandTextSceneGeometry(composition, scenes, cached, undefined, () => undefined)).toBe(
      cached,
    );
    const missing = structuredClone(scenes[0]);
    missing.instanceId = "not-present-in-cached-batches";
    const withBounds = () => ({ x: -1, y: -2, width: 300, height: 200 });
    expect(expandTextSceneGeometry(composition, [missing], cached, undefined, withBounds)).toBe(
      cached,
    );
    const readBounds = (id: string) =>
      id === scenes[0].resourceInstanceId ? withBounds() : undefined;
    const actual = expandTextSceneGeometry(composition, scenes, cached, undefined, readBounds);
    const expected = buildSceneGeometry(composition, scenes, undefined, readBounds);
    expect(bytes(actual.data)).toEqual(bytes(expected.data));
  });
});
