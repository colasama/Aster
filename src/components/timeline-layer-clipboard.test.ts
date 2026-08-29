import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layer-factory";
import { createBlankComposition } from "../core/project";
import { duplicateTimelineLayers } from "./timeline-layer-clipboard";

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
