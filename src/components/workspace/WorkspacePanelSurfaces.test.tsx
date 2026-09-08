// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider } from "../../state/editor-store";
import { WorkspaceTimelineSurface } from "./WorkspacePanelSurfaces";

vi.mock("../timeline/Timeline", () => ({
  Timeline: ({ mode }: { mode?: string }) => <div data-mode={mode} />,
}));

it("keeps simultaneously mounted timeline and graph surfaces in independent modes", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <WorkspaceTimelineSurface mode="timeline" />
            <WorkspaceTimelineSurface mode="graph" />
          </EditorProvider>
        </I18nProvider>,
      ),
    );
    expect(
      [...container.querySelectorAll("[data-mode]")].map((entry) =>
        entry.getAttribute("data-mode"),
      ),
    ).toEqual(["timeline", "graph"]);
  } finally {
    act(() => root.unmount());
  }
});
