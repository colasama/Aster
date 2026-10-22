import type { NativePreviewDescriptor } from "../../src/core/rendering/native-preview-protocol";
import { NativePreviewCanvas } from "../../src/renderer/native-project/preview-canvas";

async function run() {
  const api = window.asterDesktop;
  if (!api?.nativePreview) throw new Error("Native preview bridge absent");
  const canvas = await NativePreviewCanvas.create(
    document.getElementById("preview") as HTMLCanvasElement,
    api.nativePreview,
  );
  try {
    for (;;) {
      const job = (await api.invoke("preview_corpus_next")) as {
        id: string;
        ready: NativePreviewDescriptor;
        samples: { frame: number; time: number }[];
      } | null;
      if (!job) break;
      canvas.bind("corpus", job.ready);
      for (const sample of job.samples) {
        const result = await canvas.present(sample.time, true, () => true);
        if (result.skipped || !result.pixels) throw new Error("Corpus pixels absent");
        await api.invoke("preview_corpus_frame", {
          id: job.id,
          ...sample,
          ready: job.ready,
          ...result.pixels,
        });
      }
    }
    await api.invoke("preview_corpus_done");
  } finally {
    canvas.dispose();
  }
}
void run().catch((error) =>
  window.asterDesktop?.invoke("preview_corpus_error", { error: String(error?.stack ?? error) }),
);
