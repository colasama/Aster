export type GpuMemoryPressure = "normal" | "warning" | "critical";

export interface GpuMemoryPlan {
  budgetMb: number;
  estimatedBytes: number;
  pressure: GpuMemoryPressure;
  shadowMapSize: number;
}

interface GpuMemoryRequest {
  width: number;
  height: number;
  effectTextureBytes: number;
  persistentBufferBytes: number;
  requestedShadowMapSize: number;
  budgetMb?: number;
}

const AUTO_BUDGET_MB = 512;

export function planGpuMemory(request: GpuMemoryRequest): GpuMemoryPlan {
  const budgetMb = request.budgetMb ?? AUTO_BUDGET_MB;
  const budgetBytes = budgetMb * 1024 * 1024;
  const baseBytes =
    request.width * request.height * (8 + 4) +
    request.effectTextureBytes +
    request.persistentBufferBytes;
  const candidates = [2048, 1024, 512, 1].filter(
    (size) => size <= Math.max(1, request.requestedShadowMapSize),
  );
  const shadowMapSize =
    candidates.find((size) => baseBytes + shadowBytes(size) <= budgetBytes * 0.85) ?? 1;
  const estimatedBytes = baseBytes + shadowBytes(shadowMapSize);
  const ratio = estimatedBytes / budgetBytes;
  return {
    budgetMb,
    estimatedBytes,
    pressure: ratio > 1 ? "critical" : ratio >= 0.85 ? "warning" : "normal",
    shadowMapSize,
  };
}

function shadowBytes(size: number): number {
  return size <= 1 ? 4 : size * size * 4;
}
