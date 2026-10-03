/** Scroll only when the playhead leaves the usable track, with room for the next step. */
export function revealTimelineTime(
  time: number,
  pixelsPerSecond: number,
  scrollLeft: number,
  trackWidth: number,
  duration: number,
): number {
  const width = Math.max(1, trackWidth);
  const margin = Math.min(48, width / 4);
  const position = time * pixelsPerSecond;
  const next =
    position < scrollLeft + margin
      ? position - margin
      : position > scrollLeft + width - margin
        ? position - width + margin
        : scrollLeft;
  return Math.max(0, Math.min(Math.max(0, duration * pixelsPerSecond - width), next));
}

/** Pixels per second; the property column is outside the left edge of the track. */
export function timelineScrubScrollSpeed(
  pointerX: number,
  trackLeft: number,
  trackWidth: number,
): number {
  const edge = Math.min(48, Math.max(0, trackWidth) / 4);
  if (edge === 0) return 0;
  const left = trackLeft + edge;
  const right = trackLeft + trackWidth - edge;
  if (pointerX < left) return -720 * Math.min(1, (left - pointerX) / edge);
  if (pointerX > right) return 720 * Math.min(1, (pointerX - right) / edge);
  return 0;
}
