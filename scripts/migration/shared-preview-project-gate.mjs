import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import electron from "electron";
import { decodeRgbaPng } from "../parity/png.mjs";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

/** Independent frozen projects exercise native evaluation and drained snapshot replacement. */
export async function runSharedPreviewProject(context, execute, reader, manifest, base, binary) {
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const output = join(context.output, "project");
  await mkdir(output);
  const projects = new Map();
  for (const id of ["shape-rectangle", "shape-ellipse"]) {
    const item = manifest.cases.find((entry) => entry.case_id === id);
    assert(item, "Frozen preview project missing");
    const capture = await reader.json(`${base}/${item.path}`, item.capture_sha256);
    assert.equal(capture.source_verified, true);
    assert.equal(capture.case_id, id);
    const project = capture.inputs.case.project;
    const document = await reader.json(project, capture.inputs.project_sha256);
    assert.equal(document.activeCompositionId, capture.inputs.case.composition);
    projects.set(id, { project, capture });
  }
  const samples = [],
    requests = [];
  const frameNumbers = [0, 59, 15, 30, 0, 30, 15, 59, 30, 15, 0, 59];
  let initial;
  for (let index = 0; index < frameNumbers.length; index++) {
    const id = index >= 6 && index < 9 ? "shape-ellipse" : "shape-rectangle";
    const { project, capture } = projects.get(id);
    const frame = manifest.frames.find(
      (entry) => entry.case_id === id && entry.frame === frameNumbers[index],
    );
    assert(frame, "Frozen preview frame missing");
    const meta = await reader.json(`${base}/${frame.meta_path}`, frame.meta_sha256);
    const reference = await reader.bytes(`${base}/${frame.path}`, frame.png_sha256);
    const pixels = decodeRgbaPng(reference.bytes);
    assert.equal(sha256(pixels.pixels), frame.rgba_sha256);
    const sample = { time: meta.time, reference: join(context.root, base, frame.path) };
    if (index % 3 === 0) {
      const request = join(output, `request-${index}.json`);
      await writeAtomicJson(request, {
        frame: {
          snapshotScope: `preview:${index}:${capture.inputs.project_sha256}`,
          projectRevision: index,
          compositionId: capture.inputs.case.composition,
          time: meta.time,
          target: meta.size,
          renderTarget: meta.size,
          antiAliasing: meta.aa,
          shadowsEnabled: true,
        },
        settings: {
          resources: {
            visualization: "beauty",
            locale: "en-US",
            layouts: {},
            surface: {
              revision: 1,
              maxTextureDimension: 4096,
              memoryBudgetMb: 512,
              renderScale: 1,
            },
            maximumRasterDimension: 8192,
            maximumRasterPixels: 67108864,
          },
          selectedLayerId: null,
          shadowMapSize: 1024,
        },
        plugins: [],
      });
      const address = { project: join(context.root, project), request };
      requests.push(await reader.json(local(request)));
      if (index === 0) initial = address;
      else sample.replace = address;
    }
    samples.push(sample);
  }
  const config = join(output, "config.json");
  await writeAtomicJson(config, {
    root: context.root,
    output,
    binary,
    compiler: join(context.root, "node_modules/electron/dist/dxcompiler.dll"),
    ...initial,
    samples,
  });
  await reader.bytes(local(config));
  const step = await execute(
    {
      id: "preview-project-electron",
      file: electron,
      args: ["scripts/migration/shared-preview-electron.mjs"],
      env: { ASTER_SHARED_PREVIEW_CONFIG: config },
      timeout_ms: 180000,
    },
    context,
  );
  const proof = await reader.bytes(local(join(output, "report.json")));
  const report = JSON.parse(proof.bytes);
  assert.equal(step.status, "passed", report.error);
  assert.equal(report.status, "passed", report.error);
  assert.equal(report.all_references_released, true);
  assert.equal(report.unregistered_receiver_rejected, true);
  assert.equal(report.frames.length, samples.length);
  assert.equal(report.replacements.length, 3);
  for (const [index, frame] of report.frames.entries()) {
    const generation = Math.floor(index / 3) + 1;
    const request = requests[generation - 1];
    const source =
      generation === 1 ? report.ready.source : report.replacements[generation - 2].after.source;
    assert.equal(frame.sequence, index + 1);
    assert.equal(frame.generation, generation);
    assert.equal(frame.time, samples[index].time);
    assert.deepEqual(frame.source, source);
    assert.equal(source.scope, request.frame.snapshotScope);
    assert.equal(source.revision, request.frame.projectRevision);
    assert.equal(source.composition_id, request.frame.compositionId);
    const reference = decodeRgbaPng((await reader.bytes(local(samples[index].reference))).bytes);
    const actual = decodeRgbaPng(
      (await reader.bytes(local(join(output, `frame-${index + 1}.png`)))).bytes,
    );
    assert.equal(actual.width, reference.width);
    assert.equal(actual.height, reference.height);
    assert.equal(sha256(actual.pixels), sha256(reference.pixels));
    assert.equal(frame.rgba_sha256, sha256(actual.pixels));
    assert.equal(frame.exact, true);
  }
  return {
    step,
    evidence: { path: local(join(output, "report.json")), sha256: proof.sha256 },
    status: "passed",
    exact_frames: samples.length,
    snapshot_replacements: 3,
    arbitrary_time: true,
    gpu_only_transport: true,
    full_corpus: false,
  };
}
