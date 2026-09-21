export const TIMELINE_LABEL_WIDTH = 286;
export const TIMELINE_BASE_SCALE = 82;
export const TIMELINE_FRAME_WIDTH = 24;

export function timelineZoomBounds(duration: number, frameDuration: number, width = 1) {
  const min = Math.max(1, width) / (duration * TIMELINE_BASE_SCALE);
  return { min, max: Math.max(min, TIMELINE_FRAME_WIDTH / frameDuration / TIMELINE_BASE_SCALE) };
}

export function timelineTicks(
  duration: number,
  frameDuration: number,
  pixelsPerSecond: number,
  scrollLeft: number,
  width: number,
) {
  const framesPerSecond = 1 / frameDuration;
  const minimumFrames = 72 / (pixelsPerSecond * frameDuration);
  const intervals = [1, 2, 5, 10, 15];
  for (const seconds of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]) {
    intervals.push(Math.max(1, Math.round(seconds * framesPerSecond)));
  }
  const majorFrames =
    intervals.sort((a, b) => a - b).find((frames) => frames >= minimumFrames) ??
    Math.ceil(minimumFrames / framesPerSecond / 3600) * Math.round(framesPerSecond * 3600);
  const minorFrames =
    majorFrames % 5 === 0 ? majorFrames / 5 : majorFrames % 2 === 0 ? majorFrames / 2 : majorFrames;
  const interval = minorFrames * frameDuration;
  const start = Math.max(
    0,
    Math.floor((scrollLeft - TIMELINE_LABEL_WIDTH) / pixelsPerSecond / interval),
  );
  const end = Math.min(
    Math.floor(duration / interval),
    Math.ceil((scrollLeft + width - TIMELINE_LABEL_WIDTH) / pixelsPerSecond / interval),
  );
  return {
    interval,
    showFrames: majorFrames < framesPerSecond,
    ticks: Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
      const index = start + offset;
      return { time: index * interval, major: (index * minorFrames) % majorFrames === 0 };
    }),
  };
}
