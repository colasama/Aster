import { expect, it, vi } from "vitest";
import { encodeFramePlan } from "./codec";
import { frameBundleFixtures } from "./frame-bundle-fixture";
import { buildFrameBundle, buildFrameBundleAsync } from "./frame-bundle-plan";
import { readFrameBundle } from "./frame-bundle-read";
import { PrecompositionBundleResources } from "./precomposition-bundle-resources";
import { contentResourceHashSync } from "./resources";

it.each([false, true])(
  "bounds small-plan digests and drains failures (reject first: %s)",
  async (rejectFirst) => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      const index = calls++;
      active += 1;
      peak = Math.max(peak, active);
      try {
        await ready;
        if (rejectFirst && index === 0) throw Error("digest unavailable");
        return await digest(...args);
      } finally {
        active -= 1;
      }
    });
    const resources = new PrecompositionBundleResources();
    try {
      const expected: Uint8Array[] = [];
      const pending = Array.from({ length: 70 }, (_, index) => {
        const plan = structuredClone(
          readFrameBundle(frameBundleFixtures()[1].frameBundle).plans.post,
        );
        plan.metadata.header.project_revision = index;
        expected.push(encodeFramePlan(plan.metadata, plan.blobs));
        const result = resources.addRequiredPlanAsync(plan, "post_uniforms_slice_v1");
        plan.metadata.header.project_revision += 1000;
        plan.blobs[0].fill(0);
        return result;
      });
      expect(active).toBe(32);
      release();
      const settled = await Promise.allSettled(pending);
      if (rejectFirst) await expect(resources.settle()).rejects.toThrow("digest unavailable");
      else await resources.settle();
      expect(calls).toBe(70);
      expect(peak).toBe(32);
      expect(active).toBe(0);
      for (const [index, result] of settled.entries()) {
        if (rejectFirst && index === 0) expect(result.status).toBe("rejected");
        else {
          if (result.status !== "fulfilled") throw result.reason;
          const resource = resources.resolve(result.value);
          expect(resource.bytes).toEqual(expected[index]);
          expect(contentResourceHashSync(resource.message, resource.bytes)).toBe(result.value);
        }
      }
    } finally {
      release();
      await resources.settle().catch(() => undefined);
      spy.mockRestore();
    }
  },
);

it.each([false, true])("owns admitted metadata and binary payloads (async: %s)", async (async) => {
  const resources = new PrecompositionBundleResources();
  const content = {
    kind: "media_source" as const,
    descriptor: {
      source_id: { utf16_units: [97, 0xd800] },
      content_identity: "identity".repeat(10000),
      media_kind: "image" as const,
      authorization_scope: "snapshot",
    },
  };
  const message = {
    ...content,
    type: "put_resource" as const,
    hash: contentResourceHashSync(content),
  };
  const expected = structuredClone(message);
  const pending = async
    ? resources.addAsync({ message, bytes: new Uint8Array() })
    : resources.add({ message, bytes: new Uint8Array() });
  message.descriptor.source_id.utf16_units[0] = 98;
  message.descriptor.content_identity = "changed";
  const hash = await pending;
  expect(resources.resolve(hash).message).toEqual(expected);
  if (async)
    await expect(resources.addAsync({ message, bytes: new Uint8Array() })).rejects.toThrow(
      /hash mismatch/,
    );
  else expect(() => resources.add({ message, bytes: new Uint8Array() })).toThrow(/hash mismatch/);

  const bytes = Uint8Array.of(1, 2, 3, 4);
  const buffer = {
    kind: "buffer" as const,
    descriptor: {
      element_type: "u8" as const,
      element_count: bytes.length,
      byte_length: bytes.length,
    },
  };
  const input = {
    bytes,
    message: {
      ...buffer,
      type: "put_resource" as const,
      hash: contentResourceHashSync(buffer, bytes),
    },
  };
  const expectedBuffer = structuredClone(input);
  const binaryPending = async ? resources.addAsync(input) : resources.add(input);
  bytes.fill(0);
  input.message.descriptor.element_count = 0;
  expect(resources.resolve(await binaryPending)).toEqual(expectedBuffer);
});

it("assembles identical owned bundles with asynchronous plan hashing", async () => {
  for (const fixture of frameBundleFixtures()) {
    if (!("input" in fixture)) continue;
    const input = structuredClone(fixture.input);
    const expected = buildFrameBundle(input);
    const pending = buildFrameBundleAsync(input);
    input.scene.blobs[0].fill(0);
    input.root.metadata.header.project_revision++;
    input.effects.clear();
    input.generators.length = 0;
    if (input.precompositions) input.precompositions.resources[0].bytes.fill(0);
    const actual = await pending;
    expect(actual).toEqual(expected);
    expect(encodeFramePlan(actual.plan.metadata, actual.plan.blobs)).toEqual(
      encodeFramePlan(expected.plan.metadata, expected.plan.blobs),
    );
    for (const resource of actual.resources)
      expect(contentResourceHashSync(resource.message, resource.bytes)).toBe(resource.message.hash);
  }
});

it.each([4, 20000])(
  "owns %i-unit encoded inputs and enforces contracts and dependencies",
  async (length) => {
    const plan = structuredClone(readFrameBundle(frameBundleFixtures()[1].frameBundle).plans.post);
    plan.metadata.header.composition_id = "x".repeat(length);
    const original = encodeFramePlan(plan.metadata, plan.blobs);
    const resources = new PrecompositionBundleResources();
    const pending = resources.addRequiredPlanAsync(plan, "post_uniforms_slice_v1");
    plan.metadata.header.project_revision++;
    plan.blobs[0][8] ^= 1;
    const hash = await pending;
    expect(resources.resolve(hash).bytes).toEqual(original);
    const changed = await resources.addRequiredPlanAsync(plan, "post_uniforms_slice_v1");
    expect(changed).not.toBe(hash);
    const packet = resources.resolve(changed);
    expect(contentResourceHashSync(packet.message, packet.bytes)).toBe(changed);
    const invalid = new PrecompositionBundleResources();
    await expect(invalid.addRequiredPlanAsync(plan, "frame_bundle_slice_v1")).rejects.toThrow(
      /contract differs/,
    );
    await expect(invalid.settle()).rejects.toThrow(/contract differs/);
    const missing = new PrecompositionBundleResources();
    await expect(
      missing.addRequiredPlanAsync(
        frameBundleFixtures()[0].frameBundle.plan,
        "frame_bundle_slice_v1",
      ),
    ).rejects.toThrow(/dependency is absent/);
    await expect(missing.settle()).rejects.toThrow(/dependency is absent/);
  },
);
