import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../core/layers/layer-factory";
import { createBlankProject } from "../core/project/project";
import {
  createRenderQueueJob,
  createRenderQueueJobAsync,
  type RenderQueueJobOptions,
} from "./render-job-builder";

function options(): RenderQueueJobOptions {
  const project = createBlankProject(true);
  const composition = project.compositions[0];
  composition.width = 640;
  composition.height = 360;
  composition.duration = 2;
  composition.workArea = { start: 0, end: 2 };
  composition.frameRate = { numerator: 24_000, denominator: 1_001 };
  return {
    project,
    composition,
    projectRevision: 7,
    outputKind: "mp4",
    destination: "C:\\renders\\parity.mp4",
    range: "composition",
    currentTime: 0,
  };
}

describe("render queue immutable snapshot parity", () => {
  it("derives the manifest from the captured project instead of a stale composition object", () => {
    const request = options();
    const staleComposition = structuredClone(request.composition);
    staleComposition.width = 1_280;
    staleComposition.height = 720;

    const job = createRenderQueueJob({ ...request, composition: staleComposition });

    expect(job).toMatchObject({
      compositionId: request.composition.id,
      width: 640,
      height: 360,
      frameRate: { numerator: 24_000, denominator: 1_001 },
    });
    const snapshot = JSON.parse(job.projectSnapshot) as typeof request.project;
    expect(snapshot.compositions[0]).toMatchObject({ width: job.width, height: job.height });
  });

  it("captures async manifest fields before yielding to snapshot serialization", async () => {
    const request = options();
    const linked = {
      id: "linked-still",
      kind: "still" as const,
      name: "plate.png",
      mimeType: "image/png",
      contentIdentity: `sha256:${"0".repeat(64)}`,
      relativePath: "assets/plate.png",
      runtimeUrl: "aster-asset://local/C%3A%5Cproject%5Cassets%5Cplate.png",
      width: 640,
      height: 360,
      interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
    };
    request.project.sources.push(linked);
    const image = createLayerForComposition("image", request.composition);
    image.sourceId = linked.id;
    request.composition.layers.push(image);
    const pending = createRenderQueueJobAsync(request);
    request.composition.width = 1_920;
    request.composition.height = 1_080;
    request.composition.frameRate = { numerator: 60, denominator: 1 };
    linked.runtimeUrl = "changed-after-queue-capture";

    const job = await pending;
    const snapshot = JSON.parse(job.projectSnapshot) as typeof request.project;

    expect(job).toMatchObject({
      width: 640,
      height: 360,
      frameRate: { numerator: 24_000, denominator: 1_001 },
    });
    expect(snapshot.compositions[0]).toMatchObject({
      width: job.width,
      height: job.height,
      frameRate: job.frameRate,
    });
    expect(JSON.parse(job.renderMediaSnapshot ?? "").entries[0].locator.url).toContain("plate.png");
  });

  it("rejects a composition that is absent from the project snapshot", () => {
    const request = options();
    expect(() =>
      createRenderQueueJob({
        ...request,
        composition: { ...request.composition, id: "not-in-project" },
      }),
    ).toThrow("not present");
  });
});
