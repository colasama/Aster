import { Gauge, Settings2, Sparkles, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { evaluateExpression } from "../../core/animation/expressions";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { getProperty, type PropertyPath } from "../../core/editing/operations";
import { logger } from "../../core/logger";
import { activeComposition } from "../../core/project/project";
import { type AntiAliasingMode, normalizeAntiAliasing } from "../../core/rendering/anti-aliasing";
import { runCpuTask } from "../../core/scheduling/cpu-scheduler";
import type { EnvironmentLighting } from "../../core/types";
import { getPreferences, isDesktopRuntime, updatePreferences } from "../../desktop/api";
import { APP_PREFERENCES_CHANGED_EVENT } from "../../desktop/preferences";
import { reportUiError } from "../../errors/report-ui-error";
import type { Locale, PlainMessageKey, Translate } from "../../i18n/core";
import { type UiErrorCode, uiErrorMessage } from "../../i18n/errors";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { applyBrowserUiScale } from "../../ui/browser-ui-scale";
import { parseUiScale, type UiScale } from "../../ui/ui-scale";
import { normalizeViewportNavigationMode } from "../../ui/viewport-zoom";
import { useDialogFocus } from "../use-dialog-focus";
import { AutomationSettingsPanel } from "./AutomationSettingsPanel";
import { GpuMemoryControls } from "./GpuMemoryControls";

const PluginManager = lazy(() =>
  import("./PluginManager").then((module) => ({ default: module.PluginManager })),
);

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
  ["Wheel / Alt + wheel", "workspace.shortcut.zoom"],
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
  const [viewportNavigationMode, setViewportNavigationMode] = useState(
    state.viewportNavigationMode,
  );
  const [antiAliasing, setAntiAliasing] = useState<AntiAliasingMode>(state.antiAliasing);
  const [gpuMemoryBudgetMb, setGpuMemoryBudgetMb] = useState(state.gpuMemoryBudgetMb);
  const [gpuMemoryValid, setGpuMemoryValid] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(
    () => readPreference("aster.reducedMotion") === "true",
  );
  const [uiScale, setUiScale] = useState<UiScale>(() =>
    parseUiScale(readPreference("aster.uiScale")),
  );
  const [preferredLocale, setPreferredLocale] = useState<Locale>(locale);
  const [expressionPath, setExpressionPath] = useState<PropertyPath>("opacity");
  const [expression, setExpression] = useState(selectedLayer?.expressions?.opacity ?? "value");
  const dialogRef = useDialogFocus<HTMLElement>({ onClose });
  const expressionResult = selectedLayer
    ? previewExpression(
        expression,
        evaluateAnimatable(getProperty(selectedLayer, expressionPath), state.currentTime),
        state.currentTime,
        t,
      )
    : undefined;

  useEffect(() => () => hdrValidationAbort.current?.abort(), []);
  useEffect(() => {
    if (kind !== "preferences" || !isDesktopRuntime()) return;
    void getPreferences()
      .then((preferences) => {
        setAutosaveSeconds(preferences.autosaveSeconds);
        setReducedMotion(preferences.reducedMotion);
        setGpuMemoryBudgetMb(preferences.gpuMemoryBudgetMb);
        setAntiAliasing(normalizeAntiAliasing(preferences.antiAliasing));
        setViewportNavigationMode(
          normalizeViewportNavigationMode(preferences.viewportNavigationMode),
        );
        setUiScale(preferences.uiScale);
        if (preferences.locale) setPreferredLocale(preferences.locale);
      })
      .catch((error: unknown) => logger.warn("preferences", "read_failed", undefined, error));
  }, [kind]);

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
    if (!gpuMemoryValid) return;
    writePreferences([
      ["aster.autosaveSeconds", String(autosaveSeconds)],
      ["aster.reducedMotion", String(reducedMotion)],
      ["aster.gpuMemoryBudgetMb", String(gpuMemoryBudgetMb)],
      ["aster.antiAliasing", antiAliasing],
      ["aster.viewportNavigationMode", viewportNavigationMode],
      ["aster.uiScale", String(uiScale)],
    ]);
    window.dispatchEvent(new Event(APP_PREFERENCES_CHANGED_EVENT));
    dispatch({ type: "setPreviewQuality", quality: previewQuality });
    dispatch({ type: "setGpuMemoryBudget", budget: gpuMemoryBudgetMb });
    dispatch({ type: "setAntiAliasing", mode: antiAliasing });
    dispatch({ type: "setViewportNavigationMode", mode: viewportNavigationMode });
    setLocale(preferredLocale);
    if (isDesktopRuntime())
      void updatePreferences({
        autosaveSeconds: [0, 15, 30, 60].includes(autosaveSeconds)
          ? (autosaveSeconds as 0 | 15 | 30 | 60)
          : 30,
        reducedMotion,
        gpuMemoryBudgetMb,
        antiAliasing,
        viewportNavigationMode,
        uiScale,
        locale: preferredLocale,
      }).catch((error: unknown) => logger.warn("preferences", "write_failed", undefined, error));
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("reduced-motion", reducedMotion);
      if (!isDesktopRuntime()) applyBrowserUiScale(uiScale);
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
      <section
        aria-label={title}
        aria-modal="true"
        className="workspace-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
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
                    .catch((error: unknown) => {
                      if (abort.signal.aborted) return;
                      setEnvironmentError("hdrImport");
                      reportUiError(t, "hdrImport", error, {
                        scope: {
                          area: "asset",
                          compositionId: composition.id,
                          assetName: file.name,
                        },
                      });
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
                <button
                  className="control-button"
                  onClick={() => setEnvironment(undefined)}
                  type="button"
                >
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
              {t("workspace.preferences.viewportNavigation")}
              <select
                onChange={(event) =>
                  setViewportNavigationMode(normalizeViewportNavigationMode(event.target.value))
                }
                value={viewportNavigationMode}
              >
                <option value="smooth">{t("workspace.preferences.navigationSmooth")}</option>
                <option value="legacy">{t("workspace.preferences.navigationLegacy")}</option>
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
              {t("workspace.preferences.uiScale")}
              <select
                onChange={(event) => setUiScale(parseUiScale(event.target.value))}
                value={uiScale}
              >
                <option value="auto">{t("workspace.preferences.uiScaleAuto")}</option>
                <option value="0.75">75%</option>
                <option value="0.875">87.5%</option>
                <option value="1">100%</option>
                <option value="1.125">112.5%</option>
                <option value="1.25">125%</option>
                <option value="1.5">150%</option>
                <option value="1.75">175%</option>
                <option value="2">200%</option>
              </select>
            </label>
            <GpuMemoryControls
              value={gpuMemoryBudgetMb}
              onChange={setGpuMemoryBudgetMb}
              onValidityChange={setGpuMemoryValid}
            />
            <label className="wide">
              {t("workspace.preferences.antiAliasing")}
              <select
                value={antiAliasing}
                onChange={(event) => setAntiAliasing(normalizeAntiAliasing(event.target.value))}
              >
                <option value="off">{t("common.disabled")}</option>
                <option value="fxaa">FXAA</option>
                <option value="ssaa2x">{t("workspace.preferences.ssaa2x")}</option>
                <option value="ssaa4x">{t("workspace.preferences.ssaa4x")}</option>
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
            {window.asterDesktop?.automationSettings && (
              <AutomationSettingsPanel api={window.asterDesktop.automationSettings} />
            )}
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
        {kind === "plugins" && (
          <Suspense fallback={<div className="plugin-manager">{t("plugin.loadingDirectory")}</div>}>
            <PluginManager />
          </Suspense>
        )}
        {kind === "about" && (
          <div className="about-dialog">
            <div className="about-mark">A</div>
            <div>
              <h2>Aster {__APP_VERSION__}</h2>
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
            <button
              className="primary"
              disabled={!gpuMemoryValid}
              onClick={savePreferences}
              type="button"
            >
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
