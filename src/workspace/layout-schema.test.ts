import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "./layout";
import {
  CURRENT_WORKSPACE_LAYOUT_VERSION,
  deserializeWorkspaceLayout,
  serializeWorkspaceLayout,
} from "./layout-schema";

function defaultLayout(): WorkspaceLayout {
  return {
    root: {
      kind: "split",
      id: "root-split",
      axis: "horizontal",
      ratio: 0.32,
      first: {
        kind: "tabGroup",
        id: "project-tabs",
        panels: ["project", "effects"],
        activePanelId: "project",
      },
      second: {
        kind: "tabGroup",
        id: "viewport-tabs",
        panels: ["viewport"],
        activePanelId: "viewport",
      },
    },
    floating: [
      {
        id: "floating-1",
        node: {
          kind: "tabGroup",
          id: "inspector-tabs",
          panels: ["inspector"],
          activePanelId: "inspector",
        },
        bounds: { x: 80, y: 60, width: 480, height: 640 },
        displayId: "secondary",
      },
    ],
    closedPanels: ["audio"],
  };
}

describe("workspace layout persistence", () => {
  it("round-trips a detached, versioned document", () => {
    const layout = defaultLayout();
    const document = serializeWorkspaceLayout(layout);
    expect(document.schemaVersion).toBe(CURRENT_WORKSPACE_LAYOUT_VERSION);
    expect(document.root).not.toBe(layout.root);
    expect(document.floating).not.toBe(layout.floating);
    expect(
      deserializeWorkspaceLayout(document, { root: null, floating: [], closedPanels: [] }),
    ).toEqual(layout);
  });

  it("migrates the unversioned version-zero shape", () => {
    const { schemaVersion: _, ...legacy } = serializeWorkspaceLayout(defaultLayout());
    expect(
      deserializeWorkspaceLayout(legacy, { root: null, floating: [], closedPanels: [] }),
    ).toEqual(defaultLayout());
  });

  it("normalizes bounded recoverable values after decoding", () => {
    const document = serializeWorkspaceLayout(defaultLayout());
    const source = structuredClone(document) as {
      root: {
        ratio: number;
        first: { panels: string[]; activePanelId: string };
      };
      closedPanels: string[];
    } & typeof document;
    source.root.ratio = 0;
    source.root.first.panels.push("project");
    source.closedPanels.push("audio", "project");

    const decoded = deserializeWorkspaceLayout(source, {
      root: null,
      floating: [],
      closedPanels: [],
    });
    expect(decoded.root).toMatchObject({ ratio: 0.1 });
    expect(
      decoded.root && decoded.root.kind === "split" ? decoded.root.first : undefined,
    ).toMatchObject({ panels: ["project", "effects"] });
    expect(decoded.closedPanels).toEqual(["audio"]);
  });

  it.each([
    null,
    { schemaVersion: 99, root: null, floating: [], closedPanels: [] },
    { schemaVersion: 1, root: {}, floating: [], closedPanels: [] },
    {
      schemaVersion: 1,
      root: {
        kind: "split",
        id: "duplicate",
        axis: "horizontal",
        ratio: 0.5,
        first: {
          kind: "tabGroup",
          id: "duplicate",
          panels: ["project"],
          activePanelId: "project",
        },
        second: {
          kind: "tabGroup",
          id: "other",
          panels: ["viewport"],
          activePanelId: "viewport",
        },
      },
      floating: [],
      closedPanels: [],
    },
    {
      schemaVersion: 1,
      root: null,
      floating: [
        {
          id: "floating-1",
          node: {
            kind: "tabGroup",
            id: "tabs-1",
            panels: ["project"],
            activePanelId: "project",
          },
          bounds: { x: 0, y: 0, width: -1, height: 400 },
        },
      ],
      closedPanels: [],
    },
  ])("falls back atomically for malformed or incompatible data", (value) => {
    const fallback = defaultLayout();
    expect(deserializeWorkspaceLayout(value, fallback)).toBe(fallback);
  });

  it("rejects over-sized documents before they enter editor state", () => {
    const fallback = defaultLayout();
    const value = {
      schemaVersion: 1,
      root: null,
      floating: [],
      closedPanels: Array.from({ length: 513 }, (_, index) => `panel-${index}`),
    };
    expect(deserializeWorkspaceLayout(value, fallback)).toBe(fallback);
  });
});
