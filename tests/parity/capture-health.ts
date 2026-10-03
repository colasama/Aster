import { logger } from "../../src/core/logger";
import type { GpuDiagnostics } from "../../src/core/types";
import type { DesktopLogEntry } from "../../src/desktop/api";

const FAILURE_WARNINGS = new Set([
  "audio_analysis_decode_failed",
  "device_lost",
  "initialization_cleanup_failed",
  "adjustment_layer_skipped",
  "material_texture_failed",
  "scene_generator_unavailable",
  "scene_generator_storage_resize_failed",
  "auxiliary_buffer_allocation_failed",
  "auxiliary_buffers_unavailable",
  "auxiliary_buffer_budget_exceeded",
]);

/** Captures production errors that otherwise leave a valid-sized, incomplete beauty frame. */
export class CaptureHealth {
  readonly #failures = new Set<string>();
  #fatal = false;

  get fatal(): boolean {
    return this.#fatal;
  }

  beginCase(): void {
    if (this.#fatal) throw new Error("The capture GPU session has been lost");
    this.#failures.clear();
  }

  observe(entry: DesktopLogEntry): void {
    if (entry.scope === "webgpu" && entry.event === "device_lost") this.#fatal = true;
    if (entry.level !== "error" && !FAILURE_WARNINGS.has(entry.event)) return;
    const detail = entry.error?.message ?? entry.message ?? JSON.stringify(entry.data ?? {});
    this.#failures.add(`${entry.scope}:${entry.event}: ${String(detail)}`);
  }

  reject(error: unknown): void {
    this.#failures.add(captureErrorMessage(error));
  }

  assertHealthy(diagnostics?: GpuDiagnostics, productionError?: string): void {
    if (productionError) this.#failures.add(productionError);
    if (diagnostics) {
      if (!diagnostics.available) this.#failures.add("The reference renderer is not WebGPU");
      for (const key of [
        "materialResourceError",
        "adjustmentLayerError",
        "precompositionSurfaceError",
        "sceneGeneratorError",
      ] as const) {
        const error = diagnostics[key];
        if (error) this.#failures.add(`${key}: ${error}`);
      }
    }
    if (this.#failures.size) throw new Error([...this.#failures].join("\n"));
  }
}

export function observeCaptureHealth(health: CaptureHealth): () => void {
  const warn = logger.warn;
  const error = logger.error;
  logger.warn = (scope, event, data, reason) => {
    health.observe({
      level: "warn",
      scope,
      event,
      data,
      ...(reason === undefined ? {} : { error: { message: captureErrorMessage(reason) } }),
    });
    warn(scope, event, data, reason);
  };
  logger.error = (scope, event, reason, data) => {
    health.observe({
      level: "error",
      scope,
      event,
      data,
      error: { message: captureErrorMessage(reason) },
    });
    error(scope, event, reason, data);
  };
  const onError = (event: ErrorEvent) => health.reject(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => health.reject(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    logger.warn = warn;
    logger.error = error;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

export function captureErrorMessage(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}
