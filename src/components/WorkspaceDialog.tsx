import { Gauge, Settings2, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { evaluateExpression } from "../core/expressions";
import { getProperty, type PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { evaluateAnimatable } from "../core/timeline";
import { useEditor } from "../state/editor-store";
import { PluginManager } from "./PluginManager";

export type WorkspaceDialogKind =
  | "preferences"
  | "composition"
  | "expression"
  | "plugins"
  | "shortcuts"
  | "about";

interface WorkspaceDialogProps {
  kind: WorkspaceDialogKind;
  onClose: () => void;
}

const shortcuts = [
  ["V / H / W", "Selection, hand, and rotation tools"],
  ["Q / G / T", "Rectangle, pen path, and text tools"],
  ["Ctrl / Cmd + K", "Open command palette"],
  ["Ctrl / Cmd + Z", "Undo the last operation"],
  ["Ctrl / Cmd + Y", "Redo the last operation"],
  ["Space", "Play or pause the timeline"],
  ["Ctrl / Cmd + wheel", "Zoom the composition freely"],
  ["Middle drag", "Pan the composition canvas"],
] as const;

export function WorkspaceDialog({ kind, onClose }: WorkspaceDialogProps) {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const [name, setName] = useState(composition.name);
  const [width, setWidth] = useState(composition.width);
  const [height, setHeight] = useState(composition.height);
  const [frameRate, setFrameRate] = useState(
    composition.frameRate.numerator / composition.frameRate.denominator,
  );
  const [duration, setDuration] = useState(composition.duration);
  const [autosaveSeconds, setAutosaveSeconds] = useState(() =>
    Number(localStorage.getItem("aster.autosaveSeconds") ?? 30),
  );
  const [previewQuality, setPreviewQuality] = useState(state.previewQuality);
  const [gpuMemoryBudgetMb, setGpuMemoryBudgetMb] = useState(state.gpuMemoryBudgetMb);
  const [reducedMotion, setReducedMotion] = useState(
    () => localStorage.getItem("aster.reducedMotion") === "true",
  );
  const [expressionPath, setExpressionPath] = useState<PropertyPath>("opacity");
  const [expression, setExpression] = useState(selectedLayer?.expressions?.opacity ?? "value");
  const expressionResult = selectedLayer
    ? previewExpression(
        expression,
        evaluateAnimatable(getProperty(selectedLayer, expressionPath), state.currentTime),
        state.currentTime,
      )
    : undefined;

  const saveComposition = () => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCompositionSettings",
          compositionId: composition.id,
          name,
          width,
          height,
          frameRate: { numerator: frameRate * 1000, denominator: 1000 },
          duration,
        },
      ],
    });
    onClose();
  };

  const savePreferences = () => {
    localStorage.setItem("aster.autosaveSeconds", String(autosaveSeconds));
    localStorage.setItem("aster.reducedMotion", String(reducedMotion));
    localStorage.setItem("aster.gpuMemoryBudgetMb", String(gpuMemoryBudgetMb));
    dispatch({ type: "setPreviewQuality", quality: previewQuality });
    dispatch({ type: "setGpuMemoryBudget", budget: gpuMemoryBudgetMb });
    document.documentElement.classList.toggle("reduced-motion", reducedMotion);
    onClose();
  };

  const saveExpression = () => {
    if (!selectedLayer || expressionResult?.error) return;
    dispatch({
      type: "operation",
      operations: [
        { type: "setExpression", layerId: selectedLayer.id, path: expressionPath, expression },
      ],
    });
    onClose();
  };

  const title = {
    preferences: "Preferences",
    composition: "Composition settings",
    expression: "Expression editor",
    plugins: "Plugin manager",
    shortcuts: "Keyboard shortcuts",
    about: "About Aster",
  }[kind];

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label={title} aria-modal="true" className="workspace-dialog" role="dialog">
        <header>
          <strong>{title}</strong>
          <button aria-label={`Close ${title}`} onClick={onClose} type="button">
            <X size={14} />
          </button>
        </header>
        {kind === "composition" && (
          <div className="dialog-form">
            <label className="wide">
              Name
              <input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label>
              Width
              <input
                max={16384}
                min={16}
                onChange={(event) => setWidth(event.currentTarget.valueAsNumber)}
                type="number"
                value={width}
              />
            </label>
            <label>
              Height
              <input
                max={16384}
                min={16}
                onChange={(event) => setHeight(event.currentTarget.valueAsNumber)}
                type="number"
                value={height}
              />
            </label>
            <label>
              Frame rate
              <input
                max={240}
                min={1}
                onChange={(event) => setFrameRate(event.currentTarget.valueAsNumber)}
                step="0.001"
                type="number"
                value={frameRate}
              />
            </label>
            <label>
              Duration (seconds)
              <input
                max={86400}
                min={0.1}
                onChange={(event) => setDuration(event.currentTarget.valueAsNumber)}
                step="0.1"
                type="number"
                value={duration}
              />
            </label>
            <div className="dialog-note wide">
              <Gauge size={15} /> The renderer supports compositions up to the GPU adapter's texture
              limit. Oversized outputs can be tiled by the native render queue.
            </div>
          </div>
        )}
        {kind === "preferences" && (
          <div className="dialog-form preferences-form">
            <label className="wide">
              Preview quality
              <select
                onChange={(event) =>
                  setPreviewQuality(Number(event.target.value) as 1 | 0.5 | 0.25)
                }
                value={previewQuality}
              >
                <option value="1">Full resolution</option>
                <option value="0.5">Half resolution</option>
                <option value="0.25">Quarter resolution</option>
              </select>
            </label>
            <label className="wide">
              Recovery snapshot interval
              <select
                onChange={(event) => setAutosaveSeconds(Number(event.target.value))}
                value={autosaveSeconds}
              >
                <option value="15">15 seconds after editing</option>
                <option value="30">30 seconds after editing</option>
                <option value="60">60 seconds after editing</option>
                <option value="0">Disabled</option>
              </select>
            </label>
            <label className="wide">
              GPU memory budget
              <select
                onChange={(event) =>
                  setGpuMemoryBudgetMb(
                    event.target.value === "auto"
                      ? "auto"
                      : (Number(event.target.value) as 32 | 64 | 128 | 256 | 512),
                  )
                }
                value={gpuMemoryBudgetMb}
              >
                <option value="auto">Auto (512 MB)</option>
                <option value="32">32 MB</option>
                <option value="64">64 MB</option>
                <option value="128">128 MB</option>
                <option value="256">256 MB</option>
                <option value="512">512 MB</option>
              </select>
            </label>
            <label className="dialog-check wide">
              <input
                checked={reducedMotion}
                onChange={(event) => setReducedMotion(event.target.checked)}
                type="checkbox"
              />
              Reduce non-essential interface motion
            </label>
            <div className="dialog-note wide">
              <Settings2 size={15} /> Aster renders through WebGPU whenever the adapter supports it;
              the 2D fallback remains available for recovery and diagnostics.
            </div>
          </div>
        )}
        {kind === "expression" && (
          <div className="expression-form">
            {selectedLayer ? (
              <>
                <div className="expression-target">
                  <strong className="expression-layer-name">{selectedLayer.name}</strong>
                  <select
                    onChange={(event) => {
                      const path = event.target.value as PropertyPath;
                      setExpressionPath(path);
                      setExpression(selectedLayer.expressions?.[path] ?? "value");
                    }}
                    value={expressionPath}
                  >
                    <option value="position.0">Position X</option>
                    <option value="position.1">Position Y</option>
                    <option value="position.2">Position Z</option>
                    <option value="rotation.0">Rotation X</option>
                    <option value="rotation.1">Rotation Y</option>
                    <option value="rotation.2">Rotation Z</option>
                    <option value="scale.0">Scale X</option>
                    <option value="scale.1">Scale Y</option>
                    <option value="scale.2">Scale Z</option>
                    <option value="opacity">Opacity</option>
                  </select>
                </div>
                <textarea
                  aria-label="Expression"
                  onChange={(event) => setExpression(event.target.value)}
                  spellCheck={false}
                  value={expression}
                />
                <div
                  className={
                    expressionResult?.error ? "expression-status error" : "expression-status"
                  }
                >
                  {expressionResult?.error ??
                    `At ${state.currentTime.toFixed(3)}s → ${expressionResult?.value.toFixed(3)}`}
                </div>
                <p>
                  Variables: <code>value</code>, <code>time</code>, <code>pi</code>. Functions:
                  <code> sin cos tan abs sqrt min max pow clamp floor ceil round</code>.
                </p>
              </>
            ) : (
              <div className="dialog-note">Select a layer before adding an expression.</div>
            )}
          </div>
        )}
        {kind === "shortcuts" && (
          <div className="shortcut-list">
            {shortcuts.map(([key, description]) => (
              <div key={key}>
                <kbd>{key}</kbd>
                <span>{description}</span>
              </div>
            ))}
          </div>
        )}
        {kind === "plugins" && <PluginManager />}
        {kind === "about" && (
          <div className="about-dialog">
            <div className="about-mark">A</div>
            <div>
              <h2>Aster 0.2.0</h2>
              <p>GPU-first motion graphics and compositing studio.</p>
              <span className="about-meta">
                React 19 · TypeScript 7 · Tauri 2 · Rust 2024 · WebGPU/WGSL · MPL-2.0
              </span>
            </div>
            <div className="dialog-note">
              <Sparkles size={15} /> HDR scene rendering, schema-driven effects, a structured AI
              operator, and a non-destructive timeline share one open project format.
            </div>
          </div>
        )}
        <footer>
          <button onClick={onClose} type="button">
            {kind === "composition" || kind === "preferences" ? "Cancel" : "Close"}
          </button>
          {kind === "composition" && (
            <button className="primary" onClick={saveComposition} type="button">
              Apply settings
            </button>
          )}
          {kind === "preferences" && (
            <button className="primary" onClick={savePreferences} type="button">
              Save preferences
            </button>
          )}
          {kind === "expression" && selectedLayer && (
            <button
              className="primary"
              disabled={Boolean(expressionResult?.error)}
              onClick={saveExpression}
              type="button"
            >
              Apply expression
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function previewExpression(
  expression: string,
  value: number,
  time: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: evaluateExpression(expression, { value, time }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid expression" };
  }
}
