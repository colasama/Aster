import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  LockKeyhole,
  LockOpen,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { canToggleLayer } from "../../core/editing/operations";
import { activeComposition } from "../../core/project/project";
import { useI18n } from "../../i18n/react";
import { useEditor } from "../../state/editor-store";
import { AiPanel } from "../ai/AiPanel";
import { Panel, PanelTabs } from "../Panel";
import { LayerBlendOptions } from "../timeline/LayerBlendOptions";
import { ClonerControls } from "./ClonerControls";
import { EffectEditor } from "./EffectEditor";
import { commonEffectTargets } from "./effect-selection";
import { InspectorCompositingControls } from "./InspectorCompositingControls";
import { InspectorTransformControls } from "./InspectorTransformControls";
import { InspectorSelection, valuesDiffer } from "./inspector-selection";
import { LayerContentControls } from "./LayerContentControls";
import { MotionBlurControls } from "./MotionBlurControls";

export function Inspector() {
  const { state, dispatch } = useEditor();
  const { t } = useI18n();
  const [propertyClipboard, setPropertyClipboard] = useState<number>();
  const composition = activeComposition(state.project);
  const layers = state.selection.flatMap((id) =>
    composition.layers.filter((entry) => entry.id === id),
  );
  const layer = layers[0];
  const effectGroups = commonEffectTargets(layers);
  const allLocked = layers.every((entry) => entry.locked);
  return (
    <Panel
      className="inspector-panel"
      tabs={
        <PanelTabs
          active={state.rightTab}
          onChange={(tab) => dispatch({ type: "setRightTab", tab: tab as "properties" | "ai" })}
          tabs={[
            { id: "properties", label: t("inspector.tab.properties") },
            { id: "ai", label: t("inspector.tab.ai") },
          ]}
        />
      }
    >
      {state.rightTab === "ai" ? (
        <AiPanel />
      ) : layer ? (
        <InspectorSelection
          layers={layers}
          key={`${state.project.id}:${composition.id}:${state.selection.join(",")}`}
        >
          <div className="inspector-scroll">
            <div className="selected-layer-card">
              <span className={`layer-kind-icon ${layer.kind}`}>
                <Box size={16} />
              </span>
              <div>
                <strong>
                  {layers.length > 1
                    ? t("inspector.selection", { count: layers.length })
                    : layer.name}
                </strong>
                {layers.length === 1 && (
                  <small>
                    {t("inspector.layerSummary", {
                      kind: layer.kind,
                      dimension: layer.threeDimensional ? "3D" : "2D",
                    })}
                  </small>
                )}
              </div>
              <button
                aria-label={
                  layers.every((entry) => entry.visible)
                    ? t("inspector.visible.hide")
                    : t("inspector.visible.show")
                }
                aria-pressed={
                  valuesDiffer(layers.map((entry) => entry.visible)) ? "mixed" : layer.visible
                }
                className={layers.every((entry) => entry.visible) ? "active" : ""}
                onClick={() =>
                  dispatch({
                    type: "operation",
                    operations: layers
                      .filter(
                        (entry) =>
                          canToggleLayer(entry, "visible") &&
                          entry.visible === layers.every((candidate) => candidate.visible),
                      )
                      .map((entry) => ({
                        type: "toggleLayer",
                        layerId: entry.id,
                        field: "visible",
                      })),
                  })
                }
                type="button"
              >
                {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                aria-label={
                  layers.every((entry) => entry.solo)
                    ? t("inspector.solo.disable")
                    : t("inspector.solo.enable")
                }
                aria-pressed={
                  valuesDiffer(layers.map((entry) => entry.solo)) ? "mixed" : layer.solo
                }
                className={layers.every((entry) => entry.solo) ? "active" : ""}
                onClick={() =>
                  dispatch({
                    type: "operation",
                    operations: layers
                      .filter(
                        (entry) =>
                          canToggleLayer(entry, "solo") &&
                          entry.solo === layers.every((candidate) => candidate.solo),
                      )
                      .map((entry) => ({ type: "toggleLayer", layerId: entry.id, field: "solo" })),
                  })
                }
                type="button"
              >
                <CircleDot size={14} />
              </button>
              <button
                aria-label={
                  layers.every((entry) => entry.locked)
                    ? t("inspector.lock.unlock")
                    : t("inspector.lock.lock")
                }
                aria-pressed={
                  valuesDiffer(layers.map((entry) => entry.locked)) ? "mixed" : layer.locked
                }
                className={layers.every((entry) => entry.locked) ? "active" : ""}
                onClick={() =>
                  dispatch({
                    type: "operation",
                    operations: layers
                      .filter(
                        (entry) =>
                          canToggleLayer(entry, "locked") &&
                          entry.locked === layers.every((candidate) => candidate.locked),
                      )
                      .map((entry) => ({
                        type: "toggleLayer",
                        layerId: entry.id,
                        field: "locked",
                      })),
                  })
                }
                type="button"
              >
                {layer.locked ? <LockKeyhole size={14} /> : <LockOpen size={14} />}
              </button>
            </div>
            <InspectorTransformControls
              layer={layer}
              propertyClipboard={propertyClipboard}
              setPropertyClipboard={setPropertyClipboard}
            />
            {layers.every((entry) => entry.kind !== "adjustment") && (
              <LayerBlendOptions layer={layer} />
            )}
            <LayerContentControls layer={layer} />
            <MotionBlurControls composition={composition} layer={layer} />
            <fieldset className="inspector-section effects-section" disabled={allLocked}>
              <div className="section-title static">
                <ChevronDown size={13} /> {t("inspector.effects.title")} <span />
              </div>
              {effectGroups.length === 0 && (
                <div className="empty-effects">
                  <Sparkles size={18} />
                  <span>{t("inspector.effects.empty")}</span>
                </div>
              )}
              {effectGroups.map((targets) => (
                <EffectEditor
                  effect={targets[0].effect}
                  key={targets[0].effect.id}
                  layerId={layer.id}
                  targets={targets}
                />
              ))}
            </fieldset>
            <InspectorCompositingControls layer={layer} />
            {layers.every(
              (entry) =>
                entry.kind !== "adjustment" && entry.kind !== "camera" && entry.kind !== "light",
            ) && (
              <details className="inspector-section cloner-section" open={Boolean(layer.cloner)}>
                <summary className="section-title">
                  <ChevronRight size={14} />
                  {t("inspector.content.cloner")}
                </summary>
                <fieldset className="compositing-grid" disabled={allLocked}>
                  <ClonerControls layer={layer} />
                </fieldset>
              </details>
            )}
          </div>
        </InspectorSelection>
      ) : (
        <div className="empty-inspector">{t("inspector.empty")}</div>
      )}
    </Panel>
  );
}
