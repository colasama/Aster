// Import run() from a WebGPU browser served by Vite. See docs/ANTI_ALIASING.md.
import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "/src/renderer/compositing/beauty-frame.ts";
import { AntiAliasingRenderer } from "/src/renderer/effects/anti-aliasing.ts";
import { WebGpuRenderer } from "/src/renderer/webgpu-renderer.ts";

export async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
  device.pushErrorScope("validation");
  const aa = new AntiAliasingRenderer(device, "rgba8unorm");
  const shader = device.createShaderModule({
    code: `
    struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
    @vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
      let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
      return Vertex(vec4f(p[i],0,1), p[i] * 0.5 + 0.5);
    }
    @fragment fn fs(v: Vertex) -> @location(0) vec4f {
      let alpha = select(0.0, 0.75, v.uv.y > v.uv.x * 0.38 + 0.2875);
      return vec4f(alpha, 0, 0, alpha);
    }`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  });
  const output = device.createTexture({
    size: [32, 32],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256 * 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const samples = {};
  for (const mode of ["off", "fxaa", "ssaa2x", "ssaa4x", "off"]) {
    const scale = mode === "ssaa4x" ? 4 : mode === "ssaa2x" ? 2 : 1;
    aa.resize(mode, 32 * scale, 32 * scale);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: aa.view ?? output.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    aa.encode(encoder, output.createView());
    encoder.copyTextureToBuffer(
      { texture: output },
      { buffer: readback, bytesPerRow: 256 },
      [32, 32],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange());
    let partial = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const i = y * 256 + x * 4;
        if (Math.abs(bytes[i] - bytes[i + 3]) > 1 || bytes[i + 1] || bytes[i + 2])
          throw new Error(`${mode}: premultiplied alpha was corrupted`);
        if (bytes[i + 3] > 0 && bytes[i + 3] < 190) partial++;
      }
    readback.unmap();
    if (mode !== "off" && partial < 8) throw new Error(`${mode}: edge coverage was not smoothed`);
    if (mode === "off" && aa.estimatedBytes !== 0) throw new Error("Disabled AA retained a target");
    samples[mode] = partial;
  }
  await device.queue.onSubmittedWorkDone();
  const scoped = await device.popErrorScope();
  if (scoped) errors.push(scoped.message);
  aa.destroy();
  output.destroy();
  readback.destroy();
  device.destroy();
  if (errors.length) throw new Error(errors.join("\n"));

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  document.body.append(canvas);
  const renderer = await WebGpuRenderer.create(canvas);
  const beauty = new ProductionBeautyFramePipeline(
    createViewportBeautyFrameBackend(renderer, canvas),
  );
  const project = createBlankProject();
  const composition = project.compositions[0];
  composition.width = 64;
  composition.height = 64;
  composition.background = [0, 0, 0, 0];
  const layer = createLayerForComposition("solid", composition);
  layer.size = [35, 22];
  layer.transform.rotation[2].value = 23;
  composition.layers = [layer];
  const rendered = {};
  try {
    const coldRequest = createBeautyFrameRequest({
      project,
      composition,
      time: 0.25,
      width: 64,
      height: 64,
      antiAliasing: "fxaa",
    });
    const cold = new Uint8Array((await beauty.readback(coldRequest)).pixels);
    const warm = new Uint8Array((await beauty.readback(coldRequest)).pixels);
    if (cold.some((v, i) => v !== warm[i]))
      throw new Error("Cold export changed on its second frame");
    for (const mode of ["off", "fxaa", "ssaa2x", "ssaa4x", "off"]) {
      const request = createBeautyFrameRequest({
        project,
        composition,
        time: 0.25,
        width: 64,
        height: 64,
        antiAliasing: mode,
      });
      beauty.present(request);
      const first = new Uint8Array((await beauty.readback(request)).pixels);
      const second = new Uint8Array((await beauty.readback(request)).pixels);
      const concurrent = await Promise.all([
        beauty.readback(request),
        beauty.readback(request),
        beauty.readback(request),
      ]);
      if (concurrent.some((frame) => new Uint8Array(frame.pixels).some((v, i) => v !== second[i])))
        throw new Error(`${mode}: concurrent readbacks changed output`);
      if (first.length !== 64 * 64 * 4 || first.some((v, i) => v !== second[i]))
        throw new Error(
          `${mode}: nondeterministic or incorrectly sized output (${first.length}/${second.length}); differences ${JSON.stringify(
            [...first.keys()]
              .filter((i) => first[i] !== second[i])
              .slice(0, 12)
              .map((i) => [i, first[i], second[i]]),
          )}`,
        );
      if (rendered[mode] && first.some((v, i) => v !== rendered[mode][i]))
        throw new Error("Switching AA off did not restore the original pixels");
      rendered[mode] = first;
      if (mode !== "off" && !first.some((v, i) => v !== rendered.off[i]))
        throw new Error(`${mode}: beauty output did not change`);
    }
    const small = createBeautyFrameRequest({
      project,
      composition,
      time: 0.25,
      width: 37,
      height: 29,
      antiAliasing: "ssaa2x",
    });
    if ((await beauty.readback(small)).pixels.byteLength !== 37 * 29 * 4)
      throw new Error("Odd output dimensions were not preserved");
    let rejected = false;
    try {
      await beauty.readback(
        createBeautyFrameRequest({
          project,
          composition,
          time: 0.25,
          width: renderer.diagnostics.maxTextureSize + 1,
          height: 1,
          antiAliasing: "ssaa4x",
        }),
      );
    } catch (error) {
      rejected = String(error).includes("GPU limit");
    }
    if (!rejected) throw new Error("Oversized SSAA was not rejected");
    const restored = new Uint8Array(
      (
        await beauty.readback(
          createBeautyFrameRequest({
            project,
            composition,
            time: 0.25,
            width: 64,
            height: 64,
            antiAliasing: "off",
          }),
        )
      ).pixels,
    );
    if (restored.some((v, i) => v !== rendered.off[i]))
      throw new Error("Rejected SSAA prevented recovery");
    const depthProject = structuredClone(project);
    const depthComposition = depthProject.compositions[0];
    const camera = createLayerForComposition("camera", depthComposition);
    camera.camera.depthOfField = true;
    camera.camera.focusDistance.value = 120;
    depthComposition.layers[0].threeDimensional = true;
    depthComposition.layers[0].motionBlur = true;
    depthComposition.motionBlur.enabled = true;
    depthComposition.layers.push(camera);
    for (const antiAliasing of ["fxaa", "ssaa2x", "ssaa4x"]) {
      const request = createBeautyFrameRequest({
        project: depthProject,
        composition: depthComposition,
        time: 0.25,
        width: 64,
        height: 64,
        antiAliasing,
      });
      const frame = await beauty.readback(request);
      if (frame.pixels.byteLength !== 64 * 64 * 4 || renderer.productionRenderError)
        throw new Error(`${antiAliasing}: depth/motion output failed`);
    }
  } finally {
    renderer.dispose();
  }
  return {
    adapter: adapter.info.description,
    edgePixels: samples,
    beautyModes: Object.keys(rendered),
    errors,
  };
}
