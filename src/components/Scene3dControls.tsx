import type { CameraSettings, Layer, LightSettings, Material3d } from "../core/types";
import { useEditor } from "../state/editor-store";

export function Scene3dControls({ layer }: { layer: Layer }) {
  const { dispatch } = useEditor();

  const updateMaterial = (field: keyof Material3d, value: number) => {
    if (!Number.isFinite(value)) return;
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setMaterial3d",
          layerId: layer.id,
          material: {
            metallic: layer.material?.metallic ?? 0.18,
            roughness: layer.material?.roughness ?? 0.42,
            emissive: layer.material?.emissive ?? 0,
            [field]: value,
          },
        },
      ],
    });
  };

  const updateLight = (field: keyof LightSettings, value: string | number) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setLightSettings",
          layerId: layer.id,
          light: {
            kind: layer.light?.kind ?? "directional",
            intensity: layer.light?.intensity ?? 2.5,
            range: layer.light?.range ?? 2400,
            coneAngle: layer.light?.coneAngle ?? 45,
            [field]: value,
          },
        },
      ],
    });
  };

  const updateCamera = (field: keyof CameraSettings, value: string | number) => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCameraSettings",
          layerId: layer.id,
          camera: {
            projection: layer.camera?.projection ?? "perspective",
            fieldOfView: layer.camera?.fieldOfView ?? 50,
            orthographicSize: layer.camera?.orthographicSize ?? 2160,
            [field]: value,
          },
        },
      ],
    });
  };

  if (layer.kind === "mesh") {
    return (
      <>
        <NumericControl
          label="Metallic"
          max={1}
          min={0}
          onChange={(value) => updateMaterial("metallic", value)}
          step={0.01}
          value={layer.material?.metallic ?? 0.18}
        />
        <NumericControl
          label="Roughness"
          max={1}
          min={0.04}
          onChange={(value) => updateMaterial("roughness", value)}
          step={0.01}
          value={layer.material?.roughness ?? 0.42}
        />
        <NumericControl
          label="Emissive"
          max={16}
          min={0}
          onChange={(value) => updateMaterial("emissive", value)}
          step={0.05}
          value={layer.material?.emissive ?? 0}
        />
      </>
    );
  }

  if (layer.kind === "camera") {
    const projection = layer.camera?.projection ?? "perspective";
    return (
      <>
        <label>
          Projection
          <select
            aria-label="Camera projection"
            onChange={(event) => updateCamera("projection", event.target.value)}
            value={projection}
          >
            <option value="perspective">Perspective</option>
            <option value="orthographic">Orthographic</option>
          </select>
        </label>
        {projection === "perspective" ? (
          <NumericControl
            label="Field of view"
            max={179}
            min={1}
            onChange={(value) => updateCamera("fieldOfView", value)}
            step={1}
            value={layer.camera?.fieldOfView ?? 50}
          />
        ) : (
          <NumericControl
            label="Orthographic size"
            max={100_000}
            min={1}
            onChange={(value) => updateCamera("orthographicSize", value)}
            step={10}
            value={layer.camera?.orthographicSize ?? 2160}
          />
        )}
      </>
    );
  }

  if (layer.kind !== "light") return null;
  const lightKind = layer.light?.kind ?? "directional";
  return (
    <>
      <label>
        Light type
        <select
          aria-label="Light type"
          onChange={(event) => updateLight("kind", event.target.value)}
          value={lightKind}
        >
          <option value="directional">Directional</option>
          <option value="point">Point</option>
          <option value="spot">Spot</option>
        </select>
      </label>
      <NumericControl
        label="Intensity"
        max={100}
        min={0}
        onChange={(value) => updateLight("intensity", value)}
        step={0.1}
        value={layer.light?.intensity ?? 2.5}
      />
      {(lightKind === "point" || lightKind === "spot") && (
        <NumericControl
          label="Range"
          max={20_000}
          min={1}
          onChange={(value) => updateLight("range", value)}
          step={10}
          value={layer.light?.range ?? 2400}
        />
      )}
      {lightKind === "spot" && (
        <NumericControl
          label="Cone angle"
          max={179}
          min={1}
          onChange={(value) => updateLight("coneAngle", value)}
          step={1}
          value={layer.light?.coneAngle ?? 45}
        />
      )}
      <label>
        Light color
        <input
          aria-label="Light color"
          onChange={(event) => {
            const color = Number.parseInt(event.target.value.slice(1), 16);
            dispatch({
              type: "operation",
              operations: [
                {
                  type: "setLayerColor",
                  layerId: layer.id,
                  color: [
                    ((color >> 16) & 0xff) / 255,
                    ((color >> 8) & 0xff) / 255,
                    (color & 0xff) / 255,
                    layer.color[3],
                  ],
                },
              ],
            });
          }}
          type="color"
          value={rgbColorInput(layer.color)}
        />
      </label>
    </>
  );
}

function NumericControl({
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function rgbColorInput(color: readonly [number, number, number, number]): string {
  return `#${color
    .slice(0, 3)
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
