// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { activeComposition, createDemoProject } from "../../core/project/project";
import type { Project } from "../../core/types";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { TimelineLayerRow } from "./TimelineLayerRow";
import { buildTimelineSnapTargets } from "./timeline-interactions";

let root: Root | undefined;

function LoadProject({ project }: { project: Project }) {
  const { dispatch } = useEditor();
  useEffect(() => dispatch({ type: "loadProject", project }), [dispatch, project]);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem("aster.locale", "en-US");
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("TimelineLayerRow locked switches", () => {
  it("keeps the lock switch reachable while disabling mutation switches", () => {
    const project = createDemoProject();
    const composition = activeComposition(project);
    const layer = createLayerForComposition("text", composition);
    layer.locked = true;
    composition.layers = [layer];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <LoadProject project={project} />
            <TimelineLayerRow
              composition={composition}
              index={0}
              layer={layer}
              onContextMenu={() => undefined}
              onContextMenuKeyDown={() => undefined}
              onDragEnd={() => undefined}
              onDragStart={() => undefined}
              onDrop={() => undefined}
              onKeyframeTimePreview={() => undefined}
              onMarqueeStart={() => undefined}
              onTimingDragStart={() => undefined}
              pixelsPerSecond={82}
              selected
              startPointerDrag={() => undefined}
              timelineTargets={buildTimelineSnapTargets(composition, 0, composition.workArea)}
            />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const label = container.querySelector<HTMLElement>(".layer-label");
    const motionBlur = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable motion blur for New Text"]',
    );
    const enable3d = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Enable 3D for New Text"]',
    );
    const unlock = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Unlock New Text"]',
    );
    if (!label) throw new Error(`Expected layer label: ${container.innerHTML}`);
    expect(label.getAttribute("draggable")).toBe("false");
    expect(motionBlur?.disabled).toBe(true);
    expect(enable3d?.disabled).toBe(true);
    expect(unlock?.disabled).toBe(false);
  });
});
