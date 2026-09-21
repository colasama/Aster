import { ChevronDown, ChevronRight, RotateCw, Timer } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useState } from "react";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { getProperty, type Operation, type PropertyPath } from "../../core/editing/operations";
import { propertyValueOperationAtTime } from "../../core/editing/property-edit-operation";
import { solidRenderSize } from "../../core/layers/solid-layer";
import { activeComposition } from "../../core/project/project";
import { createId, type Layer } from "../../core/types";
import type { PlainMessageKey } from "../../i18n/core";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useContextMenuTrigger } from "../context-menu/use-context-menu-trigger";
import { type NumericEditPhase, NumericInput } from "../NumericInput";
import { InspectorPropertyContextMenu } from "./InspectorPropertyContextMenu";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
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

export function InspectorTransformControls({
  layer,
  propertyClipboard,
  setPropertyClipboard,
}: {
  layer: Layer;
  propertyClipboard?: number;
  setPropertyClipboard: (value: number) => void;
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const composition = activeComposition(state.project);
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked && entry.kind !== "adjustment");
  const [transformOpen, setTransformOpen] = useState(true);
  const [propertyMenuTarget, setPropertyMenuTarget] = useState<{
    label: string;
    path: PropertyPath;
  }>();
  const contextMenu = useContextMenuTrigger();
  const editProperty = useInspectorPropertyEdit();
  const valueAt = (entry: Layer, path: PropertyPath) =>
    evaluateAnimatable(getProperty(entry, path), state.currentTime);
  const isMixed = (path: PropertyPath) => valuesDiffer(layers.map((entry) => valueAt(entry, path)));
  const updateProperty = (
    path: PropertyPath,
    value: number,
    phase: NumericEditPhase = "commit",
  ) => {
    if (!Number.isFinite(value)) return;
    editProperty(
      editable.map((entry) => propertyValueOperationAtTime(entry, path, value, state.currentTime)),
      phase,
    );
  };
  const addKeyframe = (path: PropertyPath) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "addKeyframe",
        layerId: entry.id,
        path,
        keyframe: {
          id: createId(),
          time: state.currentTime,
          value: valueAt(entry, path),
          interpolation: "bezier",
          easing: [0.16, 1, 0.3, 1],
        },
      })),
    });
  const propertyDefault = (entry: Layer, path: PropertyPath): number => {
    if (path === "anchor.0") return solidRenderSize(entry)[0] * 0.5;
    if (path === "anchor.1") return solidRenderSize(entry)[1] * 0.5;
    if (path === "position.0") return composition.width / 2;
    if (path === "position.1") return composition.height / 2;
    if (path.startsWith("scale.") || path === "opacity") return 100;
    return 0;
  };
  const resetPaths = (paths: PropertyPath[]) =>
    dispatch({
      type: "operation",
      operations: editable.flatMap((entry) =>
        paths.map((path) =>
          propertyValueOperationAtTime(
            entry,
            path,
            propertyDefault(entry, path),
            state.currentTime,
          ),
        ),
      ),
    });
  const resetTransform = () => resetPaths([...fields.flatMap((field) => field.paths), "opacity"]);
  const openPropertyPointer = (
    event: MouseEvent<HTMLElement>,
    path: PropertyPath,
    label: string,
  ) => {
    setPropertyMenuTarget({ path, label });
    contextMenu.openFromPointer(event);
  };
  const openPropertyKeyboard = (
    event: KeyboardEvent<HTMLElement>,
    path: PropertyPath,
    label: string,
  ) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    setPropertyMenuTarget({ path, label });
    contextMenu.openFromKeyboard(event);
  };
  const keyframeAt = (entry: Layer, path: PropertyPath) => {
    const property = getProperty(entry, path);
    return property.mode === "animated"
      ? property.keyframes.find(
          (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
        )
      : undefined;
  };
  const hasPropertyKeyframe = (path: PropertyPath) =>
    editable.length > 0 && editable.every((entry) => keyframeAt(entry, path));
  return (
    <>
      {layers.every((entry) => entry.kind !== "adjustment") && (
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
              disabled={!editable.length}
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
                          layers.every((entry) => entry.threeDimensional) ||
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
                              onValueChange={(value, phase) => updateProperty(path, value, phase)}
                              disabled={!editable.length}
                              type="number"
                              mixed={isMixed(path)}
                              value={evaluateAnimatable(
                                getProperty(layer, path),
                                state.currentTime,
                              )}
                            />
                            <small>{field.suffix}</small>
                            <button
                              disabled={!editable.length}
                              className={`effect-keyframe ${layers.every((entry) => getProperty(entry, path).mode === "animated") ? "animated" : ""} ${hasPropertyKeyframe(path) ? "active" : ""}`}
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
                    disabled={!editable.length}
                    onContextMenu={(event) =>
                      openPropertyPointer(event, "opacity", t("inspector.transform.opacity"))
                    }
                    onKeyDown={(event) =>
                      openPropertyKeyboard(event, "opacity", t("inspector.transform.opacity"))
                    }
                    type="range"
                    mixed={isMixed("opacity")}
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
                    disabled={!editable.length}
                    type="number"
                    min={0}
                    max={100}
                    mixed={isMixed("opacity")}
                    value={evaluateAnimatable(layer.transform.opacity, state.currentTime)}
                  />
                  <span>%</span>
                  <button
                    disabled={!editable.length}
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
      {propertyMenuTarget && contextMenu.point && (
        <InspectorPropertyContextMenu
          addKeyframe={() => addKeyframe(propertyMenuTarget.path)}
          canEdit={editable.length > 0}
          canCopy={!isMixed(propertyMenuTarget.path)}
          canPaste={propertyClipboard !== undefined}
          copy={() => setPropertyClipboard(valueAt(layer, propertyMenuTarget.path))}
          disabledReason={t("inspector.menu.locked")}
          hasKeyframe={hasPropertyKeyframe(propertyMenuTarget.path)}
          label={propertyMenuTarget.label}
          onClose={contextMenu.close}
          paste={() => {
            if (propertyClipboard !== undefined)
              updateProperty(propertyMenuTarget.path, propertyClipboard);
          }}
          removeKeyframe={() =>
            dispatch({
              type: "operation",
              operations: editable.flatMap((entry): Operation[] => {
                const keyframe = keyframeAt(entry, propertyMenuTarget.path);
                return keyframe
                  ? [
                      {
                        type: "removeKeyframe",
                        layerId: entry.id,
                        path: propertyMenuTarget.path,
                        keyframeId: keyframe.id,
                      },
                    ]
                  : [];
              }),
            })
          }
          reset={() => resetPaths([propertyMenuTarget.path])}
          revealInTimeline={() => dispatch({ type: "setBottomMode", mode: "timeline" })}
          x={contextMenu.point.x}
          y={contextMenu.point.y}
        />
      )}
    </>
  );
}
