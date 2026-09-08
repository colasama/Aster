import { frameAt } from "../../core/animation/timeline";

export function formatTimecode(
  time: number,
  frameRate: { numerator: number; denominator: number },
): string {
  const totalFrames = frameAt(time, frameRate);
  const fps = Math.round(frameRate.numerator / frameRate.denominator);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

export const formatSeconds = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, "0")}`;

export function toggleTimelineFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else {
    const panel = document.querySelector<HTMLElement>(".timeline-panel");
    if (panel) void panel.requestFullscreen();
  }
}

export function rowAtClientY(canvas: HTMLElement, clientY: number, fallback: number): number {
  const rows = [...canvas.querySelectorAll<HTMLElement>("[data-timeline-row]")];
  for (const row of rows) {
    const bounds = row.getBoundingClientRect();
    if (clientY >= bounds.top && clientY <= bounds.bottom)
      return Number(row.dataset.timelineRow ?? fallback);
  }
  const first = rows[0]?.getBoundingClientRect();
  if (first && clientY < first.top) return 0;
  return rows.length ? rows.length - 1 : fallback;
}
