import { copyRenderSnapshotIdentity } from "../../src/core/rendering/render-snapshot";

/** One immutable loaded input bundle, independent of frame address or benchmark run number. */
export function captureSnapshotIdentity(caseHash: string, projectRevision = 0) {
  if (!/^[a-f0-9]{64}$/.test(caseHash))
    throw new Error("Capture snapshot requires its complete input SHA-256");
  return copyRenderSnapshotIdentity({
    snapshotScope: `capture:${caseHash}`,
    projectRevision,
  });
}
