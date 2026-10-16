import assert from "node:assert/strict";
import { spawn } from "node:child_process";

/** Bound time without consumer progress, including downstream work; always reap failed decoders. */
export async function consumeDecoderOutput(options, args, consume, launch = spawn) {
  const timeoutMs = options.timeoutMs ?? 600000;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647);
  const child = launch(options.ffmpeg, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = Buffer.alloc(0),
    failure = null;
  const closed = new Promise((done) => {
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => done({ code, signal }));
  });
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-65536);
  });
  let timer;
  let rejectTimeout;
  const timedOut = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const progress = () => {
    if (failure) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      failure = new Error("Media decode timed out without consumer progress");
      child.kill("SIGKILL");
      rejectTimeout(failure);
    }, timeoutMs);
  };
  progress();
  try {
    const result = await Promise.race([consume(child.stdout, progress), timedOut]);
    const exit = await Promise.race([closed, timedOut]);
    if (failure) throw failure;
    assert.equal(exit.code, 0, `FFmpeg decode failed (${exit.code}, ${exit.signal}): ${stderr}`);
    return result;
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw failure ?? error;
  } finally {
    clearTimeout(timer);
  }
}
