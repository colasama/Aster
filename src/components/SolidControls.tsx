import { MAX_SOLID_DIMENSION } from "../core/solid-layer";
import type { Layer, SolidSettings } from "../core/types";
import { useI18n } from "../i18n/react";
import { useEditor } from "../state/editor-store";
import { colorInputValue, parseColorInput } from "../ui/color-input";

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
            update("color", [...parseColorInput(event.target.value), settings.color[3]])
          }
          type="color"
          value={colorInputValue(settings.color)}
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
