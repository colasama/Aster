import type { PutResource } from "../../../src/renderer/frame-plan/types";
import { GpuFrameReadbackPool } from "../../../src/renderer/gpu/frame-readback";
import {
  prepareEncodedTexture,
  uploadEncodedTexture,
} from "../../../src/renderer/media/encoded-texture-upload";
import { legacyNormalUpload } from "./legacy-upload";

async function read(device: GPUDevice, texture: GPUTexture) {
  const pool = new GpuFrameReadbackPool(device, "rgba8unorm", 1);
  const ticket = pool.reserve(texture.width, texture.height);
  try {
    const encoder = device.createCommandEncoder();
    ticket.encode(encoder, texture);
    device.queue.submit([encoder.finish()]);
    return Array.from(new Uint8Array((await ticket.read()).pixels));
  } finally {
    pool.destroy();
    texture.destroy();
  }
}

async function capture() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  try {
    const canvas = new OffscreenCanvas(3, 2);
    const context = canvas.getContext("2d");
    if (!context) throw Error("Canvas unavailable");
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray([
          128, 128, 255, 255, 255, 0, 128, 255, 0, 255, 128, 255, 64, 192, 240, 127, 210, 32, 96,
          64, 0, 0, 0, 0,
        ]),
        3,
        2,
      ),
      0,
      0,
    );
    const results = [];
    for (const encoding of ["png", "jpeg", "webp"] as const) {
      const blob = await canvas.convertToBlob({ type: `image/${encoding}`, quality: 0.9 });
      if (blob.type !== `image/${encoding}`) throw Error(`Missing ${encoding} encoder`);
      const reference = await read(device, await legacyNormalUpload(device, blob));
      const prepared = await prepareEncodedTexture(blob);
      results.push({
        encoding,
        message: prepared.message,
        bytes: Array.from(prepared.bytes),
        reference,
      });
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return {
      results,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    };
  } finally {
    device.destroy();
  }
}

async function replay(inputs: { message: PutResource; bytes: number[] }[]) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("GPU unavailable");
  const device = await adapter.requestDevice();
  device.pushErrorScope("validation");
  try {
    const results = [];
    for (const input of inputs) {
      const uploaded = await uploadEncodedTexture(
        device,
        input.message,
        new Uint8Array(input.bytes),
        "Decoded normal replay",
        true,
      );
      if (uploaded.texture.width !== 3 || uploaded.texture.height !== 2)
        throw Error("Unexpected decoded extent");
      results.push(await read(device, uploaded.texture));
    }
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    return results;
  } finally {
    device.destroy();
  }
}

Object.assign(window, { captureNormalTextures: capture, replayNormalTextures: replay });
