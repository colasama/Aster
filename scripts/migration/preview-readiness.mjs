import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

function isFrameSessionPending(error) {
  const prefix = "render_preview: ";
  if (!error.message?.startsWith(prefix)) return false;
  const message = error.message.slice(prefix.length);
  if (message === "Renderer did not open a frame session") return true;
  try {
    const payload = JSON.parse(message);
    return (
      payload.code === "execution_failed" &&
      payload.message === "Renderer did not open a frame session"
    );
  } catch {
    return false;
  }
}

export async function captureInitialPreview(capture, attempts, options = {}) {
  const maximumAttempts = options.maximumAttempts ?? 30;
  const wait = options.wait ?? (() => delay(1_000));
  const started = performance.now();
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const attemptStarted = performance.now();
    const record = { attempt, started_at: new Date().toISOString() };
    try {
      const preview = await capture();
      record.status = "passed";
      return preview;
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      if (
        !isFrameSessionPending(error) ||
        attempt === maximumAttempts ||
        performance.now() - started >= 30_000
      ) {
        throw error;
      }
    } finally {
      record.duration_ms = Math.round(performance.now() - attemptStarted);
      attempts.push(record);
    }
    await wait();
  }
  throw new Error("Initial preview readiness has no attempts configured");
}
