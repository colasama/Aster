import { Box, Eye, Lock, Volume2, Wind } from "lucide-react";
import { useMemo } from "react";
import {
  compositionMotionBlurSettings,
  motionBlurInterval,
} from "../../core/animation/motion-blur";
import { activeComposition } from "../../core/project/project";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { TIMELINE_LABEL_WIDTH, timelineTicks } from "../../ui/timeline-zoom";
import type { useWindowPointerDrag } from "../use-window-pointer-drag";
import { TimelineWorkArea } from "./TimelineWorkArea";
import { formatSeconds, formatTimecode } from "./timeline-display";
import {
  compositionFrameDuration,
  type TimelineWorkArea as WorkArea,
} from "./timeline-interactions";

export function TimelineRuler({
  pixelsPerSecond,
  viewport,
  scrub,
  startPointerDrag,
  setWorkArea,
}: {
  pixelsPerSecond: number;
  viewport: { width: number; scrollLeft: number };
  scrub: (clientX: number, bypassSnap: boolean) => void;
  startPointerDrag: ReturnType<typeof useWindowPointerDrag>["start"];
  setWorkArea: (value: WorkArea) => void;
}) {
  const { state } = useEditor();
  const composition = activeComposition(state.project);
  const { t } = useI18n();
  const frameDuration = compositionFrameDuration(composition);
  const motionBlur = compositionMotionBlurSettings(composition);
  const shutter = motionBlurInterval(state.currentTime, 1 / frameDuration, motionBlur);
  const ruler = useMemo(
    () =>
      timelineTicks(
        composition.duration,
        frameDuration,
        pixelsPerSecond,
        viewport.scrollLeft,
        viewport.width,
      ),
    [composition.duration, frameDuration, pixelsPerSecond, viewport.scrollLeft, viewport.width],
  );
  return (
    <div className="timeline-header">
      <div className="layer-column-header">
        <span>{t("timeline.sourceName")}</span>
        <div>
          <Eye size={11} />
          <Volume2 size={11} />
          <Lock size={11} />
          <Box size={11} />
          <Wind size={11} />
        </div>
      </div>
      <div
        className="time-ruler"
        style={{ left: TIMELINE_LABEL_WIDTH, width: composition.duration * pixelsPerSecond }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          scrub(event.clientX, event.ctrlKey || event.metaKey);
          startPointerDrag(event.pointerId, {
            onMove: (moveEvent) => scrub(moveEvent.clientX, moveEvent.ctrlKey || moveEvent.metaKey),
            onCommit: () => undefined,
          });
        }}
      >
        {motionBlur.enabled && motionBlur.shutterAngle > 0 && state.timelineZoom >= 1.25 && (
          <div
            aria-hidden="true"
            className="timeline-shutter-region"
            style={{
              left: shutter.openTime * pixelsPerSecond,
              width: Math.max(1, shutter.duration * pixelsPerSecond),
            }}
            title={t("timeline.motionBlur.shutterRegion")}
          />
        )}
        {ruler.ticks.map(({ time, major }) => (
          <div
            className={major ? "major tick" : "tick"}
            key={time}
            style={{ left: time * pixelsPerSecond }}
          >
            <span>
              {major
                ? ruler.showFrames
                  ? formatTimecode(time, composition.frameRate).slice(6)
                  : formatSeconds(time)
                : ""}
            </span>
          </div>
        ))}
        <TimelineWorkArea
          duration={composition.duration}
          frameDuration={frameDuration}
          onChange={setWorkArea}
          pixelsPerSecond={pixelsPerSecond}
          startPointerDrag={startPointerDrag}
          value={composition.workArea}
        />
      </div>
      <div className="playhead">
        <span />
      </div>
    </div>
  );
}
