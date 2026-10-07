import type { Composition, Project } from "../../../src/core/types";
import { FrameBundleRenderer } from "../../../src/renderer/compositing/frame-bundle-renderer";
import { decodeFramePlan, encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import { readFrameBundle } from "../../../src/renderer/frame-plan/frame-bundle-read";
import { contentResourceHashSync } from "../../../src/renderer/frame-plan/resources";
import {
  buildTemporalPassSlice,
  readTemporalPassSlice,
} from "../../../src/renderer/frame-plan/temporal-pass-plan";
import { normalizeRawFrameRgba } from "../../../src/renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../../src/renderer/webgpu-renderer";

/** Warmed production caches must still supply executable temporal derivations to an isolated device. */
export async function auditTemporalFrameReplay(
  project: Project,
  composition: Composition,
  minimumSurfaces = 0,
  capture = false,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.body.append(canvas);
  const renderer = await WebGpuRenderer.create(canvas);
  let replay: FrameBundleRenderer | undefined;
  try {
    replay = await FrameBundleRenderer.create();
    renderer.configureBeautyTarget(320, 180, "off");
    const snapshot = { snapshotScope: "temporal-whole-frame", projectRevision: 1 };
    renderer.render(composition, 1, snapshot, false, project);
    await renderer.complete();
    const results = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const raw = await renderer.renderRawFrame(
        composition,
        1,
        snapshot,
        project,
        true,
        undefined,
        true,
      );
      if (!raw.bundle) throw Error("Temporal whole-frame bundle is absent");
      const surfaces = readFrameBundle(raw.bundle).plans.precompositions.length;
      if (surfaces < minimumSurfaces) throw Error("Recursive temporal surfaces are absent");
      const actual = await replay.render({
        ...raw.bundle,
        plan: decodeFramePlan(encodeFramePlan(raw.bundle.plan.metadata, raw.bundle.plan.blobs)),
      });
      const expected = normalizeRawFrameRgba(raw, 320, 180);
      const difference = actual.findIndex((byte, index) => byte !== expected[index]);
      if (difference !== -1)
        throw Error(
          `Temporal whole-frame replay differs at byte ${difference}: ${actual[difference]} != ${expected[difference]}`,
        );
      const temporal = replay.temporalExecution;
      if (temporal.passes === 0 || temporal.samples === 0)
        throw Error("Temporal whole-frame replay did not execute samples");
      const mutated = structuredClone(raw.bundle),
        envelope = mutated.plan.metadata.slices[0];
      if (envelope.kind !== "frame_bundle") throw Error("Missing temporal envelope");
      const old = envelope.temporal[0],
        packet = mutated.resources.find((r) => r.message.hash === old);
      if (!packet) throw Error("Missing temporal stage");
      const stage = decodeFramePlan(packet.bytes),
        pass = readTemporalPassSlice(stage);
      const changed = buildTemporalPassSlice(stage.metadata.header, {
        ...pass,
        samples: pass.samples.map((sample) => ({ ...sample, weight: 0 })),
      });
      packet.bytes = encodeFramePlan(changed.metadata, changed.blobs);
      packet.message.hash = contentResourceHashSync(packet.message, packet.bytes);
      envelope.temporal[0] = packet.message.hash;
      mutated.plan.metadata.resources = mutated.plan.metadata.resources
        .map((hash) => (hash === old ? packet.message.hash : hash))
        .sort();
      const zeroExposure = await replay.render(mutated);
      let changedPixels = 0;
      for (let pixel = 0; pixel < actual.length; pixel += 4)
        if (
          actual
            .subarray(pixel, pixel + 4)
            .some((value, lane) => value !== zeroExposure[pixel + lane])
        )
          changedPixels++;
      if (changedPixels <= 16) throw Error("Temporal weights did not affect whole-frame pixels");
      results.push({
        capture: capture
          ? {
              plan: Array.from(encodeFramePlan(raw.bundle.plan.metadata, raw.bundle.plan.blobs)),
              resources: raw.bundle.resources.map((packet) => ({
                message: packet.message,
                bytes: Array.from(packet.bytes),
              })),
              rgba: Array.from(expected),
            }
          : undefined,
        ...temporal,
        changed_pixels: changedPixels,
        bytes: actual.length,
        exact: true,
        independent_device: true,
        warmed_cache: true,
        surfaces,
      });
    }
    return results;
  } finally {
    await renderer.complete();
    renderer.dispose();
    replay?.destroy();
    canvas.remove();
  }
}
