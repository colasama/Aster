import { requestPreferredGpuAdapter } from "../../src/desktop/gpu-preference";
import { captureFontFingerprint } from "../parity/capture-fonts";
import { CaptureHealth, captureErrorMessage, observeCaptureHealth } from "../parity/capture-health";
import { runPerformanceAssignments } from "./runner";
import { productionPerformanceRuntime } from "./runtime";

async function performanceSuite(): Promise<void> {
  const api = window.asterPerformance;
  if (!api) throw new Error("Performance capture requires its dedicated Electron preload");
  const health = new CaptureHealth();
  const stopObserving = observeCaptureHealth(health);
  try {
    if (!navigator.gpu) throw new Error("Performance measurements require WebGPU");
    const adapter = await requestPreferredGpuAdapter();
    if (!adapter) throw new Error("Performance capture could not select the production adapter");
    const fonts = await captureFontFingerprint();
    if (fonts.status !== "available") throw new Error(fonts.reason);
    const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
    await api.ready({ vendor, architecture, device, description, isFallbackAdapter, fonts });
    health.assertHealthy();
    await runPerformanceAssignments(api, productionPerformanceRuntime, health);
    const finalFonts = await captureFontFingerprint();
    if (
      finalFonts.status !== "available" ||
      finalFonts.sha256 !== fonts.sha256 ||
      finalFonts.count !== fonts.count
    )
      throw new Error("System font inputs changed during performance measurements");
    health.assertHealthy();
  } catch (error) {
    await api.fail({ error: captureErrorMessage(error) });
  } finally {
    stopObserving();
    await api.done();
  }
}

void performanceSuite().catch((error: unknown) => {
  console.error("Performance capture terminated", error);
});
