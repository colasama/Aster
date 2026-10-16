import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { frameBundleFixtures } from "./frame-bundle-fixture";
import { withFrameBundleMedia } from "./frame-bundle-media";
import { readFrameBundle, readFrameBundleAsync } from "./frame-bundle-read";
import { PrecompositionBundleResources } from "./precomposition-bundle-resources";
import { contentResourceHashSync } from "./resources";

describe("owned root frame bundles", () => {
  it("registers validated producer dependencies without weakening the resource boundary", () => {
    const fixture = frameBundleFixtures()[0].frameBundle;
    const resources = new PrecompositionBundleResources();
    for (const packet of fixture.resources) resources.add(packet);
    const plan = structuredClone(fixture.plan);
    const expected = encodeFramePlan(plan.metadata, plan.blobs);
    const hash = resources.addRequiredPlan(plan, "frame_bundle_slice_v1");
    expect([...resources.used].sort()).toEqual([...plan.metadata.resources, hash].sort());
    plan.metadata.header.project_revision++;
    for (const blob of plan.blobs) blob.fill(0);
    expect(resources.resolve(hash).bytes).toEqual(expected);
    expect(() => resources.plan(hash, "frame_bundle_slice_v1")).not.toThrow();
    expect(() => resources.addRequiredPlan(fixture.plan, "post_uniforms_slice_v1")).toThrow(
      /contract differs/,
    );
    expect(() =>
      resources.addRequiredPlan({ ...fixture.plan, blobs: [] }, "frame_bundle_slice_v1"),
    ).toThrow(/Missing blob bytes/);
    expect(() =>
      new PrecompositionBundleResources().addRequiredPlan(fixture.plan, "frame_bundle_slice_v1"),
    ).toThrow(/dependency is absent/);
  });

  it("owns directly encoded plan resources and still authenticates external packets", () => {
    const plan = structuredClone(readFrameBundle(frameBundleFixtures()[1].frameBundle).plans.post);
    const expected = encodeFramePlan(plan.metadata, plan.blobs);
    const resources = new PrecompositionBundleResources();
    const hash = resources.addPlan(plan);
    for (const blob of plan.blobs) blob.fill(0);
    plan.metadata.header.project_revision++;
    const packet = resources.resolve(hash);
    expect(packet.bytes).toEqual(expected);
    expect(contentResourceHashSync(packet.message, packet.bytes)).toBe(hash);
    const corrupted = structuredClone(packet);
    corrupted.bytes[0] ^= 1;
    expect(() => resources.add(corrupted)).toThrow(/hash mismatch/);
    const unknown = structuredClone(packet);
    Object.assign(unknown.message, { untrusted: true });
    expect(() => resources.add(unknown)).toThrow(/exactly these fields/);
  });

  it("requires the complete marker on executable root bundles", () => {
    const packet = structuredClone(frameBundleFixtures()[1].frameBundle);
    expect(packet.plan.metadata.renderer_plan_complete).toBe(true);
    packet.plan.metadata.renderer_plan_complete = false;
    expect(() => encodeFramePlan(packet.plan.metadata, packet.plan.blobs)).toThrow(
      /complete renderer plan/,
    );
  });
  it("owns temporal samples and rejects duplicate passes and undeclared stages", () => {
    const packet = structuredClone(frameBundleFixtures()[2].frameBundle);
    const decoded = readFrameBundle(packet);
    expect(decoded.plans.temporal).toHaveLength(2);
    expect(decoded.mediaPixels).toHaveLength(4);
    const bundle = packet.plan.metadata.slices[0];
    if (bundle.kind !== "frame_bundle") throw Error("Missing fixture");
    bundle.temporal[1] = bundle.temporal[0];
    expect(() => readFrameBundle(packet)).toThrow(/Duplicate temporal/);
    bundle.temporal[1] = "f".repeat(64);
    expect(() => readFrameBundle(packet)).toThrow(/Undeclared temporal/);
  });
  it("resolves recursive scenes, LUT effects and effective generator inputs without authoring objects", () => {
    const fixture = frameBundleFixtures()[0];
    const packet = structuredClone(fixture.frameBundle);
    packet.plan = decodeFramePlan(fixture.bytes);
    const decoded = readFrameBundle(packet);
    expect(decoded.effects.size).toBe(4);
    expect(decoded.generators).toHaveLength(3);
    expect(decoded.plans.precompositions).toHaveLength(2);
    expect(decoded.mediaFrames).toHaveLength(1);
    expect(decoded.mediaPixels).toHaveLength(1);
    const before = new Uint8Array(decoded.plans.scene.blobs[0]);
    for (const resource of packet.resources) resource.bytes.fill(0);
    expect(decoded.plans.scene.blobs[0]).toEqual(before);
    expect(
      encodeFramePlan(fixture.frameBundle.plan.metadata, fixture.frameBundle.plan.blobs),
    ).toEqual(fixture.bytes);
  });
  it("rejects missing, duplicate and unrelated media capture links", () => {
    const packet = structuredClone(frameBundleFixtures()[0].frameBundle);
    const decoded = readFrameBundle(packet);
    const bundle = packet.plan.metadata.slices[0];
    if (bundle.kind !== "frame_bundle") throw Error("Missing fixture");
    const link = bundle.media_pixels[0];
    bundle.media_pixels = [];
    new DataView(packet.plan.blobs[0].buffer).setUint32(16, 0, true);
    // This fixture also references the same bytes from its recursive bundle.
    expect(() => withFrameBundleMedia(packet, [])).toThrow(/coverage differs/);
    expect(() =>
      withFrameBundleMedia(packet, [...decoded.mediaPixels, ...decoded.mediaPixels]),
    ).toThrow(/coverage differs/);
    expect(readFrameBundle(withFrameBundleMedia(packet, decoded.mediaPixels)).mediaPixels).toEqual(
      decoded.mediaPixels,
    );
    bundle.media_pixels = [link, link];
    new DataView(packet.plan.blobs[0].buffer).setUint32(16, 2, true);
    expect(() => readFrameBundle(packet)).toThrow(/Duplicate/);
  });
  it("rejects missing and corrupt payloads before resource realization", () => {
    const { frameBundle } = frameBundleFixtures()[0];
    expect(() =>
      readFrameBundle({ ...frameBundle, resources: frameBundle.resources.slice(1) }),
    ).toThrow();
    const corrupt = structuredClone(frameBundle);
    corrupt.resources[0].bytes[0] ^= 1;
    expect(() => readFrameBundle(corrupt)).toThrow(/hash mismatch/);
  });
  it("owns asynchronous decode inputs before hashing and rejects changed media bytes", async () => {
    const packet = structuredClone(frameBundleFixtures()[0].frameBundle);
    const expected = readFrameBundle(packet);
    const decoding = readFrameBundleAsync(packet);
    for (const resource of packet.resources) resource.bytes.fill(0);
    expect(await decoding).toEqual(expected);
    const corrupt = structuredClone(frameBundleFixtures()[0].frameBundle);
    const pixelHash = expected.mediaPixels[0].pixels.message.hash;
    const pixels = corrupt.resources.find((p) => p.message.hash === pixelHash);
    if (!pixels) throw Error("Missing media fixture");
    pixels.bytes[0] ^= 1;
    await expect(readFrameBundleAsync(corrupt)).rejects.toThrow(/hash mismatch/);
  });
  it("rejects a validly rehashed stage from another frame", () => {
    const packet = structuredClone(frameBundleFixtures()[1].frameBundle);
    const bundle = packet.plan.metadata.slices[0];
    if (bundle.kind !== "frame_bundle") throw Error("Missing fixture");
    const entry = packet.resources.find((p) => p.message.hash === bundle.post);
    if (!entry) throw Error("Missing stage");
    const post = decodeFramePlan(entry.bytes);
    post.metadata.header.project_revision++;
    const old = entry.message.hash;
    entry.bytes = encodeFramePlan(post.metadata, post.blobs);
    entry.message.hash = contentResourceHashSync(entry.message, entry.bytes);
    bundle.post = entry.message.hash;
    packet.plan.metadata.resources = packet.plan.metadata.resources
      .map((h) => (h === old ? entry.message.hash : h))
      .sort();
    expect(() => readFrameBundle(packet)).toThrow(/frame differs/);
  });
  it("rejects forged generator outcome counts and frame count payloads", () => {
    const packet = structuredClone(frameBundleFixtures()[0].frameBundle);
    const bundle = packet.plan.metadata.slices[0];
    if (bundle.kind !== "frame_bundle") throw Error("Missing fixture");
    const state = bundle.generators[0].execution;
    if (state.status !== "ready") throw Error("Missing state");
    state.effective_count--;
    expect(() => readFrameBundle(packet)).toThrow(/count differs/);
    packet.plan.blobs[0][0] ^= 1;
    expect(() => readFrameBundle(packet)).toThrow(/count mismatch/);
  });
});
