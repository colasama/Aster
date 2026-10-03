import { requestPreferredGpuAdapter } from "../../src/desktop/gpu-preference";
import { captureFontFingerprint, withCaptureFontRecheck } from "./capture-fonts";
import { CaptureHealth, captureErrorMessage, observeCaptureHealth } from "./capture-health";
import { runCaptureAssignments } from "./capture-runner";
import { productionCaptureRuntime } from "./capture-runtime";

async function capture(): Promise<void> {
  const api = window.asterParity;
  if (!api) throw new Error("Reference capture requires the dedicated Electron preload");
  const health = new CaptureHealth();
  const stopObserving = observeCaptureHealth(health);
  try {
    if (!navigator.gpu) throw new Error("Reference capture requires WebGPU");
    const adapter = await requestPreferredGpuAdapter();
    if (!adapter) throw new Error("Reference capture could not select a production GPU adapter");
    const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
    const fonts = await captureFontFingerprint();
    await api.ready({ vendor, architecture, device, description, isFallbackAdapter, fonts });
    health.assertHealthy();
    await runCaptureAssignments(
      withCaptureFontRecheck(api, fonts),
      productionCaptureRuntime,
      health,
    );
  } catch (error) {
    await api.fail({ error: captureErrorMessage(error) });
    await api.done();
  } finally {
    stopObserving();
  }
}

void capture().catch((error: unknown) => {
  console.error("Reference capture terminated", error);
});
