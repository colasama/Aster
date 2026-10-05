import { decodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { readMaterialBindingSlice } from "../../../src/renderer/frame-plan/material-binding-plan";
import { prepareSceneBuffers } from "../../../src/renderer/frame-plan/scene-buffer-upload";
import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { uploadEncodedTexture } from "../../../src/renderer/media/encoded-texture-upload";
import { MaterialGpuBindings } from "../../../src/renderer/media/material-gpu-bindings";
import { uploadTexturePixels } from "../../../src/renderer/media/texture-pixel-upload";
import { legacyNormalUpload } from "../material-textures/legacy-upload";
import { drawMaterial, lightingLayout } from "./draw";
import { materialDrawFixtures } from "./fixtures";
import { LegacyMaterialGpuBindings } from "./legacy-bindings";

async function capture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const layout = lightingLayout(device);
  const consumer = new LegacyMaterialGpuBindings(device, "rgba16float", layout);
  try {
    const fixture = await materialDrawFixtures();
    const normal = await legacyNormalUpload(device, fixture.normalBlob);
    const hdr = fixture.decodedHdr;
    const environment = device.createTexture({
      size: [hdr.width, hdr.height],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (!hdr.pixels) throw Error("Missing decoded HDR pixels");
    device.queue.writeTexture(
      { texture: environment },
      hdr.pixels,
      { bytesPerRow: hdr.bytesPerRow },
      [hdr.width, hdr.height],
    );
    consumer.register(fixture.normal.message.hash, "normal", normal);
    consumer.register(fixture.environment.message.hash, "environment", environment);
    const cases = [];
    for (const input of fixture.cases)
      cases.push({
        id: input.id,
        plan: input.plan,
        reference: await drawMaterial(device, layout, consumer, fixture.buffers, input.material),
      });
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      cases,
      scene: fixture.scenePlan,
      resources: [fixture.normal, fixture.environment].map((r) => ({
        message: r.message,
        bytes: Array.from(r.bytes),
      })),
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    consumer.destroy();
    device.destroy();
  }
}

async function replay(input: {
  scene: number[];
  cases: { id: string; plan: number[] }[];
  resources: { message: PutResource; bytes: number[] }[];
}) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  const layout = lightingLayout(device);
  const consumer = new MaterialGpuBindings(device, "rgba16float", layout);
  try {
    for (const resource of input.resources) {
      const bytes = new Uint8Array(resource.bytes);
      if (resource.message.kind === "encoded_texture") {
        const uploaded = await uploadEncodedTexture(
          device,
          resource.message,
          bytes,
          "Supplied normal",
        );
        consumer.register(resource.message.hash, "normal", uploaded.texture);
      } else {
        consumer.register(
          resource.message.hash,
          "environment",
          uploadTexturePixels(device, resource.message, bytes, "Supplied HDR"),
        );
      }
    }
    const plan = decodeFramePlan(new Uint8Array(input.scene));
    if (
      plan.metadata.header.render_target.width !== 64 ||
      plan.metadata.header.render_target.height !== 48
    )
      throw Error("Wrong replay extent");
    const buffers = prepareSceneBuffers(plan);
    const results = [];
    for (const item of input.cases) {
      const material = readMaterialBindingSlice(decodeFramePlan(new Uint8Array(item.plan)));
      results.push({
        id: item.id,
        pixels: await drawMaterial(device, layout, consumer, buffers, material),
      });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    consumer.destroy();
    device.destroy();
  }
}

Object.assign(window, { captureMaterialDraws: capture, replayMaterialDraws: replay });
