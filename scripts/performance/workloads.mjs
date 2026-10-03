import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { writeAtomicJson } from "../migration/report.mjs";
import { captureAssignments } from "../parity/provenance.mjs";

export const outputModes = ["readback-only", "ipc-no-encode", "full-mp4"];

export async function prepareWorkloads(root, env = process.env) {
  let owner;
  try {
    if (env.ASTER_PERF_PROJECT)
      owner = JSON.parse(await readFile(join(env.ASTER_PERF_PROJECT, "project.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const server = await createServer({
    configFile: false,
    root,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: { ignored: ["**/artifacts/**"] } },
    appType: "custom",
  });
  try {
    const { performanceFixtures } = await server.ssrLoadModule("/scripts/performance/workloads.ts");
    const { ownerCases } = await server.ssrLoadModule("/tests/parity/external-cases.ts");
    const generated = performanceFixtures();
    for (const item of generated)
      await writeAtomicJson(join(root, item.case.project), item.project);
    const external = ownerCases(owner);
    const opening = external.find((item) => item.id === "owner-opening");
    opening.frames = Array.from(
      { length: Math.max(...opening.frames) - Math.min(...opening.frames) + 1 },
      (_, index) => Math.min(...opening.frames) + index,
    );
    const assignments = await captureAssignments(
      root,
      [...external, ...generated.map((item) => item.case)],
      env,
    );
    for (const assignment of assignments) {
      const project =
        assignment.case.project === "env:ASTER_PERF_PROJECT"
          ? owner
          : generated.find((item) => item.case.id === assignment.case.id).project;
      assignment.frameRate =
        project?.compositions.find((item) => item.id === assignment.case.composition)?.frameRate ??
        null;
    }
    return assignments;
  } finally {
    await server.close();
  }
}

/** Run a complete ten-frame warm-up suite first, then rotate mode and workload order. */
export function scheduleWorkloads(workloads, { selected = [], modes = [], smoke = false } = {}) {
  for (const id of selected)
    if (!workloads.some((item) => item.case.id === id)) throw new Error(`Unknown workload ${id}`);
  for (const mode of modes)
    if (!outputModes.includes(mode)) throw new Error(`Unknown output mode ${mode}`);
  const active = workloads.filter(
    (item) => selected.length === 0 || selected.includes(item.case.id),
  );
  const assignments = [];
  for (const run of smoke ? [1] : [0, 1, 2, 3]) {
    const ordered = run % 2 === 0 ? active : [...active].reverse();
    for (const item of ordered) {
      const supported = item.case.id.startsWith("owner-") ? outputModes : ["readback-only"];
      const filtered = supported.filter((mode) => modes.length === 0 || modes.includes(mode));
      const rotation = run % Math.max(1, filtered.length);
      const orderedModes = [...filtered.slice(rotation), ...filtered.slice(0, rotation)];
      for (const mode of orderedModes) {
        const startFrame = Math.min(...(item.frames ?? item.case.frames));
        const fullEnd = Math.max(...(item.frames ?? item.case.frames)) + 1;
        const endFrameExclusive = run === 0 || smoke ? Math.min(startFrame + 10, fullEnd) : fullEnd;
        assignments.push({
          ...item,
          benchmark: {
            id: `${item.case.id}-${mode}-${run}`,
            mode,
            requireAudio: mode === "full-mp4" && item.case.id.startsWith("owner-"),
            run,
            frameRate: item.frameRate,
            warmupFrames: 10,
            startFrame,
            endFrameExclusive,
          },
        });
      }
    }
  }
  if (assignments.length === 0) throw new Error("No performance workloads were selected");
  return assignments;
}
