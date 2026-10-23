import { describe, expect, it } from "vitest";
import { NativeRasterPayloads } from "./native-raster-payloads";

const hash = "a".repeat(64);
const file = `${hash}.bin`;
const item = (bytes?: Uint8Array) => ({ frame: {}, pixels: { message: { hash }, bytes } });

describe("resident raster payload transport", () => {
  it("requires Rust residency and prior-frame presence for descriptor references", () => {
    const cache = new NativeRasterPayloads(),
      full = { type: "put_resource", hash },
      reference = { type: "resident_resource", hash };
    expect(cache.knownResources([hash])).toEqual([]);
    expect(() => cache.prepareResources([reference], [hash])).toThrow(/not advertised/);
    cache.commit(new Map(), cache.prepareResources([full], []));
    expect(cache.knownResources([hash])).toEqual([hash]);
    expect(() => cache.prepareResources([reference], [])).toThrow(/not advertised/);
    cache.commit(new Map(), cache.prepareResources([reference], [hash]));
    expect(cache.knownResources([hash])).toEqual([hash]);
    cache.commit(new Map(), cache.prepareResources([], []));
    expect(cache.knownResources([hash])).toEqual([]);
    expect(() => cache.prepareResources([reference], [hash])).toThrow(/not advertised/);
    expect(() =>
      cache.prepareResources([{ type: "resident_resource", hash: "bad" }], []),
    ).toThrow();
  });
  it("omits bytes only for advertised identities and resends after eviction", () => {
    const cache = new NativeRasterPayloads();
    const first = cache.prepare([item(new Uint8Array([1, 2, 3, 4]))], [], 4);
    expect(first.payloads.size).toBe(1);
    expect(cache.known([file])).toEqual([]);
    cache.commit(first.identities);
    const resident = cache.prepare([item()], cache.known([file]), 4);
    expect(resident.payloads.size).toBe(0);
    expect(resident.pixels).toEqual(first.pixels);
    expect(() => cache.prepare([item()], [], 4)).toThrow(/not advertised/);
    cache.commit(cache.prepare([], [], 4).identities);
    expect(cache.known([file])).toEqual([]);
    expect(() => cache.prepare([item()], [file], 4)).toThrow(/not advertised/);
    expect(cache.prepare([item(new Uint8Array([1, 2, 3, 4]))], [], 4).payloads.size).toBe(1);
  });

  it("enforces the full byte budget and rejects content conflicts on cache hits", () => {
    const cache = new NativeRasterPayloads();
    cache.commit(cache.prepare([item(new Uint8Array([1, 2, 3, 4]))], [], 4).identities);
    expect(() => cache.prepare([item()], [file], 3)).toThrow(/budget/);
    expect(() => cache.prepare([item(new Uint8Array([4, 3, 2, 1]))], [file], 4)).toThrow(
      /Conflicting resident/,
    );
    expect(() =>
      cache.prepare([item(new Uint8Array([1])), item(new Uint8Array([2]))], [], 4),
    ).toThrow(/Conflicting raster/);
    expect(cache.prepare([item(), item()], [file], 4).identities.size).toBe(1);
  });
});
