import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import { createDefaultTextAnimator } from "../../core/animation/text-animator";
import { resolveTextStyle } from "../../core/layers/text-style";
import type { Layer, TextStyle } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { colorInputValue, parseColorInput } from "../../ui/color-input";
import { FontFamilyControl } from "./FontFamilyControl";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect, MixedValueTextarea } from "./MixedValueInput";
import type { SettingsRecipe } from "./settings-edit";
import { TextAnimatorControls } from "./TextAnimatorControls";

export function TextControls({ layer }: { layer: Layer }) {
  const { dispatch, state } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const styles = layers.map(resolveTextStyle);
  if (layer.kind !== "text") return null;
  const style = resolveTextStyle(layer);
  const animator = layer.textAnimator ?? createDefaultTextAnimator();
  const update = <Field extends keyof TextStyle>(
    field: Field,
    value: TextStyle[Field] | ((style: TextStyle) => TextStyle[Field]),
  ) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setTextStyle",
        layerId: entry.id,
        textStyle: {
          ...resolveTextStyle(entry),
          [field]: typeof value === "function" ? value(resolveTextStyle(entry)) : value,
        },
      })),
    });
  };
  const updateColor = (value: string) => {
    dispatch({
      type: "operation",
      operations: editable.map((entry) => ({
        type: "setLayerColor",
        layerId: entry.id,
        color: [...parseColorInput(value), entry.color[3]],
      })),
    });
  };
  const updateAnimator = (
    textAnimator: typeof animator,
    recipe?: SettingsRecipe<typeof animator>,
  ) => {
    dispatch({
      type: "operation",
      operations: layers.flatMap((entry, index) =>
        entry.locked
          ? []
          : [
              {
                type: "setTextAnimator" as const,
                layerId: entry.id,
                textAnimator: recipe
                  ? recipe(entry.textAnimator ?? createDefaultTextAnimator(), index)
                  : textAnimator,
              },
            ],
      ),
    });
  };

  return (
    <>
      <label>
        {t("text.content")}
        <MixedValueTextarea
          mixed={valuesDiffer(layers.map((entry) => entry.text ?? ""))}
          aria-label={t("text.contentA11y")}
          maxLength={20_000}
          onChange={(event) =>
            dispatch({
              type: "operation",
              operations: editable.map((entry) => ({
                type: "setTextContent",
                layerId: entry.id,
                text: event.target.value,
              })),
            })
          }
          rows={3}
          value={layer.text ?? ""}
        />
      </label>
      <FontFamilyControl
        layer={layer}
        style={style}
        onChange={(family) => update("fontFamily", family)}
      />
      <TextNumber
        label={t("text.fontSize")}
        min={1}
        onChange={(value) => update("fontSize", value)}
        mixed={valuesDiffer(styles.map((entry) => entry.fontSize))}
        value={style.fontSize}
      />
      <label>
        {t("text.fontWeight")}
        <MixedValueSelect
          aria-label={t("text.fontWeight")}
          onChange={(event) => update("fontWeight", Number(event.target.value))}
          mixed={valuesDiffer(styles.map((entry) => entry.fontWeight))}
          value={style.fontWeight}
        >
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
            <option key={weight} value={weight}>
              {weight}
            </option>
          ))}
        </MixedValueSelect>
      </label>
      <label>
        {t("text.alignment")}
        <MixedValueSelect
          aria-label={t("text.alignmentA11y")}
          onChange={(event) => update("alignment", event.target.value as TextStyle["alignment"])}
          mixed={valuesDiffer(styles.map((entry) => entry.alignment))}
          value={style.alignment}
        >
          <option value="left">{t("text.left")}</option>
          <option value="center">{t("text.center")}</option>
          <option value="right">{t("text.right")}</option>
        </MixedValueSelect>
      </label>
      <TextNumber
        label={t("text.tracking")}
        min={-1000}
        onChange={(value) => update("tracking", value)}
        mixed={valuesDiffer(styles.map((entry) => entry.tracking))}
        value={style.tracking}
      />
      <TextNumber
        label={t("text.leading")}
        min={1}
        onChange={(value) => update("leading", value)}
        mixed={valuesDiffer(styles.map((entry) => entry.leading))}
        value={style.leading}
      />
      <label>
        {t("text.fillColor")}
        <MixedValueInput
          aria-label={t("text.fillColorA11y")}
          onChange={(event) => updateColor(event.target.value)}
          type="color"
          mixed={valuesDiffer(layers.map((entry) => colorInputValue(entry.color)))}
          value={colorInputValue(layer.color)}
        />
      </label>
      <TextNumber
        label={t("text.strokeWidth")}
        min={0}
        onChange={(value) => update("strokeWidth", value)}
        mixed={valuesDiffer(styles.map((entry) => entry.strokeWidth))}
        value={style.strokeWidth}
      />
      <label>
        {t("text.strokeColor")}
        <MixedValueInput
          aria-label={t("text.strokeColorA11y")}
          onChange={(event) =>
            update("strokeColor", (current) => [
              ...parseColorInput(event.target.value),
              current.strokeColor[3],
            ])
          }
          type="color"
          mixed={valuesDiffer(styles.map((entry) => colorInputValue(entry.strokeColor)))}
          value={colorInputValue(style.strokeColor)}
        />
      </label>
      <TextAnimatorControls
        onChange={updateAnimator}
        settings={animator}
        selection={layers.map((entry) => entry.textAnimator ?? createDefaultTextAnimator())}
        times={layers.map((entry) => evaluateLayerSourceTime(entry, state.currentTime))}
        time={evaluateLayerSourceTime(layer, state.currentTime)}
      />
    </>
  );
}

function TextNumber({
  label,
  mixed,
  min,
  max,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  mixed?: boolean;
  min: number;
  max?: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  return (
    <label>
      {label}
      <MixedValueInput
        mixed={mixed}
        aria-label={label}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}
