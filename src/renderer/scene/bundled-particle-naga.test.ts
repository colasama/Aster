/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bundledParticleDefinition, bundledParticleManifest } from "./bundled-particle-generator";

describe("bundled particle WGSL conformance", () => {
  it("passes the same Rust/Naga and ABI validator used for installed generators", () => {
    const result = spawnSync(
      process.platform === "win32" ? "cargo.exe" : "cargo",
      ["run", "--quiet", "-p", "aster-plugin", "--bin", "aster-plugin-validate-scene-generator"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          manifest: bundledParticleManifest,
          shader_sources: bundledParticleDefinition.shaderSources,
        }),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);
});
