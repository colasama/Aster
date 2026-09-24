export interface ExactFrameResourceBarrier {
  readonly hasPendingFrameResources: boolean;
  waitForFrameResources(): Promise<void>;
}

/** Serializes media generations until capture submission, without waiting for GPU readback. */
export class ExactFrameCaptureQueue<Frame> {
  #submitted: Promise<void> = Promise.resolve();

  capture(
    capture: () => Promise<Frame>,
    resources: ExactFrameResourceBarrier,
    prepare?: () => void,
  ): Promise<Frame> {
    const submitted = this.#submitted.then(async () => {
      if (prepare) {
        prepare();
        await resources.waitForFrameResources();
        return { frame: capture() };
      }
      return submitAfterExactFrameResources(capture, resources);
    });
    this.#submitted = submitted.then(
      () => undefined,
      () => undefined,
    );
    return submitted.then(({ frame }) => frame);
  }
}

/**
 * Starts one capture so frame evaluation can discover its exact asynchronous media generation.
 * Cached frames stay on the one-capture path; newly pending media is recaptured after readiness.
 */
async function submitAfterExactFrameResources<Frame>(
  capture: () => Promise<Frame>,
  resources: ExactFrameResourceBarrier,
): Promise<{ frame: Promise<Frame> }> {
  const candidate = capture();
  void candidate.catch(() => undefined);
  const needsRecapture = resources.hasPendingFrameResources;
  try {
    await resources.waitForFrameResources();
  } catch (error) {
    await candidate.catch(() => undefined);
    throw error;
  }
  if (!needsRecapture) return { frame: candidate };
  await candidate;
  return { frame: capture() };
}
