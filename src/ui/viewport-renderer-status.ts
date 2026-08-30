import type { GpuDiagnostics } from "../core/types";
import type { Translate } from "../i18n/core";

export interface ViewportRendererStatus {
  label: string;
  title: string;
  tone: "fallback" | "gpu" | "performance-warning" | "resource-error";
}

export function viewportRendererStatus(
  diagnostics: GpuDiagnostics | undefined,
  t: Translate,
): ViewportRendererStatus {
  if (diagnostics?.materialResourceError)
    return {
      label: t("viewport.gpuResourceError"),
      title: t("viewport.gpuResourceError"),
      tone: "resource-error",
    };
  if (!diagnostics)
    return {
      label: t("viewport.initializing"),
      title: t("viewport.initializing"),
      tone: "fallback",
    };

  const degradedReason = diagnostics.depthOfFieldDegradedReason;
  if (degradedReason) {
    const tier = diagnostics.depthOfFieldTier;
    return {
      label:
        tier === 0 || tier === 1
          ? t("viewport.dofReduced", { tier: `K${tier}` })
          : t("viewport.dofUnavailable"),
      title: degradedReason,
      tone: "performance-warning",
    };
  }

  if (diagnostics.available) {
    const gpuDetails = t("viewport.gpuDetails", {
      adapter: diagnostics.adapter,
      count: diagnostics.prewarmedPipelines ?? 0,
      ms: (diagnostics.pipelineCompileMs ?? 0).toFixed(1),
    });
    return {
      label: t("viewport.webgpu", { adapter: diagnostics.adapter }),
      title:
        diagnostics.depthOfFieldTier === 2
          ? `${gpuDetails} · ${t("viewport.dofFullQuality", { tier: "K2" })}`
          : gpuDetails,
      tone: "gpu",
    };
  }

  return {
    label: t("viewport.compatibility"),
    title: t("viewport.compatibility"),
    tone: "fallback",
  };
}
