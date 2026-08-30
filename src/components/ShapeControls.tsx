import type { Layer, ShapeSettings } from "../core/types";
import { useI18n } from "../i18n/react";
import { createDefaultBezierPath } from "../renderer/vector-path";
import { useEditor } from "../state/editor-store";
import { colorInputValue, parseColorInput } from "../ui/color-input";

export function ShapeControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();
  const { t } = useI18n();
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
          color: [...parseColorInput(value), layer.color[3]],
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
        {t("shape.kind")}
        <select
          aria-label={t("shape.kindA11y")}
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
          <option value="rectangle">{t("shape.rectangle")}</option>
          <option value="ellipse">{t("shape.ellipse")}</option>
          <option value="line">{t("shape.line")}</option>
          <option value="bezier">{t("shape.bezier")}</option>
        </select>
      </label>
      <label>
        {t("shape.fillColor")}
        <input
          aria-label={t("shape.fillColor")}
          onChange={(event) => setFill(event.target.value)}
          type="color"
          value={colorInputValue(layer.color)}
        />
      </label>
      <label>
        {t("shape.fillMode")}
        <select
          aria-label={t("shape.fillMode")}
          onChange={(event) => update("fillMode", event.target.value as ShapeSettings["fillMode"])}
          value={settings.fillMode}
        >
          <option value="solid">{t("shape.solid")}</option>
          <option value="linear">{t("shape.linearGradient")}</option>
          <option value="radial">{t("shape.radialGradient")}</option>
        </select>
      </label>
      {settings.fillMode !== "solid" && (
        <>
          <label>
            {t("shape.gradientColor")}
            <input
              aria-label={t("shape.gradientColor")}
              onChange={(event) =>
                update("gradientColor", [
                  ...parseColorInput(event.target.value),
                  settings.gradientColor[3],
                ])
              }
              type="color"
              value={colorInputValue(settings.gradientColor)}
            />
          </label>
          {settings.fillMode === "linear" && (
            <label>
              {t("shape.gradientAngle")}
              <input
                aria-label={t("shape.gradientAngle")}
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
        {t("shape.roundness")}
        <input
          aria-label={t("shape.roundness")}
          min="0"
          onChange={(event) => update("roundness", Number(event.target.value))}
          step="1"
          type="number"
          value={settings.roundness}
        />
      </label>
      <label>
        {t("shape.strokeWidth")}
        <input
          aria-label={t("shape.strokeWidth")}
          min="0"
          onChange={(event) => update("strokeWidth", Number(event.target.value))}
          step="1"
          type="number"
          value={settings.strokeWidth}
        />
      </label>
      <label>
        {t("shape.strokeColor")}
        <input
          aria-label={t("shape.strokeColor")}
          onChange={(event) =>
            update("strokeColor", [...parseColorInput(event.target.value), settings.strokeColor[3]])
          }
          type="color"
          value={colorInputValue(settings.strokeColor)}
        />
      </label>
      {(settings.kind === "line" || settings.kind === "bezier") && (
        <>
          <label>
            {t("shape.lineCap")}
            <select
              aria-label={t("shape.lineCap")}
              onChange={(event) =>
                update("lineCap", event.target.value as ShapeSettings["lineCap"])
              }
              value={settings.lineCap}
            >
              <option value="round">{t("shape.capRound")}</option>
              <option value="butt">{t("shape.capButt")}</option>
            </select>
          </label>
          {settings.kind === "bezier" && (
            <>
              <label>
                {t("shape.lineJoin")}
                <select
                  aria-label={t("shape.lineJoin")}
                  onChange={(event) =>
                    update("lineJoin", event.target.value as ShapeSettings["lineJoin"])
                  }
                  value={settings.lineJoin ?? "round"}
                >
                  <option value="miter">{t("shape.joinMiter")}</option>
                  <option value="bevel">{t("shape.joinBevel")}</option>
                  <option value="round">{t("shape.joinRound")}</option>
                </select>
              </label>
              {settings.path && (
                <>
                  <label>
                    {t("shape.closedPath")}
                    <input
                      aria-label={t("shape.closedPath")}
                      checked={settings.path.closed}
                      onChange={(event) => setPathClosed(event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                  <label>
                    {t("shape.trimStart")}
                    <input
                      aria-label={t("shape.trimStartA11y")}
                      max="100"
                      min="0"
                      onChange={(event) =>
                        update("trim", {
                          ...(settings.trim ?? { start: 0, end: 100, offset: 0 }),
                          start: Number(event.target.value),
                        })
                      }
                      step="0.1"
                      type="number"
                      value={settings.trim?.start ?? 0}
                    />
                  </label>
                  <label>
                    {t("shape.trimEnd")}
                    <input
                      aria-label={t("shape.trimEndA11y")}
                      max="100"
                      min="0"
                      onChange={(event) =>
                        update("trim", {
                          ...(settings.trim ?? { start: 0, end: 100, offset: 0 }),
                          end: Number(event.target.value),
                        })
                      }
                      step="0.1"
                      type="number"
                      value={settings.trim?.end ?? 100}
                    />
                  </label>
                  <label>
                    {t("shape.trimOffset")}
                    <input
                      aria-label={t("shape.trimOffsetA11y")}
                      max="100000"
                      min="-100000"
                      onChange={(event) =>
                        update("trim", {
                          ...(settings.trim ?? { start: 0, end: 100, offset: 0 }),
                          offset: Number(event.target.value),
                        })
                      }
                      step="0.1"
                      type="number"
                      value={settings.trim?.offset ?? 0}
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label>
            {t("shape.dashLength")}
            <input
              aria-label={t("shape.dashLength")}
              min="0"
              onChange={(event) => update("dashLength", Number(event.target.value))}
              step="1"
              type="number"
              value={settings.dashLength}
            />
          </label>
          <label>
            {t("shape.dashGap")}
            <input
              aria-label={t("shape.dashGap")}
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
