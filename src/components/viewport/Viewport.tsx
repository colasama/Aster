import {
  ChevronDown,
  Crosshair,
  Grid3X3,
  Maximize2,
  Minus,
  Move3D,
  Plus,
  Scan,
  Sparkles,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onPlaybackFrame } from "../../core/animation/playback-frame";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { logger } from "../../core/logger";
import {
  activateProjectFonts,
  prepareProjectFonts,
  projectFontsReady,
} from "../../core/media/project-font-runtime";
import { planCompositionCrop } from "../../core/project/composition-crop";
import { activeComposition } from "../../core/project/project";
import type { FrameRenderSessionOpenRequest } from "../../core/rendering/render-export";
import {
  BoundedRenderSessionController,
  ExclusiveRenderSessionGuard,
  type RenderSessionLease,
} from "../../core/rendering/render-session-guard";
import { evaluateWorldTransform } from "../../core/scene/scene-evaluation";
import { type GpuDiagnostics, setLayerSizeAndCenterAnchor } from "../../core/types";
import { isDesktopRuntime, onDisplayMetricsChanged } from "../../desktop/api";
import { useI18n } from "../../i18n/react";
import { CanvasFallbackRenderer } from "../../renderer/canvas-fallback";
import {
  createBeautyFrameRequest,
  createViewportBeautyFrameBackend,
  ProductionBeautyFramePipeline,
} from "../../renderer/compositing/beauty-frame";
import { createDefaultBezierPath } from "../../renderer/geometry/vector-path";
import { calculatePreviewSize } from "../../renderer/gpu/preview-size";
import { encodeRawFramePng } from "../../renderer/gpu/raw-frame-png";
import { BUFFER_VISUALIZATIONS, type BufferVisualization } from "../../renderer/gpu/render-buffers";
import { WebGpuRenderer } from "../../renderer/webgpu-renderer";
import { useEditor } from "../../state/editor-store";
import { viewportRendererStatus } from "../../ui/viewport-renderer-status";
import {
  beginViewportTextEdit,
  canEditViewportText,
  commitViewportTextEdit,
  previewViewportTextEdit,
  updateViewportTextEdit,
  type ViewportTextEditSession,
} from "../../ui/viewport-text-editing";
import {
  DEFAULT_VIEWPORT_ZOOM,
  MAX_VIEWPORT_ZOOM,
  MIN_VIEWPORT_ZOOM,
  viewportZoomPercent,
} from "../../ui/viewport-zoom";
import { resolveWorkspaceViewerComposition } from "../../workspace/viewer-context";
import { useContextMenuTrigger } from "../context-menu/use-context-menu-trigger";
import { Panel } from "../Panel";
import { useWorkspaceApi } from "../workspace/DockWorkspace";
import { useWorkspaceViewerIdentity } from "../workspace/WorkspaceViewerIdentity";
import { CameraGizmo } from "./CameraGizmo";
import { useViewportBenchmark } from "./use-viewport-benchmark";
import { Viewport3dTransformControls } from "./Viewport3dTransformControls";
import { ViewportContextMenu } from "./ViewportContextMenu";
import { ViewportTextEditor } from "./ViewportTextEditor";
import { ViewportTransformControls } from "./ViewportTransformControls";
import { hitTestLayer, viewportCssMatrix } from "./viewport-geometry";
import {
  bufferViewLabel,
  compositionContainsVideo,
  disposeRenderer,
  type Renderer,
  shallowDiagnosticsEqual,
  syncMirrorCanvas,
  toggleFullscreen,
} from "./viewport-rendering";

const WorkspaceDialog = lazy(() =>
  import("../settings/WorkspaceDialog").then((module) => ({ default: module.WorkspaceDialog })),
);

// Split viewers share these window-level commands. Claim each dispatched event once so
// the first ready surface becomes the bounded render host instead of every canvas
// opening an identical session or benchmark concurrently.
const claimedRenderSessionEvents = new WeakSet<Event>();

export function Viewport() {
  const { state, dispatch } = useEditor();
  const workspace = useWorkspaceApi();
  const { t } = useI18n();
  const viewerIdentity = useWorkspaceViewerIdentity();
  const { composition, readOnly: viewerReadOnly } = resolveWorkspaceViewerComposition(
    state.project,
    viewerIdentity,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | undefined>(undefined);
  const beautyPipelineRef = useRef<ProductionBeautyFramePipeline | undefined>(undefined);
  const renderSessionGuardRef = useRef(new ExclusiveRenderSessionGuard());
  const previewQualityRef = useRef(state.previewQuality);
  const lastMetricUpdate = useRef(0);
  const hasGpuPassMetrics = useRef(false);
  const [diagnostics, setDiagnostics] = useState<GpuDiagnostics>();
  const publishDiagnostics = useCallback((next: GpuDiagnostics) => {
    setDiagnostics((current) =>
      current && shallowDiagnosticsEqual(current, next) ? current : { ...next },
    );
  }, []);
  const rendererStatus = viewportRendererStatus(diagnostics, t);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererRevision, setRendererRevision] = useState(0);
  const [view, setView] = useState<"active" | "custom">("active");
  const [viewCount, setViewCount] = useState(1);
  const [compositionSettingsOpen, setCompositionSettingsOpen] = useState(false);
  const [bufferView, setBufferView] = useState<BufferVisualization>("beauty");
  const contextMenu = useContextMenuTrigger();
  const [space, setSpace] = useState<"local" | "world">("local");
  const [textEditSession, setTextEditSession] = useState<ViewportTextEditSession>();
  const textEditRef = useRef<ViewportTextEditSession | undefined>(undefined);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const previewProject = useMemo(
    () => previewViewportTextEdit(state.project, composition, state.currentTime, textEditSession),
    [composition, state.currentTime, state.project, textEditSession],
  );
  const previewComposition =
    previewProject === state.project
      ? composition
      : (previewProject.compositions.find((candidate) => candidate.id === composition.id) ??
        composition);
  const previewRestoreRef = useRef({
    bufferView,
    composition: previewComposition,
    project: previewProject,
    selectedLayerId: state.selection[0],
    time: state.currentTime,
  });
  previewRestoreRef.current = {
    bufferView,
    composition: previewComposition,
    project: previewProject,
    selectedLayerId: state.selection[0],
    time: state.currentTime,
  };
  const displayZoom = state.viewportZoom * (viewCount === 2 ? 0.5 : 1);
  const pan = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const selectedLayerIds = new Set(state.selection);
  const childLayerIds = composition.layers
    .filter((layer) => layer.parentId && selectedLayerIds.has(layer.parentId))
    .map((layer) => layer.id);
  const compositionCrop = useMemo(
    () =>
      contextMenu.point && !viewerReadOnly
        ? planCompositionCrop(composition, state.selection, state.currentTime)
        : undefined,
    [composition, contextMenu.point, state.currentTime, state.selection, viewerReadOnly],
  );
  const editingTextLayerId = textEditSession?.layerId;
  const editingTextLayer =
    editingTextLayerId === selectedLayer?.id
      ? previewComposition.layers.find((layer) => layer.id === editingTextLayerId)
      : undefined;
  const selectedTransform = useMemo(
    () =>
      selectedLayer
        ? evaluateWorldTransform(selectedLayer, previewComposition, state.currentTime)
        : undefined,
    [previewComposition, selectedLayer, state.currentTime],
  );
  const resize = useCallback(() => {
    if (renderSessionGuardRef.current.active) return;
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const preview = calculatePreviewSize({
      cssWidth: bounds.width,
      cssHeight: bounds.height,
      devicePixelRatio,
      quality: previewQualityRef.current,
      maxDimension: rendererRef.current?.diagnostics.maxTextureSize || undefined,
    });
    if (canvas.width === preview.width && canvas.height === preview.height) return;
    const pipeline = beautyPipelineRef.current;
    if (pipeline) pipeline.resize(preview.width, preview.height);
    else {
      canvas.width = preview.width;
      canvas.height = preview.height;
      rendererRef.current?.resize(preview.width, preview.height);
    }
    setRendererRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    previewQualityRef.current = state.previewQuality;
    resize();
  }, [resize, state.previewQuality]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return onDisplayMetricsChanged(() => resize());
  }, [resize]);

  useEffect(() => {
    if (renderSessionGuardRef.current.active) return;
    const renderer = rendererRef.current;
    if (!(renderer instanceof WebGpuRenderer)) return;
    const actual = renderer.setBufferVisualization(bufferView);
    if (actual !== bufferView) setBufferView(actual);
    setRendererRevision((revision) => revision + 1);
  }, [bufferView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let cancelled = false;
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    WebGpuRenderer.create(canvas, () => {
      if (!cancelled) setRendererRevision((revision) => revision + 1);
    })
      .catch((error: unknown) => {
        logger.error("viewport", "webgpu_fallback_activated", error);
        return new CanvasFallbackRenderer(canvas);
      })
      .then((renderer) => {
        if (cancelled) {
          disposeRenderer(renderer);
          return;
        }
        logger.info("viewport", "renderer_ready", {
          backend: renderer instanceof WebGpuRenderer ? "webgpu" : "canvas2d",
          adapter: renderer.diagnostics.adapter,
        });
        rendererRef.current = renderer;
        beautyPipelineRef.current = new ProductionBeautyFramePipeline(
          createViewportBeautyFrameBackend(renderer, canvas),
        );
        publishDiagnostics(renderer.diagnostics);
        resize();
        renderer.resize(canvas.width, canvas.height);
        setRendererReady(true);
      });
    return () => {
      cancelled = true;
      observer.disconnect();
      const renderer = rendererRef.current;
      rendererRef.current = undefined;
      beautyPipelineRef.current = undefined;
      disposeRenderer(renderer);
    };
  }, [publishDiagnostics, resize]);

  useEffect(() => {
    if (!rendererReady) return;
    rendererRef.current?.setMemoryBudget(
      state.gpuMemoryBudgetMb === "auto" ? undefined : state.gpuMemoryBudgetMb,
    );
    setRendererRevision((revision) => revision + 1);
  }, [rendererReady, state.gpuMemoryBudgetMb]);

  useEffect(() => {
    void rendererRevision;
    void viewCount;
    if (!rendererReady) return;
    if (renderSessionGuardRef.current.active) return;
    if (!projectFontsReady(previewProject)) {
      let cancelled = false;
      void prepareProjectFonts(previewProject)
        .then(() => {
          if (!cancelled) setRendererRevision((revision) => revision + 1);
        })
        .catch((error: unknown) => {
          logger.error("fonts", "project_font_load_failed", error);
        });
      return () => {
        cancelled = true;
      };
    }
    activateProjectFonts(previewProject);
    const renderer = rendererRef.current;
    if (!renderer) return;
    const pipeline = beautyPipelineRef.current;
    const renderAtTime = (time: number) => {
      const metrics =
        bufferView === "beauty" && pipeline
          ? pipeline.present(
              createBeautyFrameRequest({
                composition: previewComposition,
                project: previewProject,
                time: time,
                width: canvasRef.current?.width ?? 1,
                height: canvasRef.current?.height ?? 1,
              }),
              state.selection[0],
              state.playing,
            )
          : renderer.render(
              previewComposition,
              time,
              state.playing,
              previewProject,
              state.selection[0],
            );
      publishDiagnostics(renderer.diagnostics);
      syncMirrorCanvas(canvasRef.current, mirrorCanvasRef.current);
      const now = performance.now();
      const firstPassBreakdown = Boolean(metrics.passTimings) && !hasGpuPassMetrics.current;
      if (firstPassBreakdown) hasGpuPassMetrics.current = true;
      if (now - lastMetricUpdate.current > 200 || firstPassBreakdown) {
        lastMetricUpdate.current = now;
        dispatch({ type: "setMetrics", metrics });
      }
    };
    if (!state.playing) renderAtTime(state.currentTime);
    return onPlaybackFrame((frame) => {
      if (frame.compositionId === previewComposition.id && !renderSessionGuardRef.current.active)
        renderAtTime(frame.time);
    });
  }, [
    previewComposition,
    previewProject,
    dispatch,
    rendererReady,
    rendererRevision,
    state.currentTime,
    state.playing,
    state.selection,
    viewCount,
    bufferView,
    publishDiagnostics,
  ]);

  useEffect(() => {
    const openRenderSession = (event: Event) => {
      const request = event as CustomEvent<FrameRenderSessionOpenRequest>;
      if (claimedRenderSessionEvents.has(event)) return;
      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      const pipeline = beautyPipelineRef.current;
      if (!canvas || !renderer || !pipeline || renderSessionGuardRef.current.active) {
        queueMicrotask(() => {
          if (claimedRenderSessionEvents.has(event)) return;
          claimedRenderSessionEvents.add(event);
          request.detail.reject(new Error("Renderer did not open a frame session"));
        });
        return;
      }
      claimedRenderSessionEvents.add(event);
      const previewWidth = canvas.width;
      const previewHeight = canvas.height;
      const renderProject = request.detail.options?.project ?? state.project;
      const renderComposition = activeComposition(renderProject);
      const maxDimension = request.detail.options?.maxDimension;
      const renderScale =
        typeof maxDimension === "number" && Number.isFinite(maxDimension) && maxDimension > 0
          ? Math.min(1, maxDimension / Math.max(renderComposition.width, renderComposition.height))
          : 1;
      const renderWidth = Math.max(1, Math.round(renderComposition.width * renderScale));
      const renderHeight = Math.max(1, Math.round(renderComposition.height * renderScale));
      const synchronizeVideo = compositionContainsVideo(renderComposition, renderProject);
      let lease: RenderSessionLease;
      try {
        lease = renderSessionGuardRef.current.acquire(() => {
          try {
            const preview = previewRestoreRef.current;
            pipeline.resize(previewWidth, previewHeight);
            if (preview.bufferView !== "beauty") {
              if (renderer instanceof WebGpuRenderer)
                renderer.setBufferVisualization(preview.bufferView);
              renderer.render(
                preview.composition,
                preview.time,
                false,
                preview.project,
                preview.selectedLayerId,
              );
            } else
              pipeline.present(
                createBeautyFrameRequest({
                  composition: preview.composition,
                  project: preview.project,
                  time: preview.time,
                  width: previewWidth,
                  height: previewHeight,
                }),
                preview.selectedLayerId,
              );
            setRendererRevision((revision) => revision + 1);
          } finally {
            queueMicrotask(resize);
          }
        });
      } catch (error) {
        request.detail.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const maximumInFlight = synchronizeVideo ? 1 : pipeline.maxConcurrentReadbacks;
      const restore = () => {
        try {
          lease.close();
        } catch (error) {
          logger.error("export", "preview_restore_failed", error);
        }
      };
      const sessionController = new BoundedRenderSessionController(
        { close: restore },
        maximumInFlight,
      );
      const renderRequestAt = (time: number) =>
        createBeautyFrameRequest({
          composition: renderComposition,
          project: renderProject,
          time,
          width: renderWidth,
          height: renderHeight,
        });
      request.detail.resolve({
        rawPixelFormat: pipeline.pixelFormat,
        width: renderWidth,
        height: renderHeight,
        maxInFlightFrames: maximumInFlight,
        videoSynchronization: synchronizeVideo ? "seek-and-await" : "none",
        renderFrame: (time) =>
          sessionController.run(async () => {
            const raw = await pipeline.readback(renderRequestAt(time), synchronizeVideo);
            return await encodeRawFramePng(raw, renderWidth, renderHeight);
          }),
        renderRawFrame: (time) =>
          sessionController.run(() => pipeline.readback(renderRequestAt(time), synchronizeVideo)),
        close: () => sessionController.close(),
      });
    };
    window.addEventListener("aster:open-render-session", openRenderSession);
    return () => window.removeEventListener("aster:open-render-session", openRenderSession);
  }, [resize, state.project]);

  useViewportBenchmark(canvasRef, rendererRef, renderSessionGuardRef, resize);

  const beginTextEditing = useCallback(
    (layerId: string) => {
      if (viewerReadOnly) return;
      const session = beginViewportTextEdit(state.project, composition, layerId, state.currentTime);
      if (!session) return;
      textEditRef.current = session;
      setTextEditSession(session);
    },
    [composition, state.currentTime, state.project, viewerReadOnly],
  );
  const finishTextEditing = useCallback(() => {
    const edit = textEditRef.current;
    textEditRef.current = undefined;
    setTextEditSession(undefined);
    if (
      !edit ||
      edit.historyBase !== state.project ||
      edit.compositionId !== composition.id ||
      !canEditViewportText(composition, edit.layerId, state.currentTime)
    )
      return;
    const transaction = commitViewportTextEdit(edit);
    if (!transaction) return;
    dispatch({
      type: "operation",
      historyBase: transaction.historyBase,
      operations: [...transaction.operations],
    });
  }, [composition, dispatch, state.currentTime, state.project]);
  const cancelTextEditing = useCallback(() => {
    textEditRef.current = undefined;
    setTextEditSession(undefined);
  }, []);
  const previewTextEditing = useCallback((value: string) => {
    const edit = textEditRef.current;
    if (!edit) return;
    const next = updateViewportTextEdit(edit, value);
    textEditRef.current = next;
    setTextEditSession(next);
  }, []);

  useEffect(() => {
    if (editingTextLayerId) textEditorRef.current?.focus();
  }, [editingTextLayerId]);

  useEffect(() => {
    const edit = textEditRef.current;
    if (!edit) {
      if (viewerReadOnly) setCompositionSettingsOpen(false);
      return;
    }
    if (
      viewerReadOnly ||
      edit.historyBase !== state.project ||
      edit.compositionId !== composition.id ||
      !canEditViewportText(composition, edit.layerId, state.currentTime)
    ) {
      cancelTextEditing();
      if (viewerReadOnly) setCompositionSettingsOpen(false);
      return;
    }
    if (state.selection[0] !== edit.layerId) finishTextEditing();
  }, [
    cancelTextEditing,
    composition,
    finishTextEditing,
    state.currentTime,
    state.project,
    state.selection,
    viewerReadOnly,
  ]);
  const frameBlob = () =>
    new Promise<Blob>((resolve, reject) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        reject(new Error("Viewport canvas is unavailable"));
        return;
      }
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Frame capture failed"))),
        "image/png",
      );
    });
  const copyFrame = () => {
    void frameBlob()
      .then((blob) => navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]))
      .catch((error: unknown) => logger.error("viewport", "copy_frame_failed", error));
  };
  const exportFrame = () => {
    void frameBlob()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.download = `${composition.name}-${Math.round(state.currentTime * 1000)}ms.png`;
        anchor.href = url;
        anchor.click();
        URL.revokeObjectURL(url);
      })
      .catch((error: unknown) => logger.error("viewport", "export_frame_failed", error));
  };

  return (
    <Panel
      className="viewport-panel"
      title={t("viewport.title", {
        composition: composition.name,
        view: t("viewport.activeCamera"),
      })}
      actions={
        <>
          <button
            className={state.showGrid ? "active" : ""}
            onClick={() => dispatch({ type: "toggleView", view: "grid" })}
            title={t("viewport.toggleGrid")}
            type="button"
          >
            <Grid3X3 size={13} />
          </button>
          <button
            onClick={() => toggleFullscreen(document.querySelector(".viewport-panel"))}
            title={t("viewport.toggleFullscreen")}
            type="button"
          >
            <Maximize2 size={13} />
          </button>
        </>
      }
    >
      <div className="viewport-toolbar">
        <select
          aria-label={t("viewport.buffer.label")}
          onChange={(event) => setBufferView(event.target.value as BufferVisualization)}
          title={t("viewport.buffer.hint")}
          value={bufferView}
        >
          {BUFFER_VISUALIZATIONS.map((mode) => (
            <option key={mode} value={mode}>
              {bufferViewLabel(mode, t)}
            </option>
          ))}
        </select>
        <button
          onClick={() => setView(view === "active" ? "custom" : "active")}
          title={t("viewport.switchCamera")}
          type="button"
        >
          {viewCount === 2
            ? t("viewport.activeAndCustom")
            : view === "active"
              ? t("viewport.activeCamera")
              : t("viewport.customView")}{" "}
          <ChevronDown size={11} />
        </button>
        <button
          onClick={() => setViewCount(viewCount === 1 ? 2 : 1)}
          title={t("viewport.cycleLayout")}
          type="button"
        >
          {viewCount === 1
            ? t("viewport.viewCount", { count: viewCount })
            : t("viewport.viewsCount", { count: viewCount })}{" "}
          <ChevronDown size={11} />
        </button>
        <span className="toolbar-gap" />
        <button
          className="active"
          onClick={() => setSpace(space === "local" ? "world" : "local")}
          title={t("viewport.toggleSpace")}
          type="button"
        >
          <Move3D size={13} />
          {space === "local" ? t("viewport.space.local") : t("viewport.space.world")}
        </button>
        <button
          className={state.showOrigin ? "active" : ""}
          onClick={() => dispatch({ type: "toggleView", view: "origin" })}
          title={t("viewport.toggleOrigin")}
          type="button"
        >
          <Crosshair size={13} />
        </button>
        <button
          className={state.showGuides ? "active" : ""}
          onClick={() => dispatch({ type: "toggleView", view: "guides" })}
          title={t("viewport.toggleGuides")}
          type="button"
        >
          <Scan size={13} />
        </button>
      </div>
      <div
        aria-label={t("viewport.menu.label")}
        className="viewport-space"
        onContextMenu={contextMenu.openFromPointer}
        onKeyDown={contextMenu.openFromKeyboard}
        onPointerDown={(event) => {
          if (viewerReadOnly && event.button === 0 && state.activeTool !== "hand") return;
          if (
            event.button === 0 &&
            ["shape", "ellipse", "pen", "text", "3d"].includes(state.activeTool)
          ) {
            const stage = stageRef.current;
            if (!stage?.contains(event.target as Node)) return;
            const bounds = stage.getBoundingClientRect();
            const point: [number, number, number] = [
              ((event.clientX - bounds.left) / bounds.width) * composition.width,
              ((event.clientY - bounds.top) / bounds.height) * composition.height,
              0,
            ];
            const kind =
              state.activeTool === "text" ? "text" : state.activeTool === "3d" ? "mesh" : "shape";
            const layer = createLayerForComposition(kind, composition, state.currentTime);
            layer.transform.position = point.map((value) => ({
              mode: "static",
              value,
            })) as typeof layer.transform.position;
            if (state.activeTool === "ellipse") {
              setLayerSizeAndCenterAnchor(layer, [480, 480]);
              if (layer.shape) layer.shape.kind = "ellipse";
            }
            if (state.activeTool === "shape") setLayerSizeAndCenterAnchor(layer, [720, 480]);
            if (state.activeTool === "pen") {
              layer.name = t("viewport.penPath");
              setLayerSizeAndCenterAnchor(layer, [760, 480]);
              if (layer.shape) {
                layer.shape.kind = "bezier";
                layer.shape.strokeWidth = 12;
                layer.shape.strokeColor = [0.46, 0.72, 1, 1];
                layer.shape.lineCap = "round";
                layer.shape.lineJoin = "round";
                layer.shape.path = createDefaultBezierPath();
              }
            }
            dispatch({
              type: "operation",
              operations: [{ type: "addLayer", layer }],
              select: [layer.id],
            });
            dispatch({ type: "setActiveTool", tool: "select" });
            return;
          }
          if (
            event.button === 0 &&
            (state.activeTool === "select" || state.activeTool === "rotate")
          ) {
            const stage = stageRef.current;
            if (!stage?.contains(event.target as Node)) return;
            const bounds = stage.getBoundingClientRect();
            const x = ((event.clientX - bounds.left) / bounds.width) * composition.width;
            const y = ((event.clientY - bounds.top) / bounds.height) * composition.height;
            const hit = hitTestLayer(composition, state.project, state.currentTime, x, y);
            const ids = event.shiftKey
              ? hit
                ? state.selection.includes(hit.id)
                  ? state.selection.filter((id) => id !== hit.id)
                  : [...state.selection, hit.id]
                : state.selection
              : hit
                ? [hit.id]
                : [];
            dispatch({ type: "select", ids });
            return;
          }
          if (event.button !== 1 && !(event.button === 0 && state.activeTool === "hand")) return;
          const target = event.currentTarget;
          pan.current = {
            active: true,
            x: event.clientX,
            y: event.clientY,
            left: target.scrollLeft,
            top: target.scrollTop,
          };
          target.setPointerCapture(event.pointerId);
          target.classList.add("panning");
        }}
        onPointerMove={(event) => {
          if (!pan.current.active) return;
          event.currentTarget.scrollLeft = pan.current.left - (event.clientX - pan.current.x);
          event.currentTarget.scrollTop = pan.current.top - (event.clientY - pan.current.y);
        }}
        onPointerUp={(event) => {
          pan.current.active = false;
          event.currentTarget.classList.remove("panning");
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          dispatch({
            type: "setViewportZoom",
            zoom: state.viewportZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
          });
        }}
        role="application"
        /* biome-ignore lint/a11y/noNoninteractiveTabindex: The composition canvas is an application-style keyboard interaction surface. */
        tabIndex={0}
      >
        <div className={`stage-centering ${viewCount === 2 ? "multiview" : ""}`}>
          <div
            className={`composition-stage ${view === "custom" && viewCount === 1 ? "custom-stage" : ""}`}
            ref={stageRef}
            style={{
              height: composition.height * displayZoom,
              width: composition.width * displayZoom,
            }}
          >
            <canvas ref={canvasRef} />
            {state.showGrid && <div className="composition-grid" />}
            {state.showGuides && (
              <div className="safe-guides">
                <span />
              </div>
            )}
            {state.showLayerControls && !state.playing && !viewerReadOnly ? (
              <>
                <ViewportTransformControls
                  activeTool={state.activeTool}
                  composition={composition}
                  dispatch={dispatch}
                  onEditText={beginTextEditing}
                  project={state.project}
                  selection={state.selection}
                  showGuides={state.showGuides}
                  time={state.currentTime}
                  zoom={displayZoom}
                />
                <Viewport3dTransformControls
                  composition={composition}
                  dispatch={dispatch}
                  project={state.project}
                  selection={state.selection}
                  space={space}
                  time={state.currentTime}
                  zoom={displayZoom}
                />
              </>
            ) : null}
            {!viewerReadOnly && editingTextLayer && selectedTransform && (
              <ViewportTextEditor
                label={t("viewport.editText", { name: editingTextLayer.name })}
                layer={editingTextLayer}
                onCancel={cancelTextEditing}
                onChange={previewTextEditing}
                onCommit={finishTextEditing}
                ref={textEditorRef}
                transformMatrix={viewportCssMatrix(selectedTransform, displayZoom)}
                value={textEditSession?.value ?? ""}
                zoom={displayZoom}
              />
            )}
            {state.showLayerControls &&
              !state.playing &&
              !viewerReadOnly &&
              selectedLayer?.kind === "camera" &&
              selectedTransform && (
                <CameraGizmo
                  activeTool={state.activeTool === "rotate" ? "rotate" : "select"}
                  dispatch={dispatch}
                  layer={selectedLayer}
                  project={state.project}
                  time={state.currentTime}
                  transform={selectedTransform}
                  zoom={displayZoom}
                />
              )}
            {state.showOrigin && (
              <div className="viewport-origin">
                <span className="axis x" />
                <span className="axis y" />
              </div>
            )}
          </div>
          {viewCount === 2 && (
            <div
              className="composition-stage custom-stage secondary-stage"
              style={{
                height: composition.height * displayZoom,
                width: composition.width * displayZoom,
              }}
            >
              <canvas ref={mirrorCanvasRef} />
              <span className="view-label">{t("viewport.customView")}</span>
            </div>
          )}
        </div>
      </div>
      {contextMenu.point && (
        <ViewportContextMenu
          bufferView={bufferView}
          canCopyFrame={
            rendererReady &&
            typeof ClipboardItem !== "undefined" &&
            typeof navigator.clipboard?.write === "function"
          }
          canEditComposition={!viewerReadOnly}
          canCropComposition={Boolean(compositionCrop)}
          canExportFrame={rendererReady}
          canInvertSelection={!viewerReadOnly && state.selection.length > 0}
          canSelectChildren={!viewerReadOnly && childLayerIds.length > 0}
          copyFrame={copyFrame}
          copyUnavailableReason={
            rendererReady
              ? t("viewport.menu.clipboardUnavailable")
              : t("viewport.menu.rendererUnavailable")
          }
          cropComposition={() => {
            if (compositionCrop)
              dispatch({ type: "operation", operations: [...compositionCrop.operations] });
          }}
          cropUnavailableReason={t("viewport.menu.cropUnavailable")}
          exportFrame={exportFrame}
          exportUnavailableReason={t("viewport.menu.rendererUnavailable")}
          invertSelection={() => {
            dispatch({
              type: "select",
              ids: composition.layers
                .filter((layer) => !selectedLayerIds.has(layer.id))
                .map((layer) => layer.id),
            });
          }}
          onClose={contextMenu.close}
          openCompositionSettings={() => {
            if (!viewerReadOnly) setCompositionSettingsOpen(true);
          }}
          previewQuality={state.previewQuality}
          revealComposition={() => {
            dispatch({ type: "setLeftTab", tab: "project" });
            workspace.reopen("project");
          }}
          selectChildren={() => {
            const ids = new Set([...state.selection, ...childLayerIds]);
            dispatch({
              type: "select",
              ids: composition.layers.filter((layer) => ids.has(layer.id)).map((layer) => layer.id),
            });
          }}
          setBufferView={setBufferView}
          setPreviewQuality={(quality) => dispatch({ type: "setPreviewQuality", quality })}
          setViewCount={setViewCount}
          setZoom={(zoom) => dispatch({ type: "setViewportZoom", zoom })}
          showGrid={state.showGrid}
          showGuides={state.showGuides}
          showLayerControls={state.showLayerControls}
          showOrigin={state.showOrigin}
          toggleGrid={() => dispatch({ type: "toggleView", view: "grid" })}
          toggleGuides={() => dispatch({ type: "toggleView", view: "guides" })}
          toggleLayerControls={() => dispatch({ type: "toggleView", view: "layerControls" })}
          toggleOrigin={() => dispatch({ type: "toggleView", view: "origin" })}
          viewCount={viewCount}
          x={contextMenu.point.x}
          y={contextMenu.point.y}
          zoom={state.viewportZoom}
        />
      )}
      {compositionSettingsOpen && (
        <Suspense fallback={null}>
          <WorkspaceDialog kind="composition" onClose={() => setCompositionSettingsOpen(false)} />
        </Suspense>
      )}
      <div className="viewport-status">
        <button
          aria-label={t("viewport.zoomOut")}
          onClick={() => dispatch({ type: "setViewportZoom", zoom: state.viewportZoom / 1.15 })}
          type="button"
        >
          <Minus size={11} />
        </button>
        <input
          aria-label={t("viewport.zoom")}
          max={MAX_VIEWPORT_ZOOM}
          min={MIN_VIEWPORT_ZOOM}
          onChange={(event) =>
            dispatch({ type: "setViewportZoom", zoom: Number(event.target.value) })
          }
          step="0.01"
          type="range"
          value={state.viewportZoom}
        />
        <input
          aria-label={t("viewport.zoom")}
          className="zoom-value"
          max={MAX_VIEWPORT_ZOOM * 100}
          min={MIN_VIEWPORT_ZOOM * 100}
          onChange={(event) =>
            dispatch({ type: "setViewportZoom", zoom: event.currentTarget.valueAsNumber / 100 })
          }
          onDoubleClick={() => dispatch({ type: "setViewportZoom", zoom: DEFAULT_VIEWPORT_ZOOM })}
          step="1"
          title={t("viewport.resetZoom")}
          type="number"
          value={viewportZoomPercent(state.viewportZoom)}
        />
        <span aria-hidden="true" className="zoom-value-unit">
          %
        </span>
        <button
          aria-label={t("viewport.zoomIn")}
          onClick={() => dispatch({ type: "setViewportZoom", zoom: state.viewportZoom * 1.15 })}
          type="button"
        >
          <Plus size={11} />
        </button>
        <span>
          {composition.width} × {composition.height} ·{" "}
          {composition.frameRate.numerator / composition.frameRate.denominator} fps
        </span>
        <span className={`renderer-status ${rendererStatus.tone}`} title={rendererStatus.title}>
          <Sparkles size={11} /> {rendererStatus.label}
        </span>
      </div>
    </Panel>
  );
}
export {
  clampScale,
  hitTestLayer,
  rotateViewportPoint,
  safeScaleRatio,
  viewportCssMatrix,
} from "./viewport-geometry";
