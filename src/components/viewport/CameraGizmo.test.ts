// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTransform } from "../../core/animation/timeline";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { I18nProvider } from "../../i18n/react";
import type { EditorAction } from "../../state/editor-store";
import { CameraGizmo, cameraGizmoGeometry } from "./CameraGizmo";

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("camera gizmo geometry", () => {
  it("widens a perspective frustum as field of view increases", () => {
    expect(cameraGizmoGeometry("perspective", 90).path).not.toBe(
      cameraGizmoGeometry("perspective", 30).path,
    );
    expect(cameraGizmoGeometry("perspective", 90).label).toBe("90°");
  });

  it("uses parallel rays for an orthographic camera", () => {
    expect(cameraGizmoGeometry("orthographic", 50)).toEqual({
      path: "M47 24H118M47 56H118M118 24V56",
      label: "",
    });
  });

  it("moves an animated camera at the current time without collapsing its track", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const project = createBlankProject();
    const composition = project.compositions[0];
    const camera = createLayerForComposition("camera", composition);
    camera.transform.position[0] = {
      mode: "animated",
      keyframes: [
        { id: "camera-start", time: 0, value: 100, interpolation: "linear" },
        { id: "camera-end", time: 2, value: 300, interpolation: "linear" },
      ],
    };
    composition.layers = [camera];
    const dispatch = vi.fn<(action: EditorAction) => void>();

    act(() =>
      root?.render(
        createElement(
          I18nProvider,
          null,
          createElement(CameraGizmo, {
            activeTool: "select",
            dispatch,
            layer: camera,
            project,
            time: 1,
            transform: evaluateTransform(camera.transform, 1),
            zoom: 1,
          }),
        ),
      ),
    );
    const gizmo = container.querySelector<HTMLButtonElement>(".camera-gizmo");
    act(() =>
      gizmo?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "operation",
      operations: [
        {
          type: "addKeyframe",
          layerId: camera.id,
          path: "position.0",
          keyframe: { time: 1, value: 201, interpolation: "linear" },
        },
        { type: "setProperty", layerId: camera.id, path: "position.1" },
      ],
    });
  });
});
