// Run run() from a WebGPU browser on the unbundled Vite server; see docs/LAYER_STYLES.md.

import { createLayerForComposition } from "/src/core/layers/layer-factory.ts";
import { createBlankProject } from "/src/core/project/project.ts";
import { BLEND_MODES } from "/src/core/types.ts";
import { createEffect } from "/src/effects/registry.ts";
import { LayerCompositor, needsBackdropBlend } from "/src/renderer/compositing/layer-composite.ts";
import { LayerEffectRenderer } from "/src/renderer/effects/layer-effects.ts";

export async function run() {
  const adapter = await navigator.gpu.requestAdapter(),
    device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener("uncapturederror", (e) => errors.push(e.error.message));
  const usage =
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.COPY_DST;
  const texture = (w = 1, h = 1) =>
    device.createTexture({ size: [w, h], format: "rgba8unorm", usage });
  const read = async (t, w = 1, h = 1) => {
    const pitch = Math.ceil((w * 4) / 256) * 256,
      buffer = device.createBuffer({
        size: pitch * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: t }, { buffer, bytesPerRow: pitch }, [w, h]);
    device.queue.submit([e.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    return { result, pitch };
  };
  const source = texture(),
    backdrop = texture(),
    target = texture(),
    compositor = new LayerCompositor(device, "rgba8unorm");
  compositor.resize(source, backdrop);
  const channel = (b, s, m) => {
    const overlay = (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s));
    switch (m) {
      case "multiply":
        return b * s;
      case "overlay":
        return overlay(b, s);
      case "darken":
        return Math.min(b, s);
      case "lighten":
        return Math.max(b, s);
      case "color-burn":
        return b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
      case "color-dodge":
        return b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s));
      case "soft-light":
        return s <= 0.5
          ? b - (1 - 2 * s) * b * (1 - b)
          : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
      case "hard-light":
        return overlay(s, b);
      case "difference":
        return Math.abs(b - s);
      case "exclusion":
        return b + s - 2 * b * s;
      default:
        return s;
    }
  };
  let cases = 0;
  for (const mode of BLEND_MODES.filter(needsBackdropBlend))
    for (const pair of [
      [
        [80, 30, 60, 128],
        [40, 100, 60, 160],
      ],
      [
        [80, 30, 60, 128],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [40, 100, 60, 160],
      ],
      [
        [0, 255, 128, 255],
        [128, 0, 255, 255],
      ],
      [
        [0, 255, 0, 255],
        [255, 0, 0, 255],
      ],
    ]) {
      const [s, b] = pair;
      device.queue.writeTexture({ texture: source }, new Uint8Array(s), { bytesPerRow: 4 }, [1, 1]);
      device.queue.writeTexture(
        { texture: backdrop },
        new Uint8Array(b),
        { bytesPerRow: 4 },
        [1, 1],
      );
      const e = device.createCommandEncoder();
      compositor.encode(e, target, mode);
      device.queue.submit([e.finish()]);
      const { result } = await read(target);
      const sa = s[3] / 255,
        ba = b[3] / 255;
      const expected = [0, 1, 2].map(
        (i) =>
          255 *
          (((1 - sa) * b[i]) / 255 +
            ((1 - ba) * s[i]) / 255 +
            sa * ba * channel(b[i] / Math.max(b[3], 1), s[i] / Math.max(s[3], 1), mode)),
      );
      expected.push(255 * (sa + ba * (1 - sa)));
      if (expected.some((v, i) => Math.abs(v - result[i]) > 2))
        throw Error(`${mode}: ${[...result.slice(0, 4)]} != ${expected}`);
      cases++;
    }
  source.destroy();
  backdrop.destroy();
  target.destroy();
  const composition = createBlankProject().compositions[0];
  composition.width = 64;
  composition.height = 64;
  const layer = createLayerForComposition("text", composition);
  layer.name = "Alpha style probe";
  const fill = createEffect("color-overlay");
  fill.parameters = { color: 0xff0000, opacity: 100, blendMode: 0 };
  const glow = createEffect("outer-glow");
  glow.parameters = { color: 0, opacity: 90, size: 8, spread: 20, range: 0.5 };
  layer.effects = [fill, glow];
  const renderer = new LayerEffectRenderer(device, "rgba8unorm");
  renderer.resize(64, 64);
  const styled = texture(64, 64);
  const module = device.createShaderModule({
    code: `@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}@fragment fn fs(@builtin(position)p:vec4f)->@location(0)vec4f {return select(vec4f(0),vec4f(1),p.x>=28&&p.x<36&&p.y>=16&&p.y<48);}`,
  });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
  });
  const e = device.createCommandEncoder();
  renderer.encode(e, styled, composition, layer, "probe", 0, (p) => {
    p.setPipeline(pipeline);
    p.draw(3);
  });
  device.queue.submit([e.finish()]);
  const { result, pitch } = await read(styled, 64, 64),
    pixel = (x, y) => [...result.slice(y * pitch + x * 4, y * pitch + x * 4 + 4)];
  if (pixel(0, 0)[3] !== 0) throw Error("Glow contaminates empty background");
  if (pixel(20, 32)[3] > 24) throw Error("Glow spread leaves a hard kernel boundary");
  if (
    pixel(25, 32)[3] === 0 ||
    pixel(25, 32)
      .slice(0, 3)
      .some((v) => v !== 0)
  )
    throw Error("Black halo is missing or tinted");
  if (pixel(32, 32)[0] < 250 || pixel(32, 32)[1] > 1 || pixel(32, 32)[3] !== 255)
    throw Error("Fill failed to preserve glyph alpha");
  const shadow = createEffect("drop-shadow");
  shadow.parameters = {
    color: 0,
    opacity: 100,
    direction: 0,
    distance: 12,
    softness: 0,
    spread: 0,
  };
  layer.effects = [shadow];
  const shadowTarget = texture(64, 64);
  const shadowEncoder = device.createCommandEncoder();
  renderer.encode(shadowEncoder, shadowTarget, composition, layer, "shadow-probe", 0, (p) => {
    p.setPipeline(pipeline);
    p.draw(3);
  });
  device.queue.submit([shadowEncoder.finish()]);
  const shadowRead = await read(shadowTarget, 64, 64);
  const shadowPixel = (x, y) => [
    ...shadowRead.result.slice(y * shadowRead.pitch + x * 4, y * shadowRead.pitch + x * 4 + 4),
  ];
  if (shadowPixel(44, 32).join() !== "0,0,0,255")
    throw Error(`Shadow offset or color failed: ${shadowPixel(44, 32)}`);
  if (shadowPixel(20, 32)[3] !== 0) throw Error("Shadow appears on the wrong side");
  if (shadowPixel(32, 32).join() !== "255,255,255,255") throw Error("Shadow obscures its source");
  shadowTarget.destroy();
  renderer.destroy();
  styled.destroy();
  device.destroy();
  if (errors.length) throw Error(errors.join("\n"));
  return { blendCases: cases, alphaStyles: "passed", gpuErrors: errors };
}
