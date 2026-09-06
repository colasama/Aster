import {
  Box,
  ClipboardPaste,
  Copy,
  Eye,
  Gauge,
  Lock,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Trash2,
  Volume2,
  Wind,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createParticleLayerForComposition } from "../core/bundled-particle";
import {
  copyKeyframes,
  selectedKeyframes as findSelectedKeyframes,
  type KeyframeClipboard,
  pasteKeyframes,
  removeKeyframes,
} from "../core/keyframe-editing";
import { createLayerForComposition } from "../core/layer-factory";
import {
  compositionMotionBlurSettings,
  layerSupportsMotionBlur,
  motionBlurInterval,
} from "../core/motion-blur";
import { onPlaybackFrame } from "../core/playback-frame";
import { planPrecomposition } from "../core/precomposition";
import { activeComposition } from "../core/project";
import { frameAt } from "../core/timeline";
import {
  adjacentTimelineEvent,
  marqueeTimelineSelection,
  snapTimelineTime,
} from "../core/timeline-editing";
import type { Layer } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { useContextMenuTrigger } from "./context-menu/use-context-menu-trigger";
import { Panel, PanelTabs } from "./Panel";
import { TimelineContextMenu, type TimelineCreateKind } from "./TimelineContextMenu";
import { collectTimelineLayerKeyframes, TimelineLayerRow } from "./TimelineLayerRow";
import { TimelineWorkArea } from "./TimelineWorkArea";
import {
  buildTimelineSnapTargets,
  collectTimelineEventTimes,
  compositionFrameDuration,
  editLayerTimingGroup,
  type LayerTimingDrag,
  layerTimingOperations,
  resolveTimelineShortcut,
  setWorkAreaBoundary,
  type TimelineWorkArea as TimelineWorkAreaValue,
  timelineContentPoint,
  timelineMarqueeRect,
} from "./timeline-interactions";
import {
  canInterpolateTimelineKeyframes,
  timelineKeyframeInterpolationOperations,
} from "./timeline-keyframe-actions";
import { duplicateTimelineLayers, splitTimelineLayers } from "./timeline-layer-clipboard";
import type { KeyframeTimePreview } from "./timeline-property-tracks";
import { usePlayback } from "./use-timeline-playback";
import { useWindowPointerDrag } from "./use-window-pointer-drag";
import { useWorkspaceApi } from "./workspace/DockWorkspace";

const GraphEditor = lazy(() =>
  import("./GraphEditor").then((module) => ({ default: module.GraphEditor })),
);

const LABEL_WIDTH = 286;
const BASE_PIXELS_PER_SECOND = 82;

interface TimelineMarquee {
  height: number;
  left: number;
  top: number;
  width: number;
}

type TimingPreview = Record<string, { inPoint: number; outPoint: number }>;

export function Timeline() {
  const { state, dispatch } = useEditor();
  const workspace = useWorkspaceApi();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * state.timelineZoom;
  const compositionMotionBlur = compositionMotionBlurSettings(composition);
  const shutterInterval = motionBlurInterval(
    state.currentTime,
    composition.frameRate.numerator / composition.frameRate.denominator,
    compositionMotionBlur,
  );
  const showShutterRegion =
    compositionMotionBlur.enabled &&
    compositionMotionBlur.shutterAngle > 0 &&
    state.timelineZoom >= 1.25;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragLayer = useRef<string | undefined>(undefined);
  const [keyframeClipboard, setKeyframeClipboard] = useState<KeyframeClipboard>();
  const [layerClipboard, setLayerClipboard] = useState<Layer[]>();
  const [menuLayerId, setMenuLayerId] = useState<string>();
  const contextMenu = useContextMenuTrigger();
  const [keyframeTimePreview, setKeyframeTimePreview] = useState<KeyframeTimePreview>();
  const [timingPreview, setTimingPreview] = useState<TimingPreview>();
  const [marquee, setMarquee] = useState<TimelineMarquee>();
  const pointerDrag = useWindowPointerDrag();
  const startPointerDrag = pointerDrag.start;
  const workArea = composition.workArea;
  const setWorkArea = useCallback(
    (value: TimelineWorkAreaValue) =>
      dispatch({
        type: "operation",
        operations: [
          {
            type: "setCompositionWorkArea",
            compositionId: composition.id,
            start: value.start,
            end: value.end,
          },
        ],
      }),
    [composition.id, dispatch],
  );
  const frameDuration = compositionFrameDuration(composition);
  const timelineTargets = useMemo(
    () => buildTimelineSnapTargets(composition, state.currentTime, workArea),
    [composition, state.currentTime, workArea],
  );
  const selectedEntries = useMemo(
    () => findSelectedKeyframes(composition, state.selectedKeyframes),
    [composition, state.selectedKeyframes],
  );
  const selectedLayers = useMemo(
    () => composition.layers.filter((layer) => state.selection.includes(layer.id)),
    [composition.layers, state.selection],
  );
  const menuLayer = useMemo(
    () => composition.layers.find((layer) => layer.id === menuLayerId),
    [composition.layers, menuLayerId],
  );
  const contextLayers = useMemo(
    () => (menuLayer && !state.selection.includes(menuLayer.id) ? [menuLayer] : selectedLayers),
    [menuLayer, selectedLayers, state.selection],
  );
  const editableContextLayers = useMemo(
    () => contextLayers.filter((layer) => !layer.locked),
    [contextLayers],
  );
  const canDeleteContextLayers =
    editableContextLayers.length === contextLayers.length &&
    editableContextLayers.length > 0 &&
    composition.layers.length - editableContextLayers.length >= 1;
  const canSplitContextLayers =
    editableContextLayers.length === contextLayers.length &&
    editableContextLayers.length > 0 &&
    editableContextLayers.every(
      (layer) =>
        state.currentTime > layer.inPoint + frameDuration * 0.5 &&
        state.currentTime < layer.outPoint - frameDuration * 0.5,
    );
  const contextLayerIds = new Set(contextLayers.map((layer) => layer.id));
  const childLayerIds = composition.layers
    .filter((layer) => layer.parentId && contextLayerIds.has(layer.parentId))
    .map((layer) => layer.id);
  const canEditSelectedKeyframes =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) => !composition.layers.find((layer) => layer.id === entry.layerId)?.locked,
    );
  const canInterpolateSelectedKeyframes =
    canEditSelectedKeyframes && canInterpolateTimelineKeyframes(composition, selectedEntries);
  const canPasteKeyframeClipboard =
    Boolean(keyframeClipboard) &&
    Boolean(
      keyframeClipboard?.entries.every((entry) => {
        const target = composition.layers.find((layer) => layer.id === entry.layerId);
        return Boolean(target && !target.locked);
      }),
    );
  useEffect(() => {
    if (composition.id) {
      pointerDrag.cancel();
      setKeyframeTimePreview(undefined);
    }
  }, [composition.id, pointerDrag]);
  useEffect(() => {
    if (state.bottomMode !== "timeline") {
      pointerDrag.cancel();
      setKeyframeTimePreview(undefined);
    }
    return pointerDrag.cancel;
  }, [pointerDrag, state.bottomMode]);
  const keyboardContext = useRef({
    bottomMode: state.bottomMode,
    composition,
    currentTime: state.currentTime,
    keyframeClipboard,
    selection: state.selection,
    selectedEntries,
    timelineTargets,
    workArea,
  });
  keyboardContext.current = {
    bottomMode: state.bottomMode,
    composition,
    currentTime: state.currentTime,
    keyframeClipboard,
    selection: state.selection,
    selectedEntries,
    timelineTargets,
    workArea,
  };
  usePlayback(composition, workArea);
  useEffect(
    () =>
      onPlaybackFrame((frame) => {
        if (frame.compositionId !== composition.id) return;
        const playhead = canvasRef.current?.querySelector<HTMLElement>(".playhead");
        if (playhead) playhead.style.left = `${LABEL_WIDTH + frame.time * pixelsPerSecond}px`;
      }),
    [composition.id, pixelsPerSecond],
  );
  const ticks = useMemo(
    () => Array.from({ length: Math.floor(composition.duration * 2) + 1 }, (_, index) => index / 2),
    [composition.duration],
  );
  const clientXToTime = (clientX: number) => {
    const scroll = scrollRef.current;
    if (!scroll) return 0;
    const bounds = scroll.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        composition.duration,
        (clientX - bounds.left + scroll.scrollLeft - LABEL_WIDTH) / pixelsPerSecond,
      ),
    );
  };
  const scrub = (clientX: number, bypassSnap: boolean) => {
    const time = clientXToTime(clientX);
    const snapped = snapTimelineTime(
      time,
      frameDuration,
      pixelsPerSecond,
      timelineTargets,
      bypassSnap,
    );
    dispatch({ type: "setTime", time: snapped.time });
  };
  const copySelection = () => {
    setKeyframeClipboard(copyKeyframes(selectedEntries));
  };
  const pasteSelection = () => {
    if (!keyframeClipboard || !canPasteKeyframeClipboard) return;
    const pasted = pasteKeyframes(keyframeClipboard, state.currentTime, composition.duration);
    dispatch({ type: "operation", operations: pasted.operations });
    dispatch({ type: "selectKeyframes", ids: pasted.selectedIds });
  };
  const deleteSelection = () => {
    if (!selectedEntries.length) return;
    dispatch({ type: "operation", operations: removeKeyframes(selectedEntries) });
    dispatch({ type: "selectKeyframes", ids: [] });
  };
  const copyContextLayers = () => {
    if (contextLayers.length) setLayerClipboard(structuredClone(contextLayers));
  };
  const pasteContextLayers = () => {
    if (!layerClipboard?.length) return;
    const layers = duplicateTimelineLayers(layerClipboard);
    dispatch({
      type: "operation",
      operations: layers.map((layer) => ({ type: "addLayer" as const, layer })),
      select: layers.map((layer) => layer.id),
    });
  };
  const deleteContextLayers = () => {
    if (!canDeleteContextLayers) return;
    dispatch({
      type: "operation",
      operations: editableContextLayers.map((layer) => ({
        type: "removeLayer" as const,
        layerId: layer.id,
      })),
      select: [],
    });
  };
  const cutContextLayers = () => {
    if (!canDeleteContextLayers) return;
    copyContextLayers();
    deleteContextLayers();
  };
  const duplicateContextLayers = () => {
    if (!contextLayers.length) return;
    const layers = duplicateTimelineLayers(contextLayers);
    dispatch({
      type: "operation",
      operations: layers.map((layer) => ({ type: "addLayer" as const, layer })),
      select: layers.map((layer) => layer.id),
    });
  };
  const splitContextLayers = () => {
    if (!canSplitContextLayers) return;
    const rightLayers = splitTimelineLayers(editableContextLayers, state.currentTime);
    dispatch({
      type: "operation",
      operations: [
        ...editableContextLayers.map((layer) => ({
          type: "setLayerTiming" as const,
          layerId: layer.id,
          inPoint: layer.inPoint,
          outPoint: state.currentTime,
        })),
        ...rightLayers.map((layer) => ({ type: "addLayer" as const, layer })),
      ],
      select: [
        ...editableContextLayers.map((layer) => layer.id),
        ...rightLayers.map(({ id }) => id),
      ],
    });
  };
  const invertLayerSelection = () => {
    const selected = new Set(state.selection);
    dispatch({
      type: "select",
      ids: composition.layers.filter((layer) => !selected.has(layer.id)).map((layer) => layer.id),
    });
  };
  const selectChildLayers = () => {
    if (childLayerIds.length === 0) return;
    const ids = new Set([...state.selection, ...childLayerIds]);
    dispatch({
      type: "select",
      ids: composition.layers.filter((layer) => ids.has(layer.id)).map((layer) => layer.id),
    });
  };
  const renameContextLayer = () => {
    const target = contextLayers[0];
    if (!target || target.locked || contextLayers.length !== 1) return;
    const name = window.prompt(t("timeline.menu.renamePrompt"), target.name)?.trim();
    if (!name || name === target.name) return;
    dispatch({
      type: "operation",
      operations: [{ type: "renameLayer", layerId: target.id, name }],
    });
  };
  const precomposeContextLayers = () => {
    if (contextLayers.length === 0 || editableContextLayers.length !== contextLayers.length) return;
    const plan = planPrecomposition(
      state.project,
      contextLayers.map((layer) => layer.id),
    );
    if (!plan) return;
    dispatch({
      type: "operation",
      operations: [{ type: "precomposeLayers", ...plan }],
      select: [plan.wrapper.id],
    });
  };
  const createTimelineLayer = (kind: TimelineCreateKind) => {
    const layer =
      kind === "generator"
        ? createParticleLayerForComposition(composition, state.currentTime)
        : createLayerForComposition(kind, composition, state.currentTime);
    dispatch({
      type: "operation",
      operations: [{ type: "addLayer", layer }],
      select: [layer.id],
    });
  };
  const setSelectedInterpolation = (interpolation: "linear" | "bezier" | "step") => {
    if (!canInterpolateSelectedKeyframes) return;
    dispatch({
      type: "operation",
      operations: timelineKeyframeInterpolationOperations(
        composition,
        selectedEntries,
        interpolation,
      ),
    });
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const context = keyboardContext.current;
      if (context.bottomMode !== "timeline" || isEditableTarget(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setKeyframeClipboard(copyKeyframes(context.selectedEntries));
      } else if (command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        if (!context.keyframeClipboard) return;
        const pasted = pasteKeyframes(
          context.keyframeClipboard,
          context.currentTime,
          context.composition.duration,
        );
        dispatch({ type: "operation", operations: pasted.operations });
        dispatch({ type: "selectKeyframes", ids: pasted.selectedIds });
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (!context.selectedEntries.length) return;
        dispatch({ type: "operation", operations: removeKeyframes(context.selectedEntries) });
        dispatch({ type: "selectKeyframes", ids: [] });
      } else if (event.key === "Escape") {
        dispatch({ type: "selectKeyframes", ids: [] });
      } else {
        const shortcut = resolveTimelineShortcut(event);
        if (!shortcut) return;
        const compositionFrame = compositionFrameDuration(context.composition);
        const setTime = (time: number) =>
          dispatch({
            type: "setTime",
            time: Math.max(0, Math.min(context.composition.duration, time)),
          });
        if (shortcut === "work-start" || shortcut === "work-end") {
          event.preventDefault();
          setWorkArea(
            setWorkAreaBoundary(
              context.workArea,
              shortcut === "work-start" ? "start" : "end",
              context.currentTime,
              context.composition.duration,
              compositionFrame,
            ),
          );
          return;
        }
        if (shortcut === "composition-start" || shortcut === "composition-end") {
          event.preventDefault();
          setTime(shortcut === "composition-start" ? 0 : context.composition.duration);
          return;
        }
        if (shortcut === "previous-frame" || shortcut === "next-frame") {
          event.preventDefault();
          setTime(
            context.currentTime +
              (shortcut === "previous-frame" ? -compositionFrame : compositionFrame),
          );
          return;
        }
        if (shortcut === "previous-event" || shortcut === "next-event") {
          const next = adjacentTimelineEvent(
            collectTimelineEventTimes(context.composition, context.workArea),
            context.currentTime,
            shortcut === "previous-event" ? -1 : 1,
          );
          if (next === undefined) return;
          event.preventDefault();
          setTime(next);
          return;
        }
        const selectedLayers = context.composition.layers.filter(
          (layer) => context.selection.includes(layer.id) && !layer.locked,
        );
        const activeId = context.selection.find((id) =>
          selectedLayers.some((layer) => layer.id === id),
        );
        const active = selectedLayers.find((layer) => layer.id === activeId);
        if (!active) return;
        const mode: LayerTimingDrag = shortcut.startsWith("trim")
          ? shortcut === "trim-in"
            ? "trim-in"
            : "trim-out"
          : "move";
        const requestedTime =
          shortcut === "align-out"
            ? context.currentTime - (active.outPoint - active.inPoint)
            : context.currentTime;
        const timings = editLayerTimingGroup(
          selectedLayers,
          active.id,
          mode,
          requestedTime,
          context.composition,
          pixelsPerSecond,
          context.timelineTargets,
          true,
        );
        if (!timings.length) return;
        event.preventDefault();
        dispatch({ type: "operation", operations: layerTimingOperations(timings) });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatch, pixelsPerSecond, setWorkArea]);

  const startLayerTimingDrag = (
    event: React.PointerEvent,
    activeLayer: Layer,
    mode: LayerTimingDrag,
  ) => {
    if (event.button !== 0 || activeLayer.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const activeWasSelected = state.selection.includes(activeLayer.id);
    const layers = composition.layers.filter(
      (layer) =>
        !layer.locked &&
        (activeWasSelected ? state.selection.includes(layer.id) : layer.id === activeLayer.id),
    );
    if (!activeWasSelected) dispatch({ type: "select", ids: [activeLayer.id] });
    const initialActive = layers.find((layer) => layer.id === activeLayer.id);
    if (!initialActive) return;
    const initialTime = mode === "trim-out" ? initialActive.outPoint : initialActive.inPoint;
    const startX = event.clientX;
    const targets = timelineTargets;
    let next = layers.map(({ id, inPoint, outPoint }) => ({ id, inPoint, outPoint }));
    startPointerDrag(event.pointerId, {
      onMove: (moveEvent) => {
        next = editLayerTimingGroup(
          layers,
          activeLayer.id,
          mode,
          initialTime + (moveEvent.clientX - startX) / pixelsPerSecond,
          composition,
          pixelsPerSecond,
          targets,
          moveEvent.ctrlKey || moveEvent.metaKey,
        );
        setTimingPreview(
          Object.fromEntries(next.map((timing) => [timing.id, timing])) as TimingPreview,
        );
      },
      onCommit: () => {
        setTimingPreview(undefined);
        const changed = next.some((timing) => {
          const initial = layers.find((layer) => layer.id === timing.id);
          return (
            !initial ||
            Math.abs(timing.inPoint - initial.inPoint) > 0.000_001 ||
            Math.abs(timing.outPoint - initial.outPoint) > 0.000_001
          );
        });
        if (changed) dispatch({ type: "operation", operations: layerTimingOperations(next) });
      },
      onCancel: () => setTimingPreview(undefined),
    });
  };

  const startMarquee = (event: React.PointerEvent, startRow: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    if (!canvas || !scroll) return;
    const scrollBounds = scroll.getBoundingClientRect();
    const contentPoint = (clientX: number, clientY: number) =>
      timelineContentPoint(clientX, clientY, {
        left: scrollBounds.left,
        top: scrollBounds.top,
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
      });
    const pointTime = (point: { x: number }) =>
      Math.max(0, Math.min(composition.duration, (point.x - LABEL_WIDTH) / pixelsPerSecond));
    const startPoint = contentPoint(event.clientX, event.clientY);
    const startTime = pointTime(startPoint);
    const previousSelection = event.shiftKey ? state.selectedKeyframes : [];
    startPointerDrag(event.pointerId, {
      onMove: (moveEvent) => {
        setMarquee(
          timelineMarqueeRect(
            startPoint,
            contentPoint(moveEvent.clientX, moveEvent.clientY),
            LABEL_WIDTH,
          ),
        );
      },
      onCommit: (upEvent) => {
        setMarquee(undefined);
        const endRow = rowAtClientY(canvas, upEvent.clientY, startRow);
        const points = composition.layers.flatMap((layer, row) =>
          collectTimelineLayerKeyframes(layer).map((entry) => ({
            id: entry.keyframe.id,
            time: entry.keyframe.time,
            row,
          })),
        );
        const selected = marqueeTimelineSelection(
          points,
          startTime,
          pointTime(contentPoint(upEvent.clientX, upEvent.clientY)),
          startRow,
          endRow,
        );
        dispatch({
          type: "selectKeyframes",
          ids: [...new Set([...previousSelection, ...selected])],
        });
      },
      onCancel: () => setMarquee(undefined),
    });
  };
  return (
    <Panel
      className="timeline-panel"
      tabs={
        <PanelTabs
          active={state.bottomMode}
          onChange={(mode) =>
            dispatch({ type: "setBottomMode", mode: mode as "timeline" | "graph" })
          }
          tabs={[
            { id: "timeline", label: t("timeline.tab.timeline") },
            { id: "graph", label: t("timeline.tab.graph") },
          ]}
        />
      }
      actions={
        <>
          <button
            className={state.showLayerControls ? "active" : ""}
            onClick={() => dispatch({ type: "toggleView", view: "layerControls" })}
            title={t("timeline.toggleLayerSwitches")}
            type="button"
          >
            <SlidersHorizontal size={13} />
          </button>
          <button
            onClick={() => toggleTimelineFullscreen()}
            title={t("timeline.toggleFullscreen")}
            type="button"
          >
            <Maximize2 size={13} />
          </button>
        </>
      }
    >
      <div className="timeline-transport">
        <div className="timecode">
          <strong>{formatTimecode(state.currentTime, composition.frameRate)}</strong>
          <small>{frameAt(state.currentTime, composition.frameRate)}f</small>
        </div>
        <div className="transport-controls">
          <button
            aria-label={t("timeline.transport.start")}
            onClick={() => dispatch({ type: "setTime", time: 0 })}
            type="button"
          >
            <SkipBack size={14} />
          </button>
          <button
            aria-label={
              state.playing ? t("timeline.transport.pause") : t("timeline.transport.play")
            }
            className="play"
            onClick={() => dispatch({ type: "setPlaying", playing: !state.playing })}
            type="button"
          >
            {state.playing ? (
              <Pause fill="currentColor" size={14} />
            ) : (
              <Play fill="currentColor" size={14} />
            )}
          </button>
          <button
            aria-label={t("timeline.transport.end")}
            onClick={() => dispatch({ type: "setTime", time: composition.duration })}
            type="button"
          >
            <SkipForward size={14} />
          </button>
        </div>
        <div className="timeline-options">
          <span>
            <Gauge size={12} />
            {Math.round(composition.frameRate.numerator / composition.frameRate.denominator)} fps
          </span>
          <button
            aria-label={
              compositionMotionBlur.enabled
                ? t("timeline.motionBlur.disableComposition")
                : t("timeline.motionBlur.enableComposition")
            }
            className={compositionMotionBlur.enabled ? "enabled" : ""}
            onClick={() =>
              dispatch({
                type: "operation",
                operations: [
                  {
                    type: "setCompositionMotionBlur",
                    compositionId: composition.id,
                    motionBlur: {
                      ...compositionMotionBlur,
                      enabled: !compositionMotionBlur.enabled,
                    },
                  },
                ],
              })
            }
            title={t("timeline.motionBlur.compositionSwitch")}
            type="button"
          >
            <Wind size={12} />
          </button>
          <span className="keyframe-selection-count">
            {t(
              state.selectedKeyframes.length === 1
                ? "timeline.selectedKeyframe"
                : "timeline.selectedKeyframes",
              { count: state.selectedKeyframes.length },
            )}
          </span>
          <button
            disabled={!selectedEntries.length}
            onClick={copySelection}
            title={t("timeline.copyKeyframes")}
            type="button"
          >
            <Copy size={12} />
          </button>
          <button
            disabled={!keyframeClipboard}
            onClick={pasteSelection}
            title={t("timeline.pasteKeyframes")}
            type="button"
          >
            <ClipboardPaste size={12} />
          </button>
          <button
            disabled={!selectedEntries.length}
            onClick={deleteSelection}
            title={t("timeline.deleteKeyframes")}
            type="button"
          >
            <Trash2 size={12} />
          </button>
          <button
            aria-label={t("timeline.zoomOut")}
            onClick={() => dispatch({ type: "setTimelineZoom", zoom: state.timelineZoom / 1.25 })}
            type="button"
          >
            <ZoomOut size={13} />
          </button>
          <input
            aria-label={t("timeline.zoom")}
            max="8"
            min="0.5"
            onChange={(event) =>
              dispatch({ type: "setTimelineZoom", zoom: Number(event.target.value) })
            }
            step="0.1"
            type="range"
            value={state.timelineZoom}
          />
          <button
            aria-label={t("timeline.zoomIn")}
            onClick={() => dispatch({ type: "setTimelineZoom", zoom: state.timelineZoom * 1.25 })}
            type="button"
          >
            <ZoomIn size={13} />
          </button>
        </div>
      </div>
      {state.bottomMode === "graph" ? (
        <Suspense fallback={null}>
          <GraphEditor />
        </Suspense>
      ) : (
        <div
          aria-label={t("timeline.menu.emptyLabel")}
          className="timeline-scroll"
          onContextMenu={(event) => {
            if ((event.target as Element).closest("[data-timeline-row]")) return;
            setMenuLayerId(undefined);
            contextMenu.openFromPointer(event);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            setMenuLayerId(undefined);
            contextMenu.openFromKeyboard(event);
          }}
          ref={scrollRef}
          role="application"
          /* biome-ignore lint/a11y/noNoninteractiveTabindex: The timeline canvas is an application-style keyboard interaction surface. */
          tabIndex={0}
        >
          <div
            className="timeline-canvas"
            ref={canvasRef}
            style={{ width: LABEL_WIDTH + composition.duration * pixelsPerSecond }}
          >
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
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                scrub(event.clientX, event.ctrlKey || event.metaKey);
                startPointerDrag(event.pointerId, {
                  onMove: (moveEvent) =>
                    scrub(moveEvent.clientX, moveEvent.ctrlKey || moveEvent.metaKey),
                  onCommit: () => undefined,
                });
              }}
              style={{ left: LABEL_WIDTH, width: composition.duration * pixelsPerSecond }}
            >
              {showShutterRegion && (
                <div
                  aria-hidden="true"
                  className="timeline-shutter-region"
                  style={{
                    left: shutterInterval.openTime * pixelsPerSecond,
                    width: Math.max(1, shutterInterval.duration * pixelsPerSecond),
                  }}
                  title={t("timeline.motionBlur.shutterRegion")}
                />
              )}
              {ticks.map((time) => (
                <div
                  className={Number.isInteger(time) ? "major tick" : "tick"}
                  key={time}
                  style={{ left: time * pixelsPerSecond }}
                >
                  <span>{Number.isInteger(time) ? formatSeconds(time) : ""}</span>
                </div>
              ))}
              <TimelineWorkArea
                duration={composition.duration}
                frameDuration={frameDuration}
                onChange={setWorkArea}
                pixelsPerSecond={pixelsPerSecond}
                startPointerDrag={startPointerDrag}
                value={workArea}
              />
            </div>
            <div className="layer-rows">
              {composition.layers.map((layer, index) => (
                <TimelineLayerRow
                  composition={composition}
                  index={index}
                  keyframeTimePreview={keyframeTimePreview}
                  key={layer.id}
                  layer={layer}
                  onDragStart={() => {
                    dragLayer.current = layer.id;
                  }}
                  onDragEnd={() => {
                    dragLayer.current = undefined;
                  }}
                  onDrop={() => {
                    if (dragLayer.current && dragLayer.current !== layer.id)
                      dispatch({
                        type: "operation",
                        operations: [{ type: "reorderLayer", layerId: dragLayer.current, index }],
                      });
                    dragLayer.current = undefined;
                  }}
                  onKeyframeTimePreview={setKeyframeTimePreview}
                  onContextMenu={(event) => {
                    if (!state.selection.includes(layer.id))
                      dispatch({ type: "select", ids: [layer.id] });
                    setMenuLayerId(layer.id);
                    contextMenu.openFromPointer(event);
                  }}
                  onContextMenuKeyDown={(event) => {
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                      return;
                    if (!state.selection.includes(layer.id))
                      dispatch({ type: "select", ids: [layer.id] });
                    setMenuLayerId(layer.id);
                    contextMenu.openFromKeyboard(event);
                  }}
                  onMarqueeStart={(event) => startMarquee(event, index)}
                  onTimingDragStart={(event, mode) => startLayerTimingDrag(event, layer, mode)}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={state.selection.includes(layer.id)}
                  startPointerDrag={startPointerDrag}
                  timing={timingPreview?.[layer.id]}
                  timelineTargets={timelineTargets}
                />
              ))}
            </div>
            {marquee && <div className="timeline-marquee" style={marquee} />}
            <div
              className="playhead"
              style={{ left: LABEL_WIDTH + state.currentTime * pixelsPerSecond }}
            >
              <span />
              <i />
            </div>
          </div>
        </div>
      )}
      {contextMenu.point && (
        <TimelineContextMenu
          canDeleteLayers={canDeleteContextLayers}
          canEditKeyframes={canEditSelectedKeyframes}
          canInterpolate={canInterpolateSelectedKeyframes}
          canInvertSelection={state.selection.length > 0}
          canPasteKeyframes={canPasteKeyframeClipboard}
          canPasteLayers={Boolean(layerClipboard?.length)}
          canSelectChildren={childLayerIds.length > 0}
          canSplitLayers={canSplitContextLayers}
          copyKeyframes={copySelection}
          copyLayers={copyContextLayers}
          createLayer={createTimelineLayer}
          cutLayers={cutContextLayers}
          deleteKeyframes={deleteSelection}
          deleteLayers={deleteContextLayers}
          duplicateLayers={duplicateContextLayers}
          hasKeyframeSelection={selectedEntries.length > 0}
          hasKeyframeClipboard={Boolean(keyframeClipboard)}
          hasSource={Boolean(menuLayer?.sourceId || menuLayer?.sourceCompositionId)}
          is3d={Boolean(menuLayer?.threeDimensional)}
          isAdjustment={menuLayer?.kind === "adjustment"}
          isMotionBlur={Boolean(menuLayer?.motionBlur)}
          canMotionBlur={Boolean(menuLayer && layerSupportsMotionBlur(menuLayer))}
          isLayerTarget={Boolean(menuLayer)}
          invertSelection={invertLayerSelection}
          locked={contextLayers.some((layer) => layer.locked)}
          onClose={contextMenu.close}
          openGraph={() => dispatch({ type: "setBottomMode", mode: "graph" })}
          pasteKeyframes={pasteSelection}
          pasteLayers={pasteContextLayers}
          precompose={precomposeContextLayers}
          rename={renameContextLayer}
          revealSource={() => {
            dispatch({ type: "setLeftTab", tab: "project" });
            workspace.reopen("project");
          }}
          selectChildren={selectChildLayers}
          selectedLayerCount={contextLayers.length}
          setInterpolation={setSelectedInterpolation}
          splitLayers={splitContextLayers}
          toggle3d={() => {
            if (!menuLayer) return;
            dispatch({
              type: "operation",
              operations: [
                { type: "toggleLayer", layerId: menuLayer.id, field: "threeDimensional" },
              ],
            });
          }}
          toggleMotionBlur={() => {
            if (!menuLayer) return;
            dispatch({
              type: "operation",
              operations: [{ type: "toggleLayer", layerId: menuLayer.id, field: "motionBlur" }],
            });
          }}
          x={contextMenu.point.x}
          y={contextMenu.point.y}
        />
      )}
    </Panel>
  );
}

function formatTimecode(
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

const formatSeconds = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, "0")}`;

function toggleTimelineFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else {
    const panel = document.querySelector<HTMLElement>(".timeline-panel");
    if (panel) void panel.requestFullscreen();
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function rowAtClientY(canvas: HTMLElement, clientY: number, fallback: number): number {
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
