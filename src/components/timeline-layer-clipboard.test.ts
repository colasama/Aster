import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankComposition } from "../core/project";
import { duplicateTimelineLayers, splitTimelineLayers } from "./timeline-layer-clipboard";

describe("duplicateTimelineLayers", () => {
  it("remaps graph identities and preserves parent links inside the copied set", () => {
    const composition = createBlankComposition();
    const parent = createLayerForComposition("null", composition);
    const child = createLayerForComposition("text", composition);
    child.parentId = parent.id;
    child.transform.opacity = {
      mode: "animated",
      keyframes: [{ id: "opacity-key", interpolation: "linear", time: 0, value: 100 }],
    };
    child.effects = [
      {
        enabled: true,
        id: "effect",
        name: "Test",
        parameters: { amount: 1 },
        parameterKeyframes: {
          amount: [{ id: "effect-key", interpolation: "linear", time: 0, value: 1 }],
        },
        type: "test",
      },
    ];

    const [parentCopy, childCopy] = duplicateTimelineLayers([parent, child]);
    expect(parentCopy?.id).not.toBe(parent.id);
    expect(childCopy?.parentId).toBe(parentCopy?.id);
    expect(childCopy?.effects[0]?.id).not.toBe("effect");
    expect(childCopy?.effects[0]?.parameterKeyframes?.amount?.[0]?.id).not.toBe("effect-key");
    expect(
      childCopy?.transform.opacity.mode === "animated" &&
        childCopy.transform.opacity.keyframes[0]?.id,
    ).not.toBe("opacity-key");
  });

  it("clears parent links that point outside the copied set", () => {
    const composition = createBlankComposition();
    const layer = createLayerForComposition("shape", composition);
    layer.parentId = "outside";
    expect(duplicateTimelineLayers([layer])[0]?.parentId).toBeUndefined();
  });
});

describe("splitTimelineLayers", () => {
  it("preserves source-time continuity, names, and external parenting", () => {
    const composition = createBlankComposition();
    const layer = createLayerForComposition("video", composition);
    layer.name = "Interview";
    layer.inPoint = 1;
    layer.outPoint = 9;
    layer.timeOffset = 2;
    layer.timeStretch = 0.5;
    layer.parentId = "external-parent";
    const split = splitTimelineLayers([layer], 4)[0];
    expect(split).toMatchObject({
      name: "Interview",
      inPoint: 4,
      outPoint: 9,
      timeOffset: 8,
      timeStretch: 0.5,
      parentId: "external-parent",
    });
    expect(split?.id).not.toBe(layer.id);
  });
});
