import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAppPreferences } from "../src/desktop/preferences";
import { createDiagnosticBundle, writeDiagnosticBundle } from "./diagnostics";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic bundle", () => {
  it("exports bounded logs without project paths or future secret fields from preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-diagnostics-"));
    roots.push(root);
    const logFile = join(root, "aster.jsonl");
    await writeFile(
      logFile,
      `${JSON.stringify({ level: "error", event: "renderer_process_gone" })}\n`,
      "utf8",
    );
    const preferences = {
      ...defaultAppPreferences(),
      recentProjects: ["C:\\private\\project"],
      lastProjectPath: "C:\\private\\project",
    };
    const bundle = await createDiagnosticBundle({
      version: "0.2.0",
      platform: "win32",
      architecture: "x64",
      gpuFeatureStatus: { webgpu: "enabled" },
      gpuInfo: { auxAttributes: { initialized: true } },
      preferences,
      logFile,
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).toContain("renderer_process_gone");
    expect(serialized).not.toContain("private");
  });

  it("publishes the completed JSON document", async () => {
    const root = await mkdtemp(join(tmpdir(), "aster-diagnostics-"));
    roots.push(root);
    const destination = join(root, "report.aster-diagnostics.json");
    await writeDiagnosticBundle(destination, { schemaVersion: 1 });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ schemaVersion: 1 });
  });
});
