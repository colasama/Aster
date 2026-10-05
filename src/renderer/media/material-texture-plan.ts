import type { EnvironmentLighting, Layer } from "../../core/types";

export interface MaterialTexturePlan {
  active: boolean;
  normalEnabled: boolean;
  normalScale: number;
  environmentIntensity: number;
  environmentRotation: number;
}

/** Prepared values and resource hashes; no authoring objects reach the draw consumer. */
export interface MaterialBindingPlan extends MaterialTexturePlan {
  instanceId: string;
  normalHash: string | null;
  environmentHash: string | null;
}

export function planMaterialTextures(
  layer: Layer,
  environment: EnvironmentLighting | undefined,
  normalReady: boolean,
  environmentReady: boolean,
): MaterialTexturePlan {
  const normal = layer.kind === "mesh" ? layer.mesh?.materialTextures?.normal : undefined;
  const normalEnabled = Boolean(normal && normalReady);
  const environmentIntensity =
    environment?.enabled && environmentReady ? clampFinite(environment.intensity, 0, 32, 1) : 0;
  return {
    active: normalEnabled || environmentIntensity > 0,
    normalEnabled,
    normalScale: clampFinite(normal?.scale ?? 1, -8, 8, 1),
    environmentIntensity,
    environmentRotation: wrapDegrees(environment?.rotation ?? 0) / 360,
  };
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function wrapDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}
