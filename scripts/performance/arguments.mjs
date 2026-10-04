import assert from "node:assert/strict";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export function parsePerformanceArguments(args, root) {
  const options = {
    selected: [],
    modes: [],
    smoke: false,
    suite: "throughput",
    reportPath: null,
    referenceBundle: false,
    hardwareManifest: "benchmarks/hardware/windows-radeon780m-local.json",
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--smoke" || key === "--reference-bundle") {
      assert(!seen.has(key), `Duplicate ${key} argument`);
      if (key === "--smoke") options.smoke = true;
      else options.referenceBundle = true;
    } else if (["--case", "--mode", "--suite", "--report", "--hardware-manifest"].includes(key)) {
      const value = args[++index];
      assert(value && !value.startsWith("--"), `Missing value for ${key}`);
      if (key === "--case") options.selected.push(value);
      else if (key === "--mode") options.modes.push(value);
      else {
        assert(!seen.has(key), `Duplicate ${key} argument`);
        if (key === "--suite") options.suite = value;
        else if (key === "--hardware-manifest") {
          assert(
            [
              "benchmarks/hardware/windows-radeon780m-local.json",
              "benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json",
            ].includes(value),
            "Unknown performance hardware series",
          );
          options.hardwareManifest = value;
        } else {
          const path = resolve(root, value);
          const member = relative(resolve(root), path).replaceAll("\\", "/");
          assert(
            member.startsWith("artifacts/") && !member.split("/").includes(".."),
            "Performance report must be a fresh path under artifacts",
          );
          options.reportPath = path;
        }
      }
    } else throw new Error(`Unknown benchmark argument: ${key}`);
    seen.add(key);
  }
  assert(["throughput", "preview"].includes(options.suite), "Unknown performance suite");
  assert(
    options.suite !== "preview" || options.modes.length === 0,
    "Preview has one fixed present mode",
  );
  assert(
    !options.referenceBundle ||
      (!options.smoke && options.selected.length === 0 && options.modes.length === 0),
    "Historical reference requires a complete suite",
  );
  return options;
}

export async function reservePerformanceReport(path) {
  if (!path) return null;
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(`${path}.lock`, "wx");
  try {
    const exists = await lstat(path).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    assert(!exists, "Requested performance report already exists");
    return async () => {
      await lock.close();
      await rm(`${path}.lock`);
    };
  } catch (error) {
    await lock.close();
    await rm(`${path}.lock`);
    throw error;
  }
}
