import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankComposition } from "../../core/project/project";
import type { EnvironmentLighting } from "../../core/types";
import {
  HDR_ENVIRONMENT_SAMPLER_DESCRIPTOR,
  NORMAL_MAP_SAMPLER_DESCRIPTOR,
  planMaterialTextures,
} from "./material-textures";

const environment: EnvironmentLighting = {
  enabled: true,
  intensity: 2.5,
  rotation: -90,
  source: {
    name: "studio.hdr",
    mimeType: "image/vnd.radiance",
    dataUrl: "data:image/vnd.radiance;base64,AA==",
  },
};

describe("mesh material texture planning", () => {
  it("keeps the regular beauty pipeline inactive without ready maps", () => {
    const layer = createLayerForComposition("mesh", createBlankComposition());
    expect(planMaterialTextures(layer, undefined, false, false)).toEqual({
      active: false,
      normalEnabled: false,
      normalScale: 1,
      environmentIntensity: 0,
      environmentRotation: 0,
    });
  });

  it("enables bounded normal and HDR environment inputs independently", () => {
    const layer = createLayerForComposition("mesh", createBlankComposition());
    layer.mesh = {
      name: "triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    layer.mesh.materialTextures = {
      normal: {
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AA==",
        texCoord: 0,
        scale: 99,
      },
    };
    expect(planMaterialTextures(layer, environment, true, true)).toEqual({
      active: true,
      normalEnabled: true,
      normalScale: 8,
      environmentIntensity: 2.5,
      environmentRotation: 0.75,
    });
    expect(
      planMaterialTextures(layer, { ...environment, enabled: false }, true, true),
    ).toMatchObject({
      active: true,
      normalEnabled: true,
      environmentIntensity: 0,
    });
  });

  it("uses independent normal and equirectangular environment address modes", () => {
    expect(NORMAL_MAP_SAMPLER_DESCRIPTOR).toMatchObject({
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    expect(HDR_ENVIRONMENT_SAMPLER_DESCRIPTOR).toMatchObject({
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
    });
  });
});
