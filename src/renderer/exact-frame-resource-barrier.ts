export interface ExactFrameResourceBarrier {
  readonly hasPendingFrameResources: boolean;
  waitForFrameResources(): Promise<void>;
}

/**
 * Starts one capture so frame evaluation can discover its exact asynchronous media generation.
 * Cached frames stay on the one-capture path; newly pending media is recaptured after readiness.
 */
export async function captureAfterExactFrameResources<Frame>(
  capture: () => Promise<Frame>,
  resources: ExactFrameResourceBarrier,
): Promise<Frame> {
  const candidate = capture();
  void candidate.catch(() => undefined);
  const needsRecapture = resources.hasPendingFrameResources;
  try {
    await resources.waitForFrameResources();
  } catch (error) {
    await candidate.catch(() => undefined);
    throw error;
  }
  if (!needsRecapture) return candidate;
  await candidate;
  return capture();
}
