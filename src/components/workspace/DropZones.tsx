import type { DragEvent } from "react";
import { useI18n } from "../../i18n/react";
import type { WorkspaceDockPosition } from "../../workspace/layout";

const positions: readonly WorkspaceDockPosition[] = ["left", "right", "top", "bottom", "center"];

export function DropZones({ onDrop }: { onDrop: (position: WorkspaceDockPosition) => void }) {
  const { t } = useI18n();
  const drop = (event: DragEvent, position: WorkspaceDockPosition) => {
    event.preventDefault();
    event.stopPropagation();
    onDrop(position);
  };
  return (
    <div className="workspace-drop-zones">
      {positions.map((position) => (
        <button
          aria-label={t(`workspace.drop.${position}`)}
          className={`workspace-drop-zone ${position}`}
          key={position}
          onDragEnter={(event) => event.preventDefault()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => drop(event, position)}
          tabIndex={-1}
          type="button"
        />
      ))}
    </div>
  );
}
