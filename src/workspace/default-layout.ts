import type { WorkspaceLayout } from "./layout";

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  root: {
    kind: "split",
    id: "workspace-root",
    axis: "horizontal",
    ratio: 0.18,
    first: {
      kind: "tabGroup",
      id: "project-group",
      panels: ["project"],
      activePanelId: "project",
    },
    second: {
      kind: "split",
      id: "workspace-detail",
      axis: "horizontal",
      ratio: 0.76,
      first: {
        kind: "split",
        id: "workspace-center",
        axis: "vertical",
        ratio: 0.7,
        first: {
          kind: "tabGroup",
          id: "viewer-group",
          panels: ["viewport", "profiler"],
          activePanelId: "viewport",
        },
        second: {
          kind: "tabGroup",
          id: "timeline-group",
          panels: ["timeline", "graph"],
          activePanelId: "timeline",
        },
      },
      second: {
        kind: "tabGroup",
        id: "inspector-group",
        panels: ["inspector", "renderQueue"],
        activePanelId: "inspector",
      },
    },
  },
  floating: [],
  closedPanels: [],
};
