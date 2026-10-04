import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { staticValue } from "../../core/types";
import { buildSceneGeometry } from "../geometry/geometry";
import { buildSceneLighting } from "../scene/scene-lighting";
import { expandTextSceneGeometry } from "../text/text-scene-geometry";
import { encodeFramePlan } from "./codec";
import { rasterPixelFixtures } from "./raster-pixel-fixture";
import { readRasterBounds } from "./raster-sample";
import { buildSceneBufferPlan } from "./scene-buffer-plan";
import { bindSceneMediaPlan } from "./scene-media-plan";

/** Real geometry producers feed a transport-only fixture; no authoring objects escape. */
export async function rasterSceneFixtures() {
  const fixtures = [];
  for (const raster of await rasterPixelFixtures()) {
    const sample = raster.frame.descriptor.sample;
    if (sample.kind !== "raster") throw new Error("Expected raster fixture");
    const { origin } = sample;
    const bounds = readRasterBounds(raster.frame.descriptor.sample);
    const project = createBlankProject();
    const composition = project.compositions[0];
    composition.id = `raster-scene-${origin}`;
    const layer = createLayerForComposition(origin === "text" ? "text" : "image", composition);
    layer.id = `raster-layer-${origin}`;
    layer.size = [190, 85];
    layer.transform.scale = [staticValue(-130), staticValue(170), staticValue(100)];
    layer.transform.rotation[2] = staticValue(23);
    composition.layers = [layer];
    const scenes = flattenSceneLayers(composition, project, 0.5);
    const cached = buildSceneGeometry(composition, scenes);
    const geometry = expandTextSceneGeometry(composition, scenes, cached, undefined, () => bounds);
    const expectedVertices = new Uint8Array(geometry.data.buffer).slice();
    const plan = bindSceneMediaPlan(
      buildSceneBufferPlan({
        snapshot: {
          snapshotScope: raster.source.descriptor.authorization_scope,
          projectRevision: 7,
        },
        compositionId: composition.id,
        time: 0.5,
        frameRate: composition.frameRate,
        target: { width: composition.width, height: composition.height },
        renderTarget: { width: composition.width, height: composition.height },
        antiAliasing: "off",
        geometry,
        lighting: buildSceneLighting(scenes, composition),
        shadowsEnabled: false,
      }),
      [{ draw_index: 0, binding: { kind: "frame", hash: raster.frame.hash } }],
    );
    fixtures.push({
      id: `raster-scene-${origin}`,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
      raster,
      expectedVertices,
      bounds,
      expandedTextBounds:
        origin !== "text" || geometry.data.some((value, i) => value !== cached.data[i]),
    });
    // Destroy the producing geometry and authoring scene before any replay begins.
    geometry.data.fill(Number.NaN);
    composition.layers.length = 0;
    project.compositions.length = 0;
  }
  return fixtures;
}
