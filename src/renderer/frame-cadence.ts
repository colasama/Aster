/** Idle gaps are not frames; main-thread stalls during playback are. */
export function frameCadenceSample(intervalMs: number, continuousPlayback: boolean): number {
  return intervalMs > 100 && !continuousPlayback ? 16.67 : Math.max(intervalMs, 0.1);
}
