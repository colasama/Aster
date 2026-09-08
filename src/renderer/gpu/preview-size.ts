export interface PreviewSizeOptions {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
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
  const cssWidth = finitePositive(options.cssWidth, 1);
  const cssHeight = finitePositive(options.cssHeight, 1);
  const deviceScale = Math.min(finitePositive(options.devicePixelRatio, 1), 2);
  const quality = Math.min(finitePositive(options.quality, 1), 1);
  const maxDimension = Math.max(
    1,
    Math.floor(
      finitePositive(options.maxDimension ?? DEFAULT_MAX_DIMENSION, DEFAULT_MAX_DIMENSION),
    ),
  );
  const requestedScale = deviceScale * quality;
  const requestedWidth = Math.max(1, Math.floor(cssWidth * requestedScale));
  const requestedHeight = Math.max(1, Math.floor(cssHeight * requestedScale));
  const largestDimension = Math.max(requestedWidth, requestedHeight);
  const limitScale = largestDimension > maxDimension ? maxDimension / largestDimension : 1;

  return {
    width: Math.max(1, Math.floor(requestedWidth * limitScale)),
    height: Math.max(1, Math.floor(requestedHeight * limitScale)),
    pixelScale: requestedScale * limitScale,
  };
}

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
