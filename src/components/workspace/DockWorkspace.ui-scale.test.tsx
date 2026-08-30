// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDisplayMetrics } from "../../desktop/api";
import { I18nProvider } from "../../i18n/react";
import type { WorkspaceLayout } from "../../workspace/layout";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "../../workspace/layout-storage";
import { DockWorkspace } from "./DockWorkspace";

const UI_SCALES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

let container: HTMLDivElement;
let hostRect: { left: number; top: number; width: number; height: number };
let notifyResize: () => void;
let root: Root;

const layout: WorkspaceLayout = {
  root: {
    kind: "tabGroup",
    id: "root-group",
    panels: ["root"],
    activePanelId: "root",
  },
  floating: [
    {
      id: "floating",
      node: {
        kind: "tabGroup",
        id: "floating-group",
        panels: ["floating"],
        activePanelId: "floating",
      },
      bounds: { x: 1_300, y: 700, width: 500, height: 400 },
    },
  ],
  closedPanels: [],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.localStorage.setItem("aster.locale", "en-US");
  hostRect = { left: 0, top: 70, width: 1_440, height: 807 };
  notifyResize = () => undefined;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("workspace-root"))
      return new DOMRect(hostRect.left, hostRect.top, hostRect.width, hostRect.height);
    return new DOMRect();
  });
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverStub implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this);
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "asterDesktop", { configurable: true, value: undefined });
});

function renderWorkspace() {
  act(() =>
    root.render(
      <I18nProvider>
        <DockWorkspace
          initialLayout={layout}
          panels={[
            { id: "root", label: "Root", element: <div /> },
            { id: "floating", label: "Floating", element: <div /> },
          ]}
        />
      </I18nProvider>,
    ),
  );
}

describe("DockWorkspace UI scaling", () => {
  it.each(UI_SCALES)("fits fixed floating frames inside the %s scaled dock DOM bounds", (scale) => {
    hostRect = {
      left: 0,
      top: 70,
      width: 1_440 / scale,
      height: 900 / scale - 93,
    };
    renderWorkspace();
    const frame = container.querySelector<HTMLElement>(".workspace-floating");
    if (!frame) throw new Error("Expected floating workspace");
    const left = Number.parseFloat(frame.style.left);
    const top = Number.parseFloat(frame.style.top);
    const width = Number.parseFloat(frame.style.width);
    const height = Number.parseFloat(frame.style.height);
    expect(left).toBeGreaterThanOrEqual(hostRect.left);
    expect(top).toBeGreaterThanOrEqual(hostRect.top);
    expect(left + width).toBeLessThanOrEqual(hostRect.left + hostRect.width + 0.001);
    expect(top + height).toBeLessThanOrEqual(hostRect.top + hostRect.height + 0.001);
  });

  it("reconciles and persists fresh bounds after a scale-driven ResizeObserver update", () => {
    renderWorkspace();
    hostRect = { left: 0, top: 70, width: 720, height: 357 };
    act(() => notifyResize());
    const frame = container.querySelector<HTMLElement>(".workspace-floating");
    expect(frame?.style.left).toBe("220px");
    expect(frame?.style.top).toBe("70px");
    expect(frame?.style.height).toBe("357px");
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({
      floating: [{ bounds: { x: 220, y: 70, width: 500, height: 357 } }],
    });
  });

  it("remeasures after native display metrics instead of persisting the pre-scale bounds", () => {
    let displayListener: ((metrics: DesktopDisplayMetrics) => void) | undefined;
    let animationFrame: FrameRequestCallback | undefined;
    Object.defineProperty(window, "asterDesktop", {
      configurable: true,
      value: {
        onDisplayMetricsChanged(listener: (metrics: DesktopDisplayMetrics) => void) {
          displayListener = listener;
          return () => (displayListener = undefined);
        },
      },
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrame = callback;
      return 1;
    });
    renderWorkspace();
    act(() =>
      displayListener?.({
        currentDisplayId: "display-2",
        deviceScaleFactor: 1.5,
        effectiveScaleFactor: 3,
        uiScale: 2,
      }),
    );

    hostRect = { left: 0, top: 70, width: 720, height: 357 };
    act(() => animationFrame?.(0));
    const frame = container.querySelector<HTMLElement>(".workspace-floating");
    expect(frame?.style.left).toBe("220px");
    expect(frame?.style.top).toBe("70px");
    expect(frame?.style.height).toBe("357px");
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) ?? "null"),
    ).toMatchObject({
      floating: [
        {
          bounds: { x: 220, y: 70, width: 500, height: 357 },
          displayId: "display-2",
        },
      ],
    });
  });
});
