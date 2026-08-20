import { auxiliarySurfaceShader } from "./auxiliary-buffer-renderer";
import { extractPositionsShader } from "./motion-vector-history";
import {
  imageShader,
  particleComputeShader,
  particleRenderShader,
  postProcessShader,
  shadowShader,
  shapeShader,
} from "./shaders";

export async function validateShaderSources(device: GPUDevice): Promise<void> {
  const sources = [
    ["shape", shapeShader],
    ["image", imageShader],
    ["particle compute", particleComputeShader],
    ["particle render", particleRenderShader],
    ["shadow", shadowShader],
    ["post process", postProcessShader],
    ["auxiliary surface MRT", auxiliarySurfaceShader],
    ["motion-vector history", extractPositionsShader],
  ] as const;
  for (const [label, code] of sources) {
    const module = device.createShaderModule({ label: `Validate ${label}`, code });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length === 0) continue;
    const details = errors
      .slice(0, 8)
      .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
      .join("\n");
    throw new Error(`WebGPU ${label} shader compilation failed:\n${details}`);
  }
}
