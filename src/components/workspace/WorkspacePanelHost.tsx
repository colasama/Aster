import { createContext, useContext } from "react";

export interface WorkspacePanelHostValue {
  readonly headerHost: HTMLElement | null;
}

export const WorkspacePanelHostContext = createContext<WorkspacePanelHostValue | null>(null);

export function useWorkspacePanelHost(): WorkspacePanelHostValue | null {
  return useContext(WorkspacePanelHostContext);
}
