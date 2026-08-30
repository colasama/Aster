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

  it("uses the dock host's viewport insets for fixed-position frames", () => {
    const source: WorkspaceLayout = {
      ...layout(),
      floating: [
        {
          ...layout().floating[0],
          bounds: { x: -20, y: 10, width: 700, height: 700 },
        },
      ],
    };
    expect(
      remapFloatingWorkspacesToHost(source, {
        width: 1_220,
        height: 880,
        leftInset: 20,
        topInset: 70,
      }).floating[0]?.bounds,
    ).toEqual({ x: 20, y: 70, width: 700, height: 700 });
  });

  it.each([0.75, 1, 1.25, 1.5, 1.75, 2])(
    "keeps floating geometry reachable at %s UI scale",
    (scale) => {
      const width = 1_440 / scale;
      const height = 900 / scale;
      const topInset = 70;
      const result = remapFloatingWorkspacesToHost(layout(), {
        width,
        height,
        topInset,
      });
      const bounds = result.floating[0]?.bounds;
      if (!bounds) throw new Error("Expected floating workspace");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(topInset);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    },
  );
});
