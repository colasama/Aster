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
import { createLayerForComposition } from "../core/layer-factory";
import type { Operation, PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { type Composition, createId, type LayerKind } from "../core/types";
import { createEffect, EFFECT_BY_TYPE } from "../effects/registry";
import { useEditor } from "../state/editor-store";

const suggestions = [
  "Make the title spring in",
  "Add a soft glow to the selection",
  "Stagger the selected layers by 0.08s",
];

export function AiPanel() {
  const { state, dispatch } = useEditor();
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<{ summary: string; operations: Operation[] }>();
  const [providerOpen, setProviderOpen] = useState(false);
  const [provider, setProvider] = useState({
    baseUrl: "https://88996api.cloud/v1",
    apiKey: "",
    model: "deepseek-v4-flash-0731",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const createPreview = async (intent: string) => {
    const layerId = state.selection[0];
    if (!layerId) return;
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
            projectSummary: JSON.stringify({
              composition: {
                duration: composition.duration,
                frameRate: composition.frameRate,
                id: composition.id,
                layers: composition.layers.map((layer) => ({
                  effects: layer.effects.map((effect) => ({ id: effect.id, type: effect.type })),
                  id: layer.id,
                  kind: layer.kind,
                  name: layer.name,
                })),
                name: composition.name,
              },
              currentTime: state.currentTime,
              selectedLayerIds: state.selection,
            }),
            prompt: intent,
          },
        );
        const operations = normalizeOperations(
          generated.operations,
          composition,
          layerId,
          state.currentTime,
        );
        if (operations.length === 0)
          throw new Error("The provider returned no supported operations");
        setPreview({ summary: generated.summary, operations });
        setPrompt("");
        return;
      } catch (providerError) {
        setError(providerError instanceof Error ? providerError.message : String(providerError));
      } finally {
        setLoading(false);
      }
    }
    const lowered = intent.toLowerCase();
    const operations: Operation[] = [];
    if (lowered.includes("glow")) {
      operations.push({
        type: "addEffect",
        layerId,
        effect: {
          id: createId(),
          type: "glow",
          name: "AI Glow",
          enabled: true,
          parameters: { radius: 64, intensity: 1.35 },
        },
      });
    } else {
      operations.push(
        {
          type: "addKeyframe",
          layerId,
          path: "position.1",
          keyframe: {
            id: createId(),
            time: state.currentTime,
            value: 1320,
            interpolation: "bezier",
            easing: [0.16, 1, 0.3, 1],
          },
        },
        {
          type: "addKeyframe",
          layerId,
          path: "position.1",
          keyframe: {
            id: createId(),
            time: state.currentTime + 0.9,
            value: 900,
            interpolation: "bezier",
            easing: [0.16, 1, 0.3, 1],
          },
        },
      );
    }
    setPreview({ summary: intent || "Animate selected layer", operations });
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
          <strong>Aster Operator</strong>
          <small>Structured operations · Preview before apply</small>
        </div>
      </div>
      <div className="ai-context">
        <Sparkles size={12} /> Context: {composition.name} · {state.selection.length} layer selected
        <button
          onClick={() => setProviderOpen(!providerOpen)}
          title="AI provider settings"
          type="button"
        >
          <Settings2 size={11} />
        </button>
      </div>
      {providerOpen && (
        <div className="provider-settings">
          <label>
            Endpoint
            <input
              onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })}
              value={provider.baseUrl}
            />
          </label>
          <label>
            Model
            <input
              onChange={(event) => setProvider({ ...provider, model: event.target.value })}
              value={provider.model}
            />
          </label>
          <label>
            API key <small>memory only</small>
            <input
              autoComplete="off"
              onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              placeholder="Uses ASTER_AI_API_KEY when empty"
              type="password"
              value={provider.apiKey}
            />
          </label>
        </div>
      )}
      {error && (
        <div className="ai-error">{error} · Local planning fallback is still available.</div>
      )}
      {!preview ? (
        <>
          <div className="ai-suggestions">
            <small>TRY AN OPERATION</small>
            {suggestions.map((suggestion) => (
              <button key={suggestion} onClick={() => void createPreview(suggestion)} type="button">
                <span>{suggestion}</span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
          <div className="ai-empty">
            <History size={20} />
            {state.auditLog.length > 0 ? (
              <div className="ai-audit-log">
                <strong>Recent accepted plans</strong>
                {state.auditLog
                  .slice(-3)
                  .reverse()
                  .map((entry) => (
                    <span key={entry.id}>
                      {entry.summary} · {entry.operationTypes.length} operations
                    </span>
                  ))}
              </div>
            ) : (
              <span>Every AI change is auditable, replayable, and undoable.</span>
            )}
          </div>
        </>
      ) : (
        <div className="operation-preview">
          <div className="preview-heading">
            <Sparkles size={14} />
            <strong>Operation preview</strong>
          </div>
          <p>{preview.summary}</p>
          <div className="operation-list">
            {preview.operations.map((operation, index) => (
              <div key={JSON.stringify(operation)}>
                <span>{index + 1}</span>
                <code>{operation.type}</code>
                <Check size={12} />
              </div>
            ))}
          </div>
          <div className="preview-actions">
            <button onClick={() => setPreview(undefined)} type="button">
              <X size={13} /> Reject
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
              <Check size={13} /> Accept all
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
          placeholder="Describe an editable motion change…"
          rows={3}
          value={prompt}
        />
        <div>
          <span>Operations only · no destructive pixel edits</span>
          <button disabled={!prompt.trim() || loading} type="submit">
            {loading ? <Loader2 className="spin" size={14} /> : <Send size={14} />}
          </button>
        </div>
      </form>
    </div>
  );
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
    }
  }
  return supported;
}
