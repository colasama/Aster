import type { Layer, ShapeSettings } from "../core/types";
import { createDefaultBezierPath } from "../renderer/vector-path";
import { useEditor } from "../state/editor-store";

export function ShapeControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  if (layer.kind !== "shape") return null;
  const settings = layer.shape ?? {
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
  const setPathClosed = (closed: boolean) => {
    if (settings.path) update("path", { ...settings.path, closed });
  };

  return (
    <>
      <label>
        Shape
        <select
          aria-label="Shape kind"
          onChange={(event) => {
            const kind = event.target.value as ShapeSettings["kind"];
            dispatch({
              type: "operation",
              operations: [
                {
                  type: "setShapeSettings",
                  layerId: layer.id,
                  shape: {
                    ...settings,
                    kind,
                    path:
                      kind === "bezier"
                        ? (settings.path ?? createDefaultBezierPath())
                        : settings.path,
                  },
                },
              ],
            });
          }}
          value={settings.kind}
        >
          <option value="rectangle">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="line">Line</option>
          <option value="bezier">Bezier path</option>
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
        Fill mode
        <select
          aria-label="Fill mode"
          onChange={(event) => update("fillMode", event.target.value as ShapeSettings["fillMode"])}
          value={settings.fillMode}
        >
          <option value="solid">Solid</option>
          <option value="linear">Linear gradient</option>
          <option value="radial">Radial gradient</option>
        </select>
      </label>
      {settings.fillMode !== "solid" && (
        <>
          <label>
            Gradient color
            <input
              aria-label="Gradient color"
              onChange={(event) =>
                update("gradientColor", [
                  ...parseColor(event.target.value),
                  settings.gradientColor[3],
                ])
              }
              type="color"
              value={colorInput(settings.gradientColor)}
            />
          </label>
          {settings.fillMode === "linear" && (
            <label>
              Gradient angle
              <input
                aria-label="Gradient angle"
                max="36000"
                min="-36000"
                onChange={(event) => update("gradientAngle", Number(event.target.value))}
                step="1"
                type="number"
                value={settings.gradientAngle}
              />
            </label>
          )}
        </>
      )}
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
      {(settings.kind === "line" || settings.kind === "bezier") && (
        <>
          <label>
            Line cap
            <select
              aria-label="Line cap"
              onChange={(event) =>
                update("lineCap", event.target.value as ShapeSettings["lineCap"])
              }
              value={settings.lineCap}
            >
              <option value="round">Round</option>
              <option value="butt">Butt</option>
            </select>
          </label>
          {settings.kind === "bezier" && (
            <>
              <label>
                Line join
                <select
                  aria-label="Line join"
                  onChange={(event) =>
                    update("lineJoin", event.target.value as ShapeSettings["lineJoin"])
                  }
                  value={settings.lineJoin ?? "round"}
                >
                  <option value="miter">Miter</option>
                  <option value="bevel">Bevel</option>
                  <option value="round">Round</option>
                </select>
              </label>
              {settings.path && (
                <label>
                  Closed path
                  <input
                    aria-label="Closed path"
                    checked={settings.path.closed}
                    onChange={(event) => setPathClosed(event.target.checked)}
                    type="checkbox"
                  />
                </label>
              )}
            </>
          )}
          <label>
            Dash length
            <input
              aria-label="Dash length"
              min="0"
              onChange={(event) => update("dashLength", Number(event.target.value))}
              step="1"
              type="number"
              value={settings.dashLength}
            />
          </label>
          <label>
            Dash gap
            <input
              aria-label="Dash gap"
              min="0"
              onChange={(event) => update("dashGap", Number(event.target.value))}
              step="1"
              type="number"
              value={settings.dashGap}
            />
          </label>
        </>
      )}
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
