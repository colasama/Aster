import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { M0Evidence, sha256, validSha } from "./m0-evidence.mjs";
import { buildQualifiedTextPlan } from "./native-project-text-plan.mjs";
import { loadQualifiedProjectText } from "./native-project-text-qualification.mjs";

// Bind retained project captures to their original invocations, inputs and content-addressed resources.
export class CorpusCheckpointAudit {
  static assertComplete(report) {
    assert.equal(report.id, "G2");
    assert.equal(report.kind, "native-project-corpus");
    assert.equal(report.status, "passed");
    assert.equal(report.full_coverage, true);
    assert.equal(report.source_unchanged, true);
    validSha(report.source.source_sha256);
    validSha(report.source.execution_sha256);
    assert.equal(report.source.source_sha256, report.source_after.source_sha256);
    assert(Array.isArray(report.cases) && report.cases.length > 0);
    assert.equal(report.cases.length, report.required_cases);
    assert.equal(new Set(report.cases.map((c) => c.id)).size, report.cases.length);
    assert(
      report.cases.every(
        (c) =>
          c.status === "passed" && c.samples.length > 0 && c.samples.every((s) => s.equal === true),
      ),
    );
    assert.equal(
      report.cases.reduce((n, c) => n + c.samples.length, 0),
      report.required_samples,
    );
  }

  constructor(root, codecs) {
    this.root = root;
    this.reader = new M0Evidence(root);
    this.codecs = codecs;
    this.resources = new Map();
  }

  local(path) {
    return relative(this.root, resolve(this.root, path)).replaceAll("\\", "/");
  }

  async step(step, command, result, exitCode = 0) {
    assert.deepEqual(step.command, command, "Original invocation differs");
    assert.equal(step.status, exitCode === 0 ? "passed" : "failed");
    assert.equal(step.exit_code, exitCode);
    assert(!step.error && !step.signal);
    const lines = (await this.reader.bytes(step.log)).bytes.toString("utf8").split(/\r?\n/);
    assert.equal(lines[0], `Command: ${JSON.stringify(command)}`);
    assert.deepEqual(JSON.parse(lines.filter((line) => line.startsWith("{")).at(-1)), result);
  }

  async qualifiedText(row, input, binary) {
    const { raw, substitution } = row.native_text_substitution;
    const original = await this.reader.json(raw.comparison.path, raw.comparison.sha256);
    assert.equal(original.kind, "plan_diff");
    assert.equal(original.equal, false);
    assert.equal(original.a_sha256, input.reference_sha256);
    assert.equal(original.b_sha256, input.frame.plan_sha256);
    assert.equal(original.relative, 1e-5);
    assert.equal(original.absolute, 1e-6);
    await this.step(
      raw.step,
      [
        binary,
        "plan-diff",
        "--a",
        input.reference,
        "--a-resources",
        input.reference_resources,
        "--b",
        input.candidate,
        "--b-resources",
        input.candidate_resources,
        "--out",
        join(this.root, raw.comparison.path),
      ],
      original,
      1,
    );
    this.textQualification ??= await loadQualifiedProjectText(this.reader);
    const rebuilt = await buildQualifiedTextPlan(
      { root: this.root },
      this.reader,
      this.codecs,
      this.textQualification,
      input,
    );
    const proof = await this.reader.json(substitution.path, substitution.sha256);
    assert.deepEqual(proof, {
      ...rebuilt.proof,
      plan: { ...rebuilt.proof.plan, path: substitution.plan.path },
    });
    assert.deepEqual(proof.plan, substitution.plan);
    const bytes = await this.reader.bytes(substitution.plan.path, substitution.plan.sha256);
    assert.deepEqual(bytes.bytes, Buffer.from(rebuilt.canonical.bytes));
    const messages = await this.reader.json(
      this.local(join(dirname(substitution.plan.path), "resources.json")),
    );
    assert.deepEqual(
      messages,
      [...rebuilt.canonical.packets.values()]
        .map((p) => p.message)
        .sort((a, b) => a.hash.localeCompare(b.hash)),
    );
    await this.resourceSet(
      this.local(join(dirname(substitution.plan.path), "resources.json")),
      substitution.resources,
      this.codecs.decodeFramePlan(bytes.bytes),
    );
    return substitution;
  }

  async resourceSet(path, directory, plan, expectedHash) {
    const messages = await this.reader.json(path, expectedHash);
    assert.equal(new Set(messages.map((m) => m.hash)).size, messages.length);
    for (const message of messages) {
      assert.equal(message.type, "put_resource");
      validSha(message.hash);
      const packetPath = this.local(join(directory, `${message.hash}.bin`));
      const identity = sha256(
        JSON.stringify({ kind: message.kind, descriptor: message.descriptor }),
      );
      const cached = this.resources.get(packetPath);
      if (cached) assert.equal(cached, identity);
      else {
        const packet = await this.reader.bytes(packetPath);
        assert.equal(
          this.codecs.contentResourceHashSync(
            { kind: message.kind, descriptor: message.descriptor },
            packet.bytes,
          ),
          message.hash,
          "Resource content no longer matches its address",
        );
        this.resources.set(packetPath, identity);
      }
    }
    const members = new Set(messages.map((m) => m.hash));
    for (const hash of plan.metadata.resources) assert(members.has(hash), "Missing plan resource");
    return messages.length;
  }

  async case(entry, expected, job, binary, regeneratedRequest) {
    assert.equal(entry.id, expected.id);
    assert.equal(entry.status, "passed");
    assert.equal(entry.samples.length, expected.samples.length);
    const requestPath = this.local(job.request);
    const request = await this.reader.json(requestPath);
    assert.deepEqual(
      request,
      regeneratedRequest,
      "Request differs from the current corpus addresses",
    );
    assert.deepEqual(Object.keys(request).sort(), [
      "frames",
      "plugins",
      "rasterProvider",
      "settings",
    ]);
    assert.equal(request.frames.length, expected.samples.length);
    const receipt = await this.reader.json(entry.receipt.path, entry.receipt.sha256);
    assert.equal(entry.receipt.path, this.local(join(job.out, "report.json")));
    assert.equal(receipt.schema_version, 1);
    assert.equal(receipt.kind, "native-project-render");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.raster_mode, "live");
    assert.equal(receipt.request_sha256, (await this.reader.bytes(requestPath)).sha256);
    assert.equal(receipt.project.authored_sha256, expected.assignment.inputs.project_sha256);
    const authoredPath = (await stat(job.project)).isDirectory()
      ? join(job.project, "project.json")
      : job.project;
    assert.equal(sha256(await readFile(authoredPath)), receipt.project.authored_sha256);
    assert.equal(receipt.frames.length, expected.samples.length);
    assert(["Dx12", "Vulkan", "Metal"].includes(receipt.adapter.backend));
    assert.notEqual(receipt.adapter.device_type, "Cpu");
    await this.step(
      entry.render,
      [
        binary,
        "render-project",
        "--project",
        job.project,
        "--request",
        job.request,
        "--out",
        job.out,
        "--ffmpeg",
        join(this.root, "build/ffmpeg/ffmpeg.exe"),
        "--ffprobe",
        join(this.root, "build/ffmpeg/ffprobe.exe"),
        "--dxcompiler",
        join(this.root, "node_modules/electron/dist/dxcompiler.dll"),
        "--layer-cache-bytes",
        "0",
        "--effect-pipeline-entries",
        "0",
        "--capture-output-bytes",
        "17179869184",
      ],
      receipt,
    );
    const declared = [];
    for (const [index, sample] of expected.samples.entries()) {
      const row = entry.samples[index];
      assert.deepEqual(row.sample, sample.sample);
      assert.equal(row.equal, true);
      const frame = receipt.frames[index];
      assert.equal(frame.index, index);
      const directory = join(job.out, String(index));
      const planPath = this.local(join(directory, "plan.fpln"));
      const plan = this.codecs.decodeFramePlan(
        (await this.reader.bytes(planPath, frame.plan_sha256)).bytes,
      );
      const reference = this.codecs.decodeFramePlan(
        (await this.reader.bytes(sample.reference_plan.path, sample.reference_plan.sha256)).bytes,
      );
      assert.deepEqual(plan.metadata.header, reference.metadata.header);
      const pngPath = this.local(join(directory, "candidate.png"));
      const image = await this.reader.image(pngPath, frame.png_sha256);
      assert.equal(image.rgba_sha256, frame.rgba_sha256);
      for (const axis of ["width", "height"]) {
        assert.equal(image[axis], expected.assignment.case.size[axis]);
        assert.equal(frame[axis], image[axis]);
      }
      assert.equal(
        await this.resourceSet(
          this.local(join(directory, "resources.json")),
          join(job.out, "resources"),
          plan,
        ),
        frame.resource_count,
      );
      const referenceDirectory = dirname(sample.reference_plan.path);
      const meta = await this.reader.json(`${referenceDirectory}/meta.json`);
      await this.resourceSet(
        `${referenceDirectory}/resources.json`,
        sample.reference_resources,
        reference,
        meta.frame_plan.files["resources.json"],
      );
      const measured = await this.reader.json(row.comparison.path, row.comparison.sha256);
      const qualified = row.native_text_substitution
        ? await this.qualifiedText(
            row,
            {
              case_id: expected.id,
              authored_sha256: receipt.project.authored_sha256,
              time: sample.sample.time,
              frame,
              reference: join(this.root, sample.reference_plan.path),
              reference_sha256: sample.reference_plan.sha256,
              reference_resources: join(this.root, sample.reference_resources),
              candidate: join(directory, "plan.fpln"),
              candidate_resources: join(job.out, "resources"),
            },
            binary,
          )
        : undefined;
      assert.equal(measured.schema_version, 1);
      assert.equal(measured.kind, "plan_diff");
      assert.equal(measured.status, "passed");
      assert.equal(measured.equal, true);
      assert.equal(measured.first_difference, null);
      assert.equal(measured.a_sha256, sample.reference_plan.sha256);
      assert.equal(measured.b_sha256, qualified?.plan.sha256 ?? frame.plan_sha256);
      assert.equal(measured.relative, 1e-5);
      assert.equal(measured.absolute, 1e-6);
      assert(measured.compared_plans > 0);
      await this.step(
        row.step,
        [
          binary,
          "plan-diff",
          "--a",
          join(this.root, sample.reference_plan.path),
          "--a-resources",
          join(this.root, sample.reference_resources),
          "--b",
          qualified ? join(this.root, qualified.plan.path) : join(directory, "plan.fpln"),
          "--b-resources",
          qualified ? join(this.root, qualified.resources) : join(job.out, "resources"),
          "--out",
          join(this.root, row.comparison.path),
        ],
        measured,
      );
      if (sample.sample.kind === "declared")
        declared.push({
          case_id: expected.id,
          frame: sample.sample.frame,
          path: pngPath,
          png_sha256: frame.png_sha256,
        });
    }
    return declared;
  }
}
