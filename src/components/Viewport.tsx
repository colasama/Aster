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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLayerForComposition } from "../core/layer-factory";
import { logger } from "../core/logger";
import type { Operation } from "../core/operations";
import { activeComposition } from "../core/project";
import type { FrameRenderSession } from "../core/render-export";
import { evaluateWorldTransform, flattenSceneLayers } from "../core/scene-evaluation";
import { evaluateAnimatable } from "../core/timeline";
import type { Composition, GpuDiagnostics, Project } from "../core/types";
import type { PlainMessageKey, Translate } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { CanvasFallbackRenderer } from "../renderer/canvas-fallback";
import { type GpuBenchmarkRequest, runGpuBenchmark } from "../renderer/gpu-benchmark";
import { calculatePreviewSize } from "../renderer/preview-size";
import { BUFFER_VISUALIZATIONS, type BufferVisualization } from "../renderer/render-buffers";
import { createDefaultBezierPath } from "../renderer/vector-path";
import { WebGpuRenderer } from "../renderer/webgpu-renderer";
import { useEditor } from "../state/editor-store";
import { CameraGizmo } from "./CameraGizmo";
import { Panel } from "./Panel";

type Renderer = WebGpuRenderer | CanvasFallbackRenderer;

export function Viewport() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | undefined>(undefined);
  const previewQualityRef = useRef(state.previewQuality);
  const lastMetricUpdate = useRef(0);
  const hasGpuPassMetrics = useRef(false);
  const [diagnostics, setDiagnostics] = useState<GpuDiagnostics>();
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererRevision, setRendererRevision] = useState(0);
  const [view, setView] = useState<"active" | "custom">("active");
  const [viewCount, setViewCount] = useState(1);
  const [bufferView, setBufferView] = useState<BufferVisualization>("beauty");
  const [space, setSpace] = useState<"local" | "world">("local");
  const [editingTextLayerId, setEditingTextLayerId] = useState<string>();
  const textEditRef = useRef<
    | {
        historyBase: Project;
        initialText: string;
        value: string;
      }
    | undefined
  >(undefined);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const displayZoom = state.viewportZoom * (viewCount === 2 ? 0.5 : 1);
  const pan = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const editingTextLayer =
    editingTextLayerId === selectedLayer?.id && selectedLayer?.kind === "text"
      ? selectedLayer
      : undefined;
  const selectedTransform = useMemo(
    () =>
      selectedLayer
        ? evaluateWorldTransform(selectedLayer, composition, state.currentTime)
        : undefined,
    [composition, selectedLayer, state.currentTime],
  );
  const resize = useCallback(() => {
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
    canvas.width = preview.width;
    canvas.height = preview.height;
    rendererRef.current?.resize(preview.width, preview.height);
    setRendererRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    previewQualityRef.current = state.previewQuality;
    resize();
  }, [resize, state.previewQuality]);

  useEffect(() => {
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
        if (cancelled) return;
        logger.info("viewport", "renderer_ready", {
          backend: renderer instanceof WebGpuRenderer ? "webgpu" : "canvas2d",
          adapter: renderer.diagnostics.adapter,
        });
        rendererRef.current = renderer;
        setDiagnostics(renderer.diagnostics);
        resize();
        renderer.resize(canvas.width, canvas.height);
        setRendererReady(true);
      });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [resize]);

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
    const renderer = rendererRef.current;
    if (!renderer) return;
    const metrics = renderer.render(
      composition,
      state.currentTime,
      state.playing,
      state.project,
      state.selection[0],
    );
    syncMirrorCanvas(canvasRef.current, mirrorCanvasRef.current);
    const now = performance.now();
    const firstPassBreakdown = Boolean(metrics.passTimings) && !hasGpuPassMetrics.current;
    if (firstPassBreakdown) hasGpuPassMetrics.current = true;
    if (now - lastMetricUpdate.current > 200 || firstPassBreakdown) {
      lastMetricUpdate.current = now;
      dispatch({ type: "setMetrics", metrics });
    }
  }, [
    composition,
    dispatch,
    rendererReady,
    rendererRevision,
    state.currentTime,
    state.playing,
    state.selection,
    viewCount,
    state.project,
  ]);

  useEffect(() => {
    const openRenderSession = (event: Event) => {
      const request = event as CustomEvent<{
        resolve: (session?: FrameRenderSession) => void;
      }>;
      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !renderer) {
        request.detail.resolve();
        return;
      }
      const previewWidth = canvas.width;
      const previewHeight = canvas.height;
      const previewBufferView =
        renderer instanceof WebGpuRenderer ? renderer.bufferVisualization : undefined;
      if (renderer instanceof WebGpuRenderer) renderer.setBufferVisualization("beauty");
      const synchronizeVideo = compositionContainsVideo(composition, state.project);
      canvas.width = composition.width;
      canvas.height = composition.height;
      renderer.resize(composition.width, composition.height);
      let closed = false;
      request.detail.resolve({
        rawPixelFormat:
          renderer instanceof WebGpuRenderer ? renderer.exportPixelFormat : ("rgba" as const),
        maxInFlightFrames: renderer instanceof WebGpuRenderer && !synchronizeVideo ? 3 : 1,
        renderFrame: async (time) => {
          if (closed) throw new Error("Render session is already closed");
          renderer.render(composition, time, false, state.project);
          await renderer.complete();
          const blob = await new Promise<Blob | undefined>((resolveBlob) =>
            canvas.toBlob((value) => resolveBlob(value ?? undefined), "image/png"),
          );
          if (!blob) throw new Error("Renderer did not encode a PNG frame");
          return blob;
        },
        renderRawFrame: async (time) => {
          if (closed) throw new Error("Render session is already closed");
          if (renderer instanceof WebGpuRenderer)
            return renderer.renderRawFrame(composition, time, state.project, synchronizeVideo);
          renderer.render(composition, time, false, state.project);
          await renderer.complete();
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas fallback pixels are unavailable");
          const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
          return { pixels: new Uint8Array(source).slice().buffer, pixelFormat: "rgba" };
        },
        close: () => {
          if (closed) return;
          closed = true;
          canvas.width = previewWidth;
          canvas.height = previewHeight;
          renderer.resize(previewWidth, previewHeight);
          if (previewBufferView && renderer instanceof WebGpuRenderer)
            renderer.setBufferVisualization(previewBufferView);
          renderer.render(composition, state.currentTime, false, state.project, state.selection[0]);
        },
      });
    };
    window.addEventListener("aster:open-render-session", openRenderSession);
    return () => window.removeEventListener("aster:open-render-session", openRenderSession);
  }, [composition, state.currentTime, state.project, state.selection]);

  useEffect(() => {
    let running = false;
    const runBenchmark = (event: Event) => {
      const request = event as CustomEvent<GpuBenchmarkRequest>;
      const canvas = canvasRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !renderer || running) {
        request.detail.resolve();
        return;
      }
      running = true;
      const benchmarkStartedAt = performance.now();
      logger.info("gpu_benchmark", "started", { sampleFrames: request.detail.sampleFrames });
      void runGpuBenchmark(
        renderer,
        canvas,
        composition,
        state.project,
        state.currentTime,
        renderer.diagnostics.adapter,
        renderer.diagnostics.architecture,
        request.detail.sampleFrames,
        request.detail.onProgress,
      )
        .then((report) => {
          logger.info("gpu_benchmark", "completed", {
            sampleFrames: request.detail.sampleFrames,
            durationMs: performance.now() - benchmarkStartedAt,
          });
          request.detail.resolve(report);
        })
        .catch((error: unknown) => {
          logger.error("gpu_benchmark", "failed", error, {
            sampleFrames: request.detail.sampleFrames,
            durationMs: performance.now() - benchmarkStartedAt,
          });
          request.detail.resolve();
        })
        .finally(() => {
          running = false;
        });
    };
    window.addEventListener("aster:run-gpu-benchmark", runBenchmark);
    return () => window.removeEventListener("aster:run-gpu-benchmark", runBenchmark);
  }, [composition, state.currentTime, state.project]);

  useEffect(() => {
    if (editingTextLayerId) textEditorRef.current?.focus();
  }, [editingTextLayerId]);

  const beginTextEditing = (layerId: string) => {
    const layer = composition.layers.find((candidate) => candidate.id === layerId);
    if (layer?.kind !== "text" || layer.locked) return;
    textEditRef.current = {
      historyBase: state.project,
      initialText: layer.text ?? "",
      value: layer.text ?? "",
    };
    setEditingTextLayerId(layerId);
  };
  const finishTextEditing = () => {
    const edit = textEditRef.current;
    const layerId = editingTextLayerId;
    textEditRef.current = undefined;
    setEditingTextLayerId(undefined);
    if (!edit || !layerId || edit.value === edit.initialText) return;
    dispatch({
      type: "operation",
      historyBase: edit.historyBase,
      operations: [{ type: "setTextContent", layerId, text: edit.value }],
    });
  };
  const cancelTextEditing = () => {
    const edit = textEditRef.current;
    const layerId = editingTextLayerId;
    textEditRef.current = undefined;
    setEditingTextLayerId(undefined);
    if (!edit || !layerId || edit.value === edit.initialText) return;
    dispatch({
      type: "previewOperation",
      operations: [{ type: "setTextContent", layerId, text: edit.initialText }],
    });
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
        className="viewport-space"
        onPointerDown={(event) => {
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
              layer.size = [480, 480];
              if (layer.shape) layer.shape.kind = "ellipse";
            }
            if (state.activeTool === "shape") layer.size = [720, 480];
            if (state.activeTool === "pen") {
              layer.name = t("viewport.penPath");
              layer.size = [760, 480];
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
            dispatch({ type: "select", ids: hit ? [hit.id] : [] });
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
            {state.showLayerControls &&
              selectedLayer &&
              selectedTransform &&
              selectedLayer.kind !== "camera" &&
              selectedLayer.kind !== "adjustment" && (
                <button
                  aria-label={t("viewport.transformLayer", { name: selectedLayer.name })}
                  className={`selection-bounds ${selectedLayer.locked ? "locked" : ""}`}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    beginTextEditing(selectedLayer.id);
                  }}
                  onKeyDown={(event) => {
                    if (selectedLayer.locked || !event.key.startsWith("Arrow")) return;
                    event.preventDefault();
                    const amount = event.shiftKey ? 10 : 1;
                    const x = evaluateAnimatable(
                      selectedLayer.transform.position[0],
                      state.currentTime,
                    );
                    const y = evaluateAnimatable(
                      selectedLayer.transform.position[1],
                      state.currentTime,
                    );
                    dispatch({
                      type: "operation",
                      operations: [
                        {
                          type: "setProperty",
                          layerId: selectedLayer.id,
                          path: "position.0",
                          value:
                            x +
                            (event.key === "ArrowLeft"
                              ? -amount
                              : event.key === "ArrowRight"
                                ? amount
                                : 0),
                        },
                        {
                          type: "setProperty",
                          layerId: selectedLayer.id,
                          path: "position.1",
                          value:
                            y +
                            (event.key === "ArrowUp"
                              ? -amount
                              : event.key === "ArrowDown"
                                ? amount
                                : 0),
                        },
                      ],
                    });
                  }}
                  onPointerDown={(event) => {
                    if (selectedLayer.locked) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const startX = event.clientX;
                    const startY = event.clientY;
                    const pointerId = event.pointerId;
                    const scaleHandle = (event.target as HTMLElement).closest<HTMLElement>(
                      "[data-scale-handle]",
                    )?.dataset.scaleHandle;
                    const rotateHandle = Boolean(
                      (event.target as HTMLElement).closest("[data-rotate-handle]"),
                    );
                    const mode =
                      rotateHandle || state.activeTool === "rotate"
                        ? "rotate"
                        : scaleHandle
                          ? "scale"
                          : "move";
                    const historyBase = state.project;
                    const initialX = evaluateAnimatable(
                      selectedLayer.transform.position[0],
                      state.currentTime,
                    );
                    const initialY = evaluateAnimatable(
                      selectedLayer.transform.position[1],
                      state.currentTime,
                    );
                    const initialRotation = evaluateAnimatable(
                      selectedLayer.transform.rotation[2],
                      state.currentTime,
                    );
                    const initialScaleX = evaluateAnimatable(
                      selectedLayer.transform.scale[0],
                      state.currentTime,
                    );
                    const initialScaleY = evaluateAnimatable(
                      selectedLayer.transform.scale[1],
                      state.currentTime,
                    );
                    const bounds = stageRef.current?.getBoundingClientRect();
                    const centerX = bounds
                      ? bounds.left +
                        (selectedTransform.position[0] / composition.width) * bounds.width
                      : startX;
                    const centerY = bounds
                      ? bounds.top +
                        (selectedTransform.position[1] / composition.height) * bounds.height
                      : startY;
                    const startAngle = Math.atan2(startY - centerY, startX - centerX);
                    const startLocal = rotateViewportPoint(
                      startX - centerX,
                      startY - centerY,
                      -initialRotation,
                    );
                    let nextX = initialX;
                    let nextY = initialY;
                    let nextRotation = initialRotation;
                    let nextScaleX = initialScaleX;
                    let nextScaleY = initialScaleY;
                    const move = (moveEvent: PointerEvent) => {
                      if (moveEvent.pointerId !== pointerId) return;
                      let operations: Operation[];
                      if (mode === "rotate") {
                        const angle = Math.atan2(
                          moveEvent.clientY - centerY,
                          moveEvent.clientX - centerX,
                        );
                        nextRotation = initialRotation + ((angle - startAngle) * 180) / Math.PI;
                        operations = [
                          {
                            type: "setProperty",
                            layerId: selectedLayer.id,
                            path: "rotation.2",
                            value: nextRotation,
                          },
                        ];
                      } else if (mode === "scale") {
                        const local = rotateViewportPoint(
                          moveEvent.clientX - centerX,
                          moveEvent.clientY - centerY,
                          -initialRotation,
                        );
                        const uniform = moveEvent.shiftKey;
                        const ratioX = safeScaleRatio(local[0], startLocal[0]);
                        const ratioY = safeScaleRatio(local[1], startLocal[1]);
                        const uniformRatio = Math.abs(ratioX) > Math.abs(ratioY) ? ratioX : ratioY;
                        nextScaleX = clampScale(initialScaleX * (uniform ? uniformRatio : ratioX));
                        nextScaleY = clampScale(initialScaleY * (uniform ? uniformRatio : ratioY));
                        operations = [
                          {
                            type: "setProperty",
                            layerId: selectedLayer.id,
                            path: "scale.0",
                            value: nextScaleX,
                          },
                          {
                            type: "setProperty",
                            layerId: selectedLayer.id,
                            path: "scale.1",
                            value: nextScaleY,
                          },
                        ];
                      } else {
                        nextX = initialX + (moveEvent.clientX - startX) / displayZoom;
                        nextY = initialY + (moveEvent.clientY - startY) / displayZoom;
                        operations = [
                          {
                            type: "setProperty",
                            layerId: selectedLayer.id,
                            path: "position.0",
                            value: nextX,
                          },
                          {
                            type: "setProperty",
                            layerId: selectedLayer.id,
                            path: "position.1",
                            value: nextY,
                          },
                        ];
                      }
                      dispatch({ type: "previewOperation", operations });
                    };
                    const up = (upEvent: PointerEvent) => {
                      if (upEvent.pointerId !== pointerId) return;
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                      window.removeEventListener("pointercancel", up);
                      if (mode === "rotate") {
                        if (Math.abs(nextRotation - initialRotation) < 0.01) return;
                        dispatch({
                          type: "operation",
                          historyBase,
                          operations: [
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "rotation.2",
                              value: nextRotation,
                            },
                          ],
                        });
                      } else if (mode === "scale") {
                        if (
                          Math.hypot(nextScaleX - initialScaleX, nextScaleY - initialScaleY) < 0.01
                        )
                          return;
                        dispatch({
                          type: "operation",
                          historyBase,
                          operations: [
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "scale.0",
                              value: nextScaleX,
                            },
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "scale.1",
                              value: nextScaleY,
                            },
                          ],
                        });
                      } else {
                        if (Math.hypot(nextX - initialX, nextY - initialY) < 0.01) return;
                        dispatch({
                          type: "operation",
                          historyBase,
                          operations: [
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "position.0",
                              value: nextX,
                            },
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "position.1",
                              value: nextY,
                            },
                          ],
                        });
                      }
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up);
                    window.addEventListener("pointercancel", up);
                  }}
                  style={{
                    height: `${(selectedLayer.size[1] * Math.abs(selectedTransform.scale[1]) * displayZoom) / 100}px`,
                    left: `${selectedTransform.position[0] * displayZoom}px`,
                    top: `${selectedTransform.position[1] * displayZoom}px`,
                    transform: `translate(-50%, -50%) rotate(${selectedTransform.rotation[2]}deg)`,
                    width: `${(selectedLayer.size[0] * Math.abs(selectedTransform.scale[0]) * displayZoom) / 100}px`,
                  }}
                  type="button"
                >
                  <i className="rotation-stem" />
                  <i className="rotation-handle" data-rotate-handle />
                  <i className="handle top-left" data-scale-handle="top-left" />
                  <i className="handle top-right" data-scale-handle="top-right" />
                  <i className="handle bottom-left" data-scale-handle="bottom-left" />
                  <i className="handle bottom-right" data-scale-handle="bottom-right" />
                  <i className="anchor-handle" />
                </button>
              )}
            {editingTextLayer && selectedTransform && (
              <textarea
                aria-label={t("viewport.editText", { name: editingTextLayer.name })}
                className="viewport-text-editor"
                maxLength={20_000}
                onBlur={finishTextEditing}
                onChange={(event) => {
                  if (!textEditRef.current) return;
                  textEditRef.current.value = event.target.value;
                  dispatch({
                    type: "previewOperation",
                    operations: [
                      {
                        type: "setTextContent",
                        layerId: editingTextLayer.id,
                        text: event.target.value,
                      },
                    ],
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTextEditing();
                  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    finishTextEditing();
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
                ref={textEditorRef}
                spellCheck="true"
                style={{
                  color: cssColor(editingTextLayer.color),
                  fontFamily: editingTextLayer.textStyle?.fontFamily,
                  fontSize: `${(editingTextLayer.textStyle?.fontSize ?? 144) * displayZoom}px`,
                  fontWeight: editingTextLayer.textStyle?.fontWeight,
                  height: `${(editingTextLayer.size[1] * Math.abs(selectedTransform.scale[1]) * displayZoom) / 100}px`,
                  left: `${selectedTransform.position[0] * displayZoom}px`,
                  lineHeight: `${(editingTextLayer.textStyle?.leading ?? 172) * displayZoom}px`,
                  textAlign: editingTextLayer.textStyle?.alignment ?? "center",
                  top: `${selectedTransform.position[1] * displayZoom}px`,
                  transform: `translate(-50%, -50%) rotate(${selectedTransform.rotation[2]}deg)`,
                  width: `${(editingTextLayer.size[0] * Math.abs(selectedTransform.scale[0]) * displayZoom) / 100}px`,
                }}
                value={editingTextLayer.text ?? ""}
              />
            )}
            {state.showLayerControls && selectedLayer?.kind === "camera" && selectedTransform && (
              <CameraGizmo
                activeTool={state.activeTool === "rotate" ? "rotate" : "select"}
                dispatch={dispatch}
                layer={selectedLayer}
                project={state.project}
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
          max="1"
          min="0.05"
          onChange={(event) =>
            dispatch({ type: "setViewportZoom", zoom: Number(event.target.value) })
          }
          step="0.01"
          type="range"
          value={state.viewportZoom}
        />
        <button
          className="zoom-value"
          onClick={() => dispatch({ type: "setViewportZoom", zoom: 0.22 })}
          title={t("viewport.resetZoom")}
          type="button"
        >
          {Math.round(state.viewportZoom * 100)}%
        </button>
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
        <span
          className={`renderer-status ${
            diagnostics?.materialResourceError
              ? "resource-error"
              : diagnostics?.available
                ? "gpu"
                : "fallback"
          }`}
          title={
            diagnostics?.materialResourceError
              ? t("viewport.gpuResourceError")
              : diagnostics?.available
                ? t("viewport.gpuDetails", {
                    adapter: diagnostics.adapter,
                    count: diagnostics.prewarmedPipelines ?? 0,
                    ms: (diagnostics.pipelineCompileMs ?? 0).toFixed(1),
                  })
                : diagnostics
                  ? t("viewport.compatibility")
                  : t("viewport.initializing")
          }
        >
          <Sparkles size={11} />{" "}
          {diagnostics?.materialResourceError
            ? t("viewport.gpuResourceError")
            : diagnostics?.available
              ? t("viewport.webgpu", { adapter: diagnostics.adapter })
              : diagnostics
                ? t("viewport.compatibility")
                : t("viewport.initializing")}
        </span>
      </div>
    </Panel>
  );
}

function bufferViewLabel(mode: BufferVisualization, t: Translate): string {
  const keys: Record<BufferVisualization, PlainMessageKey> = {
    beauty: "viewport.buffer.beauty",
    linearColor: "viewport.buffer.linearColor",
    luminance: "viewport.buffer.luminance",
    alpha: "viewport.buffer.alpha",
    depthFog: "viewport.buffer.depthFog",
    depthOfField: "viewport.buffer.depthOfField",
    selectionIsolation: "viewport.buffer.selectionIsolation",
    vectorMotionBlur: "viewport.buffer.vectorMotionBlur",
    normal: "viewport.buffer.normal",
    objectId: "viewport.buffer.objectId",
    materialId: "viewport.buffer.materialId",
    worldPosition: "viewport.buffer.worldPosition",
    motionVector: "viewport.buffer.motionVector",
  };
  return t(keys[mode]);
}

function syncMirrorCanvas(
  source: HTMLCanvasElement | null,
  target: HTMLCanvasElement | null,
): void {
  if (!source || !target) return;
  if (target.width !== source.width) target.width = source.width;
  if (target.height !== source.height) target.height = source.height;
  requestAnimationFrame(() => target.getContext("2d")?.drawImage(source, 0, 0));
}

function toggleFullscreen(element: Element | null): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (element instanceof HTMLElement) void element.requestFullscreen();
}

function hitTestLayer(
  composition: ReturnType<typeof activeComposition>,
  project: Project,
  time: number,
  x: number,
  y: number,
) {
  const hit = flattenSceneLayers(composition, project, time).find((scene) => {
    const { layer, transform } = scene;
    if (layer.kind === "camera" || layer.kind === "light" || layer.kind === "adjustment")
      return false;
    const radians = (-transform.rotation[2] * Math.PI) / 180;
    const deltaX = x - transform.position[0];
    const deltaY = y - transform.position[1];
    const localX = deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
    const localY = deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
    const halfWidth = (layer.size[0] * Math.abs(transform.scale[0])) / 200;
    const halfHeight = (layer.size[1] * Math.abs(transform.scale[1])) / 200;
    return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
  });
  return hit ? composition.layers.find((layer) => layer.id === hit.selectionId) : undefined;
}

export function rotateViewportPoint(x: number, y: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [
    x * Math.cos(radians) - y * Math.sin(radians),
    x * Math.sin(radians) + y * Math.cos(radians),
  ];
}

export function safeScaleRatio(value: number, origin: number): number {
  return Math.abs(origin) < 0.5 ? 1 : value / origin;
}

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 100;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.max(0.1, Math.min(10_000, Math.abs(value)));
}

function cssColor(color: readonly [number, number, number, number]): string {
  const channels = color.map((value, index) =>
    index === 3
      ? Math.max(0, Math.min(1, value))
      : Math.round(Math.max(0, Math.min(1, value)) * 255),
  );
  return `rgba(${channels.join(", ")})`;
}

function compositionContainsVideo(
  composition: Composition,
  project: Project,
  visited = new Set<string>(),
): boolean {
  if (visited.has(composition.id)) return false;
  visited.add(composition.id);
  return composition.layers.some((layer) => {
    if (layer.kind === "video") return true;
    if (layer.kind !== "precomposition" || !layer.sourceCompositionId) return false;
    const source = project.compositions.find(
      (candidate) => candidate.id === layer.sourceCompositionId,
    );
    return source ? compositionContainsVideo(source, project, visited) : false;
  });
}
