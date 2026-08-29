import type { ReactNode } from "react";
import type { WorkspaceViewerIdentity } from "./WorkspaceViewerIdentity";

export interface WorkspacePanelDefinition {
  readonly id: string;
  readonly label: string;
  readonly element: ReactNode;
  /** Marks a panel as a viewer that can be locked or instantiated more than once. */
  readonly viewerType?: string;
  readonly viewerIdentity?: WorkspaceViewerIdentity;
  readonly viewerCanCreate?: boolean;
}
