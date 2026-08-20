import type { Layer, TextStyle } from "../core/types";
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
  if (layer.kind !== "text") return null;
  const style = layer.textStyle ?? DEFAULT_STYLE;
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

  return (
    <>
      <label>
        Text
        <textarea
          aria-label="Text content"
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
        Font family
        <input
          aria-label="Font family"
          maxLength={160}
          onChange={(event) => update("fontFamily", event.target.value)}
          type="text"
          value={style.fontFamily}
        />
      </label>
      <TextNumber
        label="Font size"
        min={1}
        onChange={(value) => update("fontSize", value)}
        value={style.fontSize}
      />
      <label>
        Font weight
        <select
          aria-label="Font weight"
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
        Alignment
        <select
          aria-label="Text alignment"
          onChange={(event) => update("alignment", event.target.value as TextStyle["alignment"])}
          value={style.alignment}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      <TextNumber
        label="Tracking"
        min={-1000}
        onChange={(value) => update("tracking", value)}
        value={style.tracking}
      />
      <TextNumber
        label="Leading"
        min={1}
        onChange={(value) => update("leading", value)}
        value={style.leading}
      />
      <label>
        Fill color
        <input
          aria-label="Text fill color"
          onChange={(event) => updateColor(event.target.value)}
          type="color"
          value={colorInput(layer.color)}
        />
      </label>
      <TextNumber
        label="Text stroke width"
        min={0}
        onChange={(value) => update("strokeWidth", value)}
        value={style.strokeWidth}
      />
      <label>
        Stroke color
        <input
          aria-label="Text stroke color"
          onChange={(event) =>
            update("strokeColor", [...parseColor(event.target.value), style.strokeColor[3]])
          }
          type="color"
          value={colorInput(style.strokeColor)}
        />
      </label>
    </>
  );
}

function TextNumber({
  label,
  min,
  onChange,
  value,
}: {
  label: string;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step="1"
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
