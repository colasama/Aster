// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectEditableKeyframes } from "../../core/animation/keyframe-editing";
import { activeComposition } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import type { WindowPointerDragCallbacks } from "../use-window-pointer-drag";
import { type TimelineLayerActions, TimelineLayers } from "./TimelineLayers";
import { buildTimelineSnapTargets } from "./timeline-interactions";

const renders = vi.hoisted(() => vi.fn());
vi.mock("./TimelineLayerRow", async (original) => {
  const module = await original<typeof import("./TimelineLayerRow")>();
  return {
    ...module,
    TimelineLayerRow: (props: Parameters<typeof module.TimelineLayerRow>[0]) => {
      renders();
      return <module.TimelineLayerRow {...props} />;
    },
  };
});

let root: Root | undefined;
let editor: ReturnType<typeof useEditor>;
let gesture: WindowPointerDragCallbacks | undefined;
const menuTimes: number[] = [];
const preview = vi.fn();
const startDrag = (_id: number, callbacks: WindowPointerDragCallbacks) => {
  gesture = callbacks;
};

function Harness() {
  editor = useEditor();
  const { state } = editor;
  const composition = activeComposition(state.project);
  const actions = useRef<TimelineLayerActions>({
    marquee() {},
    timing() {},
    menu() {},
    menuKey() {},
  });
  actions.current.menu = () => menuTimes.push(state.currentTime);
  const targets = useRef(
    buildTimelineSnapTargets(composition, state.currentTime, composition.workArea),
  );
  targets.current = [{ kind: "playhead", time: state.currentTime }];
  return (
    <TimelineLayers
      composition={composition}
      pixelsPerSecond={100}
      onKeyframeTimePreview={preview}
      startPointerDrag={startDrag}
      actions={actions}
      targets={targets}
    />
  );
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  renders.mockClear();
  preview.mockClear();
  menuTimes.length = 0;
  gesture = undefined;
});

describe("stationary timeline during playback", () => {
  it("skips row renders for clock/metrics while preserving selection, edits and fresh gestures", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <Harness />
          </EditorProvider>
        </I18nProvider>,
      ),
    );
    const initialRenders = renders.mock.calls.length;
    const composition = activeComposition(editor.state.project);
    const entry = collectEditableKeyframes(composition)[0];
    if (!entry) throw new Error("Expected an animated demo layer");
    const playhead = entry.keyframe.time + 0.5;
    act(() => {
      editor.dispatch({ type: "setPlaybackTime", time: playhead });
      editor.dispatch({ type: "setMetrics", metrics: { ...editor.state.metrics, fps: 20 } });
    });
    expect(renders).toHaveBeenCalledTimes(initialRenders);

    const row = host.querySelector<HTMLElement>(".timeline-layer");
    act(() => row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(menuTimes).toEqual([playhead]);
    const marker = host.querySelector<HTMLButtonElement>(".keyframe");
    if (!marker) throw new Error("Expected a keyframe");
    act(() =>
      marker.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 0 }),
      ),
    );
    expect(marker.classList.contains("selected")).toBe(true);
    expect(gesture).toBeDefined();
    // 0.46 seconds is within the playhead snap radius; the old playhead must not be used.
    act(() => gesture?.onMove(new PointerEvent("pointermove", { pointerId: 1, clientX: 46 })));
    expect(preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ [entry.keyframe.id]: playhead }),
    );
    act(() => gesture?.onCancel?.());

    act(() =>
      editor.dispatch({
        type: "operation",
        operations: [
          { type: "renameLayer", layerId: composition.layers[0].id, name: "Updated layer" },
        ],
      }),
    );
    expect(host.textContent).toContain("Updated layer");
    expect(renders.mock.calls.length).toBeGreaterThan(initialRenders);
  });
});
