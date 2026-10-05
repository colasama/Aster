export function planGeneratorCapacity(
  requestedCount: number,
  maximumCount: number,
  stride: number,
  verticesPerInstance: number,
  budgetMb = 512,
  storageByteLimit = Number.POSITIVE_INFINITY,
  dispatchInstanceLimit = Number.POSITIVE_INFINITY,
): { effectiveCount: number; capacity: number } {
  const boundedBudgetMb = Number.isFinite(budgetMb) ? Math.max(16, budgetMb) : 512;
  const memoryLimit = Math.max(1_024, Math.floor((boundedBudgetMb * 1024 * 1024 * 0.125) / stride));
  const deviceStorageLimit = Math.max(1, Math.floor(storageByteLimit / stride));
  const boundedDispatchLimit = Math.max(1, Math.floor(dispatchInstanceLimit));
  const vertexLimit = Math.max(
    16_384,
    Math.floor((boundedBudgetMb * 12_288) / Math.max(verticesPerInstance, 1)),
  );
  const effectiveCount = Math.min(
    requestedCount,
    maximumCount,
    memoryLimit,
    deviceStorageLimit,
    boundedDispatchLimit,
    vertexLimit,
  );
  const capacityCeiling = Math.min(maximumCount, deviceStorageLimit);
  return {
    effectiveCount,
    capacity: Math.min(
      capacityCeiling,
      2 ** Math.ceil(Math.log2(Math.min(capacityCeiling, Math.max(1_024, effectiveCount)))),
    ),
  };
}
