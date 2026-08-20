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
import { activeComposition } from "../core/project";
import type { FrameRenderSession } from "../core/render-export";
import { evaluateWorldTransform, flattenSceneLayers } from "../core/scene-evaluation";
import { evaluateAnimatable } from "../core/timeline";
import type { GpuDiagnostics, Project } from "../core/types";
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
  const [view, setView] = useState("Active Camera");
  const [viewCount, setViewCount] = useState(1);
  const [bufferView, setBufferView] = useState<BufferVisualization>("beauty");
  const [space, setSpace] = useState<"Local" | "World">("Local");
  const displayZoom = state.viewportZoom * (viewCount === 2 ? 0.5 : 1);
  const pan = useRef({ active: false, x: 0, y: 0, left: 0, top: 0 });
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
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
    canvas.width = preview.width;
    canvas.height = preview.height;
    rendererRef.current?.resize(canvas.width, canvas.height);
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
        console.error(
          error instanceof Error ? error.message : "WebGPU renderer initialization failed",
        );
        return new CanvasFallbackRenderer(canvas);
      })
      .then((renderer) => {
        if (cancelled) return;
        rendererRef.current = renderer;
        setDiagnostics(renderer.diagnostics);
        setRendererReady(true);
        resize();
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
    const metrics = renderer.render(composition, state.currentTime, state.playing, state.project);
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
      canvas.width = composition.width;
      canvas.height = composition.height;
      renderer.resize(composition.width, composition.height);
      let closed = false;
      request.detail.resolve({
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
        close: () => {
          if (closed) return;
          closed = true;
          canvas.width = previewWidth;
          canvas.height = previewHeight;
          renderer.resize(previewWidth, previewHeight);
          if (previewBufferView && renderer instanceof WebGpuRenderer)
            renderer.setBufferVisualization(previewBufferView);
          renderer.render(composition, state.currentTime, false, state.project);
        },
      });
    };
    window.addEventListener("aster:open-render-session", openRenderSession);
    return () => window.removeEventListener("aster:open-render-session", openRenderSession);
  }, [composition, state.currentTime, state.project]);

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
        .then(request.detail.resolve)
        .catch((error: unknown) => {
          console.error(error instanceof Error ? error.message : "GPU benchmark failed");
          request.detail.resolve();
        })
        .finally(() => {
          running = false;
        });
    };
    window.addEventListener("aster:run-gpu-benchmark", runBenchmark);
    return () => window.removeEventListener("aster:run-gpu-benchmark", runBenchmark);
  }, [composition, state.currentTime, state.project]);

  return (
    <Panel
      className="viewport-panel"
      title={`${composition.name}  •  Active Camera`}
      actions={
        <>
          <button
            className={state.showGrid ? "active" : ""}
            onClick={() => dispatch({ type: "toggleView", view: "grid" })}
            title="Toggle composition grid"
            type="button"
          >
            <Grid3X3 size={13} />
          </button>
          <button
            onClick={() => toggleFullscreen(document.querySelector(".viewport-panel"))}
            title="Toggle fullscreen viewport"
            type="button"
          >
            <Maximize2 size={13} />
          </button>
        </>
      }
    >
      <div className="viewport-toolbar">
        <select
          aria-label="Viewport render buffer"
          onChange={(event) => setBufferView(event.target.value as BufferVisualization)}
          title="Visualize the GPU scene buffer"
          value={bufferView}
        >
          {BUFFER_VISUALIZATIONS.map((mode) => (
            <option key={mode} value={mode}>
              {bufferViewLabel(mode)}
            </option>
          ))}
        </select>
        <button
          onClick={() => setView(view === "Active Camera" ? "Custom View" : "Active Camera")}
          title="Switch camera view"
          type="button"
        >
          {viewCount === 2 ? "Active + Custom" : view} <ChevronDown size={11} />
        </button>
        <button
          onClick={() => setViewCount(viewCount === 1 ? 2 : 1)}
          title="Cycle viewport layout"
          type="button"
        >
          {viewCount} {viewCount === 1 ? "View" : "Views"} <ChevronDown size={11} />
        </button>
        <span className="toolbar-gap" />
        <button
          className="active"
          onClick={() => setSpace(space === "Local" ? "World" : "Local")}
          title="Toggle transform coordinate space"
          type="button"
        >
          <Move3D size={13} /> {space}
        </button>
        <button
          className={state.showOrigin ? "active" : ""}
          onClick={() => dispatch({ type: "toggleView", view: "origin" })}
          title="Toggle composition origin"
          type="button"
        >
          <Crosshair size={13} />
        </button>
        <button
          className={state.showGuides ? "active" : ""}
          onClick={() => dispatch({ type: "toggleView", view: "guides" })}
          title="Toggle title/action safe guides"
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
              layer.name = "Pen Path";
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
            className={`composition-stage ${view === "Custom View" && viewCount === 1 ? "custom-stage" : ""}`}
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
              selectedLayer.kind !== "particle" && (
                <button
                  aria-label={`Transform ${selectedLayer.name} in viewport`}
                  className={`selection-bounds ${selectedLayer.locked ? "locked" : ""}`}
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
                    const element = event.currentTarget;
                    const startX = event.clientX;
                    const startY = event.clientY;
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
                    let nextX = initialX;
                    let nextY = initialY;
                    let nextRotation = initialRotation;
                    const move = (moveEvent: PointerEvent) => {
                      if (state.activeTool === "rotate") {
                        const angle = Math.atan2(
                          moveEvent.clientY - centerY,
                          moveEvent.clientX - centerX,
                        );
                        nextRotation = initialRotation + ((angle - startAngle) * 180) / Math.PI;
                        element.style.setProperty("--preview-rotation", `${nextRotation}deg`);
                      } else {
                        nextX = initialX + (moveEvent.clientX - startX) / displayZoom;
                        nextY = initialY + (moveEvent.clientY - startY) / displayZoom;
                        element.style.setProperty("--drag-x", `${moveEvent.clientX - startX}px`);
                        element.style.setProperty("--drag-y", `${moveEvent.clientY - startY}px`);
                      }
                    };
                    const up = () => {
                      window.removeEventListener("pointermove", move);
                      window.removeEventListener("pointerup", up);
                      element.style.removeProperty("--drag-x");
                      element.style.removeProperty("--drag-y");
                      element.style.removeProperty("--preview-rotation");
                      if (state.activeTool === "rotate") {
                        if (Math.abs(nextRotation - initialRotation) < 0.01) return;
                        dispatch({
                          type: "operation",
                          operations: [
                            {
                              type: "setProperty",
                              layerId: selectedLayer.id,
                              path: "rotation.2",
                              value: nextRotation,
                            },
                          ],
                        });
                      } else {
                        if (Math.hypot(nextX - initialX, nextY - initialY) < 0.01) return;
                        dispatch({
                          type: "operation",
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
                  }}
                  style={{
                    height: `${(selectedLayer.size[1] * selectedTransform.scale[1] * displayZoom) / 100}px`,
                    left: `${selectedTransform.position[0] * displayZoom}px`,
                    top: `${selectedTransform.position[1] * displayZoom}px`,
                    transform: `translate(calc(-50% + var(--drag-x, 0px)), calc(-50% + var(--drag-y, 0px))) rotate(var(--preview-rotation, ${selectedTransform.rotation[2]}deg))`,
                    width: `${(selectedLayer.size[0] * selectedTransform.scale[0] * displayZoom) / 100}px`,
                  }}
                  type="button"
                >
                  <i className="handle top-left" />
                  <i className="handle top-right" />
                  <i className="handle bottom-left" />
                  <i className="handle bottom-right" />
                  <i className="anchor-handle" />
                </button>
              )}
            {state.showLayerControls && selectedLayer?.kind === "camera" && selectedTransform && (
              <CameraGizmo
                activeTool={state.activeTool === "rotate" ? "rotate" : "select"}
                dispatch={dispatch}
                layer={selectedLayer}
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
              <span className="view-label">Custom View</span>
            </div>
          )}
        </div>
      </div>
      <div className="viewport-status">
        <button
          aria-label="Zoom out"
          onClick={() => dispatch({ type: "setViewportZoom", zoom: state.viewportZoom / 1.15 })}
          type="button"
        >
          <Minus size={11} />
        </button>
        <input
          aria-label="Viewport zoom"
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
          title="Reset to 22%"
          type="button"
        >
          {Math.round(state.viewportZoom * 100)}%
        </button>
        <button
          aria-label="Zoom in"
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
          className={`renderer-status ${diagnostics?.available ? "gpu" : "fallback"}`}
          title={
            diagnostics?.available
              ? `${diagnostics.description} · ${diagnostics.prewarmedPipelines ?? 0} pipelines asynchronously prewarmed in ${(diagnostics.pipelineCompileMs ?? 0).toFixed(1)} ms`
              : diagnostics?.description
          }
        >
          <Sparkles size={11} />{" "}
          {diagnostics?.available
            ? `WebGPU · ${diagnostics.adapter}`
            : diagnostics
              ? "Compatibility renderer"
              : "Initializing GPU…"}
        </span>
      </div>
    </Panel>
  );
}

function bufferViewLabel(mode: BufferVisualization): string {
  return {
    beauty: "Beauty",
    linearColor: "Linear HDR",
    luminance: "Luminance",
    alpha: "Alpha",
    normal: "Normal",
    objectId: "Object ID",
    materialId: "Material ID",
    worldPosition: "World Position",
    motionVector: "Motion Vector",
  }[mode];
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
    if (layer.kind === "camera" || layer.kind === "particle" || layer.kind === "light")
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
