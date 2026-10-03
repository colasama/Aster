import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import productionManifest from "../../../shaders/manifest.json";
import { antiAliasingShader } from "../effects/anti-aliasing";
import { SharedShaderCatalog, sharedShaders } from "./shared-shader-catalog";

const manifest = {
  schema_version: 1,
  fragments: { "output-anti-aliasing": "effects/anti-aliasing.wgsl" },
  programs: { "output-anti-aliasing": productionManifest.programs["output-anti-aliasing"] },
};

describe("shared shader catalog", () => {
  it("preserves the pre-extraction production AA source and pipeline override values", () => {
    expect(createHash("sha256").update(antiAliasingShader).digest("hex")).toBe(
      "7ae357bfe93db1c985380b3bc2c473517593a706cc9ef9aac0fc8fbd05e3e86c",
    );
    expect(sharedShaders.pipelineConstants("output-anti-aliasing")).toEqual({ scale: 1 });
    for (const scale of [2, 4])
      expect(sharedShaders.pipelineConstants("output-anti-aliasing", { scale })).toEqual({ scale });
    for (const scale of [-1, 0.5, 0x1_0000_0000, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => sharedShaders.pipelineConstants("output-anti-aliasing", { scale })).toThrow();
    expect(() => sharedShaders.pipelineConstants("output-anti-aliasing", { missing: 2 })).toThrow();
  });

  it("keeps manifest fragment order and exact whitespace without implicit separators", () => {
    const recipe = {
      ...manifest,
      fragments: { first: "first.wgsl", second: "second.wgsl" },
      programs: {
        "output-anti-aliasing": {
          ...manifest.programs["output-anti-aliasing"],
          fragments: ["second", "first", "second"],
        },
      },
    };
    const catalog = new SharedShaderCatalog(recipe, {
      "first.wgsl": " first\n",
      "second.wgsl": "second",
    });
    expect(catalog.source("output-anti-aliasing")).toBe("second first\nsecond");
    expect(() => catalog.source("missing")).toThrow("Unknown shared shader program");
  });

  it("rejects missing fragments and invalid recipe or constant declarations", () => {
    const sources = { "effects/anti-aliasing.wgsl": antiAliasingShader };
    expect(() => new SharedShaderCatalog(manifest, {})).toThrow("fragment");
    const missing = structuredClone(manifest);
    missing.programs["output-anti-aliasing"].fragments.push("missing");
    expect(() => new SharedShaderCatalog(missing, sources)).toThrow("fragment");
    const invalid = structuredClone(manifest);
    invalid.programs["output-anti-aliasing"].overrides.scale.default = -1;
    expect(() => new SharedShaderCatalog(invalid, sources)).toThrow("override");
    expect(() => new SharedShaderCatalog({ ...manifest, schema_version: 2 }, sources)).toThrow();
  });

  it("rejects unknown manifest fields and undeclared or unsafe source paths", () => {
    const sources = { "effects/anti-aliasing.wgsl": antiAliasingShader };
    for (const target of ["manifest", "program", "entry", "override"]) {
      const recipe = structuredClone(manifest);
      const program = recipe.programs["output-anti-aliasing"];
      const object =
        target === "manifest"
          ? recipe
          : target === "program"
            ? program
            : target === "entry"
              ? program.entry_points[0]
              : program.overrides.scale;
      Object.assign(object, { unexpected: true });
      expect(() => new SharedShaderCatalog(recipe, sources)).toThrow();
    }
    expect(
      () => new SharedShaderCatalog(manifest, { ...sources, "extra.wgsl": antiAliasingShader }),
    ).toThrow("Undeclared");
    expect(
      () =>
        new SharedShaderCatalog(
          { ...manifest, fragments: { ...manifest.fragments, unused: "unused.wgsl" } },
          { ...sources, "unused.wgsl": "invalid WGSL" },
        ),
    ).toThrow("Unused");
    for (const path of ["/a.wgsl", "a//b.wgsl", "../a.wgsl", "./a.wgsl", "a\\b.wgsl", "C:a.wgsl"]) {
      const recipe = { ...manifest, fragments: { "output-anti-aliasing": path } };
      expect(() => new SharedShaderCatalog(recipe, { [path]: antiAliasingShader })).toThrow(
        "fragment",
      );
    }
  });

  it("inserts checked fixed integers in decimal without changing fragment boundaries", () => {
    const recipe = {
      schema_version: 1,
      constants: { count: 7 },
      fragments: { first: "first.wgsl", second: "second.wgsl" },
      programs: {
        helper: {
          fragments: ["first", { constant: "count" }, "second"],
          entry_points: [],
          overrides: {},
        },
      },
    };
    const sources = { "first.wgsl": " first ", "second.wgsl": "u\n" };
    for (const count of [0, 7, 0xffff_ffff]) {
      const catalog = new SharedShaderCatalog({ ...recipe, constants: { count } }, sources);
      expect(catalog.source("helper")).toBe(` first ${count}u\n`);
    }
    for (const count of [-1, 0.5, 0x1_0000_0000, Number.NaN])
      expect(() => new SharedShaderCatalog({ ...recipe, constants: { count } }, sources)).toThrow(
        "constant",
      );
    expect(() => new SharedShaderCatalog({ ...recipe, constants: {} }, sources)).toThrow("Unknown");
    expect(
      () => new SharedShaderCatalog({ ...recipe, constants: { count: 7, extra: 1 } }, sources),
    ).toThrow("Unused");
    Object.assign(recipe.programs.helper.fragments[1], { unexpected: true });
    expect(() => new SharedShaderCatalog(recipe, sources)).toThrow("recipe item");
  });
});
