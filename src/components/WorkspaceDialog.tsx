import { Gauge, Settings2, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runCpuTask } from "../core/cpu-scheduler";
import { evaluateExpression } from "../core/expressions";
import { getProperty, type PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { evaluateAnimatable } from "../core/timeline";
import type { EnvironmentLighting } from "../core/types";
import type { Locale, PlainMessageKey, Translate } from "../i18n/core";
import { type UiErrorCode, uiErrorMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
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
  ["V / H / W", "workspace.shortcut.tools"],
  ["Q / G / T", "workspace.shortcut.creation"],
  ["Ctrl / Cmd + K", "workspace.shortcut.palette"],
  ["Ctrl / Cmd + Z", "workspace.shortcut.undo"],
  ["Ctrl / Cmd + Y", "workspace.shortcut.redo"],
  ["Space", "workspace.shortcut.playback"],
  ["Ctrl / Cmd + wheel", "workspace.shortcut.zoom"],
  ["Middle drag", "workspace.shortcut.pan"],
] as const satisfies readonly (readonly [string, PlainMessageKey])[];

export function WorkspaceDialog({ kind, onClose }: WorkspaceDialogProps) {
  const { state, dispatch } = useEditor();
  const { locale, setLocale, t } = useI18n();
  const composition = activeComposition(state.project);
  const selectedLayer = composition.layers.find((layer) => layer.id === state.selection[0]);
  const [name, setName] = useState(composition.name);
  const [width, setWidth] = useState(composition.width);
  const [height, setHeight] = useState(composition.height);
  const [frameRate, setFrameRate] = useState(
    composition.frameRate.numerator / composition.frameRate.denominator,
  );
  const [duration, setDuration] = useState(composition.duration);
  const [environment, setEnvironment] = useState<EnvironmentLighting | undefined>(
    composition.environment,
  );
  const [environmentError, setEnvironmentError] = useState<UiErrorCode>();
  const [environmentValidating, setEnvironmentValidating] = useState(false);
  const hdrValidationAbort = useRef<AbortController | undefined>(undefined);
  const [autosaveSeconds, setAutosaveSeconds] = useState(() =>
    Number(readPreference("aster.autosaveSeconds") ?? 30),
  );
  const [previewQuality, setPreviewQuality] = useState(state.previewQuality);
  const [gpuMemoryBudgetMb, setGpuMemoryBudgetMb] = useState(state.gpuMemoryBudgetMb);
  const [reducedMotion, setReducedMotion] = useState(
    () => readPreference("aster.reducedMotion") === "true",
  );
  const [preferredLocale, setPreferredLocale] = useState<Locale>(locale);
  const [expressionPath, setExpressionPath] = useState<PropertyPath>("opacity");
  const [expression, setExpression] = useState(selectedLayer?.expressions?.opacity ?? "value");
  const expressionResult = selectedLayer
    ? previewExpression(
        expression,
        evaluateAnimatable(getProperty(selectedLayer, expressionPath), state.currentTime),
        state.currentTime,
        t,
      )
    : undefined;

  useEffect(() => () => hdrValidationAbort.current?.abort(), []);

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
        {
          type: "setCompositionEnvironment",
          compositionId: composition.id,
          environment,
        },
      ],
    });
    onClose();
  };

  const savePreferences = () => {
    writePreferences([
      ["aster.autosaveSeconds", String(autosaveSeconds)],
      ["aster.reducedMotion", String(reducedMotion)],
      ["aster.gpuMemoryBudgetMb", String(gpuMemoryBudgetMb)],
    ]);
    dispatch({ type: "setPreviewQuality", quality: previewQuality });
    dispatch({ type: "setGpuMemoryBudget", budget: gpuMemoryBudgetMb });
    setLocale(preferredLocale);
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("reduced-motion", reducedMotion);
    }
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

  const titleKey: Record<WorkspaceDialogKind, PlainMessageKey> = {
    preferences: "workspace.title.preferences",
    composition: "workspace.title.composition",
    expression: "workspace.title.expression",
    plugins: "workspace.title.plugins",
    shortcuts: "workspace.title.shortcuts",
    about: "workspace.title.about",
  };
  const title = t(titleKey[kind]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label={title} aria-modal="true" className="workspace-dialog" role="dialog">
        <header>
          <strong>{title}</strong>
          <button
            aria-label={t("workspace.closeDialog", { title })}
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>
        {kind === "composition" && (
          <div className="dialog-form">
            <label className="wide">
              {t("workspace.composition.name")}
              <input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label>
              {t("workspace.composition.width")}
              <input
                max={16384}
                min={16}
                onChange={(event) => setWidth(event.currentTarget.valueAsNumber)}
                type="number"
                value={width}
              />
            </label>
            <label>
              {t("workspace.composition.height")}
              <input
                max={16384}
                min={16}
                onChange={(event) => setHeight(event.currentTarget.valueAsNumber)}
                type="number"
                value={height}
              />
            </label>
            <label>
              {t("workspace.composition.frameRate")}
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
              {t("workspace.composition.duration")}
              <input
                max={86400}
                min={0.1}
                onChange={(event) => setDuration(event.currentTarget.valueAsNumber)}
                step="0.1"
                type="number"
                value={duration}
              />
            </label>
            <label className="dialog-check wide">
              <input
                checked={environment?.enabled ?? false}
                disabled={!environment}
                onChange={(event) =>
                  setEnvironment((current) =>
                    current ? { ...current, enabled: event.target.checked } : current,
                  )
                }
                type="checkbox"
              />
              {t("workspace.composition.enableEnvironment")}
            </label>
            {environment && (
              <>
                <label>
                  {t("workspace.composition.environmentIntensity")}
                  <input
                    max={32}
                    min={0}
                    onChange={(event) =>
                      setEnvironment({
                        ...environment,
                        intensity: event.currentTarget.valueAsNumber,
                      })
                    }
                    step="0.05"
                    type="number"
                    value={environment.intensity}
                  />
                </label>
                <label>
                  {t("workspace.composition.environmentRotation")}
                  <input
                    max={360}
                    min={-360}
                    onChange={(event) =>
                      setEnvironment({
                        ...environment,
                        rotation: event.currentTarget.valueAsNumber,
                      })
                    }
                    step="1"
                    type="number"
                    value={environment.rotation}
                  />
                </label>
              </>
            )}
            <label className="wide">
              {t("workspace.composition.environmentFile")}
              <input
                accept=".hdr,image/vnd.radiance,image/x-hdr"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  hdrValidationAbort.current?.abort();
                  const abort = new AbortController();
                  hdrValidationAbort.current = abort;
                  setEnvironmentError(undefined);
                  setEnvironmentValidating(true);
                  void readHdrFile(file, abort.signal, t)
                    .then((source) =>
                      setEnvironment({
                        enabled: true,
                        intensity: environment?.intensity ?? 1,
                        rotation: environment?.rotation ?? 0,
                        source,
                      }),
                    )
                    .catch(() => {
                      if (abort.signal.aborted) return;
                      setEnvironmentError("hdrImport");
                    })
                    .finally(() => {
                      if (hdrValidationAbort.current !== abort) return;
                      hdrValidationAbort.current = undefined;
                      setEnvironmentValidating(false);
                    });
                }}
                type="file"
              />
            </label>
            {environmentValidating && (
              <div className="dialog-note wide">
                {t("workspace.composition.validatingEnvironment")}
              </div>
            )}
            {environment && (
              <div className="dialog-note wide">
                <Sparkles size={15} /> {environment.source.name} ·{" "}
                {t("workspace.composition.environmentSummary")}
                <button onClick={() => setEnvironment(undefined)} type="button">
                  {t("common.remove")}
                </button>
              </div>
            )}
            {environmentError && (
              <div className="dialog-note wide">{uiErrorMessage(t, environmentError)}</div>
            )}
            <div className="dialog-note wide">
              <Gauge size={15} /> {t("workspace.composition.gpuLimit")}
            </div>
          </div>
        )}
        {kind === "preferences" && (
          <div className="dialog-form preferences-form">
            <label className="wide">
              {t("workspace.preferences.previewQuality")}
              <select
                onChange={(event) =>
                  setPreviewQuality(Number(event.target.value) as 1 | 0.5 | 0.25)
                }
                value={previewQuality}
              >
                <option value="1">{t("workspace.preferences.fullResolution")}</option>
                <option value="0.5">{t("workspace.preferences.halfResolution")}</option>
                <option value="0.25">{t("workspace.preferences.quarterResolution")}</option>
              </select>
            </label>
            <label className="wide">
              {t("locale.language")}
              <select
                onChange={(event) => setPreferredLocale(event.target.value as Locale)}
                value={preferredLocale}
              >
                <option value="en-US">{t("locale.enUS")}</option>
                <option value="zh-CN">{t("locale.zhCN")}</option>
              </select>
              <small>{t("locale.systemHint")}</small>
            </label>
            <label className="wide">
              {t("workspace.preferences.recoveryInterval")}
              <select
                onChange={(event) => setAutosaveSeconds(Number(event.target.value))}
                value={autosaveSeconds}
              >
                {[15, 30, 60].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t("workspace.preferences.afterEditing", { seconds })}
                  </option>
                ))}
                <option value="0">{t("common.disabled")}</option>
              </select>
            </label>
            <label className="wide">
              {t("workspace.preferences.gpuBudget")}
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
                <option value="auto">{t("workspace.preferences.autoBudget")}</option>
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
              {t("workspace.preferences.reducedMotion")}
            </label>
            <div className="dialog-note wide">
              <Settings2 size={15} /> {t("workspace.preferences.webgpuNote")}
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
                    <option value="position.0">{t("workspace.expression.positionX")}</option>
                    <option value="position.1">{t("workspace.expression.positionY")}</option>
                    <option value="position.2">{t("workspace.expression.positionZ")}</option>
                    <option value="rotation.0">{t("workspace.expression.rotationX")}</option>
                    <option value="rotation.1">{t("workspace.expression.rotationY")}</option>
                    <option value="rotation.2">{t("workspace.expression.rotationZ")}</option>
                    <option value="scale.0">{t("workspace.expression.scaleX")}</option>
                    <option value="scale.1">{t("workspace.expression.scaleY")}</option>
                    <option value="scale.2">{t("workspace.expression.scaleZ")}</option>
                    <option value="opacity">{t("workspace.expression.opacity")}</option>
                  </select>
                </div>
                <textarea
                  aria-label={t("workspace.expression.label")}
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
                    t("workspace.expression.result", {
                      time: state.currentTime.toFixed(3),
                      value: expressionResult?.value.toFixed(3) ?? "—",
                    })}
                </div>
                <p>{t("workspace.expression.help")}</p>
              </>
            ) : (
              <div className="dialog-note">{t("workspace.expression.selectLayer")}</div>
            )}
          </div>
        )}
        {kind === "shortcuts" && (
          <div className="shortcut-list">
            {shortcuts.map(([key, descriptionKey]) => (
              <div key={key}>
                <kbd>{key}</kbd>
                <span>{t(descriptionKey)}</span>
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
              <p>{t("workspace.about.summary")}</p>
              <span className="about-meta">
                React 19 · TypeScript 7 · Electron 43 · Rust 2024 · WebGPU/WGSL · MPL-2.0
              </span>
            </div>
            <div className="dialog-note">
              <Sparkles size={15} /> {t("workspace.about.detail")}
            </div>
          </div>
        )}
        <footer>
          <button onClick={onClose} type="button">
            {kind === "composition" || kind === "preferences"
              ? t("common.cancel")
              : t("common.close")}
          </button>
          {kind === "composition" && (
            <button
              className="primary"
              disabled={environmentValidating}
              onClick={saveComposition}
              type="button"
            >
              {t("workspace.action.applySettings")}
            </button>
          )}
          {kind === "preferences" && (
            <button className="primary" onClick={savePreferences} type="button">
              {t("workspace.action.savePreferences")}
            </button>
          )}
          {kind === "expression" && selectedLayer && (
            <button
              className="primary"
              disabled={Boolean(expressionResult?.error)}
              onClick={saveExpression}
              type="button"
            >
              {t("workspace.action.applyExpression")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

async function readHdrFile(
  file: File,
  signal: AbortSignal,
  t: Translate,
): Promise<EnvironmentLighting["source"]> {
  if (!file.name.toLowerCase().endsWith(".hdr")) throw new Error(t("workspace.error.chooseHdr"));
  if (file.size === 0 || file.size > 48 * 1024 * 1024)
    throw new Error(t("workspace.error.hdrSize"));
  const buffer = await file.arrayBuffer();
  await runCpuTask(
    { kind: "decode-radiance-hdr", metadataOnly: true, source: buffer },
    {
      priority: "interactive",
      requireWorker: true,
      signal,
      timeoutMs: 30_000,
      transfer: [buffer],
    },
  );
  if (signal.aborted) throw new DOMException(t("workspace.error.hdrCancelled"), "AbortError");
  const result = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => {
      reader.abort();
      reject(new DOMException(t("workspace.error.hdrCancelled"), "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    reader.addEventListener("load", () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error(t("workspace.error.readFailed"))),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(t("workspace.error.readFailed"))),
    );
    reader.addEventListener("loadend", () => signal.removeEventListener("abort", cancel));
    reader.readAsDataURL(file);
  });
  const comma = result.indexOf(",");
  if (comma < 0) throw new Error(t("workspace.error.encodeHdr"));
  return {
    name: file.name.slice(0, 512),
    mimeType: "image/vnd.radiance",
    dataUrl: `data:image/vnd.radiance;base64,${result.slice(comma + 1)}`,
  };
}

function previewExpression(
  expression: string,
  value: number,
  time: number,
  t: Translate,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: evaluateExpression(expression, { value, time }) };
  } catch {
    return { error: uiErrorMessage(t, "expression") };
  }
}

function readPreference(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writePreferences(entries: ReadonlyArray<readonly [string, string]>): void {
  if (typeof window === "undefined") return;
  try {
    for (const [key, value] of entries) window.localStorage.setItem(key, value);
  } catch {
    // Preferences still apply to this session when persistent storage is unavailable.
  }
}
