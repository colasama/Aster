import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { srgbDisplayShader } from "../color-management";
import { MAX_SCENE_LIGHTS, SCENE_LIGHTING_BYTES } from "../scene/scene-lighting";
import { auxiliarySurfaceShader } from "./auxiliary-surface-shader";
import {
  imageShader,
  materialShapeShader,
  shadowShader,
  shapeShader,
  textureCompositeShader,
} from "./base-shaders";
import { FLOAT_BUFFER_VISUALIZATION_WGSL, UINT_BUFFER_VISUALIZATION_WGSL } from "./render-buffers";

describe("shared scene shader extraction", () => {
  it.each([
    ["shape", shapeShader, "6693040867a62e1f92f99b0598ddc224cf2dec6209bb57172e7bef64a2f9f6d0"],
    [
      "material",
      materialShapeShader,
      "a11b6c1bb1b5ff09344cf1f58f684956c5b80e4a9ac0539c4f875cf34ef9b770",
    ],
    ["shadow", shadowShader, "46229695d09a58f965126035e48852663143aff9a3461d01b09118f9ee4d62c7"],
    ["image", imageShader, "a68966608f7b985b054292bbb4773f5f6e3983616e09c6e07f79601c7fc5d52d"],
    [
      "composite",
      textureCompositeShader,
      "eb9a216513761ea121abc99103017a01878e398fd4d77cd523a9e8cc8205440d",
    ],
    [
      "auxiliary",
      auxiliarySurfaceShader,
      "08e398e7dfbe97874caaa09e1c05762ce1a927599a2d17e16def1c7867e517af",
    ],
    [
      "display",
      srgbDisplayShader,
      "33712ad3bb4bca9c5d360d915a46b582c10d54d56371257fc9ddd3aa68cd7c76",
    ],
    [
      "float buffer",
      FLOAT_BUFFER_VISUALIZATION_WGSL,
      "64f5e9e6a037126b132254cd9fc153ce2b627df9d8ecdbabe328619b0805ddec",
    ],
    [
      "uint buffer",
      UINT_BUFFER_VISUALIZATION_WGSL,
      "81fbaa9dedda06359931ed0959f7f8332eec7dc28c60af59c1083e60de87af64",
    ],
  ])("preserves the original %s shader's expanded bytes", (_name, source, expectedHash) => {
    expect(createHash("sha256").update(source).digest("hex")).toBe(expectedHash);
  });

  it("keeps the production lighting uniform layout", () => {
    expect(MAX_SCENE_LIGHTS).toBe(8);
    expect(SCENE_LIGHTING_BYTES).toBe(592);
  });
});
