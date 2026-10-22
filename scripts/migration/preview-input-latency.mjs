import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { preparePreviewInputFocus } from "./preview-input-focus.mjs";
import { writeAtomicJson } from "./report.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Match compositor presentation pixels after real timeline mouse input, outside render callbacks. */
export async function capturePreviewInputLatency(editor, call, output, samples) {
  assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 600);
  const contents = editor.webContents;
  const focusReadiness = [];
  const prepareFocus = async (phase) => {
    try {
      await preparePreviewInputFocus(editor, phase, focusReadiness);
    } finally {
      await writeAtomicJson(join(output, "latency-focus.json"), focusReadiness);
    }
  };
  await prepareFocus("geometry");
  await contents.executeJavaScript(`new Promise(resolve => {
    const surface=document.querySelector('.timeline-canvas');
    const pps=parseFloat(getComputedStyle(surface).getPropertyValue('--timeline-pps'));
    surface.parentElement.scrollLeft=22*pps;
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  const geometry = await contents.executeJavaScript(`(() => {
    const canvas = document.querySelector('.composition-image > canvas:not(.viewport-snapshot)');
    const ruler = document.querySelector('.time-ruler');
    if (!canvas || !ruler) throw new Error('Preview latency surfaces are absent');
    const c = canvas.getBoundingClientRect(), clip = canvas.closest('.viewport-space').getBoundingClientRect();
    const r = ruler.getBoundingClientRect(), pps = parseFloat(getComputedStyle(ruler).getPropertyValue('--timeline-pps'));
    const x = Math.ceil(Math.max(c.left, clip.left, 0)) + 2;
    const y = Math.ceil(Math.max(c.top, clip.top, 0)) + 2;
    const right = Math.floor(Math.min(c.right, clip.right, innerWidth)) - 2;
    const bottom = Math.floor(Math.min(c.bottom, clip.bottom, innerHeight)) - 2;
    return { crop: { x, y, width: right-x, height: bottom-y },
      page: {width:innerWidth,height:innerHeight}, canvas: {width:canvas.width,height:canvas.height},
      points: [24,26].map(t => ({x:Math.round(r.left+pps*t),y:Math.round(r.top+r.height/2)})),
      ruler: {left:r.left,right:Math.min(r.right,innerWidth)}, pps,
      quality: {antiAliasing:localStorage.getItem('aster.antiAliasing'),
        memoryBudgetMb:localStorage.getItem('aster.gpuMemoryBudgetMb'),
        frameCacheBudgetMb:localStorage.getItem('aster.frameCacheBudgetMb')} };
  })()`);
  assert(geometry.crop.width > 32 && geometry.crop.height > 32);
  assert(Number.isFinite(geometry.pps) && geometry.pps > 0);
  for (const point of geometry.points)
    assert(point.x > geometry.ruler.left && point.x < geometry.ruler.right);
  assert.deepEqual(geometry.quality, {
    antiAliasing: "off",
    memoryBudgetMb: "1024",
    frameCacheBudgetMb: "0",
  });
  const click = (point) => {
    assert(editor.isFocused(), "Test window lost focus during input latency capture");
    contents.sendInputEvent({
      type: "mouseDown",
      ...point,
      button: "left",
      clickCount: 1,
      modifiers: [],
    });
    contents.sendInputEvent({
      type: "mouseUp",
      ...point,
      button: "left",
      clickCount: 1,
      modifiers: [],
    });
  };
  const canvasHash = async () =>
    digest(
      await contents.executeJavaScript(
        "document.querySelector('.composition-image > canvas:not(.viewport-snapshot)').toDataURL()",
      ),
    );
  const crop = (image) => {
    const size = image.getSize();
    const scale = size.width / geometry.page.width;
    assert(Math.abs(size.height / geometry.page.height - scale) < 0.01);
    const rect = Object.fromEntries(
      Object.entries(geometry.crop).map(([key, value]) => [key, Math.round(value * scale)]),
    );
    return image.crop(rect);
  };
  const references = [];
  for (const [index, point] of geometry.points.entries()) {
    await prepareFocus(`calibration-${index}`);
    const before = await canvasHash();
    click(point);
    await delay(100);
    const inputState = await call("get_editor_context");
    await writeAtomicJson(join(output, `latency-input-${index}.json`), { geometry, inputState });
    await writeFile(
      join(output, `latency-page-${index}.png`),
      (await contents.capturePage()).toPNG(),
      { flag: "wx" },
    );
    const started = Date.now();
    while ((await canvasHash()) === before) {
      assert(Date.now() - started < 30000, "Timeline input did not change the preview canvas");
      await delay(50);
    }
    await delay(500);
    const state = await call("get_editor_context");
    const expectedTime = (point.x - geometry.ruler.left) / geometry.pps;
    const rate = state.activeComposition.frameRate;
    assert(Math.abs(state.currentTime - expectedTime) <= rate.denominator / rate.numerator + 1e-6);
    assert.equal(state.currentTime, index === 0 ? 24 : 26, "Latency seek address changed");
    const image = crop(await contents.capturePage());
    const path = join(output, `latency-reference-${index}.png`);
    await writeFile(path, image.toPNG(), { flag: "wx" });
    references.push({
      time: state.currentTime,
      composition_id: state.activeComposition.id,
      image_sha256: digest(image.toBitmap()),
      png_sha256: digest(image.toPNG()),
      path,
    });
    await writeAtomicJson(join(output, "latency-calibration.json"), { geometry, references });
  }
  assert.notEqual(
    references[0].image_sha256,
    references[1].image_sha256,
    "Latency addresses must produce distinct visible frames",
  );
  const report = {
    status: "failed",
    scope: "timeline-input-to-compositor-presentation",
    timing: "main-process monotonic input dispatch to matching frame-subscription callback",
    warmup: 10,
    geometry,
    references,
    focus_readiness: focusReadiness,
    samples: [],
  };
  let pending;
  await prepareFocus("measurement");
  let attempted = 0;
  let lastPresentation;
  let observed = 0;
  contents.beginFrameSubscription(false, (image) => {
    const arrived = performance.now();
    if (!pending) return;
    try {
      const cropped = crop(image);
      const hash = digest(cropped.toBitmap());
      observed++;
      lastPresentation = { image: cropped, hash, arrived };
      if (hash !== pending.expected) return;
      const work = pending;
      pending = undefined;
      clearTimeout(work.timer);
      work.resolve({
        address: work.address,
        input_ms: work.started,
        presentation_ms: arrived,
        latency_ms: arrived - work.started,
        image_sha256: hash,
      });
    } catch (error) {
      const work = pending;
      pending = undefined;
      clearTimeout(work.timer);
      work.reject(error);
    }
  });
  try {
    for (let index = 0; index < samples + 10; index++) {
      attempted = index;
      observed = 0;
      lastPresentation = undefined;
      const address = index % 2;
      const sample = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(new Error(`Matching compositor presentation timed out: ${address}`));
        }, 120000);
        pending = {
          address,
          expected: references[address].image_sha256,
          started: performance.now(),
          timer,
          resolve,
          reject,
        };
        click(geometry.points[address]);
      });
      assert(sample.latency_ms > 0 && sample.presentation_ms >= sample.input_ms);
      if (index >= 10) report.samples.push(sample);
    }
    report.status = "passed";
    return report;
  } catch (error) {
    // Preserve the failed observation without accepting another frame or replaying the input.
    const page = await contents.capturePage();
    const canvas = await contents.executeJavaScript(
      "document.querySelector('.composition-image > canvas:not(.viewport-snapshot)').toDataURL()",
    );
    const paths = {
      page: join(output, "latency-failure-page.png"),
      crop: join(output, "latency-failure-crop.png"),
      canvas: join(output, "latency-failure-canvas.png"),
      subscription: lastPresentation ? join(output, "latency-failure-subscription.png") : null,
    };
    await writeFile(paths.page, page.toPNG(), { flag: "wx" });
    await writeFile(paths.crop, crop(page).toPNG(), { flag: "wx" });
    await writeFile(paths.canvas, Buffer.from(canvas.split(",")[1], "base64"), { flag: "wx" });
    if (lastPresentation)
      await writeFile(paths.subscription, lastPresentation.image.toPNG(), { flag: "wx" });
    await writeAtomicJson(join(output, "latency-failure.json"), {
      ...report,
      error: String(error.stack ?? error),
      attempted,
      expected_address: attempted % 2,
      observed,
      last_presentation: lastPresentation
        ? { image_sha256: lastPresentation.hash, presentation_ms: lastPresentation.arrived }
        : null,
      editor: await call("get_editor_context"),
      evidence: paths,
    });
    throw error;
  } finally {
    contents.endFrameSubscription();
    if (pending) clearTimeout(pending.timer);
  }
}
