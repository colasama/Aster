import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashFile } from "./source.mjs";

export function appCommands(output) {
  const packaged = join(output, "package");
  const binary = join(packaged, "win-unpacked", "Aster.exe");
  return [
    { id: "app-build", file: "pnpm", args: ["build"] },
    {
      id: "app-mcp-build",
      file: "cargo",
      args: ["build", "--release", "-p", "aster-desktop-bridge", "--bin", "aster-mcp"],
    },
    {
      id: "app-package",
      file: "pnpm",
      args: [
        "exec",
        "electron-builder",
        "--config",
        "scripts/electron-builder.ts",
        "--dir",
        "--publish",
        "never",
        `--config.directories.output=${packaged}`,
      ],
    },
    ...[false, true].map((background) => ({
      id: background ? "app-background" : "app-foreground",
      file: "node",
      args: ["scripts/automation-smoke.mjs", binary, ...(background ? ["--background"] : [])],
      env: { ASTER_SMOKE_OUTPUT: join(output, background ? "background" : "foreground") },
      timeout_ms: 900_000,
    })),
  ];
}

export async function runAppChecks(context, execute, platform = process.platform) {
  const started = Date.now();
  const gate = { id: "G6", status: "failed", steps: [], evidence: {} };
  try {
    if (platform !== "win32") {
      throw new Error("G6 currently requires the primary Windows machine");
    }
    const ffmpeg = {};
    for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
      ffmpeg[name] = await hashFile(join(context.root, "build", "ffmpeg", name));
    }
    gate.evidence.source_ffmpeg_sha256 = ffmpeg;
    for (const command of appCommands(context.output)) {
      const step = await execute(command, context);
      gate.steps.push(step);
      if (step.status !== "passed") return gate;
      if (command.id === "app-package") {
        const bin = join(context.output, "package", "win-unpacked", "resources", "bin");
        for (const [name, expected] of Object.entries(ffmpeg)) {
          if ((await hashFile(join(bin, name))) !== expected) {
            throw new Error(`Packaged ${name} does not match the existing build/ffmpeg binary`);
          }
        }
        gate.evidence.ffmpeg_preserved = true;
        gate.evidence.packaged_binaries_sha256 = {};
        for (const name of ["aster-desktop-bridge.exe", "aster-mcp.exe"]) {
          gate.evidence.packaged_binaries_sha256[name] = await hashFile(join(bin, name));
        }
      }
      if (command.id === "app-foreground" || command.id === "app-background") {
        const reportPath = join(command.env.ASTER_SMOKE_OUTPUT, "report.json");
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        const background = command.id === "app-background";
        if (
          report.status !== "passed" ||
          report.background !== background ||
          report.binary !== command.args[1] ||
          !report.preview?.length ||
          report.render_job?.status !== "completed" ||
          !report.render_job?.id
        ) {
          throw new Error(`Incomplete smoke evidence in ${reportPath}`);
        }
        gate.evidence[background ? "background" : "foreground"] = {
          report: relative(context.root, reportPath).replaceAll("\\", "/"),
          preview: report.preview,
          preview_attempts: report.preview_attempts,
          render_job: report.render_job,
        };
      }
    }
    gate.status = "passed";
  } catch (error) {
    gate.error = error.message;
  } finally {
    gate.duration_ms = Date.now() - started;
  }
  return gate;
}
