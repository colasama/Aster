import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

export async function validateAudioWaveHeaders(context) {
  const { root, output } = context;
  const step = await runStep(
    {
      id: "native-wave-fixtures",
      file: "cargo",
      args: [
        "test",
        "-p",
        "aster-render-project",
        "--lib",
        "write_sparse_audio_qualification_files",
        "--",
        "--ignored",
      ],
      env: { ASTER_EXPORT_AUDIO_WAVE_DIR: output },
    },
    context,
  );
  assert.equal(step.status, "passed");
  const cases = JSON.parse(await readFile(join(output, "cases.json"))),
    steps = [step],
    observations = [];
  for (const item of cases) {
    const probe = await runStep(
      {
        id: `probe-${item.name}`,
        file: join(root, "build/ffmpeg/ffprobe.exe"),
        args: ["-v", "error", "-show_streams", "-show_format", "-of", "json", item.path],
      },
      context,
    );
    steps.push(probe);
    assert.equal(probe.status, "passed");
    const log = await readFile(join(root, probe.log), "utf8"),
      data = JSON.parse(log.slice(log.indexOf("\n") + 1));
    const audio = data.streams.find((s) => s.codec_type === "audio");
    assert.equal(audio.codec_name, "pcm_f32le");
    assert.equal(audio.sample_rate, "48000");
    assert.equal(audio.channels, 2);
    assert.equal(audio.duration_ts, item.frames);
    assert.equal(Number(data.format.size), item.bytes);
    observations.push({ ...item, probe: data });
  }
  assert(observations.some((item) => item.bytes > 4294967295));
  const report = {
    status: "passed",
    scope:
      "Production RIFF/RF64 headers with sparse PCM payloads above 4 GiB; not full-duration rendering",
    cases: observations,
    steps,
  };
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}

export async function validateLongNativeAudio(context, prepared, baseline) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const steps = [],
    cases = [],
    oldHash = await hashFile(baseline),
    source = join(output, "long-source.wav");
  const generated = await runStep(
    {
      id: "long-audio-source",
      file: join(root, "build/ffmpeg/ffmpeg.exe"),
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=360",
        "-c:a",
        "pcm_s16le",
        source,
      ],
    },
    context,
  );
  steps.push(generated);
  assert.equal(generated.status, "passed");
  const { MediaBytesIdentity } = await import(
    pathToFileURL(join(root, "dist-electron/src/importers/media-import-identity.js"))
  );
  const identity = new MediaBytesIdentity();
  for await (const chunk of createReadStream(source)) identity.update(chunk);
  const digest = identity.digest(),
    corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const fixture = corpus.cases.find((c) => c.id === "scene-audio-spectrum-bars");
  const document = JSON.parse(await readFile(join(root, fixture.project)));
  const composition = document.compositions.find((c) => c.id === fixture.composition);
  composition.duration = 360;
  composition.workArea = { start: 0, end: 360 };
  for (const layer of composition.layers) layer.outPoint = 360;
  Object.assign(document.sources[0], {
    duration: 360,
    channels: 1,
    sampleRate: 48000,
    contentIdentity: digest,
  });
  document.mediaImports.entries[0].contentIdentity = digest;
  Object.assign(document.mediaImports.payloads[0], {
    contentIdentity: digest,
    storage: { kind: "relative", relativePath: "long-source.wav", byteIdentity: digest },
  });
  const project = join(output, "project.json"),
    request = join(output, "request.json");
  await writeAtomicJson(project, document);
  await writeAtomicJson(request, {
    rasterProvider: prepared.rasterProvider,
    plugins: fixture.plugins.map((p) => join(root, p, "plugin.toml")),
  });
  const images = [],
    audio = [];
  for (const [index, binary] of [baseline, prepared.binary].entries()) {
    for (const format of ["png", "mp4"]) {
      const name = `long-${index}-${format}`,
        destination = join(output, `${name}.${format}`);
      const step = await runStep(
        {
          id: name,
          file: binary,
          args: [
            "export",
            "--project",
            project,
            "--composition",
            fixture.composition,
            "--request",
            request,
            "--out",
            destination,
            "--format",
            format,
            "--start-frame",
            "9300",
            "--frames",
            format === "png" ? "1" : "12",
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
            ...(index === 0 ? ["--project-audio-max-seconds", "600"] : []),
          ],
        },
        context,
      );
      steps.push(step);
      assert.equal(step.status, "passed");
      const rows = (await readFile(join(root, step.log), "utf8")).split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const receipt = rows.find((r) => r.status === "passed" && r.report);
      assert(receipt);
      if (format === "png") {
        assert.equal(await hashFile(destination), receipt.images[0].png_sha256);
        images.push(receipt.images[0]);
      } else {
        assert.equal(receipt.report.audio_frames, 19200);
        const pcm = join(output, `${name}.pcm`);
        const decode = await runStep(
          {
            id: `decode-${name}`,
            file: join(root, "build/ffmpeg/ffmpeg.exe"),
            args: [
              "-v",
              "error",
              "-i",
              destination,
              "-map",
              "0:a:0",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-f",
              "f32le",
              pcm,
            ],
          },
          context,
        );
        steps.push(decode);
        assert.equal(decode.status, "passed");
        const samples = await readFile(pcm);
        assert(samples.some((byte) => byte !== 0));
        audio.push({
          sha256: await hashFile(pcm),
          bytes: samples.length,
          frames: receipt.report.audio_frames,
        });
      }
    }
  }
  assert.deepEqual(images[0], images[1]);
  assert.deepEqual(audio[0], audio[1]);
  assert.equal(await hashFile(baseline), oldHash);
  await prepared.assertUnchanged();
  cases.push({
    id: "six-minute-source-after-five-minute-boundary",
    status: "passed",
    source_sha256: await hashFile(source),
    project_sha256: await hashFile(project),
    image: images[1],
    audio: audio[1],
    exact: true,
  });
  const report = {
    status: "passed",
    scope:
      "Six-minute source admission and 310-second export versus prior native renderer with explicit duration override",
    cases,
    steps,
    baseline: { binary: baseline, sha256: oldHash },
  };
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
