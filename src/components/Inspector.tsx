import {
  ArrowDown,
  ArrowUp,
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileUp,
  KeyRound,
  Plus,
  RotateCw,
  Scan,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { getProperty, type PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { evaluateAnimatable, evaluateEffectParameter } from "../core/timeline";
import { type BlendMode, createId, type Effect } from "../core/types";
import { parseCubeLutFile } from "../effects/cube-lut";
import { createEffect, EFFECT_BY_TYPE } from "../effects/registry";
import type { EffectParameterDefinition } from "../effects/types";
import { useEditor } from "../state/editor-store";
import { AiPanel } from "./AiPanel";
import { AudioControls } from "./AudioControls";
import { EffectMaskEditor } from "./EffectMaskEditor";
import { Panel, PanelTabs } from "./Panel";
import { Scene3dControls } from "./Scene3dControls";
import { ShapeControls } from "./ShapeControls";
import { TextControls } from "./TextControls";

const fields: { label: string; paths: PropertyPath[]; suffix: string }[] = [
  { label: "Position", paths: ["position.0", "position.1", "position.2"], suffix: "px" },
  { label: "Rotation", paths: ["rotation.0", "rotation.1", "rotation.2"], suffix: "°" },
  { label: "Scale", paths: ["scale.0", "scale.1", "scale.2"], suffix: "%" },
];

export function Inspector() {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  const layer = composition.layers.find((entry) => entry.id === state.selection[0]);
  const [transformOpen, setTransformOpen] = useState(true);
  const [compositingOpen, setCompositingOpen] = useState(false);
  const updateProperty = (path: PropertyPath, value: number) => {
    if (!layer || !Number.isFinite(value)) return;
    dispatch({
      type: "operation",
      operations: [{ type: "setProperty", layerId: layer.id, path, value }],
    });
  };
  const addKeyframe = (path: PropertyPath) => {
    if (!layer) return;
    const value = evaluateAnimatable(getProperty(layer, path), state.currentTime);
    dispatch({
      type: "operation",
      operations: [
        {
          type: "addKeyframe",
          layerId: layer.id,
          path,
          keyframe: {
            id: createId(),
            time: state.currentTime,
            value,
            interpolation: "bezier",
            easing: [0.16, 1, 0.3, 1],
          },
        },
      ],
    });
  };
  const resetTransform = () => {
    if (!layer) return;
    const defaults: [PropertyPath, number][] = [
      ["position.0", composition.width / 2],
      ["position.1", composition.height / 2],
      ["position.2", 0],
      ["rotation.0", 0],
      ["rotation.1", 0],
      ["rotation.2", 0],
      ["scale.0", 100],
      ["scale.1", 100],
      ["scale.2", 100],
      ["opacity", 100],
    ];
    dispatch({
      type: "operation",
      operations: defaults.map(([path, value]) => ({
        type: "setProperty" as const,
        layerId: layer.id,
        path,
        value,
      })),
    });
  };
  return (
    <Panel
      className="inspector-panel"
      tabs={
        <PanelTabs
          active={state.rightTab}
          onChange={(tab) => dispatch({ type: "setRightTab", tab: tab as "properties" | "ai" })}
          tabs={[
            { id: "properties", label: "Properties" },
            { id: "ai", label: "AI Operator" },
          ]}
        />
      }
    >
      {state.rightTab === "ai" ? (
        <AiPanel />
      ) : layer ? (
        <div className="inspector-scroll">
          <div className="selected-layer-card">
            <span className={`layer-kind-icon ${layer.kind}`}>
              <Box size={16} />
            </span>
            <div>
              <strong>{layer.name}</strong>
              <small>
                {layer.kind} layer · {layer.threeDimensional ? "3D" : "2D"}
              </small>
            </div>
            <button
              aria-label={layer.solo ? "Disable solo" : "Solo layer"}
              className={layer.solo ? "active" : ""}
              onClick={() =>
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "solo" }],
                })
              }
              type="button"
            >
              <CircleDot size={14} />
            </button>
          </div>
          <div className="inspector-section">
            <div className="section-title">
              <button
                className="section-toggle"
                onClick={() => setTransformOpen(!transformOpen)}
                type="button"
              >
                {transformOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Transform
              </button>
              <span />
              <button aria-label="Reset transform" onClick={resetTransform} type="button">
                <RotateCw size={12} />
              </button>
            </div>
            {transformOpen && (
              <div className="property-grid">
                {fields.map((field) => (
                  <div className="vector-property" key={field.label}>
                    <div className="property-label">{field.label}</div>
                    <div className="vector-inputs">
                      {field.paths.map((path, index) => (
                        <div className="number-field" key={path}>
                          <span className={`axis-label axis-${index}`}>
                            {["X", "Y", "Z"][index]}
                          </span>
                          <input
                            onChange={(event) => updateProperty(path, Number(event.target.value))}
                            type="number"
                            value={
                              Math.round(
                                evaluateAnimatable(getProperty(layer, path), state.currentTime) *
                                  100,
                              ) / 100
                            }
                          />
                          <small>{field.suffix}</small>
                          <button
                            onClick={() => addKeyframe(path)}
                            title="Add keyframe"
                            type="button"
                          >
                            <KeyRound size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="vector-property">
                  <div className="property-label">Opacity</div>
                  <div className="slider-property">
                    <input
                      max="100"
                      min="0"
                      onChange={(event) => updateProperty("opacity", Number(event.target.value))}
                      type="range"
                      value={evaluateAnimatable(layer.transform.opacity, state.currentTime)}
                    />
                    <input
                      onChange={(event) => updateProperty("opacity", Number(event.target.value))}
                      type="number"
                      value={Math.round(
                        evaluateAnimatable(layer.transform.opacity, state.currentTime),
                      )}
                    />
                    <span>%</span>
                    <button onClick={() => addKeyframe("opacity")} type="button">
                      <KeyRound size={11} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="inspector-section effects-section">
            <div className="section-title static">
              <ChevronDown size={13} /> Effects <span />
              <button onClick={() => addDefaultEffect(layer.id, dispatch)} type="button">
                <Plus size={13} />
              </button>
            </div>
            {layer.effects.length === 0 && (
              <div className="empty-effects">
                <Sparkles size={18} />
                <span>No effects applied</span>
                <small>Use Effects & Presets or click +</small>
              </div>
            )}
            {layer.effects.map((effect) => (
              <EffectEditor effect={effect} key={effect.id} layerId={layer.id} />
            ))}
          </div>
          <div className="inspector-section blend-section">
            <div className="section-title">
              <button
                className="section-toggle"
                onClick={() => setCompositingOpen(!compositingOpen)}
                type="button"
              >
                {compositingOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Compositing
              </button>
            </div>
            {compositingOpen && (
              <div className="compositing-grid">
                <label>
                  Blend mode
                  <select
                    onChange={(event) =>
                      dispatch({
                        type: "operation",
                        operations: [
                          {
                            type: "setBlendMode",
                            layerId: layer.id,
                            blendMode: event.target.value as BlendMode,
                          },
                        ],
                      })
                    }
                    value={layer.blendMode}
                  >
                    <option value="normal">Normal</option>
                    <option value="add">Add</option>
                    <option value="multiply">Multiply</option>
                    <option value="screen">Screen</option>
                    <option value="overlay">Overlay</option>
                  </select>
                </label>
                <label>
                  Parent
                  <select
                    onChange={(event) =>
                      dispatch({
                        type: "operation",
                        operations: [
                          {
                            type: "setParent",
                            layerId: layer.id,
                            parentId: event.target.value || undefined,
                          },
                        ],
                      })
                    }
                    value={layer.parentId ?? ""}
                  >
                    <option value="">None</option>
                    {composition.layers
                      .filter((candidate) => candidate.id !== layer.id)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  In point
                  <input
                    min="0"
                    onChange={(event) =>
                      setLayerTiming(layer.id, Number(event.target.value), layer.outPoint, dispatch)
                    }
                    step="0.01"
                    type="number"
                    value={layer.inPoint}
                  />
                </label>
                <label>
                  Out point
                  <input
                    min={layer.inPoint + 1 / 240}
                    onChange={(event) =>
                      setLayerTiming(layer.id, layer.inPoint, Number(event.target.value), dispatch)
                    }
                    step="0.01"
                    type="number"
                    value={layer.outPoint}
                  />
                </label>
                <label>
                  Source offset
                  <input
                    min="0"
                    onChange={(event) =>
                      dispatch({
                        type: "operation",
                        operations: [
                          {
                            type: "setLayerTimeMapping",
                            layerId: layer.id,
                            offset: Number(event.target.value),
                            stretch: layer.timeStretch ?? 1,
                          },
                        ],
                      })
                    }
                    step="0.01"
                    type="number"
                    value={layer.timeOffset ?? 0}
                  />
                </label>
                <label>
                  Time stretch
                  <input
                    min="1"
                    onChange={(event) =>
                      dispatch({
                        type: "operation",
                        operations: [
                          {
                            type: "setLayerTimeMapping",
                            layerId: layer.id,
                            offset: layer.timeOffset ?? 0,
                            stretch: Number(event.target.value) / 100,
                          },
                        ],
                      })
                    }
                    step="1"
                    type="number"
                    value={(layer.timeStretch ?? 1) * 100}
                  />
                </label>
                <label className="compositing-check">
                  <input
                    checked={Boolean(layer.timeRemap)}
                    onChange={(event) =>
                      dispatch({
                        type: "operation",
                        operations: [
                          {
                            type: "setLayerTimeRemap",
                            layerId: layer.id,
                            value: event.target.checked
                              ? {
                                  mode: "static",
                                  value: evaluateLayerSourceTime(layer, state.currentTime),
                                }
                              : undefined,
                          },
                        ],
                      })
                    }
                    type="checkbox"
                  />
                  Enable time remapping
                </label>
                {layer.timeRemap && (
                  <label>
                    Remapped time
                    <input
                      min="0"
                      onChange={(event) =>
                        dispatch({
                          type: "operation",
                          operations: [
                            {
                              type: "setLayerTimeRemap",
                              layerId: layer.id,
                              value: { mode: "static", value: Number(event.target.value) },
                            },
                          ],
                        })
                      }
                      step="0.01"
                      type="number"
                      value={evaluateAnimatable(layer.timeRemap, state.currentTime)}
                    />
                  </label>
                )}
                <label className="compositing-check">
                  <input
                    checked={layer.threeDimensional}
                    onChange={() =>
                      dispatch({
                        type: "operation",
                        operations: [
                          { type: "toggleLayer", layerId: layer.id, field: "threeDimensional" },
                        ],
                      })
                    }
                    type="checkbox"
                  />
                  Enable 3D layer
                </label>
                <Scene3dControls layer={layer} />
                <ShapeControls layer={layer} />
                <TextControls layer={layer} />
                <AudioControls layer={layer} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="empty-inspector">Select a layer to edit its properties.</div>
      )}
    </Panel>
  );
}

function EffectEditor({ effect, layerId }: { effect: Effect; layerId: string }) {
  const { state, dispatch } = useEditor();
  const [resourceError, setResourceError] = useState<string>();
  const lutPickerRef = useRef<HTMLInputElement>(null);
  const definition = EFFECT_BY_TYPE.get(effect.type);
  const parameters = definition?.parameters ?? fallbackParameters(effect);
  const layerEffects = activeComposition(state.project).layers.find(
    (layer) => layer.id === layerId,
  )?.effects;
  const effectIndex = layerEffects?.findIndex((entry) => entry.id === effect.id) ?? -1;
  const setParameter = (parameter: string, value: number) => {
    if (!Number.isFinite(value)) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setEffectParameterAtTime",
          layerId,
          effectId: effect.id,
          parameter,
          time: state.currentTime,
          value,
          keyframeId: createId(),
        },
      ],
    });
  };
  const toggleParameterKeyframe = (parameter: string, value: number) => {
    const current = effect.parameterKeyframes?.[parameter]?.find(
      (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
    );
    dispatch({
      type: "operation",
      operations: current
        ? [
            {
              type: "removeEffectParameterKeyframe",
              layerId,
              effectId: effect.id,
              parameter,
              keyframeId: current.id,
            },
          ]
        : [
            {
              type: "addEffectParameterKeyframe",
              layerId,
              effectId: effect.id,
              parameter,
              keyframe: {
                id: createId(),
                time: state.currentTime,
                value,
                interpolation: "bezier",
                easing: [0.42, 0, 0.58, 1],
              },
            },
          ],
    });
  };
  const setMask = (mask: Effect["mask"]) =>
    dispatch({
      type: "operation",
      operations: [{ type: "setEffectMask", layerId, effectId: effect.id, mask }],
    });
  return (
    <div className={`effect-editor ${effect.enabled ? "" : "disabled"}`}>
      <div className="effect-title">
        <button
          aria-label={effect.enabled ? "Disable effect" : "Enable effect"}
          className="effect-power"
          onClick={() =>
            dispatch({
              type: "operation",
              operations: [{ type: "toggleEffect", layerId, effectId: effect.id }],
            })
          }
          type="button"
        >
          <Sparkles size={13} />
        </button>
        <strong>{effect.name}</strong>
        <span
          className={`gpu-pill ${definition ? "" : "missing"}`}
          title={definition ? undefined : `Effect provider ${effect.type} is not installed`}
        >
          {definition?.execution.replace("-", " ") ?? "Missing plugin"}
        </span>
        <button
          aria-label={effect.mask ? `Remove ${effect.name} mask` : `Add ${effect.name} mask`}
          className={effect.mask ? "effect-mask-toggle active" : "effect-mask-toggle"}
          onClick={() =>
            setMask(
              effect.mask
                ? undefined
                : {
                    shape: "ellipse",
                    center: [50, 50],
                    size: [55, 55],
                    feather: 24,
                    opacity: 100,
                    invert: false,
                  },
            )
          }
          title={effect.mask ? "Remove local effect mask" : "Add local effect mask"}
          type="button"
        >
          <Scan size={11} />
        </button>
        <button
          aria-label={`Move ${effect.name} up`}
          disabled={effectIndex <= 0}
          onClick={() =>
            dispatch({
              type: "operation",
              operations: [
                { type: "moveEffect", layerId, effectId: effect.id, toIndex: effectIndex - 1 },
              ],
            })
          }
          type="button"
        >
          <ArrowUp size={11} />
        </button>
        <button
          aria-label={`Move ${effect.name} down`}
          disabled={!layerEffects || effectIndex < 0 || effectIndex >= layerEffects.length - 1}
          onClick={() =>
            dispatch({
              type: "operation",
              operations: [
                { type: "moveEffect", layerId, effectId: effect.id, toIndex: effectIndex + 1 },
              ],
            })
          }
          type="button"
        >
          <ArrowDown size={11} />
        </button>
        <button
          aria-label={`Remove ${effect.name}`}
          onClick={() =>
            dispatch({
              type: "operation",
              operations: [{ type: "removeEffect", layerId, effectId: effect.id }],
            })
          }
          type="button"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {effect.mask && <EffectMaskEditor mask={effect.mask} onChange={setMask} />}
      {parameters.map((parameter) => (
        <EffectParameter
          animated={(effect.parameterKeyframes?.[parameter.key]?.length ?? 0) > 0}
          definition={parameter}
          keyframed={
            effect.parameterKeyframes?.[parameter.key]?.some(
              (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
            ) ?? false
          }
          key={parameter.key}
          onChange={(value) => setParameter(parameter.key, value)}
          onToggleKeyframe={(value) => toggleParameterKeyframe(parameter.key, value)}
          value={evaluateEffectParameter(
            effect,
            parameter.key,
            state.currentTime,
            parameter.defaultValue,
          )}
        />
      ))}
      {effect.type === "lut" && (
        <div className="lut-resource-editor">
          <input
            accept=".cube,text/plain"
            aria-label="Choose .cube LUT"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void parseCubeLutFile(file)
                  .then((resource) => {
                    dispatch({
                      type: "operation",
                      operations: [
                        { type: "setEffectLut", layerId, effectId: effect.id, resource },
                      ],
                    });
                    setResourceError(undefined);
                  })
                  .catch((error: unknown) =>
                    setResourceError(error instanceof Error ? error.message : "LUT import failed"),
                  );
              event.target.value = "";
            }}
            ref={lutPickerRef}
            type="file"
          />
          <button onClick={() => lutPickerRef.current?.click()} type="button">
            <FileUp size={12} /> {effect.resource ? "Replace .cube" : "Load .cube LUT"}
          </button>
          {effect.resource && (
            <div className="lut-resource-summary">
              <span title={effect.resource.name}>
                {effect.resource.title || effect.resource.name}
              </span>
              <small>
                {effect.resource.size}³ · {effect.resource.checksum}
              </small>
              <button
                aria-label="Remove LUT resource"
                onClick={() =>
                  dispatch({
                    type: "operation",
                    operations: [
                      { type: "setEffectLut", layerId, effectId: effect.id, resource: undefined },
                    ],
                  })
                }
                type="button"
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
          {resourceError && <small className="lut-resource-error">{resourceError}</small>}
        </div>
      )}
    </div>
  );
}

function EffectParameter({
  definition,
  value,
  onChange,
  onToggleKeyframe,
  animated,
  keyframed,
}: {
  definition: EffectParameterDefinition;
  value: number;
  onChange: (value: number) => void;
  onToggleKeyframe: (value: number) => void;
  animated: boolean;
  keyframed: boolean;
}) {
  if (definition.kind === "texture") {
    return (
      <div className="effect-parameter">
        <span>{definition.label}</span>
        <small title="WGSL effect ABI v1 binds the current layer as the source texture">
          Layer source
        </small>
      </div>
    );
  }
  if (definition.kind === "toggle") {
    return (
      <label className="effect-parameter effect-toggle">
        <span>{definition.label}</span>
        <input
          checked={value > 0.5}
          onChange={(event) => onChange(event.target.checked ? 1 : 0)}
          type="checkbox"
        />
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  if (definition.kind === "choice") {
    return (
      <label className="effect-parameter">
        <span>{definition.label}</span>
        <select onChange={(event) => onChange(Number(event.target.value))} value={value}>
          {definition.options?.map((option, index) => (
            <option key={option} value={index}>
              {option}
            </option>
          ))}
        </select>
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  if (definition.kind === "color") {
    return (
      <label className="effect-parameter effect-color">
        <span>{definition.label}</span>
        <input
          onChange={(event) => onChange(Number.parseInt(event.target.value.slice(1), 16))}
          type="color"
          value={`#${Math.max(0, Math.min(0xffffff, Math.round(value)))
            .toString(16)
            .padStart(6, "0")}`}
        />
        <EffectKeyframeButton
          animated={animated}
          keyframed={keyframed}
          label={definition.label}
          onClick={() => onToggleKeyframe(value)}
        />
      </label>
    );
  }
  return (
    <label className="effect-parameter effect-numeric">
      <span>{definition.label}</span>
      <input
        className="effect-range"
        max={definition.max}
        min={definition.min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={definition.step}
        type="range"
        value={value}
      />
      <span className="effect-value">
        <input
          max={definition.max}
          min={definition.min}
          onChange={(event) => onChange(Number(event.target.value))}
          step={definition.step}
          type="number"
          value={value}
        />
        <small>{definition.unit}</small>
      </span>
      <EffectKeyframeButton
        animated={animated}
        keyframed={keyframed}
        label={definition.label}
        onClick={() => onToggleKeyframe(value)}
      />
    </label>
  );
}

function EffectKeyframeButton({
  animated,
  keyframed,
  label,
  onClick,
}: {
  animated: boolean;
  keyframed: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={`${keyframed ? "Remove" : "Add"} ${label} keyframe`}
      className={`effect-keyframe ${animated ? "animated" : ""} ${keyframed ? "active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <KeyRound size={10} />
    </button>
  );
}

function fallbackParameters(effect: Effect): EffectParameterDefinition[] {
  return Object.keys(effect.parameters).map((key) => ({
    key,
    label: key.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase()),
    kind: "number",
    defaultValue: effect.parameters[key],
    step: 0.1,
  }));
}

function addDefaultEffect(layerId: string, dispatch: ReturnType<typeof useEditor>["dispatch"]) {
  dispatch({
    type: "operation",
    operations: [
      {
        type: "addEffect",
        layerId,
        effect: createEffect("glow"),
      },
    ],
  });
}

function setLayerTiming(
  layerId: string,
  inPoint: number,
  outPoint: number,
  dispatch: ReturnType<typeof useEditor>["dispatch"],
): void {
  if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint)) return;
  dispatch({
    type: "operation",
    operations: [{ type: "setLayerTiming", layerId, inPoint, outPoint }],
  });
}
