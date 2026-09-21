import type { Layer, ShapeSettings } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { createDefaultBezierPath } from "../../renderer/geometry/vector-path";
import { useEditor } from "../../state/editor-store";
import { colorInputValue, parseColorInput } from "../../ui/color-input";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";
import { TextAnimatableControl } from "./TextAnimatableControl";

export function ShapeControls({ layer }: { layer: Layer }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  if (layer.kind !== "shape") return null;
  const settings = shapeSettings(layer);
  const selections = layers.map(shapeSettings);
  const update = <Field extends keyof ShapeSettings>(
    field: Field,
    value: ShapeSettings[Field] | ((settings: ShapeSettings) => ShapeSettings[Field]),
  ) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setShapeSettings",
        layerId: entry.id,
        shape: {
          ...shapeSettings(entry),
          [field]: typeof value === "function" ? value(shapeSettings(entry)) : value,
        },
      })),
    });
  };
  const setFill = (value: string) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setLayerColor",
        layerId: entry.id,
        color: [...parseColorInput(value), entry.color[3]],
      })),
    });
  };
  const setPathClosed = (closed: boolean) =>
    dispatch({
      type: "operation",
      operations: editable.map((entry) => {
        const current = shapeSettings(entry);
        return {
          type: "setShapeSettings",
          layerId: entry.id,
          shape: {
            ...current,
            path: current.path ? { ...current.path, closed } : undefined,
            ...(current.morph
              ? { morph: { ...current.morph, target: { ...current.morph.target, closed } } }
              : {}),
          },
        };
      }),
    });
  return (
    <>
      <label>
        {t("shape.kind")}
        <MixedValueSelect
          aria-label={t("shape.kindA11y")}
          onChange={(event) => {
            const kind = event.target.value as ShapeSettings["kind"];
            dispatch({
              type: "operation",
              operations: editable.map((entry) => {
                const current = shapeSettings(entry);
                return {
                  type: "setShapeSettings",
                  layerId: entry.id,
                  shape: {
                    ...current,
                    kind,
                    morph: kind === "bezier" ? current.morph : undefined,
                    path:
                      kind === "bezier"
                        ? (current.path ?? createDefaultBezierPath())
                        : current.path,
                  },
                };
              }),
            });
          }}
          mixed={valuesDiffer(selections.map((entry) => entry.kind))}
          value={settings.kind}
        >
          <option value="rectangle">{t("shape.rectangle")}</option>
          <option value="ellipse">{t("shape.ellipse")}</option>
          <option value="line">{t("shape.line")}</option>
          <option value="bezier">{t("shape.bezier")}</option>
        </MixedValueSelect>
      </label>
      {settings.morph && selections.every((entry) => entry.morph) && (
        <TextAnimatableControl
          label={t("shape.morphProgress")}
          keyframeLabel={t("shape.morphKeyframe")}
          min={0}
          max={100}
          step={0.1}
          property={settings.morph.progress}
          selection={selections.flatMap((entry) => (entry.morph ? [entry.morph.progress] : []))}
          time={state.currentTime}
          onChange={(progress, recipe) =>
            update("morph", (current) =>
              current.morph
                ? {
                    ...current.morph,
                    progress: recipe ? recipe(current.morph.progress, 0) : progress,
                  }
                : undefined,
            )
          }
        />
      )}
      <label>
        {t("shape.fillColor")}
        <MixedValueInput
          aria-label={t("shape.fillColor")}
          onChange={(event) => setFill(event.target.value)}
          type="color"
          mixed={valuesDiffer(layers.map((entry) => colorInputValue(entry.color)))}
          value={colorInputValue(layer.color)}
        />
      </label>
      <label>
        {t("shape.fillMode")}
        <MixedValueSelect
          aria-label={t("shape.fillMode")}
          onChange={(event) => update("fillMode", event.target.value as ShapeSettings["fillMode"])}
          mixed={valuesDiffer(selections.map((entry) => entry.fillMode))}
          value={settings.fillMode}
        >
          <option value="solid">{t("shape.solid")}</option>
          <option value="linear">{t("shape.linearGradient")}</option>
          <option value="radial">{t("shape.radialGradient")}</option>
        </MixedValueSelect>
      </label>
      {selections.every((entry) => entry.fillMode !== "solid") && (
        <>
          <label>
            {t("shape.gradientColor")}
            <MixedValueInput
              aria-label={t("shape.gradientColor")}
              onChange={(event) =>
                update("gradientColor", (current) => [
                  ...parseColorInput(event.target.value),
                  current.gradientColor[3],
                ])
              }
              type="color"
              mixed={valuesDiffer(selections.map((entry) => colorInputValue(entry.gradientColor)))}
              value={colorInputValue(settings.gradientColor)}
            />
          </label>
          {selections.every((entry) => entry.fillMode === "linear") && (
            <label>
              {t("shape.gradientAngle")}
              <MixedValueInput
                aria-label={t("shape.gradientAngle")}
                max="36000"
                min="-36000"
                onChange={(event) => update("gradientAngle", Number(event.target.value))}
                step="1"
                type="number"
                mixed={valuesDiffer(selections.map((entry) => entry.gradientAngle))}
                value={settings.gradientAngle}
              />
            </label>
          )}
        </>
      )}
      <label>
        {t("shape.roundness")}
        <MixedValueInput
          aria-label={t("shape.roundness")}
          min="0"
          onChange={(event) => update("roundness", Number(event.target.value))}
          step="1"
          type="number"
          mixed={valuesDiffer(selections.map((entry) => entry.roundness))}
          value={settings.roundness}
        />
      </label>
      <label>
        {t("shape.strokeWidth")}
        <MixedValueInput
          aria-label={t("shape.strokeWidth")}
          min="0"
          onChange={(event) => update("strokeWidth", Number(event.target.value))}
          step="1"
          type="number"
          mixed={valuesDiffer(selections.map((entry) => entry.strokeWidth))}
          value={settings.strokeWidth}
        />
      </label>
      <label>
        {t("shape.strokeColor")}
        <MixedValueInput
          aria-label={t("shape.strokeColor")}
          onChange={(event) =>
            update("strokeColor", (current) => [
              ...parseColorInput(event.target.value),
              current.strokeColor[3],
            ])
          }
          type="color"
          mixed={valuesDiffer(selections.map((entry) => colorInputValue(entry.strokeColor)))}
          value={colorInputValue(settings.strokeColor)}
        />
      </label>
      {selections.every((entry) => entry.kind === "line" || entry.kind === "bezier") && (
        <>
          <label>
            {t("shape.lineCap")}
            <MixedValueSelect
              aria-label={t("shape.lineCap")}
              onChange={(event) =>
                update("lineCap", event.target.value as ShapeSettings["lineCap"])
              }
              mixed={valuesDiffer(selections.map((entry) => entry.lineCap))}
              value={settings.lineCap}
            >
              <option value="round">{t("shape.capRound")}</option>
              <option value="butt">{t("shape.capButt")}</option>
            </MixedValueSelect>
          </label>
          {selections.every((entry) => entry.kind === "bezier") && (
            <>
              <label>
                {t("shape.lineJoin")}
                <MixedValueSelect
                  aria-label={t("shape.lineJoin")}
                  onChange={(event) =>
                    update("lineJoin", event.target.value as ShapeSettings["lineJoin"])
                  }
                  mixed={valuesDiffer(selections.map((entry) => entry.lineJoin ?? "round"))}
                  value={settings.lineJoin ?? "round"}
                >
                  <option value="miter">{t("shape.joinMiter")}</option>
                  <option value="bevel">{t("shape.joinBevel")}</option>
                  <option value="round">{t("shape.joinRound")}</option>
                </MixedValueSelect>
              </label>
              {settings.path && selections.every((entry) => entry.path) && (
                <>
                  <label>
                    {t("shape.closedPath")}
                    <MixedValueInput
                      aria-label={t("shape.closedPath")}
                      mixed={valuesDiffer(selections.map((entry) => entry.path?.closed))}
                      checked={settings.path.closed}
                      onChange={(event) => setPathClosed(event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                  <label>
                    {t("shape.trimStart")}
                    <MixedValueInput
                      aria-label={t("shape.trimStartA11y")}
                      max="100"
                      min="0"
                      onChange={(event) =>
                        update("trim", (current) => ({
                          ...(current.trim ?? { start: 0, end: 100, offset: 0 }),
                          start: Number(event.target.value),
                        }))
                      }
                      step="0.1"
                      type="number"
                      mixed={valuesDiffer(selections.map((entry) => entry.trim?.start ?? 0))}
                      value={settings.trim?.start ?? 0}
                    />
                  </label>
                  <label>
                    {t("shape.trimEnd")}
                    <MixedValueInput
                      aria-label={t("shape.trimEndA11y")}
                      max="100"
                      min="0"
                      onChange={(event) =>
                        update("trim", (current) => ({
                          ...(current.trim ?? { start: 0, end: 100, offset: 0 }),
                          end: Number(event.target.value),
                        }))
                      }
                      step="0.1"
                      type="number"
                      mixed={valuesDiffer(selections.map((entry) => entry.trim?.end ?? 100))}
                      value={settings.trim?.end ?? 100}
                    />
                  </label>
                  <label>
                    {t("shape.trimOffset")}
                    <MixedValueInput
                      aria-label={t("shape.trimOffsetA11y")}
                      max="100000"
                      min="-100000"
                      onChange={(event) =>
                        update("trim", (current) => ({
                          ...(current.trim ?? { start: 0, end: 100, offset: 0 }),
                          offset: Number(event.target.value),
                        }))
                      }
                      step="0.1"
                      type="number"
                      mixed={valuesDiffer(selections.map((entry) => entry.trim?.offset ?? 0))}
                      value={settings.trim?.offset ?? 0}
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label>
            {t("shape.dashLength")}
            <MixedValueInput
              aria-label={t("shape.dashLength")}
              min="0"
              onChange={(event) => update("dashLength", Number(event.target.value))}
              step="1"
              type="number"
              mixed={valuesDiffer(selections.map((entry) => entry.dashLength))}
              value={settings.dashLength}
            />
          </label>
          <label>
            {t("shape.dashGap")}
            <MixedValueInput
              aria-label={t("shape.dashGap")}
              min="0"
              onChange={(event) => update("dashGap", Number(event.target.value))}
              step="1"
              type="number"
              mixed={valuesDiffer(selections.map((entry) => entry.dashGap))}
              value={settings.dashGap}
            />
          </label>
        </>
      )}
    </>
  );
}

function shapeSettings(layer: Layer): ShapeSettings {
  return (
    layer.shape ?? {
      kind: layer.size[0] === layer.size[1] ? "ellipse" : "rectangle",
      roundness: 0,
      strokeWidth: 0,
      strokeColor: [1, 1, 1, 1],
      fillMode: "solid" as const,
      gradientColor: [0.2, 0.45, 1, 1] as [number, number, number, number],
      gradientAngle: 0,
      dashLength: 0,
      dashGap: 0,
      lineCap: "round" as const,
      lineJoin: "round" as const,
    }
  );
}
