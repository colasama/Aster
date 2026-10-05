export async function drawGenerators(
  device: GPUDevice,
  compute: (pass: GPUComputePassEncoder) => void,
  draw: (pass: GPURenderPassEncoder) => void,
) {
  const target = device.createTexture({
    size: [128, 96],
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depth = device.createTexture({
    size: [128, 96],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const readback = device.createBuffer({
    size: 128 * 96 * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    const computePass = encoder.beginComputePass();
    compute(computePass);
    computePass.end();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    draw(pass);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 1024, rowsPerImage: 96 },
      [128, 96],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Uint8Array(readback.getMappedRange()));
    readback.unmap();
    return pixels;
  } finally {
    target.destroy();
    depth.destroy();
    readback.destroy();
  }
}
