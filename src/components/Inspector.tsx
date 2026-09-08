import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  LockKeyhole,
  LockOpen,
  RotateCw,
  Sparkles,
  Timer,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useState } from "react";
import { evaluateLayerSourceTime } from "../core/layer-time";
import { getProperty, type PropertyPath } from "../core/operations";
import { activeComposition } from "../core/project";
import { propertyValueOperationAtTime } from "../core/property-edit-operation";
import { solidRenderSize } from "../core/solid-layer";
import { evaluateAnimatable } from "../core/timeline";
import { createId } from "../core/types";
import type { PlainMessageKey } from "../i18n/core";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { AiPanel } from "./AiPanel";
import { AudioControls } from "./AudioControls";
import { ClonerControls } from "./ClonerControls";
import { useContextMenuTrigger } from "./context-menu/use-context-menu-trigger";
import { EffectEditor } from "./EffectEditor";
import { InspectorPropertyContextMenu } from "./InspectorPropertyContextMenu";
import { LayerBlendOptions } from "./LayerBlendOptions";
import { MotionBlurControls } from "./MotionBlurControls";
import { type NumericEditPhase, NumericInput } from "./NumericInput";
import { Panel, PanelTabs } from "./Panel";
import { Scene3dControls } from "./Scene3dControls";
import { ShapeControls } from "./ShapeControls";
import { SolidControls } from "./SolidControls";
import { TextControls } from "./TextControls";
import { useInspectorPropertyEdit } from "./use-inspector-property-edit";

const fields: { labelKey: PlainMessageKey; paths: PropertyPath[]; suffix: string }[] = [
  {
    labelKey: "inspector.transform.anchorPoint",
    paths: ["anchor.0", "anchor.1", "anchor.2"],
    suffix: "px",
  },
  {
    labelKey: "inspector.transform.position",
    paths: ["position.0", "position.1", "position.2"],
    suffix: "px",
  },
  {
    labelKey: "inspector.transform.rotation",
    paths: ["rotation.0", "rotation.1", "rotation.2"],
    suffix: "°",
  },
  {
    labelKey: "inspector.transform.scale",
    paths: ["scale.0", "scale.1", "scale.2"],
    suffix: "%",
  },
];

export function Inspector() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const layer = composition.layers.find((entry) => entry.id === state.selection[0]);
  const isAdjustment = layer?.kind === "adjustment";
  const [transformOpen, setTransformOpen] = useState(true);
  const [compositingOpen, setCompositingOpen] = useState(false);
  const [propertyClipboard, setPropertyClipboard] = useState<number>();
  const [propertyMenuTarget, setPropertyMenuTarget] = useState<{
    defaultValue: number;
    label: string;
    path: PropertyPath;
    value: number;
  }>();
  const contextMenu = useContextMenuTrigger();
  const editProperty = useInspectorPropertyEdit();
  const updateProperty = (
    path: PropertyPath,
    value: number,
    phase: NumericEditPhase = "commit",
  ) => {
    if (!layer || layer.locked || isAdjustment || !Number.isFinite(value)) return;
    editProperty(propertyValueOperationAtTime(layer, path, value, state.currentTime), phase);
  };
  const addKeyframe = (path: PropertyPath) => {
    if (!layer || layer.locked || isAdjustment) return;
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
    if (!layer || layer.locked || isAdjustment) return;
    const [sourceWidth, sourceHeight] = solidRenderSize(layer);
    const defaults: [PropertyPath, number][] = [
      ["anchor.0", sourceWidth * 0.5],
      ["anchor.1", sourceHeight * 0.5],
      ["anchor.2", 0],
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
      operations: defaults.map(([path, value]) =>
        propertyValueOperationAtTime(layer, path, value, state.currentTime),
      ),
    });
  };
  const propertyDefault = (path: PropertyPath): number => {
    if (path === "anchor.0") return layer ? solidRenderSize(layer)[0] * 0.5 : 0;
    if (path === "anchor.1") return layer ? solidRenderSize(layer)[1] * 0.5 : 0;
    if (path === "position.0") return composition.width / 2;
    if (path === "position.1") return composition.height / 2;
    if (path.startsWith("scale.") || path === "opacity") return 100;
    return 0;
  };
  const setPropertyMenu = (path: PropertyPath, label: string) => {
    if (!layer) return;
    setPropertyMenuTarget({
      defaultValue: propertyDefault(path),
      label,
      path,
      value: evaluateAnimatable(getProperty(layer, path), state.currentTime),
    });
  };
  const openPropertyPointer = (
    event: MouseEvent<HTMLElement>,
    path: PropertyPath,
    label: string,
  ) => {
    setPropertyMenu(path, label);
    contextMenu.openFromPointer(event);
  };
  const openPropertyKeyboard = (
    event: KeyboardEvent<HTMLElement>,
    path: PropertyPath,
    label: string,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    setPropertyMenu(path, label);
    contextMenu.openFromKeyboard(event);
  };
  const hasPropertyKeyframe = (path: PropertyPath): boolean => {
    if (!layer) return false;
    const property = getProperty(layer, path);
    return (
      property.mode === "animated" &&
      property.keyframes.some(
        (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
      )
    );
  };
  return (
    <Panel
      className="inspector-panel"
      tabs={
        <PanelTabs
          active={state.rightTab}
          onChange={(tab) => dispatch({ type: "setRightTab", tab: tab as "properties" | "ai" })}
          tabs={[
            { id: "ai", label: t("inspector.tab.ai") },
            { id: "properties", label: t("inspector.tab.properties") },
          ]}
        />
      }
    >
      {state.rightTab === "ai" ? (
        <AiPanel />
      ) : layer ? (
        <div className="inspector-scroll" key={layer.id}>
          <div className="selected-layer-card">
            <span className={`layer-kind-icon ${layer.kind}`}>
              <Box size={16} />
            </span>
            <div>
              <strong>{layer.name}</strong>
              <small>
                {t("inspector.layerSummary", {
                  kind: layer.kind,
                  dimension: layer.threeDimensional ? "3D" : "2D",
                })}
              </small>
            </div>
            <button
              aria-label={layer.visible ? t("inspector.visible.hide") : t("inspector.visible.show")}
              className={layer.visible ? "active" : ""}
              onClick={() =>
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "visible" }],
                })
              }
              type="button"
            >
              {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <button
              aria-label={layer.solo ? t("inspector.solo.disable") : t("inspector.solo.enable")}
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
            <button
              aria-label={layer.locked ? t("inspector.lock.unlock") : t("inspector.lock.lock")}
              className={layer.locked ? "active" : ""}
              onClick={() =>
                dispatch({
                  type: "operation",
                  operations: [{ type: "toggleLayer", layerId: layer.id, field: "locked" }],
                })
              }
              type="button"
            >
              {layer.locked ? <LockKeyhole size={14} /> : <LockOpen size={14} />}
            </button>
          </div>
          {!isAdjustment && (
            <div className="inspector-section">
              <div className="section-title">
                <button
                  className="section-toggle"
                  aria-expanded={transformOpen}
                  onClick={() => setTransformOpen(!transformOpen)}
                  type="button"
                >
                  {transformOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{" "}
                  {t("inspector.transform.title")}
                </button>
                <span />
                <button
                  aria-label={t("inspector.transform.reset")}
                  disabled={layer.locked}
                  onClick={resetTransform}
                  type="button"
                >
                  <RotateCw size={12} />
                </button>
              </div>
              {transformOpen && (
                <div className="property-grid">
                  {fields.map((field) => (
                    <div className="vector-property" key={field.labelKey}>
                      <div className="property-label">{t(field.labelKey)}</div>
                      <div className="vector-inputs">
                        {field.paths
                          .filter(
                            (path) =>
                              layer.threeDimensional ||
                              (path.startsWith("rotation.")
                                ? path.endsWith(".2")
                                : !path.endsWith(".2")),
                          )
                          .map((path) => {
                            const index = Number(path.slice(-1));
                            return (
                              <div className="number-field" key={path}>
                                <span className={`axis-label axis-${index}`}>
                                  {["X", "Y", "Z"][index]}
                                </span>
                                <NumericInput
                                  editTime={state.currentTime}
                                  aria-label={`${t(field.labelKey)} ${["X", "Y", "Z"][index]}`}
                                  onContextMenu={(event) =>
                                    openPropertyPointer(
                                      event,
                                      path,
                                      `${t(field.labelKey)} ${["X", "Y", "Z"][index]}`,
                                    )
                                  }
                                  onKeyDown={(event) =>
                                    openPropertyKeyboard(
                                      event,
                                      path,
                                      `${t(field.labelKey)} ${["X", "Y", "Z"][index]}`,
                                    )
                                  }
                                  onValueChange={(value, phase) =>
                                    updateProperty(path, value, phase)
                                  }
                                  disabled={layer.locked}
                                  type="number"
                                  value={evaluateAnimatable(
                                    getProperty(layer, path),
                                    state.currentTime,
                                  )}
                                />
                                <small>{field.suffix}</small>
                                <button
                                  disabled={layer.locked}
                                  className={`effect-keyframe ${getProperty(layer, path).mode === "animated" ? "animated" : ""} ${hasPropertyKeyframe(path) ? "active" : ""}`}
                                  aria-label={`${t("inspector.transform.addKeyframe")} ${t(field.labelKey)} ${["X", "Y", "Z"][index]}`}
                                  onClick={() => addKeyframe(path)}
                                  title={t("inspector.transform.addKeyframe")}
                                  type="button"
                                >
                                  <Timer size={10} />
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  ))}
                  <div className="vector-property">
                    <div className="property-label">{t("inspector.transform.opacity")}</div>
                    <div className="slider-property">
                      <NumericInput
                        editTime={state.currentTime}
                        aria-label={t("inspector.transform.opacity")}
                        max={100}
                        min={0}
                        onValueChange={(value, phase) => updateProperty("opacity", value, phase)}
                        disabled={layer.locked}
                        onContextMenu={(event) =>
                          openPropertyPointer(event, "opacity", t("inspector.transform.opacity"))
                        }
                        onKeyDown={(event) =>
                          openPropertyKeyboard(event, "opacity", t("inspector.transform.opacity"))
                        }
                        type="range"
                        value={evaluateAnimatable(layer.transform.opacity, state.currentTime)}
                      />
                      <NumericInput
                        editTime={state.currentTime}
                        aria-label={t("inspector.transform.opacity")}
                        onContextMenu={(event) =>
                          openPropertyPointer(event, "opacity", t("inspector.transform.opacity"))
                        }
                        onKeyDown={(event) =>
                          openPropertyKeyboard(event, "opacity", t("inspector.transform.opacity"))
                        }
                        onValueChange={(value, phase) => updateProperty("opacity", value, phase)}
                        disabled={layer.locked}
                        type="number"
                        min={0}
                        max={100}
                        value={evaluateAnimatable(layer.transform.opacity, state.currentTime)}
                      />
                      <span>%</span>
                      <button
                        disabled={layer.locked}
                        aria-label={`${t("inspector.transform.addKeyframe")} ${t("inspector.transform.opacity")}`}
                        className={`effect-keyframe ${hasPropertyKeyframe("opacity") ? "active" : ""}`}
                        onClick={() => addKeyframe("opacity")}
                        type="button"
                      >
                        <Timer size={11} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {!isAdjustment && <LayerBlendOptions layer={layer} />}
          <MotionBlurControls composition={composition} layer={layer} />
          <fieldset className="inspector-section effects-section" disabled={layer.locked}>
            <div className="section-title static">
              <ChevronDown size={13} /> {t("inspector.effects.title")} <span />
            </div>
            {layer.effects.length === 0 && (
              <div className="empty-effects">
                <Sparkles size={18} />
                <span>{t("inspector.effects.empty")}</span>
              </div>
            )}
            {layer.effects.map((effect) => (
              <EffectEditor effect={effect} key={effect.id} layerId={layer.id} />
            ))}
          </fieldset>
          {isAdjustment ? (
            <div className="inspector-section blend-section">
              <div className="section-title">
                <button
                  className="section-toggle"
                  onClick={() => setCompositingOpen(!compositingOpen)}
                  type="button"
                >
                  {compositingOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t("inspector.compositing.adjustmentTiming")}
                </button>
              </div>
              {compositingOpen && (
                <fieldset className="compositing-grid" disabled={layer.locked}>
                  <label>
                    {t("inspector.compositing.inPoint")}
                    <input
                      min="0"
                      onChange={(event) =>
                        setLayerTiming(
                          layer.id,
                          Number(event.target.value),
                          layer.outPoint,
                          dispatch,
                        )
                      }
                      step="0.01"
                      type="number"
                      value={layer.inPoint}
                    />
                  </label>
                  <label>
                    {t("inspector.compositing.outPoint")}
                    <input
                      min={layer.inPoint + 1 / 240}
                      onChange={(event) =>
                        setLayerTiming(
                          layer.id,
                          layer.inPoint,
                          Number(event.target.value),
                          dispatch,
                        )
                      }
                      step="0.01"
                      type="number"
                      value={layer.outPoint}
                    />
                  </label>
                </fieldset>
              )}
            </div>
          ) : (
            <div className="inspector-section blend-section">
              <div className="section-title">
                <button
                  className="section-toggle"
                  onClick={() => setCompositingOpen(!compositingOpen)}
                  type="button"
                >
                  {compositingOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t("inspector.compositing.title")}
                </button>
              </div>
              {compositingOpen && (
                <fieldset className="compositing-grid" disabled={layer.locked}>
                  <label>
                    {t("inspector.compositing.parent")}
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
                      <option value="">{t("common.none")}</option>
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
                    {t("inspector.compositing.inPoint")}
                    <input
                      min="0"
                      onChange={(event) =>
                        setLayerTiming(
                          layer.id,
                          Number(event.target.value),
                          layer.outPoint,
                          dispatch,
                        )
                      }
                      step="0.01"
                      type="number"
                      value={layer.inPoint}
                    />
                  </label>
                  <label>
                    {t("inspector.compositing.outPoint")}
                    <input
                      min={layer.inPoint + 1 / 240}
                      onChange={(event) =>
                        setLayerTiming(
                          layer.id,
                          layer.inPoint,
                          Number(event.target.value),
                          dispatch,
                        )
                      }
                      step="0.01"
                      type="number"
                      value={layer.outPoint}
                    />
                  </label>
                  <label>
                    {t("inspector.compositing.sourceOffset")}
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
                    {t("inspector.compositing.timeStretch")}
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
                    {t("inspector.compositing.enableRemap")}
                  </label>
                  {layer.timeRemap && (
                    <label>
                      {t("inspector.compositing.remappedTime")}
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
                    {t("inspector.compositing.enable3d")}
                  </label>
                  <Scene3dControls layer={layer} />
                  <ShapeControls layer={layer} />
                  <SolidControls layer={layer} />
                  <ClonerControls layer={layer} />
                  <TextControls layer={layer} />
                  <AudioControls layer={layer} />
                </fieldset>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="empty-inspector">{t("inspector.empty")}</div>
      )}
      {layer && propertyMenuTarget && contextMenu.point && (
        <InspectorPropertyContextMenu
          addKeyframe={() => addKeyframe(propertyMenuTarget.path)}
          canEdit={!layer.locked && !isAdjustment}
          canPaste={propertyClipboard !== undefined}
          copy={() => setPropertyClipboard(propertyMenuTarget.value)}
          disabledReason={
            layer.locked ? t("inspector.menu.locked") : t("inspector.menu.unsupported")
          }
          hasKeyframe={hasPropertyKeyframe(propertyMenuTarget.path)}
          label={propertyMenuTarget.label}
          onClose={contextMenu.close}
          paste={() => {
            if (propertyClipboard !== undefined)
              updateProperty(propertyMenuTarget.path, propertyClipboard);
          }}
          removeKeyframe={() => {
            const property = getProperty(layer, propertyMenuTarget.path);
            if (property.mode !== "animated") return;
            const keyframe = property.keyframes.find(
              (entry) => Math.abs(entry.time - state.currentTime) <= 0.000_001,
            );
            if (!keyframe) return;
            dispatch({
              type: "operation",
              operations: [
                {
                  type: "removeKeyframe",
                  layerId: layer.id,
                  path: propertyMenuTarget.path,
                  keyframeId: keyframe.id,
                },
              ],
            });
          }}
          reset={() => updateProperty(propertyMenuTarget.path, propertyMenuTarget.defaultValue)}
          revealInTimeline={() => {
            dispatch({ type: "select", ids: [layer.id] });
            dispatch({ type: "setBottomMode", mode: "timeline" });
          }}
          x={contextMenu.point.x}
          y={contextMenu.point.y}
        />
      )}
    </Panel>
  );
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
