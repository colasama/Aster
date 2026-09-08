import { ChevronDown, ChevronRight, Timer } from "lucide-react";
import { useState } from "react";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { propertyValueOperationAtTime } from "../../core/editing/property-edit-operation";
import { BLEND_MODES, type BlendMode, createId, type Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useInspectorPropertyEdit } from "../inspector/use-inspector-property-edit";
import { NumericInput } from "../NumericInput";

export function LayerBlendOptions({ layer }: { layer: Layer }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const edit = useInspectorPropertyEdit();
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
        <fieldset className="compositing-grid" disabled={layer.locked}>
          <label>
            {t("inspector.compositing.blendMode")}
            <select
              value={layer.blendMode}
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
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`inspector.blend.${mode}`)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`layer-blend-opacity-${layer.id}`}>
            {t("inspector.transform.opacity")}
            <NumericInput
              id={`layer-blend-opacity-${layer.id}`}
              editTime={state.currentTime}
              min={0}
              max={100}
              value={opacity}
              onValueChange={(value, phase) =>
                edit(
                  propertyValueOperationAtTime(layer, "opacity", value, state.currentTime),
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
                operations: [
                  {
                    type: "addKeyframe",
                    layerId: layer.id,
                    path: "opacity",
                    keyframe: {
                      id: createId(),
                      time: state.currentTime,
                      value: opacity,
                      interpolation: "bezier",
                      easing: [0.42, 0, 0.58, 1],
                    },
                  },
                ],
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
