import type { WorkspaceDrag } from "../../workspace/interaction";
import type {
  WorkspaceDockPosition,
  WorkspaceGroupLocation,
  WorkspaceNode,
} from "../../workspace/layout";
import { DockGroup } from "./DockGroup";
import { DockSplit } from "./DockSplit";
import type { WorkspacePanelDefinition } from "./workspace-types";

export interface DockNodeProps {
  readonly node: WorkspaceNode;
  readonly canUndo: boolean;
  readonly panels: ReadonlyMap<string, WorkspacePanelDefinition>;
  readonly groups: readonly WorkspaceGroupLocation[];
  readonly drag: WorkspaceDrag | null;
  readonly maximizedGroupId: string | null;
  readonly onActivate: (groupId: string, panelId: string) => void;
  readonly onClose: (panelId: string) => void;
  readonly onCloseGroup: (groupId: string) => void;
  readonly onCloseOthers: (groupId: string, panelId: string) => void;
  readonly onDockGroup: (groupId: string) => void;
  readonly onDockPanel: (panelId: string) => void;
  readonly onDragChange: (drag: WorkspaceDrag | null) => void;
  readonly onDrop: (
    drag: WorkspaceDrag,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onFloat: (groupId: string, bounds: DOMRect) => void;
  readonly onFloatPanel: (panelId: string, bounds: DOMRect) => void;
  readonly onHover: (groupId: string) => void;
  readonly onMaximize: (groupId: string) => void;
  readonly onMoveGroup: (
    sourceGroupId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onMovePanel: (
    panelId: string,
    targetGroupId: string,
    position: WorkspaceDockPosition,
  ) => void;
  readonly onResize: (splitId: string, ratio: number) => void;
  readonly onUndo: () => void;
}

export function DockNode(props: DockNodeProps) {
  return props.node.kind === "split" ? (
    <DockSplit {...props} node={props.node} />
  ) : (
    <DockGroup
      drag={props.drag}
      canUndo={props.canUndo}
      group={props.node}
      groups={props.groups}
      maximized={props.maximizedGroupId === props.node.id}
      onActivate={props.onActivate}
      onClose={props.onClose}
      onCloseGroup={props.onCloseGroup}
      onCloseOthers={props.onCloseOthers}
      onDockGroup={props.onDockGroup}
      onDockPanel={props.onDockPanel}
      onDragChange={props.onDragChange}
      onDrop={props.onDrop}
      onFloat={props.onFloat}
      onFloatPanel={props.onFloatPanel}
      onHover={props.onHover}
      onMaximize={props.onMaximize}
      onMoveGroup={props.onMoveGroup}
      onMovePanel={props.onMovePanel}
      onUndo={props.onUndo}
      panels={props.panels}
    />
  );
}
