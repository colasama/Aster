import { createLayerForComposition } from "../../../src/core/layers/layer-factory";
import type { NativeFramePacket } from "../../../src/core/rendering/native-export-protocol";
import type { RenderJobManifest } from "../../../src/core/rendering/render-queue";
import { type Composition, createTransform, type FootageSource } from "../../../src/core/types";
import { FrameBundleRenderer } from "../../../src/renderer/compositing/frame-bundle-renderer";
import { nativeFramePacket } from "../../../src/renderer/compositing/native-frame-packet";
import { encodeFramePlan } from "../../../src/renderer/frame-plan/codec";
import type { FrameBundle } from "../../../src/renderer/frame-plan/frame-bundle-plan";
import { readFrameBundle } from "../../../src/renderer/frame-plan/frame-bundle-read";
import { normalizeRawFrameRgba } from "../../../src/renderer/gpu/raw-frame-png";
import { WebGpuRenderer } from "../../../src/renderer/webgpu-renderer";
import { fixture } from "../temporal-text/runtime";

interface Asset {
  data: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  duration?: number;
}

function assertNativePacket(actual: NativeFramePacket, expected: NativeFramePacket): void {
  const sameBytes = (left: ArrayBuffer, right: ArrayBuffer) => {
    const actual = new Uint8Array(left),
      expected = new Uint8Array(right);
    return (
      actual.length === expected.length && actual.every((value, index) => value === expected[index])
    );
  };
  if (
    !sameBytes(actual.plan, expected.plan) ||
    actual.resources.length !== expected.resources.length ||
    JSON.stringify(actual.retainedResources) !== JSON.stringify(expected.retainedResources) ||
    actual.resources.some(
      (resource, index) =>
        JSON.stringify(resource.message) !== JSON.stringify(expected.resources[index].message) ||
        !sameBytes(resource.bytes, expected.resources[index].bytes),
    )
  )
    throw Error("Direct native packet differs from complete production capture");
}

function nativeInputs(input: FrameBundle) {
  const bundle = structuredClone(input);
  const envelope = bundle.plan.metadata.slices[0];
  if (envelope.kind !== "frame_bundle") throw Error("Frame envelope absent");
  const rasterFrames = new Set(
    bundle.resources
      .filter(
        (r) => r.message.kind === "media_frame" && r.message.descriptor.sample.kind === "raster",
      )
      .map((r) => r.message.hash),
  );
  const removed = new Set(
    envelope.media_pixels.filter((p) => !rasterFrames.has(p.frame)).map((p) => p.pixels),
  );
  envelope.media_pixels = envelope.media_pixels.filter((p) => rasterFrames.has(p.frame));
  for (const pixel of envelope.media_pixels) removed.delete(pixel.pixels);
  bundle.plan.metadata.resources = bundle.plan.metadata.resources.filter((h) => !removed.has(h));
  bundle.resources = bundle.resources.filter((r) => !removed.has(r.message.hash));
  const counts = bundle.plan.blobs[0];
  new DataView(counts.buffer, counts.byteOffset, counts.byteLength).setUint32(
    16,
    envelope.media_pixels.length,
    true,
  );
  readFrameBundle(bundle);
  return bundle;
}

/** Independent-device TS replay freezes mixed native-file and temporal-raster expectations. */
export async function captureMixedMedia(assets: Record<string, Asset>, jobCapture = false) {
  const results = [];
  for (const mode of ["root", "recursive"] as const) {
    const { project, composition, layer: text } = fixture("full");
    composition.width = 320;
    composition.height = 180;
    composition.background = [0, 0, 0, 0];
    text.transform = createTransform([145, 40, 0], [128, 40, 0]);
    if (text.textStyle) text.textStyle.fontSize = 40;
    for (const [index, name] of ["pattern.png", "barcode-24000-1001.mp4"].entries()) {
      const asset = assets[name],
        video = name.endsWith("mp4");
      const shared = {
        id: name,
        name,
        mimeType: asset.mimeType,
        contentIdentity: `sha256:${asset.sha256}`,
        runtimeUrl: `data:${asset.mimeType};base64,${asset.data}`,
        ...(jobCapture ? { dataUrl: `data:${asset.mimeType};base64,${asset.data}` } : {}),
        width: asset.width,
        height: asset.height,
        interpretation: { alpha: "straight" as const, colorSpace: "srgb" as const },
      };
      const source: FootageSource = video
        ? { ...shared, kind: "video", duration: asset.duration ?? 3.003 }
        : { ...shared, kind: "still" };
      project.sources.push(source);
      const layer = createLayerForComposition(video ? "video" : "image", composition);
      layer.sourceId = name;
      layer.size = [96, 64];
      layer.transform = createTransform([70 + index * 175, 125, 0], [48, 32, 0]);
      composition.layers.push(layer);
    }
    let target: Composition = composition;
    if (mode === "recursive") {
      for (let depth = 0; depth < 2; depth++) {
        const parent = structuredClone(composition);
        parent.id = crypto.randomUUID();
        const layer = createLayerForComposition("precomposition", parent);
        layer.sourceCompositionId = target.id;
        layer.size = [320, 180];
        layer.transform = createTransform([160, 90, 0], [160, 90, 0]);
        layer.effects = [
          {
            id: `blur-${depth}`,
            type: "gaussian-blur",
            name: "Blur",
            enabled: true,
            parameters: { radius: 1 },
          },
        ];
        parent.layers = [layer];
        project.compositions.push(parent);
        target = parent;
      }
    }
    const canvas = document.createElement("canvas");
    const job: RenderJobManifest | undefined = jobCapture
      ? {
          id: `native-media-${mode}`,
          compositionId: target.id,
          compositionName: target.name,
          projectRevision: 1,
          projectSnapshot: JSON.stringify({
            ...project,
            sources: project.sources.map(({ runtimeUrl: _runtimeUrl, ...source }) => source),
          }),
          antiAliasing: "off",
          width: 320,
          height: 180,
          frameRate: { numerator: 30, denominator: 1 },
          startFrame: 15,
          endFrameExclusive: 18,
          priority: 1,
          createdAt: new Date(0).toISOString(),
          outputs: [
            {
              id: "video",
              kind: "mp4",
              codec: "h264",
              destination: "fixture.mp4",
              bitrateMbps: 8,
              includeAudio: false,
            },
          ],
        }
      : undefined;
    const snapshot = {
      snapshotScope: job ? `render-job:${job.id}` : `mixed-media:${mode}`,
      projectRevision: 1,
    };
    canvas.width = 320;
    canvas.height = 180;
    document.body.append(canvas);
    console.log(`capture: ${mode} creating production device`);
    const renderer = await WebGpuRenderer.create(canvas);
    const replay = await FrameBundleRenderer.create();
    console.log(`capture: ${mode} devices ready`);
    try {
      let previous: Uint8ClampedArray | undefined;
      renderer.configureBeautyTarget(320, 180, "off");
      for (const [index, time] of (job ? [15 / 30, 16 / 30, 17 / 30] : [0.5, 1, 0.5]).entries()) {
        console.log(`capture: ${mode}-${index} render`);
        const context = canvas.getContext("webgpu");
        if (!context) throw Error("Production canvas context missing");
        const currentTexture = context.getCurrentTexture;
        context.getCurrentTexture = () => {
          throw Error("Plan-only capture touched the final output");
        };
        let planned: FrameBundle;
        try {
          planned = await renderer.planExportFrame(target, time, snapshot, project, true);
          const warm = await renderer.planExportFrame(target, time, snapshot, project, true);
          if (JSON.stringify(warm) !== JSON.stringify(planned))
            throw Error("Warm native raster capture differs from its cold input bytes");
          const complete = nativeFramePacket(planned);
          const direct = await renderer.planExportPacket(
            new Set(),
            target,
            time,
            snapshot,
            project,
            true,
          );
          assertNativePacket(direct, complete);
          const retained = new Set(complete.resources.map((resource) => resource.message.hash));
          const references = await renderer.planExportPacket(
            retained,
            target,
            time,
            snapshot,
            project,
            true,
          );
          assertNativePacket(references, nativeFramePacket(planned, retained));
        } finally {
          context.getCurrentTexture = currentTexture;
        }
        const raw = await renderer.renderRawFrame(
          target,
          time,
          snapshot,
          project,
          true,
          undefined,
          true,
        );
        if (!raw.bundle) throw Error("Mixed frame capture absent");
        const rgba = normalizeRawFrameRgba(raw, 320, 180);
        if (rgba.filter((value, index) => index % 4 === 3 && value > 8).length < 1000)
          throw Error("Mixed reference has insufficient visible coverage");
        if (previous && rgba.filter((value, index) => value !== previous?.[index]).length < 100)
          throw Error("Mixed reference time did not change visible pixels");
        previous = rgba;
        const repeated = await replay.render(raw.bundle);
        if (rgba.some((byte, i) => byte !== repeated[i]))
          throw Error("Independent TS replay differs");
        const hybrid = nativeInputs(raw.bundle);
        const expectedPlan = encodeFramePlan(hybrid.plan.metadata, hybrid.plan.blobs);
        const plannedBytes = new Uint8Array(nativeFramePacket(planned).plan);
        if (
          expectedPlan.length !== plannedBytes.length ||
          expectedPlan.some((byte, i) => byte !== plannedBytes[i])
        )
          throw Error(
            `Plan-only native plan differs from the production plan: ${JSON.stringify(
              [planned, hybrid].map((bundle) =>
                bundle.resources
                  .filter(
                    (r) =>
                      r.message.kind === "media_frame" &&
                      r.message.descriptor.sample.kind === "video",
                  )
                  .map((r) => r.message.descriptor),
              ),
            )}`,
          );
        if (
          hybrid.resources.length !== planned.resources.length ||
          hybrid.resources.some((expected) => {
            const resource = planned.resources.find(
              (r) => r.message.hash === expected.message.hash,
            );
            return (
              !resource ||
              resource.bytes.length !== expected.bytes.length ||
              resource.bytes.some((byte, i) => byte !== expected.bytes[i])
            );
          })
        )
          throw Error("Plan-only native resources differ from the production capture");
        const decoded = readFrameBundle(raw.bundle);
        const kinds = new Set<string>(decoded.mediaFrames.map((f) => f.descriptor.sample.kind));
        if (!["image", "video", "raster"].every((kind) => kinds.has(kind)))
          throw Error("Mixed media kinds absent");
        if (replay.temporalExecution.passes === 0) throw Error("Temporal raster execution absent");
        if (mode === "recursive" && decoded.plans.precompositions.length < 2)
          throw Error("Recursive surfaces absent");
        results.push({
          id: `${mode}-${index}`,
          mode,
          ...(job ? { job } : {}),
          time,
          width: 320,
          height: 180,
          independent_device_exact: true,
          plan_only_exact: true,
          plan_only_repeat_exact: true,
          direct_packet_exact: true,
          direct_packet_reference_exact: true,
          plan_only_final_output_accesses: 0,
          plan_only_file_pixel_captures: 0,
          adapter: {
            device: renderer.diagnostics.adapter,
            description: renderer.diagnostics.description,
          },
          surfaces: decoded.plans.precompositions.length,
          temporal: replay.temporalExecution,
          plan: Array.from(encodeFramePlan(hybrid.plan.metadata, hybrid.plan.blobs)),
          replay: Array.from(encodeFramePlan(raw.bundle.plan.metadata, raw.bundle.plan.blobs)),
          resources: raw.bundle.resources.map((r) => ({
            message: r.message,
            bytes: Array.from(r.bytes),
          })),
          rgba: Array.from(rgba),
        });
      }
    } finally {
      await renderer.complete();
      renderer.dispose();
      replay.destroy();
      canvas.remove();
    }
  }
  return results;
}
