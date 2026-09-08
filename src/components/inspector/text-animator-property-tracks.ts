import {
  collectTextAnimatorTrackEntries,
  type TextAnimatorPropertyEntry,
  type TextSelectorPropertyEntry,
} from "../../core/animation/text-animator-property-paths";
import type { TextSelector } from "../../core/animation/text-selectors";
import type { Layer } from "../../core/types";
import type { PlainMessageKey } from "../../i18n/core";
import type {
  TimelinePropertyGroup,
  TransformTimelinePropertyTrack,
} from "../timeline/timeline-property-tracks";

interface NumericTrackPresentation {
  labelKey: PlainMessageKey;
  labelSuffix?: string;
  max?: number;
  min?: number;
  spatialGroup?: string;
  spatialSpeedLabelKey?: PlainMessageKey;
  step: number;
  unit: string;
}

/** Builds stable-ID text tracks matching the Animator > Selector hierarchy. */
export function collectTextAnimatorTimelineGroups(layer: Layer): TimelinePropertyGroup[] {
  if (!layer.textAnimator) return [];
  const entries = collectTextAnimatorTrackEntries(layer);
  return layer.textAnimator.groups.flatMap((group) => {
    const propertyTracks = entries.flatMap((entry) =>
      entry.source === "property" && entry.groupId === group.id
        ? [{ ...timelineTrack(entry, propertyPresentation(entry)), labelPrefix: group.name }]
        : [],
    );
    const propertyGroup: TimelinePropertyGroup[] = propertyTracks.length
      ? [
          {
            id: `textAnimator:${group.id}:properties`,
            label: group.name,
            source: "transform",
            tracks: propertyTracks,
          },
        ]
      : [];
    const selectors = group.selectors.flatMap((selector) => {
      const selectorTracks = entries.flatMap((entry) =>
        entry.source === "selector" &&
        entry.groupId === group.id &&
        entry.selectorId === selector.id
          ? [
              {
                ...timelineTrack(entry, selectorPresentation(selector, entry)),
                labelPrefix: `${group.name} · ${selector.name}`,
              },
            ]
          : [],
      );
      return selectorTracks.length
        ? [
            {
              id: `textAnimator:${group.id}:selector:${selector.id}`,
              label: `${group.name} · ${selector.name}`,
              source: "transform" as const,
              tracks: selectorTracks,
            },
          ]
        : [];
    });
    return [...propertyGroup, ...selectors];
  });
}

function timelineTrack(
  entry: TextAnimatorPropertyEntry | TextSelectorPropertyEntry,
  presentation: NumericTrackPresentation,
): TransformTimelinePropertyTrack {
  return {
    source: "transform",
    id: entry.path,
    path: entry.path,
    property: entry.property,
    ...presentation,
  };
}

function propertyPresentation(entry: TextAnimatorPropertyEntry): NumericTrackPresentation {
  const labelKey = `text.property.${entry.field}` as PlainMessageKey;
  const labelSuffix = componentLabel(entry.field, entry.component);
  const common = { labelKey, ...(labelSuffix ? { labelSuffix } : {}) };
  if (entry.field === "anchorPoint" || entry.field === "position")
    return {
      ...common,
      step: 0.1,
      unit: "px",
      min: -8192,
      max: 8192,
      spatialGroup: `textAnimator:${entry.groupId}:${entry.field}`,
      spatialSpeedLabelKey:
        entry.field === "position" ? "graph.track.positionSpeed" : "graph.track.anchorSpeed",
    };
  if (entry.field === "scale")
    return { ...common, step: 0.1, unit: "%", min: -10_000, max: 10_000 };
  if (entry.field === "rotation")
    return { ...common, step: 0.1, unit: "°", min: -36_000, max: 36_000 };
  if (entry.field === "skew" || entry.field === "skewAxis")
    return { ...common, step: 0.1, unit: "°", min: -360, max: 360 };
  if (entry.field === "opacity") return { ...common, step: 1, unit: "%", min: 0, max: 100 };
  if (entry.field === "fillColor" || entry.field === "strokeColor")
    return { ...common, step: 0.01, unit: "", min: 0, max: 1 };
  if (entry.field === "strokeWidth")
    return { ...common, step: 0.1, unit: "px", min: -4096, max: 4096 };
  if (entry.field === "tracking")
    return { ...common, step: 0.1, unit: "px", min: -10_000, max: 10_000 };
  if (entry.field === "lineAnchor") return { ...common, step: 1, unit: "%", min: 0, max: 100 };
  if (entry.field === "lineSpacing")
    return { ...common, step: 0.1, unit: "px", min: -8192, max: 8192 };
  if (entry.field === "characterOffset")
    return { ...common, step: 1, unit: "", min: -0x10ffff, max: 0x10ffff };
  if (entry.field === "characterValue")
    return { ...common, step: 1, unit: "", min: 0, max: 0x10ffff };
  return { ...common, step: 0.1, unit: "px", min: 0, max: 4096 };
}

function selectorPresentation(
  selector: TextSelector,
  entry: TextSelectorPropertyEntry,
): NumericTrackPresentation {
  const common = { labelKey: `text.selector.${entry.field}` as PlainMessageKey };
  if (entry.field === "start" || entry.field === "end" || entry.field === "offset")
    return {
      ...common,
      step: 1,
      unit: selector.kind === "range" && selector.units === "percentage" ? "%" : "",
      min: -1_000_000,
      max: 1_000_000,
    };
  if (entry.field === "smoothness") return { ...common, step: 1, unit: "%", min: 0, max: 100 };
  if (
    entry.field === "amount" ||
    entry.field === "easeHigh" ||
    entry.field === "easeLow" ||
    entry.field === "minimumAmount" ||
    entry.field === "maximumAmount"
  )
    return { ...common, step: 1, unit: "%", min: -100, max: 100 };
  if (entry.field === "wigglesPerSecond")
    return { ...common, step: 0.1, unit: "Hz", min: 0, max: 100 };
  if (entry.field === "correlation") return { ...common, step: 1, unit: "%", min: 0, max: 100 };
  return { ...common, step: 0.1, unit: "°", min: -1_000_000, max: 1_000_000 };
}

function componentLabel(
  field: TextAnimatorPropertyEntry["field"],
  component: number | undefined,
): string | undefined {
  if (component === undefined) return undefined;
  if (field === "fillColor" || field === "strokeColor") return ["R", "G", "B", "A"][component];
  return ["X", "Y", "Z"][component];
}
