const { ipcRenderer, sharedTexture } = require("electron");
let device;
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, identity) => {
  const sequence = identity.sequence;
  let video;
  let readback;
  try {
    video = importedSharedTexture.getVideoFrame();
    if (!device) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("Preview witness GPU unavailable");
      device = await adapter.requestDevice();
    }
    const canvas = document.querySelector("canvas");
    canvas.width = video.displayWidth;
    canvas.height = video.displayHeight;
    const context = canvas.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
      colorSpace: "srgb",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    const target = context.getCurrentTexture();
    device.queue.copyExternalImageToTexture(
      { source: video },
      { texture: target, premultipliedAlpha: true, colorSpace: "srgb" },
      [canvas.width, canvas.height],
    );
    const stride = Math.ceil((canvas.width * 4) / 256) * 256;
    readback = device.createBuffer({
      size: stride * canvas.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: stride }, [
      canvas.width,
      canvas.height,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(readback.getMappedRange());
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const offset = y * stride + x * 4;
        const targetOffset = (y * canvas.width + x) * 4;
        pixels[targetOffset] = source[offset + (format === "bgra8unorm" ? 2 : 0)];
        pixels[targetOffset + 1] = source[offset + 1];
        pixels[targetOffset + 2] = source[offset + (format === "bgra8unorm" ? 0 : 2)];
        pixels[targetOffset + 3] = source[offset + 3];
      }
    }
    // Readback is confined to the witness; normal presentation stays GPU-resident.
    ipcRenderer.send("preview-witness-frame", {
      sequence,
      generation: identity.generation,
      time: identity.time,
      source: identity.source,
      width: canvas.width,
      height: canvas.height,
      format: video.format,
      timestamp: video.timestamp,
      pixels: Buffer.from(pixels).toString("base64"),
    });
  } catch (error) {
    ipcRenderer.send("preview-witness-error", String(error.stack ?? error));
  } finally {
    readback?.destroy();
    video?.close();
    importedSharedTexture.release();
  }
});
window.addEventListener("DOMContentLoaded", () => ipcRenderer.send("preview-witness-ready"));
