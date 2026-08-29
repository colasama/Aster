import { auxiliaryRenderPassBytes, planAuxiliaryBuffers } from "./render-buffers";

export type DepthOfFieldSurfaceTier = -1 | 0 | 1 | 2;

export interface AuxiliarySurfaceAllocation {
  bytes: number;
  depthOfFieldTier: DepthOfFieldSurfaceTier;
  diagnostic?: string;
}

const K1_BYTES_PER_PIXEL = 16;
const K2_BYTES_PER_PIXEL = 36;

/** Selects the highest bounded transparency tier that fits before any GPU allocation. */
export function planAuxiliarySurfaceAllocation(
  width: number,
  height: number,
  byteBudget: number,
  depthOfField: boolean,
  reservedBytes = 0,
): AuxiliarySurfaceAllocation | undefined {
  const plan = planAuxiliaryBuffers(width, height);
  const baseBytes = auxiliaryRenderPassBytes(plan);
  const available = Math.max(0, byteBudget - Math.max(0, reservedBytes));
  if (baseBytes > available) return undefined;
  if (!depthOfField) return { bytes: baseBytes, depthOfFieldTier: -1 };
  const k2Bytes = baseBytes + plan.width * plan.height * K2_BYTES_PER_PIXEL;
  if (k2Bytes <= available) return { bytes: k2Bytes, depthOfFieldTier: 2 };
  const k1Bytes = baseBytes + plan.width * plan.height * K1_BYTES_PER_PIXEL;
  if (k1Bytes <= available)
    return {
      bytes: k1Bytes,
      depthOfFieldTier: 1,
      diagnostic: "K1 DOF: front color/depth is exact; deeper transparency uses aggregate depth",
    };
  return {
    bytes: baseBytes,
    depthOfFieldTier: 0,
    diagnostic: "K0 DOF: canonical beauty uses primary depth without transparent layer separation",
  };
}

export function auxiliaryDepthOfFieldSurfaceBytes(width: number, height: number): number {
  const plan = planAuxiliaryBuffers(width, height);
  return auxiliaryRenderPassBytes(plan) + plan.width * plan.height * K2_BYTES_PER_PIXEL;
}

export function productionDepthOfFieldAllocationError(
  depthOfField: boolean,
  tier: DepthOfFieldSurfaceTier,
  diagnostic?: string,
): string | undefined {
  if (!depthOfField || tier === 2) return undefined;
  return `Production depth of field requires K2 transparent surfaces; ${diagnostic ?? "the required GPU resources are unavailable"}`;
}
