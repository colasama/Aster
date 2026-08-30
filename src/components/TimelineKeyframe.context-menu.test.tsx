// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectEditableKeyframes } from "../core/keyframe-editing";
import { activeComposition } from "../core/project";
import { I18nProvider } from "../i18n/react";
import { EditorProvider, type EditorState, useEditor } from "../state/editor-store";
import { TimelineKeyframe } from "./TimelineKeyframe";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function Harness({ capture, open }: { capture: (state: EditorState) => void; open: () => void }) {
  const { state } = useEditor();
  const composition = activeComposition(state.project);
  const entry = collectEditableKeyframes(composition)[0];
  useEffect(() => {
    capture(state);
  }, [capture, state]);
  if (!entry) throw new Error("Expected demo keyframe");
  return (
    <div
      aria-label="Timeline row"
      onContextMenu={(event) => {
        event.preventDefault();
        open();
      }}
      role="application"
    >
      <TimelineKeyframe
        compositionDuration={composition.duration}
        entry={{ ...entry, label: "Opacity" }}
        frameDuration={composition.frameRate.denominator / composition.frameRate.numerator}
        onPreview={() => undefined}
        pixelsPerSecond={100}
        startPointerDrag={() => undefined}
        timelineTargets={[]}
      />
    </div>
  );
}

describe("TimelineKeyframe context menu routing", () => {
  it("selects without deleting and bubbles pointer and keyboard menu requests", () => {
    const open = vi.fn();
    let latest: EditorState | undefined;
    act(() =>
      root.render(
        <I18nProvider>
          <EditorProvider>
            <Harness capture={(state) => (latest = state)} open={open} />
          </EditorProvider>
        </I18nProvider>,
      ),
    );
    const marker = container.querySelector<HTMLButtonElement>(".keyframe");
    if (!marker || !latest) throw new Error("Expected keyframe marker");
    const before = collectEditableKeyframes(activeComposition(latest.project));
    const keyframeId = before[0]?.keyframe.id;

    act(() =>
      marker.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 18,
        }),
      ),
    );
    expect(open).toHaveBeenCalledOnce();
    expect(latest.selectedKeyframes).toEqual([keyframeId]);
    expect(collectEditableKeyframes(activeComposition(latest.project))).toHaveLength(before.length);
    expect(latest.history.past).toHaveLength(0);

    act(() =>
      marker.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "F10",
          shiftKey: true,
        }),
      ),
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(latest.selectedKeyframes).toEqual([keyframeId]);
    expect(latest.history.past).toHaveLength(0);
  });
});
