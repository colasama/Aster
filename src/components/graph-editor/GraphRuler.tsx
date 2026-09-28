import type { PointerEvent as ReactPointerEvent } from "react";
import type { Translate } from "../../i18n/core";
import { type GraphTimeRange, timeToGraphX } from "./viewport";

const TARGET_TICK_SPACING_PX = 90;
const MAX_TICKS = 200;

/** Evenly spaced 1/2/5 × 10ⁿ second ticks that keep labels roughly a fixed distance apart. */
export function graphRulerTicks(range: GraphTimeRange, widthPx: number): number[] {
  const span = range.end - range.start;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const target = span / Math.max(1, widthPx / TARGET_TICK_SPACING_PX);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= target);
  if (!step) return [];
  const ticks: number[] = [];
  for (
    let time = Math.ceil(range.start / step) * step;
    time <= range.end + step * 1e-6 && ticks.length < MAX_TICKS;
    time += step
  )
    ticks.push(Number(time.toFixed(6)));
  return ticks;
}

export function GraphRuler({
  currentTime,
  onScrubStart,
  t,
  timeRange,
  widthPx,
}: {
  readonly currentTime: number;
  readonly onScrubStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly t: Translate;
  readonly timeRange: GraphTimeRange;
  readonly widthPx: number;
}) {
  const percent = (time: number) => `${(timeToGraphX(time, timeRange) / 1_000) * 100}%`;
  return (
    <div
      aria-label={t("graph.ruler")}
      className="graph-ruler"
      onPointerDown={onScrubStart}
      role="presentation"
    >
      {graphRulerTicks(timeRange, widthPx).map((time) => (
        <span className="graph-ruler-tick" key={time} style={{ left: percent(time) }}>
          {`${time}s`}
        </span>
      ))}
      <i className="graph-ruler-playhead" style={{ left: percent(currentTime) }} />
    </div>
  );
}
