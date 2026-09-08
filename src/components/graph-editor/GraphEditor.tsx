import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphSampleBuffer } from "../../core/animation/graph-sampling";
import {
  copyKeyframes,
  type KeyframeClipboard,
  pasteKeyframes,
  removeKeyframes,
} from "../../core/animation/keyframe-editing";
import { activeComposition } from "../../core/project/project";
import type { Keyframe } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useContextMenuTrigger } from "../context-menu/use-context-menu-trigger";
import {
  constrainGraphPasteOperations,
  deduplicateGraphEntries,
  expandSpatialGraphEntries,
  graphEaseOperations,
  graphEditableKeyframe,
  graphInterpolationOperations,
  graphTargetEditableKeyframe,
  graphTrackOwnsEntry,
  graphUpdateOperations,
} from "./editing";
import { GraphContextMenu } from "./GraphContextMenu";
import { GraphSidebar, GraphToolbar } from "./GraphControls";
import { GraphPlot } from "./GraphPlot";
import {
  collectAnimatedGraphTracks,
  constrainGraphTrackValue,
  easingFromGraphSpeedHandle,
  type GraphCurve,
  type GraphEasingPreview,
  type GraphKeyframePreview,
  type GraphTrack,
  type GraphType,
  graphCurveRange,
  graphDraggedKeyframeValue,
  graphTrackInterpolation,
  graphTrackKeyframesAtTime,
  graphTrackLabelKey,
  graphTrackSegmentBaseSpeed,
  graphTrackSegmentKeyframes,
  graphTracksForType,
  previewGraphTrack,
  resolveGraphType,
  sampleGraphTrack,
} from "./model";
import {
  addWindowPointerListeners,
  clientGraphPoint,
  keyframePoint,
  removeWindowPointerListeners,
  signedNonZero,
} from "./pointer";
import {
  fitGraphTimeRange,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  type GraphTimeRange,
  type GraphValueRange,
  graphMarkerRadii,
  graphXToTime,
  graphYToValue,
  panGraphTimeRange,
  panGraphValueRange,
  snapGraphTime,
  zoomGraphTimeRange,
  zoomGraphValueRange,
} from "./viewport";

const POINTER_EPSILON = 0.000_001;
type OwnedGraphTrack = GraphTrack & {
  ownerLayerId: string;
  ownerLayerName: string;
  sourceTrackId: string;
};

export { graphMarkerRadii } from "./viewport";

export function GraphEditor() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const sampleBuffers = useRef(new Map<string, GraphSampleBuffer>());
  const gridId = useId().replace(/:/g, "");
  const composition = activeComposition(state.project);
  const selectedLayers = useMemo(
    () =>
      state.selection.flatMap((id) => {
        const layer = composition.layers.find((entry) => entry.id === id);
        return layer ? [layer] : [];
      }),
    [composition.layers, state.selection],
  );
  const layer = selectedLayers[0];
  const resetKey = `${selectedLayers.map((entry) => entry.id).join(":")}:${composition.duration}`;
  const resetKeyRef = useRef(resetKey);
  const tracks = useMemo<OwnedGraphTrack[]>(
    () =>
      selectedLayers.flatMap((owner) =>
        collectAnimatedGraphTracks(owner).map((track) => ({
          ...track,
          id: `${owner.id}:${track.id}`,
          sourceTrackId: track.id,
          ownerLayerId: owner.id,
          ownerLayerName: owner.name,
        })),
      ),
    [selectedLayers],
  );
  const trackOwners = useMemo(
    () => tracks.map((track) => ({ layerId: track.ownerLayerId, track })),
    [tracks],
  );
  const [graphType, setGraphType] = useState<GraphType>("auto");
  const [showReferenceGraph, setShowReferenceGraph] = useState(false);
  const [showLayerBounds, setShowLayerBounds] = useState(true);
  const [allowBetweenFrames, setAllowBetweenFrames] = useState(false);
  const [keyframeClipboard, setKeyframeClipboard] = useState<KeyframeClipboard>();
  const contextMenu = useContextMenuTrigger();
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(() => new Set());
  const [timeRange, setTimeRange] = useState<GraphTimeRange>(() => ({
    start: 0,
    end: Math.max(composition.duration, Number.EPSILON),
  }));
  const [manualValueRange, setManualValueRange] = useState<GraphValueRange>({ min: -1, max: 1 });
  const [autoZoomHeight, setAutoZoomHeight] = useState(true);
  const [keyframePreview, setKeyframePreview] = useState<GraphKeyframePreview>();
  const [easingPreview, setEasingPreview] = useState<GraphEasingPreview>();
  const [selectedKeyframeOwners, setSelectedKeyframeOwners] = useState<Record<string, string>>({});
  const [viewportSize, setViewportSize] = useState({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
  const frameDuration = composition.frameRate.denominator / composition.frameRate.numerator;

  useEffect(() => {
    setSelectedKeyframeOwners((current) => {
      const selected = new Set(state.selectedKeyframes);
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => selected.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [state.selectedKeyframes]);

  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    sampleBuffers.current.clear();
    setHiddenTracks(new Set());
    setTimeRange({ start: 0, end: Math.max(composition.duration, Number.EPSILON) });
    setAutoZoomHeight(true);
    setKeyframePreview(undefined);
    setEasingPreview(undefined);
    setSelectedKeyframeOwners({});
  }, [composition.duration, resetKey]);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateViewportSize = () => {
      const { width, height } = svg.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setViewportSize((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const displayedTracks = useMemo(
    () => tracks.map((track) => previewGraphTrack(track, keyframePreview, easingPreview)),
    [easingPreview, keyframePreview, tracks],
  );
  const activeTracks = useMemo(
    () => graphTracksForType(displayedTracks, graphType),
    [displayedTracks, graphType],
  );
  const visibleTracks = useMemo(
    () => activeTracks.filter((track) => !hiddenTracks.has(track.id)),
    [activeTracks, hiddenTracks],
  );
  const sidebarTracks = useMemo(() => graphTracksForType(tracks, graphType), [graphType, tracks]);
  const visibleTrackIds = useMemo(
    () =>
      new Set(
        graphTracksForType(tracks, graphType)
          .filter((track) => !hiddenTracks.has(track.id))
          .map((track) => track.id),
      ),
    [graphType, hiddenTracks, tracks],
  );
  const curves = useMemo(
    () =>
      visibleTracks.map((track) => {
        const curve = sampleGraphTrack(
          track,
          graphType,
          timeRange.start,
          timeRange.end,
          Math.max(1, viewportSize.width),
          sampleBuffers.current.get(track.id),
          Math.max(1, viewportSize.height),
        );
        sampleBuffers.current.set(track.id, curve.samples);
        return curve;
      }),
    [
      graphType,
      timeRange.end,
      timeRange.start,
      viewportSize.height,
      viewportSize.width,
      visibleTracks,
    ],
  );
  const referenceCurves = useMemo(
    () =>
      showReferenceGraph
        ? visibleTracks.map((track) => {
            const primary = resolveGraphType(graphType, track);
            return sampleGraphTrack(
              track,
              primary === "value" ? "speed" : "value",
              timeRange.start,
              timeRange.end,
              Math.max(1, viewportSize.width),
              undefined,
              Math.max(1, viewportSize.height),
            );
          })
        : [],
    [
      graphType,
      showReferenceGraph,
      timeRange.end,
      timeRange.start,
      viewportSize.height,
      viewportSize.width,
      visibleTracks,
    ],
  );
  const sampledValueRange = useMemo(() => graphCurveRange(curves), [curves]);
  const referenceValueRange = useMemo(() => graphCurveRange(referenceCurves), [referenceCurves]);
  const valueRange = autoZoomHeight ? sampledValueRange : manualValueRange;
  const keyRadii = graphMarkerRadii(viewportSize.width, viewportSize.height, 5);
  const handleRadii = graphMarkerRadii(viewportSize.width, viewportSize.height, 4);
  const pixelsPerSecond = viewportSize.width / Math.max(timeRange.end - timeRange.start, 1e-9);
  const graphSnapTargets = useMemo(
    () => [
      0,
      composition.duration,
      composition.workArea.start,
      composition.workArea.end,
      ...selectedLayers.flatMap((entry) => [entry.inPoint, entry.outPoint]),
      ...visibleTracks.flatMap((track) =>
        track.property.keyframes.map((keyframe) => keyframe.time),
      ),
    ],
    [
      composition.duration,
      composition.workArea.end,
      composition.workArea.start,
      selectedLayers,
      visibleTracks,
    ],
  );
  const visibleSelectedEntries = useMemo(
    () =>
      tracks.flatMap((track) =>
        visibleTrackIds.has(track.id)
          ? track.property.keyframes
              .filter(
                (keyframe) =>
                  state.selectedKeyframes.includes(keyframe.id) &&
                  (!selectedKeyframeOwners[keyframe.id] ||
                    selectedKeyframeOwners[keyframe.id] === track.id),
              )
              .map((keyframe) => graphEditableKeyframe(track.ownerLayerId, track, keyframe))
          : [],
      ),
    [selectedKeyframeOwners, state.selectedKeyframes, tracks, visibleTrackIds],
  );
  const selectedEntries = useMemo(
    () => expandSpatialGraphEntries(visibleSelectedEntries, trackOwners, graphType),
    [graphType, trackOwners, visibleSelectedEntries],
  );
  const canEditSelection = Boolean(
    selectedEntries.length &&
      selectedEntries.every(
        (entry) => !composition.layers.find((candidate) => candidate.id === entry.layerId)?.locked,
      ),
  );
  const canPasteClipboard =
    Boolean(keyframeClipboard) &&
    Boolean(
      keyframeClipboard?.entries.every((entry) => {
        const target = composition.layers.find((candidate) => candidate.id === entry.layerId);
        if (!target || target.locked) return false;
        if (entry.source === "transform") return true;
        return Boolean(
          target.effects.some(
            (effect) =>
              effect.id === entry.effectId &&
              (entry.parameter in effect.parameters ||
                entry.parameter in (effect.parameterKeyframes ?? {})),
          ),
        );
      }),
    );

  const updateKeyframe = (
    track: OwnedGraphTrack,
    keyframe: Keyframe,
    time: number,
    value: number,
    easing = keyframe.easing,
    interpolation = keyframe.interpolation,
  ) => {
    const owner = composition.layers.find((candidate) => candidate.id === track.ownerLayerId);
    if (!owner || owner.locked) return;
    const nextInterpolation = graphTrackInterpolation(track, interpolation);
    const entry = graphEditableKeyframe(owner.id, track, keyframe);
    dispatch({
      type: "operation",
      operations: graphUpdateOperations(entry, {
        ...keyframe,
        time,
        value: constrainGraphTrackValue(track, value),
        interpolation: nextInterpolation,
        easing: nextInterpolation === "bezier" ? easing : undefined,
      }),
    });
  };

  const scrub = (svg: SVGSVGElement, clientX: number, bypass: boolean) => {
    const bounds = svg.getBoundingClientRect();
    const point = clientGraphPoint(svg, clientX, bounds.top);
    const time = snapGraphTime(
      graphXToTime(point.x, timeRange),
      frameDuration,
      state.currentTime,
      pixelsPerSecond,
      bypass,
      graphSnapTargets,
      allowBetweenFrames,
    );
    dispatch({ type: "setTime", time: Math.max(0, Math.min(composition.duration, time)) });
  };

  const startSurfacePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    if (event.button === 1 || (event.button === 0 && event.altKey)) {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const initialTime = timeRange;
      const initialValue = valueRange;
      const startX = event.clientX;
      const startY = event.clientY;
      const move = (moveEvent: PointerEvent) => {
        const timeDelta =
          (-(moveEvent.clientX - startX) / Math.max(1, bounds.width)) *
          (initialTime.end - initialTime.start);
        const valueDelta =
          ((moveEvent.clientY - startY) / Math.max(1, bounds.height)) *
          (initialValue.max - initialValue.min);
        setTimeRange(panGraphTimeRange(initialTime, timeDelta, composition.duration));
        if (Math.abs(valueDelta) > POINTER_EPSILON) {
          setAutoZoomHeight(false);
          setManualValueRange(panGraphValueRange(initialValue, valueDelta));
        }
      };
      const end = () => removeWindowPointerListeners(move, end);
      addWindowPointerListeners(move, end);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    scrub(svg, event.clientX, event.ctrlKey || event.metaKey);
    const move = (moveEvent: PointerEvent) =>
      scrub(svg, moveEvent.clientX, moveEvent.ctrlKey || moveEvent.metaKey);
    const end = () => removeWindowPointerListeners(move, end);
    addWindowPointerListeners(move, end);
  };

  const startKeyframeDrag = (
    event: React.PointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    const owner = sourceTrack
      ? composition.layers.find((candidate) => candidate.id === sourceTrack.ownerLayerId)
      : undefined;
    if (!svg || !sourceTrack || !owner || owner.locked) return;
    const selectedOwner = selectedKeyframeOwners[keyframe.id];
    const alreadySelected =
      state.selectedKeyframes.includes(keyframe.id) &&
      (!selectedOwner || selectedOwner === sourceTrack.id);
    if (event.shiftKey) {
      setSelectedKeyframeOwners((current) => {
        const next = { ...current };
        if (alreadySelected) delete next[keyframe.id];
        else next[keyframe.id] = sourceTrack.id;
        return next;
      });
      dispatch({
        type: "selectKeyframes",
        ids: alreadySelected
          ? state.selectedKeyframes.filter((id) => id !== keyframe.id)
          : [...state.selectedKeyframes, keyframe.id],
      });
      return;
    }
    if (!alreadySelected) {
      setSelectedKeyframeOwners({ [keyframe.id]: sourceTrack.id });
      dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
    }
    const selectedForDrag = alreadySelected
      ? selectedEntries.filter(
          (entry) =>
            !composition.layers.find((candidate) => candidate.id === entry.layerId)?.locked,
        )
      : [graphEditableKeyframe(owner.id, sourceTrack, keyframe)];
    const draggedEntries =
      curve.type === "speed" && sourceTrack.spatialProperties
        ? deduplicateGraphEntries(
            selectedForDrag.flatMap((entry) =>
              graphTrackOwnsEntry(sourceTrack, entry)
                ? graphTrackKeyframesAtTime(sourceTrack, entry.keyframe.time).map((target) =>
                    graphTargetEditableKeyframe(owner.id, target),
                  )
                : [entry],
            ),
          )
        : selectedForDrag;
    const draggedTimes = new Set(draggedEntries.map((entry) => entry.keyframe.time));
    const dragSnapTargets = graphSnapTargets.filter((target) => !draggedTimes.has(target));
    let next = {
      trackId: sourceTrack.id,
      keyframeId: keyframe.id,
      time: keyframe.time,
      value: keyframe.value,
    } satisfies GraphKeyframePreview;
    const move = (moveEvent: PointerEvent) => {
      const point = clientGraphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      next = {
        ...next,
        time: Math.max(
          0,
          Math.min(
            composition.duration,
            snapGraphTime(
              graphXToTime(point.x, timeRange),
              frameDuration,
              state.currentTime,
              pixelsPerSecond,
              moveEvent.ctrlKey || moveEvent.metaKey,
              dragSnapTargets,
              allowBetweenFrames,
            ),
          ),
        ),
        value: constrainGraphTrackValue(
          sourceTrack,
          graphDraggedKeyframeValue(curve.type, keyframe.value, graphYToValue(point.y, valueRange)),
        ),
      };
      setKeyframePreview(next);
    };
    const end = () => {
      removeWindowPointerListeners(move, end);
      setKeyframePreview(undefined);
      if (
        Math.abs(next.time - keyframe.time) > POINTER_EPSILON ||
        Math.abs(next.value - keyframe.value) > POINTER_EPSILON
      ) {
        const earliest = Math.min(...draggedEntries.map((entry) => entry.keyframe.time));
        const latest = Math.max(...draggedEntries.map((entry) => entry.keyframe.time));
        const timeDelta = Math.max(
          -earliest,
          Math.min(composition.duration - latest, next.time - keyframe.time),
        );
        const valueDelta = next.value - keyframe.value;
        dispatch({
          type: "operation",
          operations: draggedEntries.flatMap((entry) =>
            graphUpdateOperations(entry, {
              ...entry.keyframe,
              time: entry.keyframe.time + timeDelta,
              value:
                curve.type === "value" && graphTrackOwnsEntry(sourceTrack, entry)
                  ? constrainGraphTrackValue(sourceTrack, entry.keyframe.value + valueDelta)
                  : entry.keyframe.value,
              interpolation:
                graphTrackOwnsEntry(sourceTrack, entry) && sourceTrack.discrete
                  ? "step"
                  : entry.keyframe.interpolation,
              easing:
                graphTrackOwnsEntry(sourceTrack, entry) && sourceTrack.discrete
                  ? undefined
                  : entry.keyframe.easing,
            }),
          ),
        });
      }
    };
    addWindowPointerListeners(move, end);
  };

  const startHandleDrag = (
    event: React.PointerEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    nextKeyframe: Keyframe,
    handle: "out" | "in",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = event.currentTarget.ownerSVGElement;
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    const sourceKeyframe = sourceTrack?.property.keyframes.find(
      (entry) => entry.id === keyframe.id,
    );
    const owner = sourceTrack
      ? composition.layers.find((candidate) => candidate.id === sourceTrack.ownerLayerId)
      : undefined;
    if (!svg || !sourceTrack || !sourceKeyframe || !owner || owner.locked || sourceTrack.discrete)
      return;
    const start = keyframePoint(keyframe, timeRange, valueRange);
    const finish = keyframePoint(nextKeyframe, timeRange, valueRange);
    let easing = keyframe.easing ?? [0.42, 0, 0.58, 1];
    const move = (moveEvent: PointerEvent) => {
      const point = clientGraphPoint(svg, moveEvent.clientX, moveEvent.clientY);
      if (curve.type === "speed") {
        const time = graphXToTime(point.x, timeRange);
        const duration = Math.max(Number.EPSILON, nextKeyframe.time - keyframe.time);
        const influence =
          handle === "out"
            ? (time - keyframe.time) / duration
            : (nextKeyframe.time - time) / duration;
        easing = easingFromGraphSpeedHandle(
          { ...keyframe, easing },
          nextKeyframe,
          handle,
          influence,
          Math.max(0, graphYToValue(point.y, valueRange)),
          graphTrackSegmentBaseSpeed(sourceTrack, keyframe, nextKeyframe),
        );
      } else {
        const x = Math.max(0, Math.min(1, (point.x - start.x) / signedNonZero(finish.x - start.x)));
        const y = Math.max(
          -4,
          Math.min(5, (point.y - start.y) / signedNonZero(finish.y - start.y)),
        );
        easing =
          handle === "out"
            ? [Math.min(x, easing[2]), y, easing[2], easing[3]]
            : [easing[0], easing[1], Math.max(x, easing[0]), y];
      }
      setEasingPreview({ trackId: sourceTrack.id, keyframeId: keyframe.id, easing });
    };
    const end = () => {
      removeWindowPointerListeners(move, end);
      setEasingPreview(undefined);
      const segmentKeyframes = graphTrackSegmentKeyframes(
        sourceTrack,
        sourceKeyframe.time,
        nextKeyframe.time,
      );
      dispatch({
        type: "operation",
        operations: segmentKeyframes.flatMap((target) => {
          const entry = graphTargetEditableKeyframe(owner.id, target);
          return graphUpdateOperations(entry, {
            ...target.keyframe,
            interpolation: "bezier",
            easing,
          });
        }),
      });
    };
    addWindowPointerListeners(move, end);
  };

  const keyboardEditKeyframe = (
    event: React.KeyboardEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
  ) => {
    const sourceTrack = tracks.find((track) => track.id === curve.track.id);
    const owner = sourceTrack
      ? composition.layers.find((candidate) => candidate.id === sourceTrack.ownerLayerId)
      : undefined;
    if (!sourceTrack || !owner || owner.locked) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedKeyframeOwners({ [keyframe.id]: sourceTrack.id });
      dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
      return;
    }
    const timeDirection = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const valueDirection = event.key === "ArrowDown" ? -1 : event.key === "ArrowUp" ? 1 : 0;
    if (!timeDirection && (!valueDirection || curve.type === "speed")) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.shiftKey ? 10 : 1;
    updateKeyframe(
      sourceTrack,
      keyframe,
      Math.max(
        0,
        Math.min(composition.duration, keyframe.time + timeDirection * frameDuration * multiplier),
      ),
      keyframe.value + valueDirection * sourceTrack.step * multiplier,
    );
  };

  const fitAll = () => {
    setTimeRange(fitGraphTimeRange(visibleTracks, composition.duration));
    setAutoZoomHeight(true);
  };
  const fitSelection = () => {
    setTimeRange(
      fitGraphTimeRange(visibleTracks, composition.duration, new Set(state.selectedKeyframes)),
    );
    setAutoZoomHeight(true);
  };
  const setSelectedInterpolation = (
    interpolation: "linear" | "bezier" | "step",
    easing?: [number, number, number, number],
  ) => {
    if (!canEditSelection) return;
    dispatch({
      type: "operation",
      operations: graphInterpolationOperations(selectedEntries, trackOwners, interpolation, easing),
    });
  };
  const easeSelectedKeyframes = (mode: "both" | "in" | "out") => {
    if (!canEditSelection) return;
    const operations = graphEaseOperations(selectedEntries, trackOwners, mode);
    if (operations.length) dispatch({ type: "operation", operations });
  };
  const copySelection = () => setKeyframeClipboard(copyKeyframes(selectedEntries));
  const pasteSelection = () => {
    if (!keyframeClipboard || !canPasteClipboard) return;
    const pasted = pasteKeyframes(keyframeClipboard, state.currentTime, composition.duration);
    dispatch({
      type: "operation",
      operations: constrainGraphPasteOperations(pasted.operations, trackOwners),
    });
    dispatch({ type: "selectKeyframes", ids: pasted.selectedIds });
  };
  const deleteSelection = () => {
    if (!canEditSelection) return;
    dispatch({ type: "operation", operations: removeKeyframes(selectedEntries) });
    setSelectedKeyframeOwners({});
    dispatch({ type: "selectKeyframes", ids: [] });
  };
  const trackLabel = (track: GraphTrack) => {
    const owned = tracks.find((candidate) => candidate.id === track.id);
    const labelKey = graphTrackLabelKey(track, graphType);
    const baseProperty = labelKey
      ? `${t(labelKey)}${
          track.source === "transform" &&
          track.labelSuffix &&
          resolveGraphType(graphType, track) === "value"
            ? ` ${track.labelSuffix}`
            : ""
        }`
      : track.source === "effect"
        ? track.label
        : (owned?.sourceTrackId ?? track.id);
    const property =
      track.source === "transform" && track.labelPrefix
        ? `${track.labelPrefix} · ${baseProperty}`
        : baseProperty;
    return selectedLayers.length > 1 && owned ? `${owned.ownerLayerName} · ${property}` : property;
  };
  const selectedKeyframeIdSet = useMemo(
    () => new Set(state.selectedKeyframes),
    [state.selectedKeyframes],
  );
  const wheelGraph = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const point = clientGraphPoint(event.currentTarget, event.clientX, event.clientY);
    const factor = Math.exp(event.deltaY * 0.0015);
    if (event.altKey) {
      setTimeRange(
        zoomGraphTimeRange(
          timeRange,
          graphXToTime(point.x, timeRange),
          factor,
          composition.duration,
          frameDuration / 4,
        ),
      );
    } else if (event.ctrlKey || event.metaKey) {
      const initial = valueRange;
      setAutoZoomHeight(false);
      setManualValueRange(zoomGraphValueRange(initial, graphYToValue(point.y, initial), factor));
    } else if (event.shiftKey) {
      setTimeRange(
        panGraphTimeRange(
          timeRange,
          (event.deltaY / Math.max(1, viewportSize.width)) * (timeRange.end - timeRange.start),
          composition.duration,
        ),
      );
    } else {
      const initial = valueRange;
      setAutoZoomHeight(false);
      setManualValueRange(
        panGraphValueRange(
          initial,
          (event.deltaY / Math.max(1, viewportSize.height)) * (initial.max - initial.min),
        ),
      );
    }
  };
  const keyframeKeyDown = (
    event: React.KeyboardEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    selected: boolean,
  ) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      if (!selected) {
        setSelectedKeyframeOwners({ [keyframe.id]: curve.track.id });
        dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
      }
      contextMenu.openFromKeyboard(event);
      return;
    }
    keyboardEditKeyframe(event, curve, keyframe);
  };
  const keyframeContextMenu = (
    event: React.MouseEvent<SVGEllipseElement>,
    curve: GraphCurve,
    keyframe: Keyframe,
    selected: boolean,
  ) => {
    if (!selected) {
      setSelectedKeyframeOwners({ [keyframe.id]: curve.track.id });
      dispatch({ type: "selectKeyframes", ids: [keyframe.id] });
    }
    contextMenu.openFromPointer(event);
  };
  const surfaceKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (contextMenu.openFromKeyboard(event)) return;
    const frameDirection = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (frameDirection) {
      event.preventDefault();
      dispatch({
        type: "setTime",
        time: Math.max(
          0,
          Math.min(composition.duration, state.currentTime + frameDirection * frameDuration),
        ),
      });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      dispatch({ type: "setTime", time: event.key === "Home" ? 0 : composition.duration });
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      setTimeRange(
        zoomGraphTimeRange(
          timeRange,
          state.currentTime,
          event.key === "-" ? 1.25 : 0.8,
          composition.duration,
          frameDuration / 4,
        ),
      );
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      if (event.shiftKey) fitAll();
      else fitSelection();
    }
  };

  return (
    <div className="graph-editor">
      <GraphSidebar
        graphType={graphType}
        hasLayer={Boolean(layer)}
        hiddenTracks={hiddenTracks}
        onToggleTrack={(trackId) =>
          setHiddenTracks((current) => {
            const next = new Set(current);
            if (next.has(trackId)) next.delete(trackId);
            else next.add(trackId);
            return next;
          })
        }
        t={t}
        title={
          selectedLayers.length > 1
            ? selectedLayers.map((entry) => entry.name).join(", ")
            : (layer?.name ?? t("graph.noSelection"))
        }
        trackLabel={trackLabel}
        tracks={sidebarTracks}
      />
      <div className="graph-main">
        <GraphToolbar
          allowBetweenFrames={allowBetweenFrames}
          autoZoomHeight={autoZoomHeight}
          canFitAll={visibleTracks.length > 0}
          canFitSelection={state.selectedKeyframes.length > 0}
          graphType={graphType}
          onFitAll={fitAll}
          onFitSelection={fitSelection}
          onGraphType={setGraphType}
          onToggleAutoZoomHeight={() => {
            if (autoZoomHeight) setManualValueRange(sampledValueRange);
            setAutoZoomHeight(!autoZoomHeight);
          }}
          onToggleBetweenFrames={() => setAllowBetweenFrames((value) => !value)}
          onToggleLayerBounds={() => setShowLayerBounds((value) => !value)}
          onToggleReference={() => setShowReferenceGraph((value) => !value)}
          showLayerBounds={showLayerBounds}
          showReferenceGraph={showReferenceGraph}
          t={t}
        />
        <div
          aria-label={t("graph.a11y")}
          className="graph-surface"
          onContextMenu={contextMenu.openFromPointer}
          onKeyDown={surfaceKeyDown}
          role="application"
          /* biome-ignore lint/a11y/noNoninteractiveTabindex: The graph canvas is an application-style keyboard interaction surface. */
          tabIndex={0}
        >
          <GraphPlot
            currentTime={state.currentTime}
            curves={curves}
            easingPreview={easingPreview}
            gridId={gridId}
            handleRadii={handleRadii}
            keyRadii={keyRadii}
            layerBounds={selectedLayers}
            onHandlePointerDown={startHandleDrag}
            onKeyframeContextMenu={keyframeContextMenu}
            onKeyframeKeyDown={keyframeKeyDown}
            onKeyframePointerDown={startKeyframeDrag}
            onPointerDown={startSurfacePointer}
            onWheel={wheelGraph}
            referenceCurves={referenceCurves}
            referenceValueRange={referenceValueRange}
            selectedKeyframeIds={selectedKeyframeIdSet}
            selectedKeyframeOwners={selectedKeyframeOwners}
            showLayerBounds={showLayerBounds}
            svgRef={svgRef}
            t={t}
            timeRange={timeRange}
            trackLabel={(curve) => trackLabel(curve.track)}
            valueRange={valueRange}
          />
        </div>
        {contextMenu.point && (
          <GraphContextMenu
            canEdit={canEditSelection}
            canPaste={canPasteClipboard}
            copy={copySelection}
            delete={deleteSelection}
            disabledReason={
              selectedLayers.some((entry) => entry.locked)
                ? t("graph.menu.locked")
                : t("graph.menu.noSelection")
            }
            easyEase={() => easeSelectedKeyframes("both")}
            easyEaseIn={() => easeSelectedKeyframes("in")}
            easyEaseOut={() => easeSelectedKeyframes("out")}
            fitAll={fitAll}
            fitSelection={fitSelection}
            graphType={graphType}
            hasClipboard={Boolean(keyframeClipboard)}
            hasSelection={selectedEntries.length > 0}
            hasTracks={visibleTracks.length > 0}
            onClose={contextMenu.close}
            paste={pasteSelection}
            setGraphType={setGraphType}
            setInterpolation={setSelectedInterpolation}
            x={contextMenu.point.x}
            y={contextMenu.point.y}
          />
        )}
      </div>
    </div>
  );
}
