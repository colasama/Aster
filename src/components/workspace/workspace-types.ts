import type { ReactNode } from "react";

export interface WorkspacePanelDefinition {
  readonly id: string;
  readonly label: string;
  readonly element: ReactNode;
}
