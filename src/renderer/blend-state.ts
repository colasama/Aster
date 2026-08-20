import type { BlendMode } from "../core/types";

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
