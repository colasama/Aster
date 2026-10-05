import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { EnvironmentLighting } from "../../core/types";
import { planMaterialTextures } from "../media/material-texture-plan";
import { encodeFramePlan } from "./codec";
import { buildMaterialBindingSlice } from "./material-binding-plan";
import { buildFrameHeader } from "./root-post-plan";

export function materialBindingFixtures() {
  const composition = createBlankComposition();
  const layer = createLayerForComposition("mesh", composition);
  layer.mesh = {
    name: "material",
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    materialTextures: {
      normal: { mimeType: "image/png", dataUrl: "fixture-normal", texCoord: 0, scale: 0.75 },
    },
  };
  const environment: EnvironmentLighting = {
    enabled: true,
    intensity: 2.5,
    rotation: -90,
    source: { name: "test.hdr", mimeType: "image/vnd.radiance", dataUrl: "fixture-environment" },
  };
  const header = buildFrameHeader({
    snapshot: { snapshotScope: "material-fixture", projectRevision: 7 },
    compositionId: "material",
    time: 1 / 3,
    frameRate: composition.frameRate,
    target: { width: 16, height: 16 },
    renderTarget: { width: 16, height: 16 },
    antiAliasing: "off",
  });
  return ["inactive", "normal", "environment", "combined", "exact-bits"].map((id) => {
    const normalReady = ["normal", "combined", "exact-bits"].includes(id);
    const environmentReady = ["environment", "combined", "exact-bits"].includes(id);
    const material = {
      ...planMaterialTextures(layer, environment, normalReady, environmentReady),
      instanceId: `mesh:${id}\ud800`,
      normalHash: normalReady ? "a".repeat(64) : null,
      environmentHash: environmentReady ? "b".repeat(64) : null,
    };
    if (id === "exact-bits") {
      material.normalScale = -0;
      material.environmentIntensity = Number.MIN_VALUE;
      material.environmentRotation = 1 / 3;
    }
    const plan = buildMaterialBindingSlice(header, material);
    return {
      id: `material-${id}`,
      material,
      plan,
      bytes: encodeFramePlan(plan.metadata, plan.blobs),
    };
  });
}
