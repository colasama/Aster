import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import { decodeFramePlan, encodeFramePlan } from "./codec";
import { frameIndexTime, productionUniformFixtures } from "./fixture";
import { defaultFramePlanLimits } from "./types";

function rewriteMetadata(
  bytes: Uint8Array,
  transform: (metadata: Record<string, unknown>) => void,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = JSON.parse(
    new TextDecoder().decode(bytes.subarray(32, 32 + view.getUint32(8, true))),
  );
  transform(metadata);
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const start = Math.ceil((32 + json.length) / 16) * 16;
  const payload = bytes.subarray(view.getUint32(16, true));
  const changed = new Uint8Array(start + payload.length);
  changed.set(bytes.subarray(0, 32));
  const header = new DataView(changed.buffer);
  header.setUint32(8, json.length, true);
  header.setUint32(16, start, true);
  header.setUint32(20, changed.length, true);
  changed.set(json, 32);
  changed.set(payload, start);
  return changed;
}

describe("FPLN typed post-uniform transport", () => {
  it("preserves real production uniforms, signed zero, multiple blobs and nonzero view offsets", () => {
    for (const fixture of productionUniformFixtures()) {
      const padded = new Uint8Array(fixture.bytes.length + 13);
      padded.set(fixture.bytes, 7);
      const input = padded.subarray(7, 7 + fixture.bytes.length);
      const decoded = decodeFramePlan(input);
      expect(decoded.metadata.renderer_plan_complete).toBe(false);
      expect(encodeFramePlan(decoded.metadata, decoded.blobs)).toEqual(fixture.bytes);
      expect(decoded.blobs[0].buffer).toBe(input.buffer);
      if (fixture.id === "negative")
        expect(
          new DataView(decoded.blobs[0].buffer, decoded.blobs[0].byteOffset).getUint32(12, true),
        ).toBe(0x80000000);
    }
  });

  it("uses exact rational arithmetic and rejects implicit overflow or approximate time", () => {
    expect(frameIndexTime(240, { numerator: 24000, denominator: 1001 })).toEqual({
      value: 1001,
      scale: 100,
    });
    expect(frameIndexTime(-30, { numerator: 30000, denominator: 1001 })).toEqual({
      value: -1001,
      scale: 1000,
    });
    expect(frameIndexTime(0, { numerator: 24, denominator: 1 })).toEqual({ value: 0, scale: 1 });
    expect(() => frameIndexTime(Number.MAX_SAFE_INTEGER, { numerator: 1, denominator: 2 })).toThrow(
      /exactly/,
    );
    expect(() => frameIndexTime(0.5, { numerator: 24, denominator: 1 })).toThrow(/integer/);
  });

  it("accepts zero resource references and rejects incompatible explicit caller limits", () => {
    const { bytes } = productionUniformFixtures()[0];
    const defaults = defaultFramePlanLimits();
    expect(
      decodeFramePlan(bytes, { ...defaults, max_resource_references: 0 }).metadata.resources,
    ).toEqual([]);
    for (const limits of [
      { ...defaults, max_container_bytes: 100, max_metadata_bytes: 101 },
      { ...defaults, max_blobs: 0x100000000 },
      { ...defaults, max_slices: 0 },
      { ...defaults, max_resource_references: -1 },
      { ...defaults, max_dimension: 16777217 },
      { ...defaults, max_pixels: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => decodeFramePlan(bytes, limits)).toThrow();
  });

  it("rejects header truncation, invalid magic/version/flags and inaccurate lengths", () => {
    const { bytes } = productionUniformFixtures()[0];
    for (let length = 0; length < 32; length += 1)
      expect(() => decodeFramePlan(bytes.subarray(0, length))).toThrow(/header/);
    for (const offset of [0, 4, 6, 8, 12, 16, 20, 24, 28]) {
      const changed = bytes.slice();
      changed[offset] ^= 1;
      expect(() => decodeFramePlan(changed)).toThrow();
    }
    expect(() => decodeFramePlan(bytes.subarray(0, bytes.length - 1))).toThrow(/length/);
    expect(() =>
      decodeFramePlan(bytes, {
        ...defaultFramePlanLimits(),
        max_container_bytes: bytes.length - 1,
        max_metadata_bytes: bytes.length - 1,
      }),
    ).toThrow(/limits/);
  });

  it("rejects unknown fields, unsafe integers, reduced-time violations and overlapping blobs", () => {
    const { bytes } = productionUniformFixtures()[1];
    const changes = [
      (metadata: Record<string, unknown>) => {
        metadata.unknown = true;
      },
      (metadata: Record<string, unknown>) => {
        metadata.renderer_plan_complete = true;
      },
      (metadata: Record<string, unknown>) => {
        (metadata.header as Record<string, unknown>).project_revision = Number.MAX_SAFE_INTEGER + 1;
      },
      (metadata: Record<string, unknown>) => {
        (metadata.header as Record<string, unknown>).time = { value: 2, scale: 2 };
      },
      (metadata: Record<string, unknown>) => {
        (metadata.header as Record<string, unknown>).composition_id = "bad\ud800";
      },
      (metadata: Record<string, unknown>) => {
        (metadata.blobs as { byte_offset: number }[])[1].byte_offset = 0;
      },
      (metadata: Record<string, unknown>) => {
        (metadata.slices as { blob_index: number }[])[1].blob_index = 0;
      },
      (metadata: Record<string, unknown>) => {
        metadata.resources = ["a".repeat(64), "a".repeat(64)];
      },
    ];
    for (const change of changes)
      expect(() => decodeFramePlan(rewriteMetadata(bytes, change))).toThrow();
  });

  it("requires canonical metadata and zero padding while enforcing the real 96-byte ABI", () => {
    const { bytes } = productionUniformFixtures()[0];
    const decoded = decodeFramePlan(bytes);
    const json = canonicalJson(decoded.metadata);
    const altered = bytes.slice();
    const start = new DataView(altered.buffer).getUint32(16, true);
    if (start > 32 + new TextEncoder().encode(json).length) {
      altered[start - 1] = 1;
      expect(() => decodeFramePlan(altered)).toThrow(/padding/);
    }
    for (const [lane, value] of [
      [0, 200],
      [2, Infinity],
      [16, 65],
      [17, 2],
      [19, 2],
      [23, -0],
    ]) {
      const changed = bytes.slice();
      new DataView(changed.buffer).setFloat32(start + lane * 4, value, true);
      expect(() => decodeFramePlan(changed)).toThrow(/uniform|ABI/);
    }
    expect(() => canonicalJson({ number: -0 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ number: 1.25 })).toThrow(/safe integers/);
    const duplicate = new TextEncoder().encode(
      json.replace('"plan_version":1', '"plan_version":1,"plan_version":1'),
    );
    const input = new Uint8Array(Math.ceil((32 + duplicate.length) / 16) * 16 + 96);
    input.set(bytes.subarray(0, 32));
    const header = new DataView(input.buffer);
    header.setUint32(8, duplicate.length, true);
    header.setUint32(16, input.length - 96, true);
    header.setUint32(20, input.length, true);
    input.set(duplicate, 32);
    input.set(decoded.blobs[0], input.length - 96);
    expect(() => decodeFramePlan(input)).toThrow(/canonical/);
  });
});
