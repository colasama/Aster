import { segmentTextLayoutUnits } from "../../core/animation/text-animator-stack";
import { activateProjectFonts, prepareProjectFonts } from "../../core/media/project-font-runtime";
import { loadProjectFromPath } from "../../core/project/project-file";
import { mediaImportRuntime } from "../../importers/media-import-runtime";
import { hydrateRenderMediaSnapshot } from "../../render-queue/render-media-manifest";
import type { FrameHeaderSlice } from "../frame-plan/types";
import { VerifiedMediaPixels } from "../media/verified-media-pixels";
import type {} from "./raster-service-protocol";
import { RetainedRasterProvider } from "./retained-raster-provider";
import type { RetainedRasterRequest } from "./retained-raster-types";

async function run() {
  const api = window.asterRasterService;
  const { projectPath, retainedMediaSnapshot } = await api.open();
  const { project } = await loadProjectFromPath(projectPath);
  await prepareProjectFonts(project);
  activateProjectFonts(project);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("Retained raster GPU is unavailable");
  const device = await adapter.requestDevice();
  let deviceFailure: Error | undefined;
  device.addEventListener("uncapturederror", (event) => {
    deviceFailure ??= new Error(event.error.message);
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const provider = new RetainedRasterProvider(device, layout, sampler);
  let retainedMedia: Awaited<ReturnType<typeof hydrateRenderMediaSnapshot>> | undefined;
  try {
    if (retainedMediaSnapshot)
      retainedMedia = await hydrateRenderMediaSnapshot(project, retainedMediaSnapshot);
    await api.ready({
      locale: new Intl.Collator().resolvedOptions().locale,
      maximumDimension: Math.min(8192, device.limits.maxTextureDimension2D),
      layouts: Object.fromEntries(
        project.compositions.map((composition) => [
          composition.id,
          Object.fromEntries(
            composition.layers
              .filter((layer) => layer.kind === "text")
              .map((layer) => [layer.id, segmentTextLayoutUnits(layer.text ?? layer.name)]),
          ),
        ]),
      ),
    });
    for (let work = await api.take(); work; work = await api.take()) {
      if (deviceFailure) throw deviceFailure;
      device.pushErrorScope("validation");
      const frame = await provider.acquireVerified(
        project,
        work.requests as RetainedRasterRequest[],
        work.header as FrameHeaderSlice,
      );
      const error = await device.popErrorScope();
      if (error || deviceFailure) throw deviceFailure ?? new Error(error?.message);
      const known = new Set(work.knownPayloads);
      const knownResources = new Set(work.knownResources);
      await api.frame({
        index: work.index,
        ...frame,
        resources: frame.resources.map((resource) =>
          knownResources.has(resource.hash)
            ? { type: "resident_resource", hash: resource.hash }
            : resource,
        ),
        pixels: frame.pixels.map((item) => {
          const description = VerifiedMediaPixels.describe(item);
          return known.has(`${description.pixels.message.hash}.bin`)
            ? description
            : VerifiedMediaPixels.copy(item);
        }),
      });
    }
  } finally {
    await device.queue.onSubmittedWorkDone();
    provider.destroy();
    retainedMedia?.dispose();
    mediaImportRuntime.clear();
    activateProjectFonts({ fonts: [] });
    device.destroy();
  }
}

void run().catch((error) => window.asterRasterService.fail(String(error?.stack ?? error)));
