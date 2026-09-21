import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Layer } from "../../core/types";
import { useI18n } from "../../i18n/react";
import { AudioControls } from "./AudioControls";
import { useInspectorLayers } from "./inspector-selection";
import { Scene3dControls } from "./Scene3dControls";
import { ShapeControls } from "./ShapeControls";
import { SolidControls } from "./SolidControls";
import { TextControls } from "./TextControls";

export function LayerContentControls({ layer }: { layer: Layer }) {
  const { t } = useI18n();
  const layers = useInspectorLayers(layer);
  if (
    !layers.every(
      (entry) =>
        entry.kind === layer.kind ||
        (["audio", "video"].includes(entry.kind) && ["audio", "video"].includes(layer.kind)),
    )
  )
    return null;
  let content: ReactNode;
  let title: string;
  switch (layer.kind) {
    case "text":
      title = t("project.add.text");
      content = <TextControls layer={layer} />;
      break;
    case "shape":
      title = t("project.add.shape");
      content = <ShapeControls layer={layer} />;
      break;
    case "solid":
      if (!layer.solid) return null;
      title = t("project.add.solid");
      content = <SolidControls layer={layer} />;
      break;
    case "video":
    case "audio":
      title = t("project.add.audio");
      content = <AudioControls layer={layer} />;
      break;
    case "camera":
    case "light":
    case "mesh":
    case "generator":
      title = t("inspector.content.scene");
      content = <Scene3dControls layer={layer} />;
      break;
    default:
      return null;
  }
  return (
    <details className="inspector-section layer-content-section" open>
      <summary className="section-title">
        <ChevronRight size={14} />
        {title}
      </summary>
      <fieldset className="compositing-grid" disabled={layers.every((entry) => entry.locked)}>
        {content}
      </fieldset>
    </details>
  );
}
