import { createContext, type PropsWithChildren, useContext } from "react";

export interface WorkspaceViewerIdentity {
  readonly id: string;
  readonly sourcePanelId: string;
  readonly viewerType: string;
  readonly locked: boolean;
  readonly contextId?: string;
}

const WorkspaceViewerIdentityContext = createContext<WorkspaceViewerIdentity | null>(null);

export function WorkspaceViewerIdentityProvider({
  children,
  identity,
}: PropsWithChildren<{ readonly identity: WorkspaceViewerIdentity }>) {
  return (
    <WorkspaceViewerIdentityContext.Provider value={identity}>
      {children}
    </WorkspaceViewerIdentityContext.Provider>
  );
}

export function useWorkspaceViewerIdentity(): WorkspaceViewerIdentity | null {
  return useContext(WorkspaceViewerIdentityContext);
}
