// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { activeComposition } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider, useEditor } from "../../state/editor-store";
import { TimelineRuler } from "./TimelineRuler";
import { timelineZoomStore } from "./timeline-zoom-store";

let root: Root | undefined;

function Harness({ beats }: { beats: number }) {
  const { state, dispatch } = useEditor();
  const composition = activeComposition(state.project);
  useEffect(() => {
    dispatch({
      type: "operation",
      operations: [
        {
          type: "setCompositionMarkers",
          compositionId: composition.id,
          markers: [
            ...Array.from({ length: beats }, (_, index) => ({
              id: `b${index}`,
              time: index * 0.4,
              kind: index % 4 === 0 ? ("downbeat" as const) : ("beat" as const),
            })),
            { id: "s1", time: 1.6, kind: "section" as const, label: "Chorus" },
          ].sort((left, right) => left.time - right.time),
        },
      ],
    });
  }, [beats, composition.id, dispatch]);
  return (
    <TimelineRuler
      viewport={{ width: 2000, scrollLeft: 0 }}
      scrub={() => undefined}
      startPointerDrag={() => undefined}
      setWorkArea={() => undefined}
    />
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe("timeline ruler markers", () => {
  it("draws downbeats and sections, and hides dense beats when zoomed out", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = async (zoom: number) => {
      act(() => timelineZoomStore.set(zoom));
      await act(async () =>
        root?.render(
          <I18nProvider>
            <EditorProvider>
              <Harness beats={8} />
            </EditorProvider>
          </I18nProvider>,
        ),
      );
    };
    await render(1);
    expect(container.querySelectorAll(".timeline-marker.downbeat")).toHaveLength(2);
    expect(container.querySelector(".timeline-marker.section")?.getAttribute("title")).toBe(
      "Chorus",
    );
    const beatsAtDefaultZoom = container.querySelectorAll(".timeline-marker.beat").length;
    await render(0.05);
    expect(container.querySelectorAll(".timeline-marker.beat").length).toBeLessThan(
      Math.max(1, beatsAtDefaultZoom),
    );
    expect(container.querySelectorAll(".timeline-marker.downbeat")).toHaveLength(2);
  });
});
