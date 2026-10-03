import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBlankProject } from "../core/project/project";
import type { FootageSource, Layer, Project } from "../core/types";
import {
  resetRasterImagePrefetch,
  takePrefetchedRasterImage,
  warmProjectRasterSources,
} from "./raster-image-prefetch";

vi.mock("./raster-image-decoder", () => ({
  decodeRasterImage: async () => ({ close: vi.fn() }),
}));

let requested: string[];
let release: Map<string, () => void>;

function still(index: number): FootageSource {
  return {
    id: `still-${index}`,
    kind: "still",
    name: `still-${index}.png`,
    mimeType: "image/png",
    width: 4,
    height: 4,
    contentIdentity: `sha256:${index}`,
    runtimeUrl: `aster-asset://still-${index}.png`,
    interpretation: { alpha: "straight", colorSpace: "srgb" },
  } as FootageSource;
}

function projectWith(count: number, inPoints: Record<number, number> = {}): Project {
  const project = createBlankProject();
  project.sources = Array.from({ length: count }, (_, index) => still(index));
  project.compositions[0].layers = Object.entries(inPoints).map(
    ([index, inPoint]) => ({ id: `layer-${index}`, sourceId: `still-${index}`, inPoint }) as Layer,
  );
  return project;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Completes every request, including ones the pool starts as earlier ones finish. */
async function drain() {
  for (let round = 0; round < 64 && release.size > 0; round++) {
    const pending = [...release.values()];
    release.clear();
    for (const resolve of pending) resolve();
    await flush();
    await flush();
  }
}

beforeEach(() => {
  resetRasterImagePrefetch();
  requested = [];
  release = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (locator: string) =>
        new Promise((resolve) => {
          requested.push(locator);
          release.set(locator, () => resolve({ ok: true, blob: async () => new Blob() }));
        }),
    ),
  );
});

afterEach(() => {
  resetRasterImagePrefetch();
  vi.unstubAllGlobals();
});

it("warms the earliest-used stills first and never more than the cache holds", async () => {
  const project = projectWith(30, { 29: 0.5, 7: 2 });
  warmProjectRasterSources(project);
  await flush();
  expect(requested).toEqual(["aster-asset://still-29.png", "aster-asset://still-7.png"]);
  await drain();
  expect(requested).toHaveLength(24);
  expect(new Set(requested).size).toBe(24);
});

it("does not queue evicted or consumed stills again on later renders", async () => {
  const project = projectWith(3);
  warmProjectRasterSources(project);
  await flush();
  await drain();
  const consumed = takePrefetchedRasterImage("aster-asset://still-0.png");
  expect(consumed).toBeDefined();
  for (let render = 0; render < 10; render++) warmProjectRasterSources(project);
  await flush();
  expect(requested).toHaveLength(3);
});

it("hands a queued warm back to the renderer instead of making it wait", async () => {
  const project = projectWith(3);
  warmProjectRasterSources(project);
  await flush();
  expect(requested).toEqual(["aster-asset://still-0.png", "aster-asset://still-1.png"]);
  expect(takePrefetchedRasterImage("aster-asset://still-2.png")).toBeUndefined();
  expect(takePrefetchedRasterImage("aster-asset://still-0.png")).toBeDefined();
  await drain();
  expect(requested).not.toContain("aster-asset://still-2.png");
});
