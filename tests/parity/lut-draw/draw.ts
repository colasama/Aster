import { textureCompositeShader } from "../../../src/renderer/gpu/shaders";

export async function drawEffect(
  device: GPUDevice,
  source: GPUTexture,
  encode: (
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    draw: (pass: GPURenderPassEncoder) => void,
  ) => void,
) {
  const target = device.createTexture({
    size: [64, 48],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: 64 * 48 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const module = device.createShaderModule({ code: textureCompositeShader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format: "rgba16float" }] },
    depthStencil: { format: "depth24plus", depthCompare: "always", depthWriteEnabled: false },
  });
  const binding = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: device.createSampler({ minFilter: "linear", magFilter: "linear" }) },
    ],
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: source }, { texture: target }, [64, 48]);
    encode(encoder, target, (pass) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding);
      pass.draw(3);
    });
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 512, rowsPerImage: 48 },
      [64, 48],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Uint8Array(readback.getMappedRange()));
    readback.unmap();
    return pixels;
  } finally {
    target.destroy();
    readback.destroy();
  }
}
