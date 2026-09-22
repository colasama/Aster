// Import run() from a WebGPU browser served by the unbundled Vite server.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createMediaLayerFromFile } from "/src/core/media/assets.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { createEffect } from "/src/effects/registry.ts";
import { acesToneMap, linearToSrgb, srgbToLinear } from "/src/renderer/color-management.ts";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "/src/renderer/compositing/beauty-frame.ts";
import { WebGpuRenderer } from "/src/renderer/webgpu-renderer.ts";

export async function run() {
  const width = 256;
  const height = 32;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const alphas = [255, 128, 64, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set([x, 255 - x, (x * 17) % 256, alphas[Math.floor(y / 8)]], (y * width + x) * 4);
  const sourceCanvas = new OffscreenCanvas(width, height);
  sourceCanvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  const file = new File(
    [await sourceCanvas.convertToBlob({ type: "image/png" })],
    "color-ramp.png",
    {
      type: "image/png",
    },
  );
  const url = URL.createObjectURL(file);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = await WebGpuRenderer.create(canvas);
  const beauty = new ProductionBeautyFramePipeline(
    createViewportBeautyFrameBackend(renderer, canvas),
  );
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = width;
  composition.height = height;
  composition.background = [0, 0, 0, 0];
  const { layer, source } = await createMediaLayerFromFile("image", file, composition, 0, {
    runtimeUrl: url,
  });
  composition.layers = [layer];
  project.sources = [source];
  const results = [];
  try {
    for (const mode of [
      "plain",
      "neutral-effect",
      "depth-of-field",
      "vectorMotionBlur",
      "selectionIsolation",
      "filmic-tone-map",
    ]) {
      const snapshot = structuredClone(project);
      const scene = snapshot.compositions[0];
      if (mode === "neutral-effect") scene.layers[0].effects = [createEffect("exposure")];
      if (mode === "filmic-tone-map") {
        const effect = createEffect(mode);
        effect.parameters = {
          curve: 0,
          exposure: 0,
          whitePoint: 1,
          toe: 0,
          shoulder: 0,
          saturation: 1,
          blend: 100,
        };
        scene.layers[0].effects = [effect];
      }
      if (mode === "depth-of-field") {
        const camera = createLayerForComposition("camera", scene);
        camera.camera.depthOfField = true;
        camera.camera.aperture.value = 0;
        scene.layers.push(camera);
      }
      const request = createBeautyFrameRequest({
        project: snapshot,
        composition: scene,
        time: 0,
        width,
        height,
      });
      // Exercise the same final pixels after preview presentation and on export.
      beauty.present(request);
      const diagnostic = mode === "vectorMotionBlur" || mode === "selectionIsolation";
      if (diagnostic) renderer.setBufferVisualization(mode);
      const frame = diagnostic
        ? await renderer.renderRawFrame(scene, 0, snapshot)
        : await beauty.readback(request);
      const actual = new Uint8Array(frame.pixels);
      const channels = frame.pixelFormat === "bgra" ? [2, 1, 0, 3] : [0, 1, 2, 3];
      let maximumError = 0;
      for (const y of [4, 12, 20, 28])
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const original = [...pixels.slice(offset, offset + 3)].map((value) => value / 255);
          const expectedColor =
            mode === "filmic-tone-map"
              ? linearToSrgb(acesToneMap(srgbToLinear(original)))
              : original;
          for (let channel = 0; channel < 4; channel++) {
            const expected =
              channel === 3 ? pixels[offset + 3] : expectedColor[channel] * pixels[offset + 3];
            const error = Math.abs(actual[offset + channels[channel]] - expected);
            maximumError = Math.max(maximumError, error);
            if (error > 2)
              throw new Error(
                `${mode} (${x}, ${y}) channel ${channel}: ${actual[offset + channels[channel]]} != ${expected}`,
              );
          }
        }
      results.push({ mode, maximumError });
    }
    return { adapter: renderer.diagnostics.adapter, results };
  } finally {
    renderer.dispose();
    URL.revokeObjectURL(url);
  }
}
