import type { CSSProperties } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { cachedFrameRanges, previewFrameCache } from "../../core/rendering/preview-frame-cache";
import type { Composition } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { compositionFrameDuration } from "./timeline-interactions";

/** Runs of finished frames the preview can replay without rendering, drawn under the ruler. */
export function TimelineFrameCache({ composition }: { composition: Composition }) {
  const { t } = useI18n();
  useSyncExternalStore(
    (listener) => previewFrameCache.subscribe(listener),
    () => previewFrameCache.revision,
  );
  const frames = previewFrameCache.cachedFrames(composition.id);
  const ranges = useMemo(() => cachedFrameRanges(frames), [frames]);
  const frameDuration = compositionFrameDuration(composition);
  return ranges.map((range) => (
    <div
      aria-hidden="true"
      className="timeline-cache-range"
      key={range.start}
      style={
        {
          "--timeline-t": range.start * frameDuration,
          "--timeline-d": range.count * frameDuration,
        } as CSSProperties
      }
      title={t("timeline.frameCache")}
    />
  ));
}
