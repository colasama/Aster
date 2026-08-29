import type { WorkspaceDrag } from "../../workspace/interaction";
import type { WorkspaceDockPosition, WorkspaceNode } from "../../workspace/layout";
import { DockGroup } from "./DockGroup";
import { DockSplit } from "./DockSplit";
import type { WorkspacePanelDefinition } from "./workspace-types";

export interface DockNodeProps {
  readonly node: WorkspaceNode;
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly drag: WorkspaceDrag | null;
  readonly maximizedGroupId: string | null;
  readonly onActivate: (groupId: string, panelId: string) => void;
  readonly onClose: (panelId: string) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onDrop: (
    drag: WorkspaceDrag,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onFloat: (groupId: string, bounds: DOMRect) => void;
  readonly onHover: (groupId: string) => void;
  readonly onMaximize: (groupId: string) => void;
  readonly onResize: (splitId: string, ratio: number) => void;
}

export function DockNode(props: DockNodeProps) {
  return props.node.kind === "split" ? (
    <DockSplit {...props} node={props.node} />
  ) : (
    <DockGroup
      drag={props.drag}
      group={props.node}
      maximized={props.maximizedGroupId === props.node.id}
      onActivate={props.onActivate}
      onClose={props.onClose}
      onDragChange={props.onDragChange}
      onDrop={props.onDrop}
      onFloat={props.onFloat}
      onHover={props.onHover}
      onMaximize={props.onMaximize}
      panels={props.panels}
    />
  );
}
