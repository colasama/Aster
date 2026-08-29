import { evaluateLayerSourceTime } from "../core/layer-time";
import { createDefaultTextAnimator } from "../core/text-animator";
import type { Layer, TextStyle } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { TextAnimatorControls } from "./TextAnimatorControls";

const DEFAULT_STYLE: TextStyle = {
  fontFamily: "Inter, Segoe UI, sans-serif",
  fontSize: 144,
  fontWeight: 700,
  alignment: "center",
  tracking: 12,
  leading: 172,
  strokeWidth: 0,
  strokeColor: [0, 0, 0, 1],
};

export function TextControls({ layer }: { layer: Layer }) {
  const { dispatch, state } = useEditor();
  const { t } = useI18n();
  if (layer.kind !== "text") return null;
  const style = layer.textStyle ?? DEFAULT_STYLE;
  const animator = layer.textAnimator ?? createDefaultTextAnimator();
  const update = <Field extends keyof TextStyle>(field: Field, value: TextStyle[Field]) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setTextStyle",
          layerId: layer.id,
          textStyle: { ...style, [field]: value },
        },
      ],
    });
  };
  const updateColor = (value: string) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setLayerColor",
          layerId: layer.id,
          color: [...parseColor(value), layer.color[3]],
        },
      ],
    });
  };
  const updateAnimator = (textAnimator: typeof animator) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setTextAnimator",
          layerId: layer.id,
          textAnimator,
        },
      ],
    });
  };

  return (
    <>
      <label>
        {t("text.content")}
        <textarea
          aria-label={t("text.contentA11y")}
          maxLength={20_000}
          onChange={(event) =>
            dispatch({
              type: "operation",
              operations: [{ type: "setTextContent", layerId: layer.id, text: event.target.value }],
            })
          }
          rows={3}
          value={layer.text ?? ""}
        />
      </label>
      <label>
        {t("text.fontFamily")}
        <input
          aria-label={t("text.fontFamily")}
          maxLength={160}
          onChange={(event) => update("fontFamily", event.target.value)}
          type="text"
          value={style.fontFamily}
        />
      </label>
      <TextNumber
        label={t("text.fontSize")}
        min={1}
        onChange={(value) => update("fontSize", value)}
        value={style.fontSize}
      />
      <label>
        {t("text.fontWeight")}
        <select
          aria-label={t("text.fontWeight")}
          onChange={(event) => update("fontWeight", Number(event.target.value))}
          value={style.fontWeight}
        >
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
            <option key={weight} value={weight}>
              {weight}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("text.alignment")}
        <select
          aria-label={t("text.alignmentA11y")}
          onChange={(event) => update("alignment", event.target.value as TextStyle["alignment"])}
          value={style.alignment}
        >
          <option value="left">{t("text.left")}</option>
          <option value="center">{t("text.center")}</option>
          <option value="right">{t("text.right")}</option>
        </select>
      </label>
      <TextNumber
        label={t("text.tracking")}
        min={-1000}
        onChange={(value) => update("tracking", value)}
        value={style.tracking}
      />
      <TextNumber
        label={t("text.leading")}
        min={1}
        onChange={(value) => update("leading", value)}
        value={style.leading}
      />
      <label>
        {t("text.fillColor")}
        <input
          aria-label={t("text.fillColorA11y")}
          onChange={(event) => updateColor(event.target.value)}
          type="color"
          value={colorInput(layer.color)}
        />
      </label>
      <TextNumber
        label={t("text.strokeWidth")}
        min={0}
        onChange={(value) => update("strokeWidth", value)}
        value={style.strokeWidth}
      />
      <label>
        {t("text.strokeColor")}
        <input
          aria-label={t("text.strokeColorA11y")}
          onChange={(event) =>
            update("strokeColor", [...parseColor(event.target.value), style.strokeColor[3]])
          }
          type="color"
          value={colorInput(style.strokeColor)}
        />
      </label>
      <TextAnimatorControls
        onChange={updateAnimator}
        settings={animator}
        time={evaluateLayerSourceTime(layer, state.currentTime)}
      />
    </>
  );
}

function TextNumber({
  label,
  min,
  max,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  min: number;
  max?: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  return (
    <label>
      {label}
      <input
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

function parseColor(value: string): [number, number, number] {
  const color = Number.parseInt(value.slice(1), 16);
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
}

function colorInput(color: readonly [number, number, number, number]): string {
  return `#${color
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
