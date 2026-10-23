import { describe, expect, it } from "vitest";
import { rendererBoundary, resolveBundledDev } from "./vite.config";

it("rejects retained renderer modules in production and requires them in reference builds", () => {
  const run = (reference: boolean, modules: string[]) => {
    const hook = rendererBoundary(reference).generateBundle;
    if (typeof hook !== "function") throw new Error("Missing build boundary hook");
    const evidence: unknown[] = [];
    hook.call(
      {
        error: (message: string) => {
          throw new Error(message);
        },
        emitFile: (value: unknown) => evidence.push(value),
      } as never,
      {} as never,
      {
        entry: { type: "chunk", modules: Object.fromEntries(modules.map((path) => [path, {}])) },
      } as never,
      false,
    );
    return evidence;
  };
  const renderer = "/workspace/src/renderer/webgpu-renderer.ts";
  expect(() => run(false, [renderer])).toThrow("TS renderer entered production");
  expect(() => run(false, ["/workspace/src/components/render-host/RenderHost.tsx"])).toThrow(
    "TS renderer entered production",
  );
  expect(() => run(true, [])).toThrow("Reference renderer is absent");
  expect(run(false, ["/workspace/src/renderer/presentation/beauty-frame.ts"])).toHaveLength(1);
  expect(run(true, [renderer])).toHaveLength(1);
});

describe("resolveBundledDev", () => {
  it("enables full-bundle development by default", () => {
    expect(resolveBundledDev("serve", "development")).toBe(true);
    expect(resolveBundledDev("serve", "development", "")).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off"])(
    "disables full-bundle development for %s",
    (configuredValue) => {
      expect(resolveBundledDev("serve", "development", configuredValue)).toBe(false);
    },
  );

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "explicitly enables full-bundle development for %s",
    (configuredValue) => {
      expect(resolveBundledDev("serve", "development", configuredValue)).toBe(true);
    },
  );

  it("never enables the development experiment in other modes", () => {
    expect(resolveBundledDev("serve", "test", "true")).toBe(false);
    expect(resolveBundledDev("serve", "production", "true")).toBe(false);
    expect(resolveBundledDev("build", "development", "true")).toBe(false);
  });

  it("rejects mistyped switch values", () => {
    expect(() => resolveBundledDev("serve", "development", "disabled")).toThrow(
      "ASTER_BUNDLED_DEV must be one of",
    );
  });
});
