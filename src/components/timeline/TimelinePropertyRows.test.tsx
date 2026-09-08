// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeComposition, createDemoProject } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import { EditorProvider } from "../../state/editor-store";
import { TimelinePropertyRows } from "./TimelinePropertyRows";

let root: Root | undefined;

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

describe("timeline property rows", () => {
  it("places Timer before properties and collapses transform and effects independently", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const composition = activeComposition(createDemoProject());
    const layer = composition.layers.find((candidate) => candidate.name === "ASTER");
    if (!layer) throw new Error("Expected demo title layer");
    const exposure = layer.effects.find((effect) => effect.name === "Exposure");
    if (!exposure) throw new Error("Expected demo exposure effect");
    exposure.parameterKeyframes = {
      exposure: [{ id: "exposure-key", time: 1, value: 0.5, interpolation: "linear" }],
    };
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider>
          <EditorProvider>
            <TimelinePropertyRows
              compositionDuration={composition.duration}
              frameDuration={composition.frameRate.denominator / composition.frameRate.numerator}
              layer={layer}
              onKeyframeTimePreview={() => undefined}
              pixelsPerSecond={82}
              startPointerDrag={() => undefined}
              timelineTargets={[]}
            />
          </EditorProvider>
        </I18nProvider>,
      ),
    );

    const firstProperty = container.querySelector(
      ".timeline-property-row .timeline-property-label",
    );
    expect(firstProperty?.children[0]?.tagName).toBe("BUTTON");
    expect(firstProperty?.children[0]?.querySelector(".lucide-timer")).not.toBeNull();
    expect(firstProperty?.children[1]?.classList.contains("timeline-property-name")).toBe(true);

    const transformToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Transform properties"]',
    );
    const exposureToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Exposure properties"]',
    );
    const glowToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Selective Glow properties"]',
    );
    expect(transformToggle?.querySelector(".lucide-move-3d")).not.toBeNull();
    expect(exposureToggle).not.toBeNull();
    expect(glowToggle).not.toBeNull();
    expect(
      exposureToggle
        ?.closest(".timeline-property-group")
        ?.querySelectorAll(".timeline-property-row").length,
    ).toBeGreaterThan(0);
    const transformGroupTrack = transformToggle
      ?.closest(".timeline-property-group")
      ?.querySelector(".timeline-property-group-track");
    const exposureGroupTrack = exposureToggle
      ?.closest(".timeline-property-group")
      ?.querySelector(".timeline-property-group-track");
    expect(transformGroupTrack?.querySelectorAll(".keyframe").length).toBe(8);
    expect(exposureGroupTrack?.querySelectorAll(".keyframe").length).toBe(1);
    expect(exposureGroupTrack?.querySelector(".keyframe")?.getAttribute("style")).toContain("82px");

    act(() => transformToggle?.click());
    expect(transformToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(
      transformToggle?.closest(".timeline-property-group")?.querySelector(".timeline-property-row"),
    ).toBeNull();
    expect(transformGroupTrack?.querySelectorAll(".keyframe").length).toBe(8);

    act(() => exposureToggle?.click());
    expect(exposureToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(
      exposureToggle?.closest(".timeline-property-group")?.querySelector(".timeline-property-row"),
    ).toBeNull();
    expect(exposureGroupTrack?.querySelectorAll(".keyframe").length).toBe(1);
    expect(
      glowToggle?.closest(".timeline-property-group")?.querySelector(".timeline-property-row"),
    ).not.toBeNull();

    act(() => exposureToggle?.click());
    expect(exposureToggle?.getAttribute("aria-expanded")).toBe("true");
  });
});
