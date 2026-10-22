// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { freezePreviewPlugins } from "./native-preview-plugins";

const directories: string[] = [];
const reference = { pluginId: "com.example.cloud", nodeType: "cloud" };
const document = { compositions: [{ layers: [{ kind: "generator", generator: reference }] }] };
const packageValue = () => ({
  ...reference,
  manifestToml: "frozen manifest",
  shaderSources: { "shaders/draw.wgsl": "frozen shader" },
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "aster-preview-plugin-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const path of directories.splice(0)) {
    expect(dirname(resolve(path))).toBe(resolve(tmpdir()));
    expect(path).toContain("aster-preview-plugin-test-");
    await rm(path, { recursive: true, force: true });
  }
});

test("freezes admitted content and changes identity without overwriting earlier packages", async () => {
  const root = await directory();
  const value = packageValue();
  const admitted = vi.fn(async () => ({ packages: [value], unavailable: [] }));
  const first = await freezePreviewPlugins(root, document, admitted);
  expect(admitted).toHaveBeenCalledWith([reference]);
  expect(await readFile(first.plugins[0], "utf8")).toBe(value.manifestToml);
  const repeated = await freezePreviewPlugins(root, document, admitted);
  expect(repeated).toEqual(first);
  value.shaderSources["shaders/draw.wgsl"] = "updated shader";
  const updated = await freezePreviewPlugins(root, document, admitted);
  expect(updated.identity).not.toBe(first.identity);
  expect(updated.plugins[0]).not.toBe(first.plugins[0]);
  expect(await readFile(join(dirname(first.plugins[0]), "shaders/draw.wgsl"), "utf8")).toBe(
    "frozen shader",
  );
});

test("binds disabled and missing identities without executable packages", async () => {
  const root = await directory();
  const disabled = await freezePreviewPlugins(root, document, async () => ({
    packages: [],
    unavailable: [{ ...reference, reason: "disabled" }],
  }));
  const missing = await freezePreviewPlugins(root, document, async () => ({
    packages: [],
    unavailable: [{ ...reference, reason: "missing" }],
  }));
  expect(disabled.plugins).toEqual([]);
  expect(disabled.unavailableGenerators).toEqual([{ ...reference, reason: "disabled" }]);
  expect(missing.identity).not.toBe(disabled.identity);
  await expect(freezePreviewPlugins(root, document)).rejects.toThrow(
    "Trusted preview plugin service",
  );
});

test("rejects incomplete, unrequested and duplicate bridge classifications", async () => {
  const root = await directory();
  for (const response of [
    { packages: [], unavailable: [] },
    { packages: [{ ...packageValue(), pluginId: "com.example.other" }], unavailable: [] },
    { packages: [packageValue()], unavailable: [{ ...reference, reason: "missing" }] },
    { packages: [], unavailable: [{ ...reference, reason: "unvalidated" }] },
  ])
    await expect(freezePreviewPlugins(root, document, async () => response)).rejects.toThrow();
});

test("rejects shader path escapes, aliases and mutated frozen files", async () => {
  const root = await directory();
  for (const path of [
    "../escape.wgsl",
    "C:/escape.wgsl",
    "/escape.wgsl",
    "sub/../escape.wgsl",
    "nul.wgsl",
    "sub./escape.wgsl",
  ]) {
    await expect(
      freezePreviewPlugins(root, document, async () => ({
        packages: [{ ...packageValue(), shaderSources: { [path]: "shader" } }],
        unavailable: [],
      })),
    ).rejects.toThrow("relative");
  }
  await expect(
    freezePreviewPlugins(root, document, async () => ({
      packages: [{ ...packageValue(), shaderSources: { "draw.wgsl": "one", "DRAW.wgsl": "two" } }],
      unavailable: [],
    })),
  ).rejects.toThrow("alias");
  const response = { packages: [packageValue()], unavailable: [] };
  const frozen = await freezePreviewPlugins(root, document, async () => response);
  await writeFile(frozen.plugins[0], "tampered manifest");
  await expect(freezePreviewPlugins(root, document, async () => response)).rejects.toThrow(
    "changed",
  );
});

test("built-in generators do not request external grants", async () => {
  const root = await directory();
  const admitted = vi.fn();
  const result = await freezePreviewPlugins(
    root,
    {
      compositions: [
        {
          layers: [
            {
              kind: "generator",
              generator: { pluginId: "org.aster.builtin.particles", nodeType: "particles" },
            },
          ],
        },
      ],
    },
    admitted,
  );
  expect(result).toEqual({ plugins: [], unavailableGenerators: [] });
  expect(admitted).not.toHaveBeenCalled();
});
