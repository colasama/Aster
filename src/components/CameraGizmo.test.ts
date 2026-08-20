import { describe, expect, it } from "vitest";
import { cameraGizmoGeometry } from "./CameraGizmo";

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
});
