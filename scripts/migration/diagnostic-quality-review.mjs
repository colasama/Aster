import { reviewExportCase } from "./native-export-checkpoint.mjs";

/** Preserve the failed flat verdict while requiring full authenticated layered review. */
export async function reviewNativeQualityDiagnostic(root, diagnostic, mode, ledger, assessed) {
  const self_review = await reviewExportCase(
    root,
    {
      id: `native-encoded-${mode}`,
      frames: [0, 1, 2],
      comparisons: diagnostic.comparisons,
      structural_witness: diagnostic.structural_witness,
      quality: { passed: assessed.relative_quality_passed },
      audio: { passed: true },
    },
    ledger,
    diagnostic,
  );
  return {
    ...assessed,
    status: self_review.status,
    layered_pixels_passed: self_review.frames
      .filter((f) => f.arm === "native")
      .every((f) => f.status === "passed"),
    self_review,
  };
}
