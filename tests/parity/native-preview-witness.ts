import { validateProjectDocument } from "../../src/core/project/validation/document";
import type { NativePreviewSnapshot } from "../../src/core/rendering/native-preview-protocol";
import { previewFrameCache } from "../../src/core/rendering/preview-frame-cache";
import { createBeautyFrameRequest } from "../../src/renderer/compositing/beauty-frame";
import { previewFramePlan } from "../../src/renderer/frame-cache/cached-beauty-presenter";
import { NativePreviewCanvas } from "../../src/renderer/native-project/preview-canvas";
import { NativePreviewView } from "../../src/renderer/native-project/preview-view";

async function run() {
  const api = window.asterDesktop;
  if (!api?.nativePreview) throw new Error("Native preview bridge absent");
  const config = (await api.invoke("preview_witness_open")) as {
    snapshots: NativePreviewSnapshot[];
    times: number[];
    restart: boolean;
  };
  if (!(await api.nativePreview.available())) throw new Error("Native preview capability absent");
  const canvas = document.getElementById("preview") as HTMLCanvasElement;
  const receiver = await NativePreviewCanvas.create(canvas, api.nativePreview);
  let id: string | undefined;
  try {
    for (const [generation, snapshot] of config.snapshots.entries()) {
      const ready = id
        ? await api.nativePreview.replace(id, snapshot)
        : await api.nativePreview.open(snapshot).then((opened) => {
            id = opened.id;
            return opened.ready;
          });
      if (!id) throw new Error("Preview id absent");
      receiver.bind(id, ready);
      for (const time of config.times) {
        const output = await receiver.present(time, true, () => true);
        if (!output.pixels || output.skipped) throw new Error("Preview capture absent");
        await api.invoke("preview_witness_frame", { generation, time, ready, ...output.pixels });
      }
    }
  } finally {
    receiver.dispose();
    if (id) await api.nativePreview.close(id);
  }
  const observedTimes: number[] = [];
  const nativeApi = api.nativePreview;
  const previewApi = {
    ...api.nativePreview,
    present: (id: string, time: number, request: number) => {
      observedTimes.push(time);
      return nativeApi.present(id, time, request);
    },
  };
  const authored = validateProjectDocument(JSON.parse(config.snapshots[0].projectDocument));
  const composition = authored.compositions.find((c) => c.id === config.snapshots[0].compositionId);
  if (!composition) throw new Error("Witness composition absent");
  const request = (time: number, width = 320, height = 180) =>
    createBeautyFrameRequest({
      project: authored,
      composition,
      snapshot: { snapshotScope: "native-view-witness", projectRevision: 1 },
      time,
      width,
      height,
      antiAliasing: "off",
    });
  const options = { visualization: "beauty", memoryBudgetMb: 512, playing: false };
  let displayed: string | undefined, failure: unknown;
  const view = await NativePreviewView.create(
    canvas,
    previewApi,
    () => {
      displayed = canvas.toDataURL();
    },
    (error) => {
      failure = error;
    },
  );
  previewFrameCache.clear();
  previewFrameCache.setBudgetMb(1);
  try {
    view.queue(request(0), options);
    await view.settled();
    if (failure) throw failure;
    if (!displayed || displayed !== canvas.toDataURL())
      throw new Error("Idle rendering changed the displayed canvas");
    if (previewFrameCache.usage().frameCount < 2) throw new Error("Idle cache did not fill");
    const cacheFrames = previewFrameCache.usage().frameCount;
    const beforeCached = observedTimes.length;
    view.queue(request(0), options);
    view.stopIdle();
    await view.settled();
    if (observedTimes.length !== beforeCached)
      throw new Error("Cached frame invoked native rendering");
    view.queue(request(0.123456789), options);
    await view.settled();
    if (!observedTimes.includes(0.123456789)) throw new Error("Paused preview time was quantized");
    view.queue(request(0.125, 160, 90), options);
    await view.settled();
    if (canvas.width !== 160 || canvas.height !== 90) throw new Error("Preview resize failed");
    view.queue(request(0), options);
    await view.settled();
    if (failure) throw failure;
    const plan = previewFramePlan(request(0));
    const pixels = previewFrameCache.lookup(plan.compositionId, `native:${plan.scope}`, plan.frame);
    if (!pixels) throw new Error("Restored view capture absent");
    await api.invoke("preview_witness_frame", { generation: 0, time: 0, ...pixels });
    const lostDevice = view.canvas.device;
    lostDevice.destroy();
    await lostDevice.lost;
    const recoveredDevicePixels = await view.readback(request(0), 512);
    if (view.canvas.device === lostDevice) throw new Error("Lost preview device was reused");
    await api.invoke("preview_witness_frame", {
      generation: 0,
      time: 0,
      width: 320,
      height: 180,
      ...recoveredDevicePixels,
    });
    await api.invoke("preview_witness_crash_producer");
    const recoveredProducerPixels = await view.readback(request(0), 512);
    await api.invoke("preview_witness_frame", {
      generation: 0,
      time: 0,
      width: 320,
      height: 180,
      ...recoveredProducerPixels,
    });
    await api.invoke("preview_witness_lifecycle", {
      idle_cache_frames: cacheFrames,
      idle_preserved_canvas: true,
      cached_without_native_render: true,
      exact_paused_time: 0.123456789,
      resized: true,
      device_loss_recovered: true,
      producer_crash_recovered: true,
      observed_times: observedTimes,
    });
  } finally {
    await view.dispose();
    previewFrameCache.clear();
  }
  if (config.restart) {
    // Keep a live producer and presentation device for the main-process crash fixture.
    const live = await NativePreviewCanvas.create(canvas, api.nativePreview);
    const opened = await api.nativePreview.open(config.snapshots[0]);
    live.bind(opened.id, opened.ready);
    await live.present(0, false, () => true);
  }
  await api.invoke("preview_witness_done");
}
void run().catch((error) =>
  window.asterDesktop?.invoke("preview_witness_error", { message: String(error?.stack ?? error) }),
);
