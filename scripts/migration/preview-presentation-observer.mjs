/** Copy the compositor serially, outside renderer callbacks and subscription rate limits. */
export async function captureMatchingPresentation({
  capture,
  identify,
  expected,
  now = () => performance.now(),
  timeoutMs = 120000,
}) {
  let active = true;
  let timer;
  const observation = async () => {
    let attempts = 0;
    while (active) {
      const started = now();
      const image = await capture();
      const arrived = now();
      if (!active) return;
      const hash = identify(image, arrived);
      attempts++;
      if (hash === expected)
        return {
          capture_started_ms: started,
          presentation_ms: arrived,
          image_sha256: hash,
          capture_attempts: attempts,
        };
    }
  };
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Matching compositor copy timed out")),
          timeoutMs,
        );
      }),
      observation(),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
