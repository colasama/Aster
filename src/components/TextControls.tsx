import { createDefaultTextAnimator, TEXT_ANIMATOR_LIMITS } from "../core/text-animator";
import type { Layer, TextAnimatorSettings, TextStyle } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

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
  const { dispatch } = useEditor();
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
  const updateAnimator = <Field extends keyof TextAnimatorSettings>(
    field: Field,
    value: TextAnimatorSettings[Field],
  ) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setTextAnimator",
          layerId: layer.id,
          textAnimator: { ...animator, [field]: value },
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
      <label>
        {t("text.animator")}
        <input
          aria-label={t("text.animator")}
          checked={animator.enabled}
          onChange={(event) => updateAnimator("enabled", event.target.checked)}
          type="checkbox"
        />
      </label>
      {animator.enabled ? (
        <>
          <TextNumber
            label={t("text.animatorDelay")}
            max={TEXT_ANIMATOR_LIMITS.delay[1]}
            min={TEXT_ANIMATOR_LIMITS.delay[0]}
            onChange={(value) => updateAnimator("delay", value)}
            step={0.01}
            value={animator.delay}
          />
          <TextNumber
            label={t("text.characterStagger")}
            max={TEXT_ANIMATOR_LIMITS.stagger[1]}
            min={TEXT_ANIMATOR_LIMITS.stagger[0]}
            onChange={(value) => updateAnimator("stagger", value)}
            step={0.01}
            value={animator.stagger}
          />
          <TextNumber
            label={t("text.characterDuration")}
            max={TEXT_ANIMATOR_LIMITS.duration[1]}
            min={TEXT_ANIMATOR_LIMITS.duration[0]}
            onChange={(value) => updateAnimator("duration", value)}
            step={0.01}
            value={animator.duration}
          />
          <TextNumber
            label={t("text.startPositionX")}
            max={TEXT_ANIMATOR_LIMITS.position[1]}
            min={TEXT_ANIMATOR_LIMITS.position[0]}
            onChange={(value) => updateAnimator("position", [value, animator.position[1]])}
            value={animator.position[0]}
          />
          <TextNumber
            label={t("text.startPositionY")}
            max={TEXT_ANIMATOR_LIMITS.position[1]}
            min={TEXT_ANIMATOR_LIMITS.position[0]}
            onChange={(value) => updateAnimator("position", [animator.position[0], value])}
            value={animator.position[1]}
          />
          <TextNumber
            label={t("text.startScale")}
            max={TEXT_ANIMATOR_LIMITS.scale[1]}
            min={TEXT_ANIMATOR_LIMITS.scale[0]}
            onChange={(value) => updateAnimator("scale", value)}
            value={animator.scale}
          />
          <TextNumber
            label={t("text.startOpacity")}
            max={TEXT_ANIMATOR_LIMITS.opacity[1]}
            min={TEXT_ANIMATOR_LIMITS.opacity[0]}
            onChange={(value) => updateAnimator("opacity", value)}
            value={animator.opacity}
          />
        </>
      ) : null}
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
