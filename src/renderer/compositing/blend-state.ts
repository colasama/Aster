import type { BlendMode } from "../../core/types";

// Advanced modes use the backdrop compositor; their source raster needs only
// the normal pipeline. Keep generator ABI pipeline variants bounded.
export const FIXED_BLEND_MODES = ["normal", "add", "multiply", "screen", "overlay"] as const;

const SOURCE_OVER_ALPHA: GPUBlendComponent = {
  srcFactor: "one",
  dstFactor: "one-minus-src-alpha",
  operation: "add",
};

export function gpuBlendState(mode: BlendMode): GPUBlendState {
  const color: GPUBlendComponent =
    mode === "add"
      ? { srcFactor: "one", dstFactor: "one", operation: "add" }
      : mode === "multiply"
        ? { srcFactor: "dst", dstFactor: "zero", operation: "add" }
        : mode === "screen"
          ? { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" }
          : { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" };
  return { color, alpha: SOURCE_OVER_ALPHA };
}
