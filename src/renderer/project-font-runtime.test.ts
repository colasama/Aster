// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

const original = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(() => {
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(document, "fonts", original);
  else Reflect.deleteProperty(document, "fonts");
});

it("shares decoded faces across snapshots and invalidates text when activation changes", async () => {
  const fontSet = new Set<object>();
  Object.defineProperty(document, "fonts", { configurable: true, value: fontSet });
  const loaded = vi.fn(async function (this: object) {
    return this;
  });
  vi.stubGlobal(
    "FontFace",
    class {
      load = loaded;
    },
  );
  const { prepareProjectFonts, activateProjectFonts, projectFontRevision } = await import(
    "../core/project-font-runtime"
  );
  const project = {
    fonts: [
      {
        id: crypto.randomUUID(),
        name: "Example.ttf",
        family: "Example",
        weight: 400,
        dataUrl: "data:font/ttf;base64,AAEAAA==",
      },
    ],
  };
  const copied = structuredClone(project);
  expect(() => activateProjectFonts(project)).toThrow("loading");
  await Promise.all([prepareProjectFonts(project), prepareProjectFonts(copied)]);
  expect(loaded).toHaveBeenCalledTimes(1);
  activateProjectFonts(project);
  const revision = projectFontRevision();
  activateProjectFonts(copied);
  expect(projectFontRevision()).toBe(revision);
  expect(fontSet.size).toBe(1);
  const applicationFont = {};
  fontSet.add(applicationFont);
  activateProjectFonts({});
  expect(fontSet).toEqual(new Set([applicationFont]));
  expect(projectFontRevision()).toBe(revision + 1);
});
