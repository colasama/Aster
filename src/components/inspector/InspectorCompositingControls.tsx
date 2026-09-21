import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { evaluateLayerSourceTime } from "../../core/animation/layer-time";
import { evaluateAnimatable } from "../../core/animation/timeline";
import { canToggleLayer, type Operation } from "../../core/editing/operations";
import { activeComposition } from "../../core/project/project";
import { createId, type Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { useInspectorLayers, valuesDiffer } from "./inspector-selection";
import { MixedValueInput, MixedValueSelect } from "./MixedValueInput";

export function InspectorCompositingControls({ layer }: { layer: Layer }) {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const layers = useInspectorLayers(layer);
  const editable = layers.filter((entry) => !entry.locked);
  const composition = activeComposition(state.project);
  const supportsMapping = layers.every((entry) => entry.kind !== "adjustment");
  const mixed = (read: (entry: Layer) => unknown) => valuesDiffer(layers.map(read));
  const update = (operation: (entry: Layer) => Operation) =>
    dispatch({ type: "operation", operations: editable.map(operation) });
  const setTiming = (field: "inPoint" | "outPoint", value: number) => {
    if (!Number.isFinite(value)) return;
    update((entry) => ({
      type: "setLayerTiming",
      layerId: entry.id,
      inPoint: entry.inPoint,
      outPoint: entry.outPoint,
      [field]: value,
    }));
  };
  const selected = new Set(layers.map((entry) => entry.id));
  const validParent = (candidate: Layer) => {
    const visited = new Set<string>();
    let current: Layer | undefined = candidate;
    while (current) {
      if (selected.has(current.id) || visited.has(current.id)) return false;
      visited.add(current.id);
      const parentId: string | undefined = current.parentId;
      current = composition.layers.find((entry) => entry.id === parentId);
    }
    return candidate.kind !== "adjustment";
  };
  return (
    <div className="inspector-section blend-section">
      <div className="section-title">
        <button
          className="section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t(
            supportsMapping
              ? "inspector.compositing.title"
              : "inspector.compositing.adjustmentTiming",
          )}
        </button>
      </div>
      {open && (
        <fieldset className="compositing-grid" disabled={!editable.length}>
          {supportsMapping && (
            <label>
              {t("inspector.compositing.parent")}
              <MixedValueSelect
                mixed={mixed((entry) => entry.parentId ?? "")}
                value={layer.parentId ?? ""}
                onChange={(event) =>
                  update((entry) => ({
                    type: "setParent",
                    layerId: entry.id,
                    parentId: event.target.value || undefined,
                  }))
                }
              >
                <option value="">{t("common.none")}</option>
                {composition.layers.filter(validParent).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </MixedValueSelect>
            </label>
          )}
          {(["inPoint", "outPoint"] as const).map((field) => (
            <label key={field}>
              {t(`inspector.compositing.${field}`)}
              <MixedValueInput
                mixed={mixed((entry) => entry[field])}
                value={layer[field]}
                min={
                  field === "outPoint"
                    ? Math.max(...layers.map((entry) => entry.inPoint)) + 1 / 240
                    : 0
                }
                type="number"
                step="0.01"
                onChange={(event) => setTiming(field, Number(event.target.value))}
              />
            </label>
          ))}
          {supportsMapping && (
            <>
              <label>
                {t("inspector.compositing.sourceOffset")}
                <MixedValueInput
                  type="number"
                  step="0.01"
                  min={0}
                  value={layer.timeOffset ?? 0}
                  mixed={mixed((entry) => entry.timeOffset ?? 0)}
                  onChange={(event) =>
                    update((entry) => ({
                      type: "setLayerTimeMapping",
                      layerId: entry.id,
                      offset: Number(event.target.value),
                      stretch: entry.timeStretch ?? 1,
                    }))
                  }
                />
              </label>
              <label>
                {t("inspector.compositing.timeStretch")}
                <MixedValueInput
                  type="number"
                  step={1}
                  min={1}
                  value={(layer.timeStretch ?? 1) * 100}
                  mixed={mixed((entry) => entry.timeStretch ?? 1)}
                  onChange={(event) =>
                    update((entry) => ({
                      type: "setLayerTimeMapping",
                      layerId: entry.id,
                      offset: entry.timeOffset ?? 0,
                      stretch: Number(event.target.value) / 100,
                    }))
                  }
                />
              </label>
              <label className="compositing-check">
                <MixedValueInput
                  type="checkbox"
                  checked={Boolean(layer.timeRemap)}
                  mixed={mixed((entry) => Boolean(entry.timeRemap))}
                  onChange={(event) =>
                    update((entry) => ({
                      type: "setLayerTimeRemap",
                      layerId: entry.id,
                      value: event.target.checked
                        ? (entry.timeRemap ?? {
                            mode: "static",
                            value: evaluateLayerSourceTime(entry, state.currentTime),
                          })
                        : undefined,
                    }))
                  }
                />
                {t("inspector.compositing.enableRemap")}
              </label>
              {layers.every((entry) => entry.timeRemap) && (
                <label>
                  {t("inspector.compositing.remappedTime")}
                  <MixedValueInput
                    type="number"
                    min={0}
                    step="0.01"
                    value={
                      layer.timeRemap ? evaluateAnimatable(layer.timeRemap, state.currentTime) : 0
                    }
                    mixed={mixed(
                      (entry) =>
                        entry.timeRemap && evaluateAnimatable(entry.timeRemap, state.currentTime),
                    )}
                    onChange={(event) =>
                      update((entry) => {
                        const value = Number(event.target.value);
                        const track = entry.timeRemap;
                        if (track?.mode !== "animated")
                          return {
                            type: "setLayerTimeRemap",
                            layerId: entry.id,
                            value: { mode: "static", value },
                          };
                        const current = track.keyframes.find(
                          (keyframe) => Math.abs(keyframe.time - state.currentTime) <= 0.000_001,
                        );
                        return {
                          type: "setLayerTimeRemap",
                          layerId: entry.id,
                          value: {
                            ...track,
                            keyframes: [
                              ...track.keyframes.filter((keyframe) => keyframe !== current),
                              {
                                ...current,
                                id: current?.id ?? createId(),
                                time: state.currentTime,
                                value,
                                interpolation: current?.interpolation ?? "linear",
                              },
                            ].sort((left, right) => left.time - right.time),
                          },
                        };
                      })
                    }
                  />
                </label>
              )}
              <label className="compositing-check">
                <MixedValueInput
                  type="checkbox"
                  checked={layer.threeDimensional}
                  mixed={mixed((entry) => entry.threeDimensional)}
                  onChange={(event) =>
                    dispatch({
                      type: "operation",
                      operations: editable
                        .filter(
                          (entry) =>
                            canToggleLayer(entry, "threeDimensional") &&
                            entry.threeDimensional !== event.target.checked,
                        )
                        .map((entry) => ({
                          type: "toggleLayer",
                          layerId: entry.id,
                          field: "threeDimensional",
                        })),
                    })
                  }
                />
                {t("inspector.compositing.enable3d")}
              </label>
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}
