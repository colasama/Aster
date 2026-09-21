import { ChevronDown, ChevronRight, Timer } from "lucide-react";
import { useState } from "react";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { propertyValueOperationAtTime } from "../../core/editing/property-edit-operation";
import { BLEND_MODES, type BlendMode, createId, type Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useInspectorLayers, valuesDiffer } from "../inspector/inspector-selection";
import { MixedValueSelect } from "../inspector/MixedValueInput";
import { useInspectorPropertyEdit } from "../inspector/use-inspector-property-edit";
import { NumericInput } from "../NumericInput";

export function LayerBlendOptions({ layer }: { layer: Layer }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const edit = useInspectorPropertyEdit();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const opacity = evaluateAnimatable(layer.transform.opacity, state.currentTime);
  return (
    <div className="inspector-section layer-blend-options">
      <div className="section-title">
        <button
          className="section-toggle"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t("inspector.blending.title")}
        </button>
      </div>
      {open && (
        <fieldset className="compositing-grid" disabled={!editable.length}>
          <label>
            {t("inspector.compositing.blendMode")}
            <MixedValueSelect
              mixed={valuesDiffer(layers.map((entry) => entry.blendMode))}
              value={layer.blendMode}
              onChange={(event) =>
                dispatch({
                  type: "operation",
                  operations: editable.map((entry) => ({
                    type: "setBlendMode",
                    layerId: entry.id,
                    blendMode: event.target.value as BlendMode,
                  })),
                })
              }
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`inspector.blend.${mode}`)}
                </option>
              ))}
            </MixedValueSelect>
          </label>
          <label htmlFor={`layer-blend-opacity-${layer.id}`}>
            {t("inspector.transform.opacity")}
            <NumericInput
              id={`layer-blend-opacity-${layer.id}`}
              editTime={state.currentTime}
              min={0}
              max={100}
              mixed={valuesDiffer(
                layers.map((entry) =>
                  evaluateAnimatable(entry.transform.opacity, state.currentTime),
                ),
              )}
              value={opacity}
              onValueChange={(value, phase) =>
                edit(
                  editable.map((entry) =>
                    propertyValueOperationAtTime(entry, "opacity", value, state.currentTime),
                  ),
                  phase,
                )
              }
            />
          </label>
          <button
            className="effect-keyframe"
            type="button"
            aria-label={`${t("inspector.transform.addKeyframe")} ${t("inspector.transform.opacity")}`}
            onClick={() =>
              dispatch({
                type: "operation",
                operations: editable.map((entry) => ({
                  type: "addKeyframe",
                  layerId: entry.id,
                  path: "opacity",
                  keyframe: {
                    id: createId(),
                    time: state.currentTime,
                    value: evaluateAnimatable(entry.transform.opacity, state.currentTime),
                    interpolation: "bezier",
                    easing: [0.42, 0, 0.58, 1],
                  },
                })),
              })
            }
          >
            <Timer size={12} />
          </button>
        </fieldset>
      )}
    </div>
  );
}
