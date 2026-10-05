import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import { decodeRadianceHdrForUpload } from "../../../src/core/media/hdr-environment";
import { createBlankProject } from "../../../src/core/project/project";
import { flattenSceneLayers } from "../../../src/core/scene/scene-evaluation";
import { encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { buildMaterialBindingSlice } from "../../../src/renderer/frame-plan/material-binding-plan";
import { buildSceneBufferPlan } from "../../../src/renderer/frame-plan/scene-buffer-plan";
import { buildSceneGeometry } from "../../../src/renderer/geometry/geometry";
import { prepareEncodedTexture } from "../../../src/renderer/media/encoded-texture-upload";
import { prepareHdrTexture } from "../../../src/renderer/media/hdr-texture-resource";
import { planMaterialTextures } from "../../../src/renderer/media/material-texture-plan";
import { buildSceneLighting } from "../../../src/renderer/scene/scene-lighting";

export async function materialDrawFixtures() {
  const canvas = new OffscreenCanvas(2, 2);
  const context = canvas.getContext("2d");
  if (!context) throw Error("Canvas unavailable");
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray([
        220, 128, 200, 255, 32, 170, 220, 255, 120, 230, 180, 255, 160, 35, 220, 255,
      ]),
      2,
      2,
    ),
    0,
    0,
  );
  const normalBlob = await canvas.convertToBlob({ type: "image/png" });
  const normal = await prepareEncodedTexture(normalBlob);
  const hdrHeader = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n");
  const rgbe = new Uint8Array(hdrHeader.length + 16);
  rgbe.set(hdrHeader);
  rgbe.set(
    [160, 32, 16, 130, 16, 140, 32, 129, 24, 48, 180, 130, 96, 80, 48, 129],
    hdrHeader.length,
  );
  const decodedHdr = decodeRadianceHdrForUpload(rgbe);
  const environment = prepareHdrTexture(decodedHdr);
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.id = "material-draw";
  composition.width = 64;
  composition.height = 48;
  composition.environment = {
    enabled: true,
    intensity: 0.8,
    rotation: 45,
    source: { name: "test.hdr", mimeType: "image/vnd.radiance", dataUrl: "fixture" },
  };
  const layer = createLayerForComposition("mesh", composition);
  layer.id = "mesh";
  layer.size = [38, 38];
  layer.transform.anchor = [
    { mode: "static", value: 19 },
    { mode: "static", value: 19 },
    { mode: "static", value: 0 },
  ];
  layer.mesh = {
    name: "plane",
    positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 2, 0, 2, 2, 0, 2],
    indices: [0, 1, 2, 0, 2, 3],
    materialTextures: {
      normal: { mimeType: "image/png", dataUrl: "fixture", texCoord: 0, scale: 1 },
    },
  };
  const light = createLayerForComposition("light", composition);
  composition.layers = [layer, light];
  const scene = flattenSceneLayers(composition, project, 0);
  const geometry = buildSceneGeometry(composition, scene);
  const lighting = buildSceneLighting(scene, composition, false);
  const scenePlan = buildSceneBufferPlan({
    snapshot: { snapshotScope: "material-replay", projectRevision: 1 },
    compositionId: composition.id,
    time: 0,
    frameRate: composition.frameRate,
    target: { width: 64, height: 48 },
    renderTarget: { width: 64, height: 48 },
    antiAliasing: "off",
    geometry,
    lighting,
    shadowsEnabled: false,
  });
  const cases = [
    "inactive",
    "normal",
    "normal-negative",
    "environment",
    "environment-rotated",
    "combined",
  ].map((id) => {
    const normalReady = id.startsWith("normal") || id === "combined";
    const environmentReady = id.startsWith("environment") || id === "combined";
    const material = {
      ...planMaterialTextures(layer, composition.environment, normalReady, environmentReady),
      instanceId: geometry.batches[0].resourceInstanceId,
      normalHash: normalReady ? normal.message.hash : null,
      environmentHash: environmentReady ? environment.message.hash : null,
    };
    if (id === "normal-negative") material.normalScale = -1;
    if (id === "environment-rotated") material.environmentRotation = 0.625;
    const plan = buildMaterialBindingSlice(scenePlan.metadata.header, material);
    return { id, material, plan: Array.from(encodeFramePlan(plan.metadata, plan.blobs)) };
  });
  return {
    normalBlob,
    normal,
    environment,
    decodedHdr,
    cases,
    scenePlan: Array.from(encodeFramePlan(scenePlan.metadata, scenePlan.blobs)),
    buffers: {
      lighting: new Uint8Array(lighting.buffer, lighting.byteOffset, lighting.byteLength),
      vertices: new Uint8Array(
        geometry.data.buffer,
        geometry.data.byteOffset,
        geometry.data.byteLength,
      ),
      draws: geometry.batches.map((b) => ({
        firstVertex: b.firstVertex,
        vertexCount: b.vertexCount,
      })),
    },
  };
}
