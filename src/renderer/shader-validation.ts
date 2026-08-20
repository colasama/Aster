import { auxiliarySurfaceShader } from "./auxiliary-buffer-renderer";
import { depthEffectsShader } from "./depth-effects";
import { extractPositionsShader } from "./motion-vector-history";
import { particleMeshRenderShader } from "./particle-mesh";
import {
  imageShader,
  materialShapeShader,
  particleComputeShader,
  particleRenderShader,
  particleStreakRenderShader,
  postProcessShader,
  shadowShader,
  shapeShader,
} from "./shaders";
import { surfacePostEffectsShader } from "./surface-post-effects";

export async function validateShaderSources(device: GPUDevice): Promise<void> {
  const sources = [
    ["shape", shapeShader],
    ["normal-mapped HDR environment", materialShapeShader],
    ["image", imageShader],
    ["particle compute", particleComputeShader],
    ["particle render", particleRenderShader],
    ["particle streak render", particleStreakRenderShader],
    ["particle mesh render", particleMeshRenderShader],
    ["shadow", shadowShader],
    ["post process", postProcessShader],
    ["auxiliary surface MRT", auxiliarySurfaceShader],
    ["depth effects", depthEffectsShader],
    ["motion-vector history", extractPositionsShader],
    ["object isolation and vector motion blur", surfacePostEffectsShader],
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
