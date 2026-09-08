import type { Layer } from "../../core/types";
import type { GeometryBatch } from "../geometry/geometry";
import { encodeRenderId } from "./render-buffers";

const ID_RECORD_BYTES = 8;

export function idBufferCapacityBytes(instanceCount: number): number {
  const requiredBytes = Math.max(ID_RECORD_BYTES, instanceCount * ID_RECORD_BYTES);
  return 2 ** Math.ceil(Math.log2(requiredBytes));
}

export function buildAuxiliaryBatchIds(
  batches: readonly Pick<GeometryBatch, "selectionId" | "layer">[],
): Uint32Array {
  const records = new Uint32Array(batches.length * 2);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    records[index * 2] = encodeRenderId(batch.selectionId);
    records[index * 2 + 1] = encodeRenderId(materialKey(batch.layer));
  }
  return records;
}

export function transparencyFallbackDiagnostic(generatorCount: number): string | undefined {
  return generatorCount > 0
    ? "scene generators preserve primary depth and residual beauty color outside the two peeled geometry layers"
    : undefined;
}

function materialKey(layer: Layer): string {
  return `material:${JSON.stringify(layer.material ?? layer.mesh?.sourceMaterial ?? layer.kind)}`;
}
