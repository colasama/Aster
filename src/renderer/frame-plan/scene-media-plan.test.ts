import { describe, expect, it, vi } from "vitest";
import { MediaBindingLease } from "../media/media-binding-lease";
import { MediaGpuRegistry } from "../media/media-gpu-registry";
import { destroyMediaResource, type MediaResource } from "../media/media-resource";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { sceneBufferFixtureInput } from "./scene-buffer-fixture";
import { buildSceneBufferPlan } from "./scene-buffer-plan";
import { bindSceneMediaPlan, resolveSceneMediaPlan } from "./scene-media-plan";
import type { SceneMediaBinding } from "./types";

function owner(kind: "image" | "sequence" | "video"): MediaResource {
  return {
    source: kind,
    kind: kind === "video" ? "video" : "image",
    textureWidth: 2,
    textureHeight: 2,
    textureBytes: 16,
    texture: { destroy: vi.fn() } as unknown as GPUTexture,
    bindGroup: {} as GPUBindGroup,
    lastUploadedTime: kind === "video" ? 1001 / 30000 + 0.0001 : undefined,
    mediaIdentity: {
      source: { source_id: kind, content_identity: `content:${kind}`, media_kind: kind },
      sample:
        kind === "sequence"
          ? { kind: "sequence", frame: -1, file_identity: "member:before-zero" }
          : { kind: "image" },
    },
  };
}

describe("serializable scene media bindings", () => {
  it("replays image, sequence and exact video references with newly resolved GPU owners", () => {
    const owners = [owner("image"), owner("sequence"), owner("video")];
    const input = sceneBufferFixtureInput();
    const lease = new MediaBindingLease(
      owners.map((resource, index) => ({
        instanceId: String(index),
        resource,
        binding: resource.bindGroup,
        requestedTime: 1001 / 30000,
      })),
      input.snapshot.snapshotScope,
    );
    const refs: SceneMediaBinding[] = owners.map((_owner, draw_index) => ({
      draw_index,
      binding: { kind: "frame", hash: lease.hashFor(String(draw_index)) as string },
    }));
    const plan = bindSceneMediaPlan(buildSceneBufferPlan(input), refs);
    const messages = lease.resourceMessages;
    const decoded = decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs));
    refs[0].binding = { kind: "pending" };
    owners.forEach(destroyMediaResource);
    lease.release();
    const registry = new MediaGpuRegistry();
    const replacements = [owner("image"), owner("sequence"), owner("video")];
    for (const message of messages) {
      if (message.kind === "media_source") registry.apply(message);
      else if (message.kind === "media_frame") {
        const replacement = replacements.find(
          (resource) =>
            resource.mediaIdentity?.source.media_kind === message.descriptor.sample.kind,
        );
        if (!replacement) throw new Error("Missing replay owner");
        registry.apply(message, replacement, replacement.bindGroup);
      }
    }
    const replay = registry.pin(decoded.metadata.resources);
    const resolved = resolveSceneMediaPlan(decoded, replay);
    resolved.forEach((value, index) => {
      expect(value.binding).toBe(replacements[index].bindGroup);
      expect(value.binding).not.toBe(owners[index].bindGroup);
    });
    expect(resolved.map(({ hash }) => hash)).toEqual(
      plan.metadata.slices[0].kind === "scene_buffers"
        ? plan.metadata.slices[0].media_bindings.map((entry) =>
            entry.binding.kind === "frame" ? entry.binding.hash : null,
          )
        : [],
    );
    replay.release();
    registry.apply({ type: "evict_resource", hash: decoded.metadata.resources[0] });
    expect(() => registry.pin(decoded.metadata.resources)).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    registry.destroy();
  });

  it("preserves pending output and rejects missing references or ambiguous draw indices before resolution", () => {
    const original = buildSceneBufferPlan(sceneBufferFixtureInput());
    const plan = bindSceneMediaPlan(original, [{ draw_index: 0, binding: { kind: "pending" } }]);
    const lookup = { bindingForHash: vi.fn() };
    expect(
      resolveSceneMediaPlan(decodeFramePlan(encodeFramePlan(plan.metadata, plan.blobs)), lookup),
    ).toEqual([{ drawIndex: 0, hash: null, binding: undefined }]);
    expect(lookup.bindingForHash).not.toHaveBeenCalled();
    for (const indices of [[0, 0], [1, 0], [999]]) {
      expect(() =>
        bindSceneMediaPlan(
          original,
          indices.map((draw_index) => ({ draw_index, binding: { kind: "pending" } })),
        ),
      ).toThrow();
    }
    const missing = bindSceneMediaPlan(original, [
      { draw_index: 0, binding: { kind: "frame", hash: "0".repeat(64) } },
    ]);
    expect(() => resolveSceneMediaPlan(missing, lookup)).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    missing.metadata.resources = [];
    lookup.bindingForHash.mockClear();
    expect(() => resolveSceneMediaPlan(missing, lookup)).toThrow(
      expect.objectContaining({ code: "missing_resource" }),
    );
    expect(lookup.bindingForHash).not.toHaveBeenCalled();
  });
});
