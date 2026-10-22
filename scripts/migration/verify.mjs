import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { nativeReleaseBuild } from "../native-build.mjs";
import { runEffectShotSmoke } from "../parity/effect-shots.mjs";
import { runPixelGate } from "../parity/pixel-gate.mjs";
import { runAppChecks } from "./app-checks.mjs";
import { runIrGate } from "./ir-gate.mjs";
import { auditM0Exit } from "./m0-exit.mjs";
import { auditM1Exit } from "./m1-exit.mjs";
import { auditM2Exit } from "./m2-exit.mjs";
import { auditM3Exit } from "./m3-exit.mjs";
import { auditM4Exit } from "./m4-exit.mjs";
import { auditM5Exit } from "./m5-exit.mjs";
import { auditM6Exit } from "./m6-exit.mjs";
import { auditM7Exit } from "./m7-exit.mjs";
import { auditM8Exit } from "./m8-exit.mjs";
import { auditM9Exit } from "./m9-exit.mjs";
import { auditM10Exit } from "./m10-exit.mjs";
import { runNativeAppGate } from "./native-app-gate.mjs";
import { runNativeCoreGate } from "./native-core-gate.mjs";
import { runNativeExportGate } from "./native-export-gate.mjs";
import { runNativePerformanceGate } from "./native-performance-gate.mjs";
import { runNativeProjectCorpusGate } from "./native-project-corpus-gate.mjs";
import { runNativeProjectExportGate } from "./native-project-export-gate.mjs";
import { runNativeProjectGate } from "./native-project-gate.mjs";
import { runNativeProjectPixelGate } from "./native-project-pixel-gate.mjs";
import { runPerformanceGate } from "./performance-gate.mjs";
import { selectRequiredGates } from "./performance-policy.mjs";
import { runPreviewAppGate } from "./preview-app-gate.mjs";
import { runPreviewPerformanceGate } from "./preview-performance-gate.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { runSharedPreviewGate } from "./shared-preview-gate.mjs";
import { hashFile, ownerProject, sourceProvenance } from "./source.mjs";
import { staticCommands } from "./static-checks.mjs";
import { verifyTsPixels } from "./ts-pixels.mjs";

export function parseArguments(args) {
  const options = { quick: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--quick") options.quick = true;
    else if (args[index] === "--milestone" && /^M\d+$/.test(args[index + 1] ?? "")) {
      options.milestone = args[++index];
    } else if (args[index] === "--nv12-resume" && args[index + 1]) {
      options.nv12Resume = args[++index];
    } else if (args[index] === "--export-resume" && args[index + 1]) {
      options.exportResume = args[++index];
    } else if (args[index] === "--project-corpus-resume" && args[index + 1]) {
      options.projectCorpusResume = args[++index];
    } else if (args[index] === "--diagnostic-resume" && args[index + 1]) {
      options.diagnosticResume = args[++index];
    } else if (args[index] === "--candidates" && args[index + 1]) {
      options.candidates = args[++index];
    } else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  return options;
}

export async function runStaticGate(context, quick, execute) {
  const hook = await execute(
    { id: "lefthook-static", file: "pnpm", args: ["exec", "lefthook", "run", "migration-static"] },
    context,
  );
  const gate = { id: "G0", status: "failed", steps: [], hook };
  try {
    const results = JSON.parse(await readFile(join(context.output, "static-results.json"), "utf8"));
    gate.steps = results.steps;
    const expected = staticCommands();
    const complete =
      gate.steps.length === expected.length &&
      expected.every((command) => {
        const matching = gate.steps.filter((step) => step.id === command.id);
        const status = quick && !command.quick ? "skipped" : "passed";
        return matching.length === 1 && matching[0].status === status;
      });
    if (hook.status === "passed" && results.quick === quick && complete) {
      gate.status = quick ? "incomplete" : "passed";
    } else gate.error = "The lefthook run did not pass every requested static check";
  } catch (error) {
    gate.error = `Missing or invalid lefthook evidence: ${error.message}`;
  }
  gate.duration_ms = hook.duration_ms;
  return gate;
}

export async function verifyMigration(options, dependencies = {}) {
  const { root, quick = false } = options;
  const started = new Date();
  const runId = `${started.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = join(root, "artifacts", "migration", runId);
  const reportPath = join(root, "artifacts", "migration", `verify-${runId}.json`);
  const report = {
    schema_version: 1,
    run_id: runId,
    started_at: started.toISOString(),
    milestone: options.milestone ?? null,
    mode: quick ? "quick" : "full",
    status: "failed",
    required_gates_passed: false,
    milestone_exit_satisfied: false,
    milestone_exit_reason:
      "Gate execution does not establish corpus, baseline or self-review completion",
    gates: [],
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  };
  const execute = dependencies.execute ?? runStep;
  const provenance = dependencies.provenance ?? sourceProvenance;
  try {
    await mkdir(output, { recursive: true });
    const owner = await ownerProject(options.env ?? process.env);
    report.owner_performance_project = owner.report;
    report.source = await provenance(root);
    const ledger = JSON.parse(
      await readFile(join(root, "docs", "migration", "rust-renderer-progress.json"), "utf8"),
    );
    const milestone = options.milestone
      ? ledger.milestones.find((item) => item.id === options.milestone)
      : ledger.milestones.find((item) => item.status !== "done");
    if (!milestone) throw new Error("Requested milestone is missing from the migration ledger");
    report.milestone = milestone.id;
    if (milestone.id === "M2") {
      report.milestone_exit_reason =
        "IR transport gates do not establish complete production plan execution, replay or capture";
    }
    Object.assign(
      report,
      selectRequiredGates(milestone, ledger.owner_overrides?.performance_delivery_policy),
    );
    report.open_tasks = milestone.tasks
      .filter((task) => task.status !== "done")
      .map((task) => task.id);
    const context = {
      root,
      output,
      env: {
        ...owner.env,
        ASTER_MIGRATION_RUN_DIR: output,
        ASTER_MIGRATION_QUICK: quick ? "1" : "0",
      },
      print: options.print,
      milestone: milestone.id,
      exportResume: options.exportResume,
      projectCorpusResume: options.projectCorpusResume,
      diagnosticResume: options.diagnosticResume,
    };
    const gateOrder = [...report.required_gates];
    if (milestone.id === "M8" && gateOrder.includes("G5") && gateOrder.includes("G6")) {
      gateOrder.splice(gateOrder.indexOf("G6"), 1);
      gateOrder.splice(gateOrder.indexOf("G5"), 0, "G6");
    }
    let appEvidence;
    let projectCorpus;
    for (const id of gateOrder) {
      if (id === "G0") report.gates.push(await runStaticGate(context, quick, execute));
      else if (id === "G1" && milestone.id === "M9") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits native project and IR round trips",
              }
            : await (dependencies.runNativeProjectGate ?? runNativeProjectGate)(
                { ...context, output: join(output, "G1"), source: report.source },
                execute,
              ),
        );
      } else if (id === "G2" && milestone.id === "M9") {
        const gate = quick
          ? {
              id,
              status: "skipped",
              reason: "Quick mode omits complete native project plan evaluation",
            }
          : await (dependencies.runNativeProjectCorpusGate ?? runNativeProjectCorpusGate)(
              { ...context, output: join(output, "G2"), source: report.source },
              execute,
            );
        report.gates.push(gate);
        if (!quick && gate.status === "passed") {
          const path = join(output, "G2/report.json");
          projectCorpus = {
            path: relative(root, path).replaceAll("\\", "/"),
            sha256: await hashFile(path),
          };
        }
      } else if (id === "G3" && milestone.id === "M9") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits native project pixel comparisons" }
            : !projectCorpus
              ? {
                  id,
                  status: "failed",
                  error: "A passed current native project corpus run is required",
                }
              : await (dependencies.runNativeProjectPixelGate ?? runNativeProjectPixelGate)(
                  { ...context, output: join(output, "G3"), source: report.source, projectCorpus },
                  execute,
                ),
        );
      } else if (id === "G1" && ["M2", "M3", "M5"].includes(milestone.id)) {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits the full cross-language IR gate" }
            : await (dependencies.runIrGate ?? runIrGate)(
                { ...context, output: join(output, "G1"), source: report.source },
                execute,
              ),
        );
      } else if (id === "G4" && milestone.id === "M2") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits measured performance suites" }
            : await (dependencies.runPerformanceGate ?? runPerformanceGate)(
                {
                  ...context,
                  output: join(output, "G4"),
                  source: report.source,
                  milestone: milestone.id,
                },
                execute,
              ),
        );
      } else if (id === "G4" && milestone.id === "M11") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits paired editor preview measurement",
              }
            : await (dependencies.runPreviewPerformanceGate ?? runPreviewPerformanceGate)(
                { ...context, output: join(output, "G4"), source: report.source },
                execute,
              ),
        );
      } else if (id === "G4" && milestone.id === "M8") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits full native paired export measurements",
              }
            : await (dependencies.runNativePerformanceGate ?? runNativePerformanceGate)(
                { ...context, output: join(output, "G4"), source: report.source },
                execute,
              ),
        );
      } else if (id === "G3" && ["M1", "M2"].includes(milestone.id)) {
        const checked = await (dependencies.verifyTsPixels ?? verifyTsPixels)(
          {
            root,
            candidates:
              options.candidates ??
              milestone.active_candidate_manifest ??
              "artifacts/parity/candidate/manifest.json",
            milestone: milestone.id,
            env: context.env,
            print: options.print,
          },
          {
            execute,
            provenance,
            rendererSource: dependencies.rendererSource,
            runPixelGate: dependencies.runPixelGate,
          },
        );
        report.gates.push({
          ...checked.report.gate,
          id: "G3",
          status:
            checked.report.status === "passed" && checked.exitCode === 0 ? "passed" : "failed",
          build: checked.report.build,
          ts_verification: relative(root, checked.reportPath).replaceAll("\\", "/"),
          error: checked.report.error,
          source_unchanged: checked.report.source_unchanged,
          candidate_capture: checked.report.candidate_capture,
          raster_resources: checked.report.raster_resources,
          frame_artifacts: checked.report.frame_artifacts,
          temporal_text: checked.report.temporal_text,
          encoded_textures: checked.report.encoded_textures,
          material_draws: checked.report.material_draws,
          lut_draws: checked.report.lut_draws,
          root_scenes: checked.report.root_scenes,
          generators: checked.report.generators,
          precompositions: checked.report.precompositions,
          auxiliary: checked.report.auxiliary,
          auxiliary_generators: checked.report.auxiliary_generators,
          output_replay: checked.report.output_replay,
          duration_ms: checked.report.duration_ms,
        });
      } else if (
        id === "G3" &&
        ["M3", "M4", "M5", "M6", "M7", "M8", "M10"].includes(milestone.id)
      ) {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits native core GPU execution" }
            : await (dependencies.runNativeCoreGate ?? runNativeCoreGate)(
                { ...context, output: join(output, "G3"), nv12Resume: options.nv12Resume },
                execute,
              ),
        );
        report.milestone_exit_reason =
          milestone.id === "M10"
            ? "Native text requires production routing, per-glyph layout parity and reviewed text pixels"
            : milestone.id === "M8"
              ? "Native export requires NV12 pixels, encoded quality, paired performance and application delivery"
              : milestone.id === "M7"
                ? "Native scene completion requires the full M7 exit audit"
                : milestone.id === "M6"
                  ? "Native media completion requires the full M6 exit audit"
                  : milestone.id === "M5"
                    ? "Native raster increments require temporal text and the complete M5 exit audit"
                    : milestone.id === "M4"
                      ? "Native effect increments require the complete effect/style corpus and M4 exit audit"
                      : "Native core increments require the complete core corpus and M3 exit audit";
      } else if (id === "G3" && milestone.id === "M11") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits shared preview GPU qualification" }
            : await (dependencies.runSharedPreviewGate ?? runSharedPreviewGate)(
                { ...context, output: join(output, "G3"), source: report.source },
                execute,
              ),
        );
        report.milestone_exit_reason =
          "Native preview requires project pixels, editor lifecycle, paired FPS and input-to-present latency";
      } else if (id === "G3") {
        const pixelContext = { ...context, output: join(output, "G3") };
        const build = await execute(nativeReleaseBuild("compare-cli-build"), pixelContext);
        if (build.status !== "passed") {
          report.gates.push({
            id,
            status: "failed",
            error: "Pixel comparison CLI build failed",
            build,
          });
        } else {
          report.gates.push({
            ...(await (dependencies.runPixelGate ?? runPixelGate)(
              pixelContext,
              {
                manifestPath:
                  options.candidates ?? join(root, "artifacts/parity/candidate/manifest.json"),
                scope: "full",
                profileOverride: ["M1", "M2"].includes(milestone.id) ? "exact" : null,
              },
              execute,
            )),
            build,
          });
        }
      } else if (id === "G5" && milestone.id === "M9") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits native project headless export coverage",
                native_export_acceptance: false,
              }
            : !projectCorpus
              ? {
                  id,
                  status: "failed",
                  error:
                    "Complete current native project plan parity is required before full export acceptance",
                  native_export_acceptance: false,
                }
              : await (dependencies.runNativeProjectExportGate ?? runNativeProjectExportGate)({
                  ...context,
                  output: join(output, "G5"),
                  source: report.source,
                }),
        );
      } else if (id === "G5" && milestone.id === "M8") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits native export quality and coverage checks",
                native_export_acceptance: false,
              }
            : await (dependencies.runNativeExportGate ?? runNativeExportGate)(
                { ...context, output: join(output, "G5"), source: report.source, appEvidence },
                execute,
              ),
        );
      } else if (id === "G6" && milestone.id === "M8") {
        report.gates.push(
          quick
            ? {
                id,
                status: "skipped",
                reason: "Quick mode omits packaged native application checks",
              }
            : await (dependencies.runNativeAppGate ?? runNativeAppGate)(
                { ...context, output: join(output, "G6") },
                execute,
              ),
        );
      } else if (id === "G6" && milestone.id === "M11") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode omits live native editor checks" }
            : await (dependencies.runPreviewAppGate ?? runPreviewAppGate)(
                {
                  ...context,
                  output: join(output, "G6"),
                  source: report.source,
                  previewPerformance: report.gates.find((gate) => gate.id === "G4"),
                  previewPerformancePath: join(output, "G4/report.json"),
                },
                execute,
              ),
        );
      } else if (id === "G6" && milestone.id === "M0") {
        report.gates.push(
          quick
            ? { id, status: "skipped", reason: "Quick mode does not build or smoke-test the app" }
            : await (dependencies.runAppChecks ?? runAppChecks)(context, execute),
        );
      } else report.gates.push({ id, status: "failed", error: "Required gate is not implemented" });
      if (id === "G6" && milestone.id === "M8" && !quick) {
        const path = join(output, "G6/report.json");
        appEvidence = { path, sha256: await hashFile(path) };
      }
    }
    report.gates.sort(
      (a, b) => report.required_gates.indexOf(a.id) - report.required_gates.indexOf(b.id),
    );
    if (
      report.gates.length !== report.required_gates.length ||
      report.required_gates.some((id) => report.gates.filter((gate) => gate.id === id).length !== 1)
    ) {
      throw new Error("Gate results must cover every required gate exactly once");
    }
    const exitTask = milestone.tasks.find((task) => task.id === "M0-T6");
    if (
      milestone.id === "M0" &&
      !quick &&
      (milestone.status === "done" ||
        exitTask?.status === "in_progress" ||
        exitTask?.status === "done" ||
        exitTask?.exit_evidence)
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM0Exit ?? auditM0Exit)(root);
        if (report.milestone_exit.status !== "passed") {
          throw new Error("M0 exit audit did not pass");
        }
        report.milestone_exit_reason = "Corpus, pixel oracle, TS exact parity and baseline audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const shaderExit = milestone.tasks.find((task) => task.id === "M1-T6");
    if (
      milestone.id === "M1" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(shaderExit?.status))
    ) {
      try {
        if (report.gates.some((gate) => gate.status !== "passed"))
          throw new Error("M1 exit requires current full G0 and exact G3");
        report.native_effect_shots = await (dependencies.runEffectShotSmoke ?? runEffectShotSmoke)(
          { ...context, output: join(output, "native-effect-shots") },
          execute,
        );
        if (report.native_effect_shots.status !== "passed")
          throw new Error("Native shared-effect shader smoke did not pass");
        report.milestone_exit = await (dependencies.auditM1Exit ?? auditM1Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M1 shared-shader exit audit did not pass");
        report.milestone_exit_reason =
          "Shared-source coverage, Naga, current TS exact parity and native effect shader smoke audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const planExit = milestone.tasks.find((task) => task.id === "M2-T15");
    if (
      milestone.id === "M2" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(planExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM2Exit ?? auditM2Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M2 complete-frame exit audit did not pass");
        report.milestone_exit_reason =
          "Complete submitted plans, resource lifetimes, exact Rust transport and independent TS replay audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const coreExit = milestone.tasks.find((task) => task.id === "M3-T5");
    if (
      milestone.id === "M3" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(coreExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM3Exit ?? auditM3Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M3 native core audit failed");
        report.milestone_exit_reason =
          "All core frames, native still decode, HDR samples and GPU cache lifetimes audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const effectsExit = milestone.tasks.find((task) => task.id === "M4-T6");
    if (
      milestone.id === "M4" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(effectsExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM4Exit ?? auditM4Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M4 native effects audit failed");
        report.milestone_exit_reason =
          "Every effect/style frame, surface output, native optimization and rejected SSAA strategy audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const rasterExit = milestone.tasks.find((task) => task.id === "M5-T4");
    if (
      milestone.id === "M5" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(rasterExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM5Exit ?? auditM5Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M5 native raster audit failed");
        report.milestone_exit_reason =
          "Supplied rasters, temporal GPU execution, root motion output and IR resource lifetimes audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const mediaExit = milestone.tasks.find((task) => task.id === "M6-T4");
    if (
      milestone.id === "M6" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(mediaExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM6Exit ?? auditM6Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M6 native media audit failed");
        report.milestone_exit_reason =
          "Exact sequence/video identities, mixed frames, authorization and bounded decode lifetimes audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const sceneExit = milestone.tasks.find((task) => task.id === "M7-T6");
    if (
      milestone.id === "M7" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(sceneExit?.status))
    ) {
      try {
        report.milestone_exit = await (dependencies.auditM7Exit ?? auditM7Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M7 native scene audit failed");
        report.milestone_exit_reason =
          "Complete scene/generator coverage, frozen pixels, self-reviews and resource lifetimes audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const exportExit = milestone.tasks.find((task) => task.id === "M8-T8");
    if (
      milestone.id === "M8" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(exportExit?.status))
    ) {
      try {
        if (report.gates.some((gate) => gate.status !== "passed"))
          throw new Error("M8 exit requires every current full gate");
        report.milestone_exit = await (dependencies.auditM8Exit ?? auditM8Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M8 native export audit failed");
        report.milestone_exit_reason =
          "Native RGB/NV12, hardware delivery, reviewed encoded quality and paired export performance audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const evaluationExit = milestone.tasks.find((task) => task.id === "M9-T20");
    if (
      milestone.id === "M9" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(evaluationExit?.status))
    ) {
      try {
        if (report.gates.some((gate) => gate.status !== "passed"))
          throw new Error("M9 exit requires every current full gate");
        report.milestone_exit = await (dependencies.auditM9Exit ?? auditM9Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M9 native evaluation and headless export audit failed");
        report.milestone_exit_reason =
          "Complete project-origin evaluation, random-time plans, reviewed pixels and headless exports audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    const textExit = milestone.tasks.find((task) => task.id === "M10-T8");
    if (
      milestone.id === "M10" &&
      !quick &&
      (milestone.status === "done" || ["in_progress", "done"].includes(textExit?.status))
    ) {
      try {
        if (report.gates.some((gate) => gate.status !== "passed"))
          throw new Error("M10 exit requires every current full gate");
        report.milestone_exit = await (dependencies.auditM10Exit ?? auditM10Exit)(root, report);
        if (report.milestone_exit.status !== "passed")
          throw new Error("M10 native text audit failed");
        report.milestone_exit_reason =
          "Complete text routing, per-glyph layout, physical fonts and reviewed production pixels audited";
      } catch (error) {
        report.milestone_exit = { status: "failed", error: error.message };
        report.milestone_exit_reason = error.message;
      }
    }
    report.source_after = await provenance(root);
    report.source_unchanged = report.source.source_sha256 === report.source_after.source_sha256;
    if (!report.source_unchanged) throw new Error("Source changed during verification; run again");
    const failed =
      report.gates.some((gate) => gate.status === "failed") ||
      report.milestone_exit?.status === "failed";
    report.required_gates_passed = !quick && report.gates.every((gate) => gate.status === "passed");
    report.milestone_exit_satisfied =
      report.required_gates_passed && report.milestone_exit?.status === "passed";
    report.status = failed ? "failed" : report.required_gates_passed ? "passed" : "incomplete";
  } catch (error) {
    report.error = error.stack ?? error.message;
  }
  report.finished_at = new Date().toISOString();
  report.duration_ms = Date.now() - started.getTime();
  await writeAtomicJson(reportPath, report);
  options.print?.(
    [
      `${report.milestone ?? "unknown"} ${report.mode}: ${report.status}`,
      ...report.gates.map(
        (gate) => `  ${gate.id}: ${gate.status}${gate.error ? ` — ${gate.error}` : ""}`,
      ),
      ...(report.optional_gates ?? []).map(
        (gate) => `  ${gate.id}: ${gate.status} — ${gate.reason}`,
      ),
      `Full required gates: ${report.required_gates_passed ? "passed" : "not satisfied"}`,
      `Milestone exit: ${report.milestone_exit_satisfied ? "passed" : report.milestone_exit_reason}`,
      `Report: ${relative(root, reportPath)}`,
    ].join("\n"),
  );
  return {
    report,
    reportPath,
    exitCode: report.status === "failed" || (!quick && !report.required_gates_passed) ? 1 : 0,
  };
}
