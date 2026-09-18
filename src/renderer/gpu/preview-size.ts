export interface PreviewSizeOptions {
  compositionWidth: number;
  compositionHeight: number;
  quality: number;
  maxDimension?: number;
}

export interface PreviewSize {
  width: number;
  height: number;
  pixelScale: number;
}

const DEFAULT_MAX_DIMENSION = 8_192;

export function calculatePreviewSize(options: PreviewSizeOptions): PreviewSize {
  const compositionWidth = finitePositive(options.compositionWidth, 1);
  const compositionHeight = finitePositive(options.compositionHeight, 1);
  const quality = Math.min(finitePositive(options.quality, 1), 1);
  const maxDimension = Math.max(
    1,
    Math.floor(
      finitePositive(options.maxDimension ?? DEFAULT_MAX_DIMENSION, DEFAULT_MAX_DIMENSION),
    ),
  );
  const requestedWidth = Math.max(1, Math.floor(compositionWidth * quality));
  const requestedHeight = Math.max(1, Math.floor(compositionHeight * quality));
  const largestDimension = Math.max(requestedWidth, requestedHeight);
  const limitScale = largestDimension > maxDimension ? maxDimension / largestDimension : 1;

  return {
    width: Math.max(1, Math.floor(requestedWidth * limitScale)),
    height: Math.max(1, Math.floor(requestedHeight * limitScale)),
    pixelScale: quality * limitScale,
  };
}

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
