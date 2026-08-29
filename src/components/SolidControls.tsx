import { MAX_SOLID_DIMENSION } from "../core/solid-layer";
import type { Layer, SolidSettings } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";

export function SolidControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  if (layer.kind !== "solid" || !layer.solid) return null;
  const settings = layer.solid;
  const update = <Field extends keyof SolidSettings>(field: Field, value: SolidSettings[Field]) =>
    dispatch({
      type: "operation",
      operations: [
        { type: "setSolidSettings", layerId: layer.id, solid: { ...settings, [field]: value } },
      ],
    });

  return (
    <>
      {(["width", "height"] as const).map((field) => (
        <label key={field}>
          {t(`solid.${field}`)}
          <input
            aria-label={t(`solid.${field}`)}
            max={MAX_SOLID_DIMENSION}
            min="1"
            onChange={(event) => update(field, Number(event.target.value))}
            step="1"
            type="number"
            value={settings[field]}
          />
        </label>
      ))}
      <label>
        {t("solid.color")}
        <input
          aria-label={t("solid.color")}
          onChange={(event) =>
            update("color", [...parseColor(event.target.value), settings.color[3]])
          }
          type="color"
          value={colorInput(settings.color)}
        />
      </label>
      <label>
        {t("solid.opacity")}
        <input
          aria-label={t("solid.opacity")}
          max="100"
          min="0"
          onChange={(event) =>
            update("color", [
              settings.color[0],
              settings.color[1],
              settings.color[2],
              Number(event.target.value) / 100,
            ])
          }
          step="1"
          type="number"
          value={Math.round(settings.color[3] * 100)}
        />
      </label>
    </>
  );
}

function colorInput(color: readonly number[]): string {
  return `#${color
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function parseColor(value: string): [number, number, number] {
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}
