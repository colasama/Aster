import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Cross both former encoded-source ceilings without changing compressed video packets. */
export async function validateVideoBudgets(context, prepared, baseline) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((item) => item.id === "video-24000-1001");
  assert(fixture);
  const original = JSON.parse(await readFile(join(root, fixture.project)));
  const source = join(output, "padded.mp4"),
    payload = original.mediaImports.payloads[0],
    bytes = Buffer.from(payload.storage.data, "base64"),
    sourceBytes = 536_870_913;
  const file = await open(source, "wx");
  try {
    await file.writeFile(bytes);
    // A standard trailing MP4 free box leaves every packet and presentation timestamp intact.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(sourceBytes - bytes.length);
    header.write("free", 4, "ascii");
    await file.write(header);
    await file.truncate(sourceBytes);
  } finally {
    await file.close();
  }
  assert.equal((await stat(source)).size, sourceBytes);
  const sourceHash = await hashFile(source),
    identity = `sha256:${sourceHash}`,
    baselineHash = await hashFile(baseline);
  const { MediaBytesIdentity } = await import(
    pathToFileURL(join(root, "dist-electron/src/importers/media-import-identity.js"))
  );
  const byteIdentity = new MediaBytesIdentity();
  for await (const chunk of createReadStream(source)) byteIdentity.update(chunk);
  const document = structuredClone(original);
  document.sources[0].contentIdentity = identity;
  document.mediaImports.entries[0].contentIdentity = identity;
  document.mediaImports.payloads[0].contentIdentity = identity;
  document.mediaImports.payloads[0].storage = {
    kind: "relative",
    relativePath: "padded.mp4",
    byteIdentity: byteIdentity.digest(),
  };
  const project = join(output, "project.json"),
    request = join(output, "request.json");
  await writeAtomicJson(project, document);
  await writeAtomicJson(request, { rasterProvider: prepared.rasterProvider });
  const { prepareNativeQueueProject } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-queue-project.js"))
  );
  const provider = prepared.rasterProvider;
  const options = {
    directory: join(output, "queue"),
    authorizedPaths: [source],
    runtime: {
      renderer: prepared.binary,
      executable: provider.executable,
      host: provider.arguments[0],
      bundle: provider.bundle,
      bridge: provider.bridge,
    },
    manifest: {
      id: "large-video",
      compositionId: fixture.composition,
      compositionName: "large-video",
      projectRevision: 0,
      projectSnapshot: JSON.stringify(document),
      renderMediaSnapshot: JSON.stringify({
        version: 1,
        entries: [
          {
            sourceId: document.sources[0].id,
            sourceKind: "video",
            contentIdentity: identity,
            kind: "locator",
            locator: { kind: "session", url: `aster-asset://local/${encodeURIComponent(source)}` },
          },
        ],
        payloads: [],
      }),
      width: 320,
      height: 180,
      frameRate: document.compositions[0].frameRate,
      startFrame: 15,
      endFrameExclusive: 17,
      outputs: [],
      priority: 0,
      createdAt: new Date().toISOString(),
    },
  };
  const queue = await prepareNativeQueueProject(options),
    cases = [];
  async function run(name, binary, input, configuration, extra = [], rejection = false) {
    const destination = join(output, name),
      temporary = join(output, `${name}-tmp`);
    await mkdir(temporary);
    const step = await runStep(
      {
        id: name,
        file: binary,
        args: [
          "export",
          "--project",
          input,
          "--composition",
          fixture.composition,
          "--request",
          configuration,
          "--out",
          destination,
          "--format",
          "png-sequence",
          "--start-frame",
          "15",
          "--frames",
          "2",
          "--width",
          "320",
          "--height",
          "180",
          "--ffmpeg",
          join(root, "build/ffmpeg/ffmpeg.exe"),
          "--ffprobe",
          join(root, "build/ffmpeg/ffprobe.exe"),
          "--dxcompiler",
          join(root, "node_modules/electron/dist/dxcompiler.dll"),
          ...extra,
        ],
        env: { TMP: temporary, TEMP: temporary },
      },
      context,
    );
    const log = await readFile(join(root, step.log), "utf8");
    assert.deepEqual(await readdir(temporary), [], "Video snapshot residue");
    assert(!(await readdir(output)).some((name) => name.startsWith(".aster-png-")));
    if (rejection) {
      assert.equal(step.exit_code, 2, log);
      assert.match(log, /budget|limit|bounded|too large/i);
      assert(!(await readdir(output)).includes(name));
      cases.push({ id: name, status: "passed", expected_rejection: true, step, cleanup: true });
      return;
    }
    assert.equal(step.status, "passed", log);
    const rows = log.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const receipt = rows.find((row) => row.status === "passed" && row.images);
    assert.equal(receipt?.images.length, 2);
    for (const image of receipt.images)
      assert.equal(await hashFile(join(destination, image.member)), image.png_sha256);
    cases.push({ id: name, status: "passed", step, receipt, cleanup: true });
    return receipt.images;
  }
  const reference = await run("reference-small", baseline, join(root, fixture.project), request);
  await run("reference-large-rejection", baseline, project, request, [], true);
  for (const [name, input, configuration] of [
    ["native-large", project, request],
    ["queue-large", queue.project, queue.request],
  ])
    assert.deepEqual(await run(name, prepared.binary, input, configuration), reference);
  await run(
    "native-source-limit",
    prepared.binary,
    project,
    request,
    ["--project-media-source-bytes", "536870912"],
    true,
  );
  await run(
    "native-video-limit",
    prepared.binary,
    project,
    request,
    ["--video-max-source-bytes", "268435456"],
    true,
  );
  // Size metadata must reject a file beyond the application budget before hashing or copying it.
  const oversized = join(output, "oversized.mp4");
  await copyFile(source, oversized);
  const oversizedFile = await open(oversized, "r+");
  try {
    await oversizedFile.truncate(2_147_483_649);
  } finally {
    await oversizedFile.close();
  }
  const media = JSON.parse(options.manifest.renderMediaSnapshot);
  media.entries[0].locator.url = `aster-asset://local/${encodeURIComponent(oversized)}`;
  const rejectedDirectory = join(output, "oversized-queue");
  await assert.rejects(
    prepareNativeQueueProject({
      ...options,
      directory: rejectedDirectory,
      authorizedPaths: [oversized],
      manifest: { ...options.manifest, renderMediaSnapshot: JSON.stringify(media) },
    }),
    /bounded regular file/,
  );
  assert(!(await readdir(output)).includes("oversized-queue"));
  assert.equal(await hashFile(source), sourceHash);
  assert.equal(await hashFile(baseline), baselineHash);
  const report = {
    status: "passed",
    scope:
      "Real file-backed video above 512 MiB through native project and queue preparation; unchanged packets, exact frames, explicit lower limits and cleanup",
    source: { path: source, sha256: sourceHash, bytes: sourceBytes, padding: "MP4 free box" },
    baseline: { path: baseline, sha256: baselineHash },
    queue,
    cases,
    oversized_queue_rejected: true,
    self_review: { result: "exact", compared_frames: 4 },
  };
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
