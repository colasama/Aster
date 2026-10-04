import { describe, expect, it } from "vitest";
import { evaluateCameraBasis } from "../../core/scene/camera-rig";
import {
  buildDepthEffectUniforms,
  DEFAULT_DEPTH_EFFECT_SETTINGS,
  depthEffectSettingsFromCameraOptics,
} from "../effects/depth-effects";
import { buildSceneGeometry } from "../geometry/geometry";
import { buildSceneGeneratorContext } from "../scene/scene-generator-abi";
import { buildSceneLighting } from "../scene/scene-lighting";
import { cameraFixture } from "./camera-fixture";
import { buildCameraPlan, readCameraPlan } from "./camera-plan";
import { decodeFramePlan, encodeFramePlan } from "./codec";

describe("evaluated camera plan", () => {
  it.each(["perspective", "orthographic"] as const)(
    "preserves nested %s camera geometry, lighting, generator and depth inputs",
    (kind) => {
      const { header, camera, composition, sceneLayers } = cameraFixture(kind);
      const plan = buildCameraPlan(header, camera);
      const supplied = readCameraPlan(decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs)));
      expect(supplied).toEqual(camera);
      expect(supplied).not.toHaveProperty("settings");
      expect(supplied).not.toHaveProperty("transform");
      expect(buildSceneGeometry(composition, sceneLayers, supplied).data).toEqual(
        buildSceneGeometry(composition, sceneLayers, camera).data,
      );
      expect(buildSceneLighting(sceneLayers, composition, true, supplied.pose.position)).toEqual(
        buildSceneLighting(sceneLayers, composition, true, camera.pose.position),
      );
      const context = (value: typeof camera) =>
        new Uint8Array(
          buildSceneGeneratorContext(
            sceneLayers[0],
            composition,
            value,
            640,
            360,
            header.time,
            1 / 30,
            1,
          ),
        );
      expect(context(supplied)).toEqual(context(camera));
      const depth = (value: typeof camera) =>
        buildDepthEffectUniforms("depthOfField", 640, 360, {
          ...DEFAULT_DEPTH_EFFECT_SETTINGS,
          ...depthEffectSettingsFromCameraOptics(value.optics, composition.width, 640),
          cameraPosition: value.pose.position,
          cameraForward: evaluateCameraBasis(value.pose).forward,
        });
      expect(depth(supplied)).toEqual(depth(camera));
    },
  );

  it("owns source values and consumes changed, unaligned supplied camera bytes", () => {
    const { header, camera, composition, sceneLayers } = cameraFixture("perspective");
    const expected = structuredClone(camera);
    const plan = buildCameraPlan(header, camera);
    camera.pose.position.fill(0);
    camera.optics.zoom = 1;
    expect(readCameraPlan(structuredClone(plan))).toEqual(expected);
    const originalVertices = buildSceneGeometry(composition, sceneLayers, expected).data;
    const backing = new Uint8Array(plan.blobs[0].byteLength + 17);
    backing.set(plan.blobs[0], 17);
    const bytes = backing.subarray(17);
    new DataView(bytes.buffer, bytes.byteOffset).setFloat64(
      0,
      expected.pose.position[0] + 100,
      true,
    );
    const changed = readCameraPlan({ metadata: plan.metadata, blobs: [bytes] });
    expect(changed.pose.position[0]).toBe(expected.pose.position[0] + 100);
    expect(buildSceneGeometry(composition, sceneLayers, changed).data).not.toEqual(
      originalVertices,
    );
  });

  it("retains f64 signed zero, subnormals and precision without GPU float quantization", () => {
    const { header, camera } = cameraFixture("orthographic");
    camera.pose.position = [-0, Number.MIN_VALUE, 1 + Number.EPSILON];
    const plan = buildCameraPlan(header, camera);
    const restored = readCameraPlan(decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs)));
    expect(
      restored.pose.position.every((value, index) => Object.is(value, camera.pose.position[index])),
    ).toBe(true);
    const invalid = structuredClone(plan);
    invalid.blobs = [invalid.blobs[0].subarray(8)];
    expect(() => readCameraPlan(invalid)).toThrow();
  });
});
