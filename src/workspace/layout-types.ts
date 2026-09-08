export type WorkspaceAxis = "horizontal" | "vertical";

export type WorkspaceDockPosition = "center" | "left" | "right" | "top" | "bottom";

export type WorkspaceGroupPresentation = "tabs" | "stacked";

export interface WorkspaceViewerInstance {
  /** Stable identity for one viewer panel, also used as its layout panel id. */
  readonly id: string;
  /** Panel definition that supplies the viewer surface without copying project state. */
  readonly sourcePanelId: string;
  readonly viewerType: string;
  readonly locked: boolean;
  /** Project-local context. Locked contexts are intentionally not persisted. */
  readonly contextId?: string;
}

export interface WorkspaceTabGroup {
  readonly kind: "tabGroup";
  readonly id: string;
  readonly panels: readonly string[];
  readonly activePanelId: string;
  readonly presentation?: WorkspaceGroupPresentation;
  readonly stackSolo?: boolean;
  readonly expandedPanelIds?: readonly string[];
}

export interface WorkspaceSplit {
  readonly kind: "split";
  readonly id: string;
  readonly axis: WorkspaceAxis;
  readonly ratio: number;
  readonly first: WorkspaceNode;
  readonly second: WorkspaceNode;
}

export type WorkspaceNode = WorkspaceTabGroup | WorkspaceSplit;

export interface WorkspaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatingWorkspace {
  readonly id: string;
  readonly node: WorkspaceNode;
  readonly bounds: WorkspaceBounds;
  readonly displayId?: string;
}

export interface WorkspaceLayout {
  readonly root: WorkspaceNode | null;
  readonly floating: readonly FloatingWorkspace[];
  readonly closedPanels: readonly string[];
  readonly maximizedGroupId?: string;
  readonly viewers?: readonly WorkspaceViewerInstance[];
}

export interface WorkspaceGroupLocation {
  readonly group: WorkspaceTabGroup;
  readonly floatingId?: string;
}

export const MIN_SPLIT_RATIO = 0.1;

export const MAX_SPLIT_RATIO = 0.9;

export const MAX_VIEWER_INSTANCES_PER_SOURCE = 4;
