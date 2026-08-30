/** Persists a terminal worker report before waiting for potentially slow external cleanup. */
export async function settleRenderHostTerminal(
  report: () => Promise<void>,
  dispose: () => Promise<void>,
): Promise<void> {
  try {
    await report();
  } finally {
    await dispose();
  }
}
