export interface ExactFrameResourceBarrier {
  readonly hasPendingFrameResources: boolean;
  waitForFrameResources(): Promise<void>;
}

/**
 * Serializes media generations until capture submission, without waiting for GPU readback.
 * `capture(true)` is the discovery attempt; it may hold (reject unencoded) while media is not
 * exact. A recapture, `capture(false)`, only follows an asynchronous media wait. Never render the
 * same frame twice back to back: a second swap-chain render in the same task can read back black.
 */
export class ExactFrameCaptureQueue<Frame> {
  #submitted: Promise<void> = Promise.resolve();

  capture(
    capture: (discovery: boolean) => Promise<Frame>,
    resources: ExactFrameResourceBarrier,
  ): Promise<Frame> {
    const submitted = this.#submitted.then(() =>
      submitAfterExactFrameResources(capture, resources),
    );
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
  capture: (discovery: boolean) => Promise<Frame>,
  resources: ExactFrameResourceBarrier,
): Promise<{ frame: Promise<Frame> }> {
  const candidate = capture(true);
  void candidate.catch(() => undefined);
  const needsRecapture = resources.hasPendingFrameResources;
  try {
    await resources.waitForFrameResources();
  } catch (error) {
    await candidate.catch(() => undefined);
    throw error;
  }
  if (!needsRecapture) return { frame: candidate };
  // A held discovery capture rejects because its readback was never encoded; its
  // outcome is disposable either way, so drain it before recapturing the ready frame.
  await candidate.catch(() => undefined);
  return { frame: capture(false) };
}
