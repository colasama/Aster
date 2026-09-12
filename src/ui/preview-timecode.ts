import { frameAt } from "../core/animation/timeline";

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

/** Non-drop-frame HH:MM:SS:FF, frame counts (42f), or seconds (1.5s). */
export function parsePreviewTimecode(
  text: string,
  rate: { numerator: number; denominator: number },
): number | undefined {
  const fps = rate.numerator / rate.denominator;
  if (!Number.isFinite(fps) || fps <= 0) return undefined;
  const value = text.trim();
  const frames = /^(\d+)f$/i.exec(value);
  if (frames) return Number(frames[1]) / fps;
  if (/^\d+(\.\d+)?s?$/i.test(value))
    return Math.round(Number(value.replace(/s$/i, "")) * fps) / fps;
  const parts = /^(\d{1,6}):([0-5]\d):([0-5]\d):(\d{2,3})$/.exec(value);
  if (!parts || Number(parts[4]) >= Math.round(fps)) return undefined;
  const frame =
    ((Number(parts[1]) * 60 + Number(parts[2])) * 60 + Number(parts[3])) * Math.round(fps) +
    Number(parts[4]);
  return frame / fps;
}
