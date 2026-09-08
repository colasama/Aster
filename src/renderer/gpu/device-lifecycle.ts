export function shouldReportGpuDeviceLoss(
  rendererDisposed: boolean,
  initializationAborted = false,
): boolean {
  return !rendererDisposed && !initializationAborted;
}

export function releaseFailedWebGpuInitialization(
  renderer: { dispose(): void } | undefined,
  device: Pick<GPUDevice, "destroy">,
): void {
  if (!renderer) {
    device.destroy();
    return;
  }
  try {
    renderer.dispose();
  } catch (error) {
    device.destroy();
    throw error;
  }
}
