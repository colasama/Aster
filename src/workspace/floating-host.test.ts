import { describe, expect, it } from "vitest";
import { remapFloatingWorkspacesToHost } from "./floating-host";
import type { WorkspaceLayout } from "./layout";

function layout(): WorkspaceLayout {
  return {
    root: null,
    floating: [
      {
        id: "floating-1",
        node: {
          kind: "tabGroup",
          id: "group-1",
          panels: ["project"],
          activePanelId: "project",
        },
        bounds: { x: 1_500, y: -80, width: 900, height: 1_000 },
        displayId: "removed-display",
      },
    ],
    closedPanels: [],
  };
}

describe("floating workspace host remapping", () => {
  it("fits a removed-monitor frame into the current display without rebuilding its node", () => {
    const source = layout();
    const result = remapFloatingWorkspacesToHost(source, {
      width: 1_280,
      height: 720,
      topInset: 31,
      displayId: "primary",
    });
    expect(result.floating[0]).toMatchObject({
      bounds: { x: 380, y: 31, width: 900, height: 689 },
      displayId: "primary",
    });
    expect(result.floating[0].node).toBe(source.floating[0].node);
  });

  it("preserves identity when all frames already fit the host", () => {
    const source: WorkspaceLayout = {
      ...layout(),
      floating: [
        {
          ...layout().floating[0],
          bounds: { x: 80, y: 60, width: 640, height: 480 },
          displayId: "primary",
        },
      ],
    };
    expect(
      remapFloatingWorkspacesToHost(source, {
        width: 1_280,
        height: 720,
        topInset: 31,
        displayId: "primary",
      }),
    ).toBe(source);
  });
});
