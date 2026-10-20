import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { M0Evidence, sha256 } from "./m0-evidence.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditResourceCli(context, oraclePath, cli, execute = runStep) {
  const reader = new M0Evidence(context.root);
  const local = (p) => relative(context.root, p).replaceAll("\\", "/");
  const oracleFile = await reader.bytes(local(oraclePath));
  const oracle = JSON.parse(oracleFile.bytes);
  for (const source of oracle.sources)
    assert.equal((await reader.bytes(source.path)).sha256, source.sha256);
  const binary = await reader.bytes(local(cli));
  const output = join(context.output, "native-resource-cli");
  await mkdir(output, { recursive: true });
  const cases = oracle.cases.filter((c) =>
    [
      "minimal-golden",
      "owner-opening",
      "media-video",
      "recursive-raster-off",
      "recursive-raster-ssaa2x",
      "recursive-raster-ssaa4x",
    ].includes(c.id),
  );
  assert(cases.length >= 5);
  const results = [],
    steps = [];
  const command = async (id, project, request, expected = 0, extra = []) => {
    const step = await execute(
      {
        id: `native-resource-cli-${id}`,
        file: cli,
        args: ["prepare-resources", "--project", project, "--request", request, ...extra],
      },
      context,
    );
    steps.push(step);
    assert.equal(step.exit_code, expected, id);
    assert(!step.error && !step.signal, id);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    const records = log.split(/\r?\n/).filter((l) => l.startsWith("{"));
    assert.equal(records.length, 1, id);
    return JSON.parse(records[0]);
  };
  let base;
  for (const c of cases) {
    let project = c.project?.path;
    if (!project) {
      project = join(output, `${c.id}-project.json`);
      await writeAtomicJson(project, c.inline);
    }
    const raw = await readFile(project);
    if (c.project) assert.equal(sha256(raw), c.project.sha256);
    for (const index of [0, 1]) {
      const sample = c.samples[index];
      const request = { frame: sample.frame, context: { ...sample.context, layouts: c.layouts } };
      const path = join(output, `${c.id}-${index}.json`);
      await writeAtomicJson(path, request);
      const result = await command(`${c.id}-${index}`, project, path);
      assert.equal(result.kind, "native-project-resource-requests");
      assert.equal(result.projectSha256, sha256(raw));
      assert.equal(result.requestSha256, (await reader.bytes(local(path))).sha256);
      const { header, ...preparation } = result.preparation;
      assert.deepEqual(preparation, sample.expected);
      assert.equal(header.snapshot_scope, request.frame.snapshotScope);
      assert.equal(header.project_revision, request.frame.projectRevision);
      assert.deepEqual(header.target, request.frame.target);
      assert.deepEqual(header.render_target, request.frame.renderTarget);
      results.push({
        case: c.id,
        index,
        project_sha256: result.projectSha256,
        runtime_project_sha256: result.runtimeProjectSha256,
        request_sha256: result.requestSha256,
        operations: preparation.operations.length,
      });
      base ??= { project, request, path };
    }
  }
  for (const kind of [
    "scope",
    "revision",
    "extent",
    "aa",
    "raster-dimension",
    "raster-pixels",
    "unknown-plan",
    "input-budget",
  ]) {
    const request = structuredClone(base.request);
    if (kind === "scope") request.frame.snapshotScope = "";
    else if (kind === "revision") request.frame.projectRevision = Number.MAX_SAFE_INTEGER + 1;
    else if (kind === "extent") request.frame.renderTarget.width++;
    else if (kind === "aa") request.context.surface.renderScale = 2;
    else if (kind === "raster-dimension") request.context.maximumRasterDimension = 0;
    else if (kind === "raster-pixels") request.context.maximumRasterPixels = 0;
    else if (kind === "unknown-plan") request.scenePlan = {};
    const path = join(output, `reject-${kind}.json`);
    await writeAtomicJson(path, request);
    const result = await command(
      `reject-${kind}`,
      base.project,
      path,
      2,
      kind === "input-budget" ? ["--max-input-bytes", "32"] : [],
    );
    assert.equal(typeof result.error, "string");
  }
  return {
    status: "passed",
    scope: "native-resource-request-cli",
    oracle: { path: local(oraclePath), sha256: oracleFile.sha256 },
    binary: { path: local(cli), sha256: binary.sha256 },
    results,
    steps,
    checked_files: await reader.stable(),
  };
}
