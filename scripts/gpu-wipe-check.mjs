// Import run() from a WebGPU browser served by Vite. See docs/SEMANTIC_VECTOR_COMPOSITING.md.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { setLayerSizeAndCenterAnchor } from "/src/core/types.ts";
import { createEffect } from "/src/effects/registry.ts";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "/src/renderer/compositing/beauty-frame.ts";
import { WebGpuRenderer } from "/src/renderer/webgpu-renderer.ts";

export async function run() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const renderer = await WebGpuRenderer.create(canvas);
  const beauty = new ProductionBeautyFramePipeline(
    createViewportBeautyFrameBackend(renderer, canvas),
  );
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = composition.height = 128;
  composition.background = [0, 0, 0, 0];
  const layer = createLayerForComposition("shape", composition);
  setLayerSizeAndCenterAnchor(layer, [128, 128]);
  layer.color = [0.1, 0.2, 0.8, 1];
  Object.assign(layer.shape, {
    kind: "rectangle",
    roundness: 0,
    strokeWidth: 0,
    fillMode: "linear",
    gradientColor: [0.8, 0.6, 0.1, 1],
    gradientAngle: 0,
  });
  composition.layers = [layer];
  const wipe = createEffect("linear-wipe");
  Object.assign(wipe.parameters, {
    completion: 50,
    feather: 0,
    bend: 24,
    bendWidth: 128,
    bendPhase: 0,
    bendSpeed: 180,
  });
  const read = async (size, time) =>
    new Uint8Array(
      (
        await beauty.readback(
          createBeautyFrameRequest({
            project,
            composition,
            time,
            width: size,
            height: size,
            antiAliasing: "off",
          }),
        )
      ).pixels,
    );
  const results = [];
  try {
    for (const size of [128, 64]) {
      layer.effects = [];
      const baseline = await read(size, 0);
      layer.effects = [wipe];
      for (const time of [0, 1, 0]) {
        const frame = await read(size, time);
        let unchanged = 0,
          removed = 0;
        for (let y = 2; y < size - 2; y++)
          for (let x = 2; x < size - 2; x++) {
            const index = (y * size + x) * 4;
            if (frame[index + 3] === 255) {
              if (
                [0, 1, 2].some(
                  (channel) => Math.abs(frame[index + channel] - baseline[index + channel]) > 2,
                )
              )
                throw new Error("Curved wipe moved or recoloured the retained source");
              unchanged++;
            } else if (frame[index + 3] === 0) removed++;
          }
        const alpha = (x, y) =>
          frame[(Math.floor((y * size) / 128) * size + Math.floor((x * size) / 128)) * 4 + 3];
        const expected = time === 0 ? [255, 0] : [0, 255];
        if (alpha(64, 32) !== expected[0] || alpha(64, 96) !== expected[1])
          throw new Error("Curved wipe phase or preview pixel scale changed the edge");
        if (unchanged < (size * size) / 4 || removed < (size * size) / 4)
          throw new Error("Curved wipe did not preserve both sides of the reveal");
        results.push({ size, time, unchanged, removed });
      }
    }
    return { passed: true, results };
  } finally {
    renderer.dispose();
    canvas.remove();
  }
}
