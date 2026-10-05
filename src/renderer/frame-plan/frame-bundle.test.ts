import { describe, expect, it } from "vitest";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { frameBundleFixtures } from "./frame-bundle-fixture";
import { readFrameBundle } from "./frame-bundle-read";
import { contentResourceHashSync } from "./resources";

describe("owned root frame bundles", () => {
  it("resolves recursive scenes, LUT effects and effective generator inputs without authoring objects", () => {
    const fixture = frameBundleFixtures()[0];
    const packet = structuredClone(fixture.frameBundle);
    packet.plan = decodeFramePlan(fixture.bytes);
    const decoded = readFrameBundle(packet);
    expect(decoded.effects.size).toBe(4);
    expect(decoded.generators).toHaveLength(3);
    expect(decoded.plans.precompositions).toHaveLength(2);
    const before = new Uint8Array(decoded.plans.scene.blobs[0]);
    for (const resource of packet.resources) resource.bytes.fill(0);
    expect(decoded.plans.scene.blobs[0]).toEqual(before);
    expect(
      encodeFramePlan(fixture.frameBundle.plan.metadata, fixture.frameBundle.plan.blobs),
    ).toEqual(fixture.bytes);
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
