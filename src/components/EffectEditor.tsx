import { ArrowDown, ArrowUp, FileUp, Scan, Sparkles, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { activeComposition } from "../core/project";
import { evaluateEffectParameter } from "../core/timeline";
import { createId, type Effect } from "../core/types";
import { parseCubeLutFile } from "../effects/cube-lut";
import { EFFECT_BY_TYPE } from "../effects/registry";
import type { EffectParameterDefinition } from "../effects/types";
import { reportUiError } from "../errors/report-ui-error";
import { type UiErrorCode, uiErrorMessage } from "../i18n/errors";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { EffectMaskEditor } from "./EffectMaskEditor";
import { EffectParameter } from "./EffectParameter";
import type { NumericEditPhase } from "./NumericInput";
import { useInspectorPropertyEdit } from "./use-inspector-property-edit";

export function EffectEditor({ effect, layerId }: { effect: Effect; layerId: string }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [resourceError, setResourceError] = useState<UiErrorCode>();
  const lutPickerRef = useRef<HTMLInputElement>(null);
  const definition = EFFECT_BY_TYPE.get(effect.type);
  const parameters = definition?.parameters ?? fallbackParameters(effect);
  const layerEffects = activeComposition(state.project).layers.find(
    (layer) => layer.id === layerId,
  )?.effects;
  const effectIndex = layerEffects?.findIndex((entry) => entry.id === effect.id) ?? -1;
  const editProperty = useInspectorPropertyEdit();
  const setParameter = (parameter: string, value: number, phase: NumericEditPhase = "commit") => {
    if (!Number.isFinite(value)) return;
    editProperty(
      {
        type: "setEffectParameterAtTime",
        layerId,
        effectId: effect.id,
        parameter,
        time: state.currentTime,
        value,
        keyframeId: createId(),
      },
      phase,
    );
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
          aria-label={effect.enabled ? t("inspector.effect.disable") : t("inspector.effect.enable")}
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
        <strong title={effect.name}>{effect.name}</strong>
        {!definition && (
          <span
            className="gpu-pill missing"
            title={t("inspector.effect.providerMissing", { type: effect.type })}
          >
            {t("inspector.effect.missingPlugin")}
          </span>
        )}
        <button
          aria-label={
            effect.mask
              ? t("inspector.effect.removeMask", { name: effect.name })
              : t("inspector.effect.addMask", { name: effect.name })
          }
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
          title={
            effect.mask ? t("inspector.effect.removeLocalMask") : t("inspector.effect.addLocalMask")
          }
          type="button"
        >
          <Scan size={11} />
        </button>
        <button
          aria-label={t("inspector.effect.moveUp", { name: effect.name })}
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
          aria-label={t("inspector.effect.moveDown", { name: effect.name })}
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
          aria-label={t("inspector.effect.remove", { name: effect.name })}
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
          editTime={state.currentTime}
          keyframed={
            effect.parameterKeyframes?.[parameter.key]?.some(
              (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
            ) ?? false
          }
          key={parameter.key}
          onChange={(value, phase) => setParameter(parameter.key, value, phase)}
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
            aria-label={t("inspector.lut.choose")}
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
                  .catch((error: unknown) => {
                    setResourceError("lutImport");
                    reportUiError(t, "lutImport", error, {
                      scope: {
                        area: "property",
                        layerId,
                        propertyPath: `effects.${effect.id}.lut`,
                      },
                    });
                  });
              event.target.value = "";
            }}
            ref={lutPickerRef}
            type="file"
          />
          <button onClick={() => lutPickerRef.current?.click()} type="button">
            <FileUp size={12} />{" "}
            {effect.resource ? t("inspector.lut.replace") : t("inspector.lut.load")}
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
                aria-label={t("inspector.lut.remove")}
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
          {resourceError && (
            <small className="lut-resource-error">{uiErrorMessage(t, resourceError)}</small>
          )}
        </div>
      )}
    </div>
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
