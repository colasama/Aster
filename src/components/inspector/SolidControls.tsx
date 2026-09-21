import { MAX_SOLID_DIMENSION } from "../../core/layers/solid-layer";
import type { Layer, SolidSettings } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { colorInputValue, parseColorInput } from "../../ui/color-input";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput } from "./MixedValueInput";

export function SolidControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  if (layer.kind !== "solid" || !layer.solid) return null;
  const settings = layer.solid;
  const update = <Field extends keyof SolidSettings>(
    field: Field,
    value: SolidSettings[Field] | ((settings: SolidSettings) => SolidSettings[Field]),
  ) =>
    dispatch({
      type: "operation",
      operations: editable.flatMap((entry) =>
        entry.solid
          ? [
              {
                type: "setSolidSettings" as const,
                layerId: entry.id,
                solid: {
                  ...entry.solid,
                  [field]: typeof value === "function" ? value(entry.solid) : value,
                },
              },
            ]
          : [],
      ),
    });

  return (
    <>
      {(["width", "height"] as const).map((field) => (
        <label key={field}>
          {t(`solid.${field}`)}
          <MixedValueInput
            aria-label={t(`solid.${field}`)}
            max={MAX_SOLID_DIMENSION}
            min="1"
            onChange={(event) => update(field, Number(event.target.value))}
            step="1"
            type="number"
            mixed={valuesDiffer(layers.map((entry) => entry.solid?.[field]))}
            value={settings[field]}
          />
        </label>
      ))}
      <label>
        {t("solid.color")}
        <MixedValueInput
          aria-label={t("solid.color")}
          onChange={(event) =>
            update("color", (current) => [...parseColorInput(event.target.value), current.color[3]])
          }
          type="color"
          mixed={valuesDiffer(
            layers.map((entry) => colorInputValue(entry.solid?.color ?? entry.color)),
          )}
          value={colorInputValue(settings.color)}
        />
      </label>
      <label>
        {t("solid.opacity")}
        <MixedValueInput
          aria-label={t("solid.opacity")}
          max="100"
          min="0"
          onChange={(event) =>
            update("color", (current) => [
              current.color[0],
              current.color[1],
              current.color[2],
              Number(event.target.value) / 100,
            ])
          }
          step="1"
          type="number"
          mixed={valuesDiffer(layers.map((entry) => entry.solid?.color[3]))}
          value={Math.round(settings.color[3] * 100)}
        />
      </label>
    </>
  );
}
