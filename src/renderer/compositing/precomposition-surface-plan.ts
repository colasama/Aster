import type { FlattenedSceneLayer } from "../../core/scene/scene-evaluation";

export const MAX_PRECOMPOSITION_SURFACE_DEPTH = 64;
export const MAX_PRECOMPOSITION_SURFACES = 1024;
export const MAX_PRECOMPOSITION_SURFACE_TEXTURES = 5120;
export const MAX_PRECOMPOSITION_SURFACE_PIXELS = 67_108_864;
export const MAX_PRECOMPOSITION_SURFACE_BYTES = 512 * 1024 * 1024;
export const MAX_PRECOMPOSITION_SURFACE_DIMENSION = 16_384;

const BASE_BYTES_PER_PIXEL = 12; // rgba16float plus depth24plus.
const EFFECT_BYTES_PER_PIXEL = 20; // LayerEffectRenderer ping-pong and depth.

export interface PrecompositionSurfaceBudget {
  surfaces: number;
  textures: number;
  pixels: number;
  bytes: number;
}

export interface PrecompositionSurfaceRequest {
  scene: FlattenedSceneLayer;
  deviceMaxTextureDimension: number;
  memoryBudgetMb?: number;
  hasEffects: boolean;
}

export interface PrecompositionSurfacePlan {
  status: "ready" | "skipped";
  width: number;
  height: number;
  textureCount: number;
  estimatedBytes: number;
  downgraded: boolean;
  diagnostic?: string;
}

export function createPrecompositionSurfaceBudget(): PrecompositionSurfaceBudget {
  return { surfaces: 0, textures: 0, pixels: 0, bytes: 0 };
}

export function planPrecompositionSurface(
  request: PrecompositionSurfaceRequest,
  budget: PrecompositionSurfaceBudget,
): PrecompositionSurfacePlan {
  const surface = request.scene.precompositionSurface;
  if (!surface) return skipped("layer is not a precomposition surface");
  if (surface.compositionPath.includes(surface.composition.id))
    return skipped(`cycle detected at composition ${surface.composition.name}`);
  if (surface.compositionPath.length > MAX_PRECOMPOSITION_SURFACE_DEPTH)
    return skipped(`nesting exceeds depth ${MAX_PRECOMPOSITION_SURFACE_DEPTH}`);
  if (budget.surfaces >= MAX_PRECOMPOSITION_SURFACES)
    return skipped(`surface count exceeds ${MAX_PRECOMPOSITION_SURFACES}`);

  const textureCount = request.hasEffects ? 5 : 2;
  if (budget.textures + textureCount > MAX_PRECOMPOSITION_SURFACE_TEXTURES)
    return skipped(`texture count exceeds ${MAX_PRECOMPOSITION_SURFACE_TEXTURES}`);

  const bytesPerPixel = BASE_BYTES_PER_PIXEL + (request.hasEffects ? EFFECT_BYTES_PER_PIXEL : 0);
  const byteLimit = Math.min(
    MAX_PRECOMPOSITION_SURFACE_BYTES,
    request.memoryBudgetMb === undefined
      ? 256 * 1024 * 1024
      : Math.max(1, request.memoryBudgetMb * 0.35) * 1024 * 1024,
  );
  const remainingPixels = Math.max(
    0,
    Math.floor(
      Math.min(
        MAX_PRECOMPOSITION_SURFACE_PIXELS - budget.pixels,
        (byteLimit - budget.bytes) / bytesPerPixel,
      ),
    ),
  );
  if (remainingPixels < 16 * 16) return skipped("pixel or VRAM budget is exhausted");

  const dimensionLimit = Math.max(
    1,
    Math.min(request.deviceMaxTextureDimension, MAX_PRECOMPOSITION_SURFACE_DIMENSION),
  );
  const sourceWidth = (surface.renderComposition ?? surface.composition).width;
  const sourceHeight = (surface.renderComposition ?? surface.composition).height;
  const dimensionScale = Math.min(1, dimensionLimit / sourceWidth, dimensionLimit / sourceHeight);
  const pixelScale = Math.min(1, Math.sqrt(remainingPixels / (sourceWidth * sourceHeight)));
  const scale = Math.min(dimensionScale, pixelScale);
  if (scale < 1) return skipped("precomposition exceeds the requested resolution or VRAM budget");
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  const pixels = width * height;
  const estimatedBytes = pixels * bytesPerPixel;
  const downgraded = width !== sourceWidth || height !== sourceHeight;
  budget.surfaces += 1;
  budget.textures += textureCount;
  budget.pixels += pixels;
  budget.bytes += estimatedBytes;
  return {
    status: "ready",
    width,
    height,
    textureCount,
    estimatedBytes,
    downgraded,
    diagnostic: downgraded
      ? `${surface.composition.name} surface scaled ${sourceWidth}x${sourceHeight} -> ${width}x${height}`
      : undefined,
  };
}

export function precompositionSurfaceCacheKey(
  scene: FlattenedSceneLayer,
  revision: number,
  width: number,
  height: number,
): string {
  const surface = scene.precompositionSurface;
  if (!surface) throw new Error("Cannot key a non-surface layer");
  return `${revision}:${surface.composition.id}:${surface.time.toFixed(9)}:${width}x${height}`;
}

function skipped(diagnostic: string): PrecompositionSurfacePlan {
  return {
    status: "skipped",
    width: 0,
    height: 0,
    textureCount: 0,
    estimatedBytes: 0,
    downgraded: false,
    diagnostic,
  };
}
