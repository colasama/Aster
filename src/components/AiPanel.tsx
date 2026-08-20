import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronRight,
  History,
  Loader2,
  Send,
  Settings2,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { planLocalAiOperations } from "../ai/local-planner";
import { buildAiContext } from "../core/ai-context";
import { createLayerForComposition } from "../core/layer-factory";
import type { Operation, PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { createDefaultTextAnimator, normalizeTextAnimatorSettings } from "../core/text-animator";
import { type Composition, createId, type LayerKind } from "../core/types";
import { createEffect, EFFECT_BY_TYPE } from "../effects/registry";
import type { PlainMessageKey, Translate } from "../i18n/core";
import { translateUiMessage, type UiMessageDescriptor, uiError, uiMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

const suggestions = [
  { intent: "Make the title spring in", labelKey: "ai.suggestion.springTitle" },
  { intent: "Add a soft glow to the selection", labelKey: "ai.suggestion.softGlow" },
  { intent: "Stagger the selected layers by 0.08s", labelKey: "ai.suggestion.stagger" },
] as const satisfies readonly { intent: string; labelKey: PlainMessageKey }[];

export function AiPanel() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<{
    summary: string;
    operations: Operation[];
    included: boolean[];
  }>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [provider, setProvider] = useState({
    baseUrl: "https://88996api.cloud/v1",
    apiKey: "",
    model: "deepseek-v4-flash-0731",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiMessageDescriptor>();
  const createPreview = async (intent: string) => {
    const layerId = state.selection[0];
    setError(undefined);
    if ("__TAURI_INTERNALS__" in window && intent.trim()) {
      setLoading(true);
      try {
        const generated = await invoke<{ summary: string; operations: unknown[] }>(
          "generate_ai_plan",
          {
            config: {
              apiKey: provider.apiKey || null,
              baseUrl: provider.baseUrl,
              model: provider.model,
            },
            projectSummary: JSON.stringify(
              buildAiContext(state.project, state.selection, state.currentTime),
            ),
            prompt: intent,
          },
        );
        const operations = normalizeOperations(
          generated.operations,
          composition,
          layerId ?? "",
          state.currentTime,
        );
        if (operations.length === 0)
          throw new Error("The provider returned no supported operations");
        setPreview({
          summary: generated.summary,
          operations,
          included: operations.map(() => true),
        });
        setPrompt("");
        return;
      } catch {
        setError(uiError("aiRequest"));
      } finally {
        setLoading(false);
      }
    }
    const local = planLocalAiOperations(intent, composition, state.selection, state.currentTime);
    if (local.operations.length === 0) {
      setError(uiMessage("ai.localSelectionError"));
      return;
    }
    setPreview({
      summary: local.summary,
      operations: local.operations,
      included: local.operations.map(() => true),
    });
    setPrompt("");
  };
  const composition = activeComposition(state.project);
  return (
    <div className="ai-panel">
      <div className="ai-intro">
        <span>
          <WandSparkles size={18} />
        </span>
        <div>
          <strong>{t("ai.title")}</strong>
          <small>{t("ai.subtitle")}</small>
        </div>
      </div>
      <div className="ai-context">
        <Sparkles size={12} />{" "}
        {t("ai.context", { composition: composition.name, count: state.selection.length })}
        <button
          onClick={() => setProviderOpen(!providerOpen)}
          title={t("ai.providerSettings")}
          type="button"
        >
          <Settings2 size={11} />
        </button>
      </div>
      {providerOpen && (
        <div className="provider-settings">
          <label>
            {t("ai.endpoint")}
            <input
              onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })}
              value={provider.baseUrl}
            />
          </label>
          <label>
            {t("ai.model")}
            <input
              onChange={(event) => setProvider({ ...provider, model: event.target.value })}
              value={provider.model}
            />
          </label>
          <label>
            {t("ai.apiKey")} <small>{t("ai.memoryOnly")}</small>
            <input
              autoComplete="off"
              onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              placeholder={t("ai.apiKeyPlaceholder")}
              type="password"
              value={provider.apiKey}
            />
          </label>
        </div>
      )}
      {error && (
        <div className="ai-error">
          {translateUiMessage(t, error)} · {t("ai.errorFallback")}
        </div>
      )}
      {!preview ? (
        <>
          <div className="ai-suggestions">
            <small>{t("ai.tryOperation")}</small>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.intent}
                onClick={() => void createPreview(suggestion.intent)}
                type="button"
              >
                <span>{t(suggestion.labelKey)}</span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
          <div className="ai-empty">
            <History size={20} />
            {state.auditLog.length > 0 ? (
              <div className="ai-audit-log">
                <strong>{t("ai.recentPlans")}</strong>
                {state.auditLog
                  .slice(-3)
                  .reverse()
                  .map((entry) => (
                    <span key={entry.id}>
                      {entry.summary} ·{" "}
                      {t("ai.operationCount", { count: entry.operationTypes.length })}
                    </span>
                  ))}
              </div>
            ) : (
              <span>{t("ai.auditEmpty")}</span>
            )}
          </div>
        </>
      ) : (
        <div className="operation-preview">
          <div className="preview-heading">
            <Sparkles size={14} />
            <strong>{t("ai.preview")}</strong>
          </div>
          <p>{preview.summary}</p>
          <div className="operation-list">
            {preview.operations.map((operation, index) => (
              <div
                className={preview.included[index] ? "" : "excluded"}
                key={JSON.stringify(operation)}
              >
                <input
                  aria-label={t("ai.includeOperation", { number: index + 1 })}
                  checked={preview.included[index]}
                  onChange={() =>
                    setPreview({
                      ...preview,
                      included: preview.included.map((included, candidate) =>
                        candidate === index ? !included : included,
                      ),
                    })
                  }
                  type="checkbox"
                />
                <span>{index + 1}</span>
                <div className="operation-diff">
                  <code>{operation.type}</code>
                  <small>{describeOperation(operation, composition, t)}</small>
                </div>
                {preview.included[index] && <Check size={12} />}
              </div>
            ))}
          </div>
          <div className="preview-actions">
            <button onClick={() => setPreview(undefined)} type="button">
              <X size={13} /> {t("ai.reject")}
            </button>
            <button
              disabled={!preview.included.some(Boolean)}
              onClick={() => {
                const selected = preview.operations.filter((_, index) => preview.included[index]);
                dispatch({
                  type: "operation",
                  operations: selected,
                  metadata: { source: "ai", summary: preview.summary },
                });
                setPreview(undefined);
              }}
              type="button"
            >
              <Check size={13} /> {t("ai.acceptSelected")}
            </button>
            <button
              className="accept"
              onClick={() => {
                dispatch({
                  type: "operation",
                  operations: preview.operations,
                  metadata: { source: "ai", summary: preview.summary },
                });
                setPreview(undefined);
              }}
              type="button"
            >
              <Check size={13} /> {t("ai.acceptAll")}
            </button>
          </div>
        </div>
      )}
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void createPreview(prompt);
        }}
      >
        <textarea
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("ai.prompt")}
          rows={3}
          value={prompt}
        />
        <div>
          <span>{t("ai.boundary")}</span>
          <button disabled={!prompt.trim() || loading} type="submit">
            {loading ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
          </button>
        </div>
      </form>
    </div>
  );
}

function describeOperation(operation: Operation, composition: Composition, t: Translate): string {
  const layer =
    "layerId" in operation
      ? composition.layers.find((candidate) => candidate.id === operation.layerId)
      : undefined;
  const target =
    layer?.name ?? ("layer" in operation ? operation.layer.name : t("ai.targetComposition"));
  switch (operation.type) {
    case "addLayer":
      return t("ai.operation.addLayer", {
        kind: operation.layer.kind,
        name: operation.layer.name,
      });
    case "removeLayer":
      return t("ai.operation.remove", { target });
    case "renameLayer":
      return `${target} → “${operation.name}”`;
    case "reorderLayer":
      return t("ai.operation.stackIndex", { target, index: operation.index });
    case "setProperty":
      return t("ai.operation.property", { target, path: operation.path, value: operation.value });
    case "addKeyframe":
      return t("ai.operation.keyframe", {
        target,
        path: operation.path,
        time: operation.keyframe.time.toFixed(2),
        value: operation.keyframe.value,
      });
    case "addEffect":
      return t("ai.operation.addEffect", { target, effect: operation.effect.name });
    case "removeEffect":
      return t("ai.operation.removeEffect", { target, id: operation.effectId.slice(0, 8) });
    case "setEffectParameter":
      return t("ai.operation.property", {
        target,
        path: operation.parameter,
        value: String(operation.value),
      });
    case "toggleLayer":
      return t("ai.operation.toggle", { target, field: operation.field });
    case "setTextAnimator":
      return t("ai.operation.stagger", {
        target,
        seconds: operation.textAnimator.stagger.toFixed(2),
      });
    case "easeLayer":
      return t("ai.operation.ease", { target });
    case "setLayerTiming":
      return t("ai.operation.timing", {
        target,
        start: operation.inPoint.toFixed(2),
        end: operation.outPoint.toFixed(2),
      });
    default:
      return t("ai.operation.structured", { target });
  }
}

function normalizeOperations(
  values: unknown[],
  composition: Composition,
  selectedLayerId: string,
  currentTime: number,
): Operation[] {
  const supported: Operation[] = [];
  const layerIds = new Set(composition.layers.map((layer) => layer.id));
  const paths = new Set<PropertyPath>([
    "position.0",
    "position.1",
    "position.2",
    "rotation.0",
    "rotation.1",
    "rotation.2",
    "scale.0",
    "scale.1",
    "scale.2",
    "opacity",
  ]);
  for (const value of values) {
    if (!value || typeof value !== "object" || !("type" in value)) continue;
    const input = value as Record<string, unknown>;
    const layerId = typeof input.layerId === "string" ? input.layerId : selectedLayerId;
    if (input.type !== "addLayer" && !layerIds.has(layerId)) continue;
    if (
      input.type === "setProperty" &&
      typeof input.path === "string" &&
      typeof input.value === "number"
    ) {
      if (paths.has(input.path as PropertyPath)) {
        supported.push({
          type: "setProperty",
          layerId,
          path: input.path as PropertyPath,
          value: input.value,
        });
      }
    } else if (input.type === "addEffect") {
      const raw =
        input.effect && typeof input.effect === "object"
          ? (input.effect as Record<string, unknown>)
          : input;
      const effectType =
        typeof raw.effectType === "string"
          ? raw.effectType
          : typeof raw.type === "string" && raw.type !== "addEffect"
            ? raw.type
            : "glow";
      if (EFFECT_BY_TYPE.has(effectType)) {
        const effect = createEffect(effectType);
        if (typeof raw.name === "string") effect.name = raw.name;
        if (typeof raw.parameters === "object" && raw.parameters) {
          for (const [key, value] of Object.entries(raw.parameters))
            if (typeof value === "number" && Number.isFinite(value)) effect.parameters[key] = value;
        }
        supported.push({
          type: "addEffect",
          layerId,
          effect,
        });
      }
    } else if (input.type === "renameLayer" && typeof input.name === "string") {
      supported.push({ type: "renameLayer", layerId, name: input.name });
    } else if (input.type === "addKeyframe") {
      const path = typeof input.path === "string" ? input.path : "position.1";
      const keyframe =
        input.keyframe && typeof input.keyframe === "object"
          ? (input.keyframe as Record<string, unknown>)
          : input;
      if (paths.has(path as PropertyPath))
        supported.push({
          type: "addKeyframe",
          layerId,
          path: path as PropertyPath,
          keyframe: {
            id: createId(),
            time: typeof keyframe.time === "number" ? Math.max(0, keyframe.time) : currentTime,
            value: typeof keyframe.value === "number" ? keyframe.value : 0,
            interpolation: "bezier",
            easing: [0.16, 1, 0.3, 1],
          },
        });
    } else if (input.type === "addLayer" && typeof input.kind === "string") {
      const kinds = new Set<LayerKind>([
        "shape",
        "text",
        "image",
        "video",
        "mesh",
        "particle",
        "camera",
        "light",
      ]);
      if (!kinds.has(input.kind as LayerKind)) continue;
      const layer = createLayerForComposition(input.kind as LayerKind, composition, currentTime);
      if (typeof input.name === "string") layer.name = input.name;
      if (typeof input.text === "string" && layer.kind === "text") layer.text = input.text;
      supported.push({ type: "addLayer", layer });
      layerIds.add(layer.id);
    } else if (input.type === "removeLayer") {
      supported.push({ type: "removeLayer", layerId });
    } else if (input.type === "reorderLayer" && typeof input.index === "number") {
      supported.push({
        type: "reorderLayer",
        layerId,
        index: Math.max(0, Math.floor(input.index)),
      });
    } else if (
      input.type === "toggleLayer" &&
      typeof input.field === "string" &&
      ["visible", "solo", "locked", "audioEnabled", "threeDimensional"].includes(input.field)
    ) {
      supported.push({
        type: "toggleLayer",
        layerId,
        field: input.field as "visible",
      });
    } else if (input.type === "removeEffect" && typeof input.effectId === "string") {
      const layer = composition.layers.find((candidate) => candidate.id === layerId);
      if (layer?.effects.some((effect) => effect.id === input.effectId))
        supported.push({ type: "removeEffect", layerId, effectId: input.effectId });
    } else if (
      input.type === "setEffectParameter" &&
      typeof input.effectId === "string" &&
      typeof input.parameter === "string" &&
      typeof input.value === "number" &&
      Number.isFinite(input.value)
    ) {
      const layer = composition.layers.find((candidate) => candidate.id === layerId);
      if (layer?.effects.some((effect) => effect.id === input.effectId))
        supported.push({
          type: "setEffectParameter",
          layerId,
          effectId: input.effectId,
          parameter: input.parameter,
          value: input.value,
        });
    } else if (input.type === "setTextAnimator") {
      const layer = composition.layers.find((candidate) => candidate.id === layerId);
      if (layer?.kind !== "text") continue;
      const current = layer.textAnimator ?? createDefaultTextAnimator(true);
      const position = finitePair(input.position) ?? current.position;
      supported.push({
        type: "setTextAnimator",
        layerId,
        textAnimator: normalizeTextAnimatorSettings({
          ...current,
          enabled: typeof input.enabled === "boolean" ? input.enabled : true,
          delay: finiteNumber(input.delay) ?? current.delay,
          stagger: finiteNumber(input.stagger) ?? current.stagger,
          duration: finiteNumber(input.duration) ?? current.duration,
          position,
          scale: finiteNumber(input.scale) ?? current.scale,
          opacity: finiteNumber(input.opacity) ?? current.opacity,
        }),
      });
    }
  }
  return supported;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finitePair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const pair = value.map(finiteNumber);
  return pair.every((entry) => entry !== undefined) ? (pair as [number, number]) : undefined;
}
