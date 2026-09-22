import { resolveGpuMemoryBudget } from "../../core/rendering/gpu-memory-policy";
import type { GpuDiagnostics } from "../../core/types";
import { initialRendererGpuMemory } from "../../desktop/gpu-memory";
import { bundledParticleDefinition } from "../scene/bundled-particle-generator";
import { precompileGpuPipelines } from "./pipeline-precompile";
import { validateShaderSources } from "./shader-validation";

export async function initializeGpuResources(
  adapter: GPUAdapter,
  device: GPUDevice,
  format: GPUTextureFormat,
) {
  const [, precompile, { memory, preference }] = await Promise.all([
    validateShaderSources(device),
    precompileGpuPipelines(device, format, [bundledParticleDefinition]),
    initialRendererGpuMemory(adapter.info),
  ]);
  const info = adapter.info;
  const diagnostics: GpuDiagnostics = {
    available: true,
    adapter: info.device || info.description || "High-performance adapter",
    architecture: info.architecture || "native",
    description: `${info.vendor || "GPU"} · ${info.description || info.device || "WebGPU"}`,
    maxTextureSize: device.limits.maxTextureDimension2D,
    timestampQueries: adapter.features.has("timestamp-query"),
    pipelineCompileMs: precompile.durationMs,
    prewarmedPipelines: precompile.count,
    gpuMemory: memory,
  };
  return { diagnostics, memoryBudgetMb: resolveGpuMemoryBudget(preference, memory.device) };
}
