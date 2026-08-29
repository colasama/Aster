import { useEffect, useRef } from "react";
import { sharedAudioPlaybackEngine } from "../core/audio-playback-engine";
import type { FootageSource, Layer } from "../core/types";

export function AudioWaveform({
  layer,
  pixelsPerSecond,
  source,
}: {
  layer: Layer;
  pixelsPerSecond: number;
  source: FootageSource;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const duration = Math.max(1 / 240, layer.outPoint - layer.inPoint);
  const width = Math.max(1, Math.round(duration * pixelsPerSecond));
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    const binCount = waveformBinCount(width);
    void sharedAudioPlaybackEngine
      .waveformPeaks(source, binCount, controller.signal)
      .then((peaks) => {
        if (controller.signal.aborted) return;
        drawWaveform(canvas, peaks, layer.audio?.reversed === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [layer.audio?.reversed, source, width]);
  return (
    <canvas
      className="timeline-audio-waveform"
      ref={canvasRef}
      style={{ left: layer.inPoint * pixelsPerSecond, width }}
    />
  );
}

function waveformBinCount(width: number): number {
  const target = Math.max(64, Math.min(4_096, width));
  return 2 ** Math.round(Math.log2(target));
}

function drawWaveform(canvas: HTMLCanvasElement, peaks: Float32Array, reversed: boolean): void {
  const logicalWidth = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
  const logicalHeight = 28;
  const scale = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
  canvas.width = Math.round(logicalWidth * scale);
  canvas.height = Math.round(logicalHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, logicalWidth, logicalHeight);
  context.strokeStyle = "rgba(104, 211, 255, 0.82)";
  context.lineWidth = 1;
  context.beginPath();
  const binCount = peaks.length / 4;
  for (let x = 0; x < logicalWidth; x += 1) {
    const normalized = logicalWidth === 1 ? 0 : x / (logicalWidth - 1);
    const logicalBin = Math.min(binCount - 1, Math.floor(normalized * binCount));
    const bin = reversed ? binCount - 1 - logicalBin : logicalBin;
    const minimum = Math.max(-1, peaks[bin * 4]);
    const maximum = Math.min(1, peaks[bin * 4 + 1]);
    context.moveTo(x + 0.5, (1 - maximum) * logicalHeight * 0.5);
    context.lineTo(x + 0.5, (1 - minimum) * logicalHeight * 0.5);
  }
  context.stroke();
}
