import { ArrowDown, ArrowUp, FileUp, Scan, Sparkles, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { evaluateEffectParameter } from "../../core/animation/timeline";
import type { Operation } from "../../core/editing/operations";
import { activeComposition } from "../../core/project/project";
import { createId, type Effect } from "../../core/types";
import { EFFECT_BY_TYPE } from "../../effects/registry";
import { parseCubeLutFile } from "../../effects/resources/cube-lut";
import type { EffectParameterDefinition } from "../../effects/types";
import { reportUiError } from "../../errors/report-ui-error";
import { type UiErrorCode, uiErrorMessage } from "../../i18n/errors";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import type { NumericEditPhase } from "../NumericInput";
import { EffectMaskEditor } from "./EffectMaskEditor";
import { EffectParameter } from "./EffectParameter";
import type { EffectTarget } from "./effect-selection";
import { valuesDiffer } from "./inspector-selection";
import { useInspectorPropertyEdit } from "./use-inspector-property-edit";

export function EffectEditor({
  effect,
  layerId,
  targets: selection,
}: {
  effect: Effect;
  layerId: string;
  targets?: readonly EffectTarget[];
}) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [resourceError, setResourceError] = useState<UiErrorCode>();
  const lutPickerRef = useRef<HTMLInputElement>(null);
  const definition = EFFECT_BY_TYPE.get(effect.type);
  const parameters = definition?.parameters ?? fallbackParameters(effect);
  const layer = activeComposition(state.project).layers.find((entry) => entry.id === layerId);
  const targets = selection ?? (layer ? [{ layer, effect }] : []);
  const editable = targets.filter((entry) => !entry.layer.locked);
  const allEnabled = targets.every((entry) => entry.effect.enabled);
  const allMasked = targets.every((entry) => entry.effect.mask);
  const hasResource = targets.some((entry) => entry.effect.resource);
  const hasKeyframe = (entry: Effect, parameter: string) =>
    entry.parameterKeyframes?.[parameter]?.find(
      (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
    );
  const update = (operation: (entry: EffectTarget) => Operation) =>
    dispatch({ type: "operation", operations: editable.map(operation) });
  const canMove = (direction: -1 | 1) =>
    editable.length > 0 &&
    editable.every((entry) => {
      const index =
        entry.layer.effects.findIndex((candidate) => candidate.id === entry.effect.id) + direction;
      return index >= 0 && index < entry.layer.effects.length;
    });
  const move = (direction: -1 | 1) =>
    update((entry) => ({
      type: "moveEffect",
      layerId: entry.layer.id,
      effectId: entry.effect.id,
      toIndex:
        entry.layer.effects.findIndex((candidate) => candidate.id === entry.effect.id) + direction,
    }));
  const editProperty = useInspectorPropertyEdit();
  const setParameter = (parameter: string, value: number, phase: NumericEditPhase = "commit") => {
    if (!Number.isFinite(value)) return;
    editProperty(
      editable.map((entry) => ({
        type: "setEffectParameterAtTime",
        layerId: entry.layer.id,
        effectId: entry.effect.id,
        parameter,
        time: state.currentTime,
        value,
        keyframeId: createId(),
      })),
      phase,
    );
  };
  const toggleParameterKeyframe = (parameter: string, defaultValue: number) => {
    const remove = editable.every((entry) => hasKeyframe(entry.effect, parameter));
    update((entry) => {
      const current = hasKeyframe(entry.effect, parameter);
      return remove && current
        ? {
            type: "removeEffectParameterKeyframe",
            layerId: entry.layer.id,
            effectId: entry.effect.id,
            parameter,
            keyframeId: current.id,
          }
        : {
            type: "addEffectParameterKeyframe",
            layerId: entry.layer.id,
            effectId: entry.effect.id,
            parameter,
            keyframe: {
              id: current?.id ?? createId(),
              time: state.currentTime,
              value: evaluateEffectParameter(
                entry.effect,
                parameter,
                state.currentTime,
                defaultValue,
              ),
              interpolation: current?.interpolation ?? "bezier",
              easing: current?.easing ?? [0.42, 0, 0.58, 1],
            },
          };
    });
  };
  const setMask = (mask: Effect["mask"]) =>
    update((entry) => ({
      type: "setEffectMask",
      layerId: entry.layer.id,
      effectId: entry.effect.id,
      mask: mask ? (entry.effect.mask ?? mask) : undefined,
    }));
  return (
    <div className={`effect-editor ${allEnabled ? "" : "disabled"}`}>
      <div className="effect-title">
        <button
          aria-label={allEnabled ? t("inspector.effect.disable") : t("inspector.effect.enable")}
          className="effect-power"
          aria-pressed={
            valuesDiffer(targets.map((entry) => entry.effect.enabled)) ? "mixed" : allEnabled
          }
          onClick={() =>
            dispatch({
              type: "operation",
              operations: editable
                .filter((entry) => entry.effect.enabled === allEnabled)
                .map((entry) => ({
                  type: "toggleEffect",
                  layerId: entry.layer.id,
                  effectId: entry.effect.id,
                })),
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
            allMasked
              ? t("inspector.effect.removeMask", { name: effect.name })
              : t("inspector.effect.addMask", { name: effect.name })
          }
          className={allMasked ? "effect-mask-toggle active" : "effect-mask-toggle"}
          aria-pressed={
            valuesDiffer(targets.map((entry) => Boolean(entry.effect.mask))) ? "mixed" : allMasked
          }
          onClick={() =>
            setMask(
              allMasked
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
            allMasked ? t("inspector.effect.removeLocalMask") : t("inspector.effect.addLocalMask")
          }
          type="button"
        >
          <Scan size={11} />
        </button>
        <button
          aria-label={t("inspector.effect.moveUp", { name: effect.name })}
          disabled={!canMove(-1)}
          onClick={() => move(-1)}
          type="button"
        >
          <ArrowUp size={11} />
        </button>
        <button
          aria-label={t("inspector.effect.moveDown", { name: effect.name })}
          disabled={!canMove(1)}
          onClick={() => move(1)}
          type="button"
        >
          <ArrowDown size={11} />
        </button>
        <button
          aria-label={t("inspector.effect.remove", { name: effect.name })}
          onClick={() =>
            dispatch({
              type: "operation",
              operations: editable.map((entry) => ({
                type: "removeEffect",
                layerId: entry.layer.id,
                effectId: entry.effect.id,
              })),
            })
          }
          type="button"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {allMasked && effect.mask && (
        <EffectMaskEditor
          mask={effect.mask}
          masks={targets.flatMap((entry) => (entry.effect.mask ? [entry.effect.mask] : []))}
          onChange={(recipe) =>
            update((entry) => ({
              type: "setEffectMask",
              layerId: entry.layer.id,
              effectId: entry.effect.id,
              mask: entry.effect.mask ? recipe(entry.effect.mask) : undefined,
            }))
          }
        />
      )}
      {parameters
        .filter(
          (parameter) =>
            definition || targets.every((entry) => parameter.key in entry.effect.parameters),
        )
        .map((parameter) => (
          <EffectParameter
            animated={targets.every(
              (entry) => (entry.effect.parameterKeyframes?.[parameter.key]?.length ?? 0) > 0,
            )}
            mixed={valuesDiffer(
              targets.map((entry) =>
                evaluateEffectParameter(
                  entry.effect,
                  parameter.key,
                  state.currentTime,
                  parameter.defaultValue,
                ),
              ),
            )}
            definition={parameter}
            editTime={state.currentTime}
            keyframed={targets.every((entry) => Boolean(hasKeyframe(entry.effect, parameter.key)))}
            key={parameter.key}
            onChange={(value, phase) => setParameter(parameter.key, value, phase)}
            onToggleKeyframe={() => toggleParameterKeyframe(parameter.key, parameter.defaultValue)}
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
                        ...editable.map(
                          (entry): Operation => ({
                            type: "setEffectLut",
                            layerId: entry.layer.id,
                            effectId: entry.effect.id,
                            resource,
                          }),
                        ),
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
            {hasResource ? t("inspector.lut.replace") : t("inspector.lut.load")}
          </button>
          {hasResource && (
            <div className="lut-resource-summary">
              <span title={effect.resource?.name}>
                {valuesDiffer(targets.map((entry) => entry.effect.resource?.checksum))
                  ? "—"
                  : effect.resource?.title || effect.resource?.name}
              </span>
              <small>
                {valuesDiffer(targets.map((entry) => entry.effect.resource?.checksum))
                  ? "—"
                  : `${effect.resource?.size}³ · ${effect.resource?.checksum}`}
              </small>
              <button
                aria-label={t("inspector.lut.remove")}
                onClick={() =>
                  dispatch({
                    type: "operation",
                    operations: [
                      ...editable.map(
                        (entry): Operation => ({
                          type: "setEffectLut",
                          layerId: entry.layer.id,
                          effectId: entry.effect.id,
                          resource: undefined,
                        }),
                      ),
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
