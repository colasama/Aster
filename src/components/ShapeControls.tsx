import type { Layer, ShapeSettings } from "../core/types";
import { useEditor } from "../state/editor-store";

export function ShapeControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  if (layer.kind !== "shape") return null;
  const settings = layer.shape ?? {
    kind: layer.size[0] === layer.size[1] ? "ellipse" : "rectangle",
    roundness: 0,
    strokeWidth: 0,
    strokeColor: [1, 1, 1, 1],
  };
  const update = <Field extends keyof ShapeSettings>(field: Field, value: ShapeSettings[Field]) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setShapeSettings",
          layerId: layer.id,
          shape: { ...settings, [field]: value },
        },
      ],
    });
  };
  const setFill = (value: string) => {
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

  return (
    <>
      <label>
        Shape
        <select
          aria-label="Shape kind"
          onChange={(event) => update("kind", event.target.value as ShapeSettings["kind"])}
          value={settings.kind}
        >
          <option value="rectangle">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="line">Line</option>
        </select>
      </label>
      <label>
        Fill color
        <input
          aria-label="Fill color"
          onChange={(event) => setFill(event.target.value)}
          type="color"
          value={colorInput(layer.color)}
        />
      </label>
      <label>
        Roundness
        <input
          aria-label="Roundness"
          min="0"
          onChange={(event) => update("roundness", Number(event.target.value))}
          step="1"
          type="number"
          value={settings.roundness}
        />
      </label>
      <label>
        Stroke width
        <input
          aria-label="Stroke width"
          min="0"
          onChange={(event) => update("strokeWidth", Number(event.target.value))}
          step="1"
          type="number"
          value={settings.strokeWidth}
        />
      </label>
      <label>
        Stroke color
        <input
          aria-label="Stroke color"
          onChange={(event) =>
            update("strokeColor", [...parseColor(event.target.value), settings.strokeColor[3]])
          }
          type="color"
          value={colorInput(settings.strokeColor)}
        />
      </label>
    </>
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
