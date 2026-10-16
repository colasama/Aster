import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  diagnosticMediaGrants,
  diagnosticStructuralInputs,
} from "./diagnostic-structural-inputs.mjs";
import {
  assertEncodedStructuralAuthorization,
  encodedStructuralPolicy,
} from "./encoded-structural-policy.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureNv12Case } from "./native-nv12-case.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile, sourceProvenance } from "./source.mjs";

/** RGB and pre-encode comparisons use the very same production plans and lossless oracle. */
export async function captureDiagnosticStructuralWitness(context, diagnostic, mode, ledger) {
  const { root, output } = context;
  const policy = assertEncodedStructuralAuthorization(ledger);
  const reader = new M0Evidence(root);
  await reader.bytes(policy.proposal.path, policy.proposal.sha256);
  const source = await sourceProvenance(root);
  assert.equal(source.execution_sha256, diagnostic.source.execution_sha256);
  const { frames, assignment } = await diagnosticStructuralInputs(reader, diagnostic, mode);
  const local = (path) => relative(root, path).replaceAll("\\", "/");
  const pin = async (path) => ({ path: local(path), sha256: await hashFile(path) });
  const binary = resolve(root, diagnostic.binary.path);
  await reader.bytes(diagnostic.binary.path, diagnostic.binary.sha256);
  await mkdir(join(output, "media"), { recursive: true });
  const { lease, grants } = await diagnosticMediaGrants(root, frames[0].job);
  const durable = [];
  try {
    for (const grant of grants) {
      const path = join(output, "media", `${grant.sha256}.media`);
      await copyFile(grant.path, path);
      assert.equal(await hashFile(path), grant.sha256);
      durable.push({ ...grant, path });
    }
  } finally {
    await lease.dispose();
  }
  const authorizations = join(output, "media/authorizations.json");
  await writeAtomicJson(authorizations, durable);
  const conversionContext = { ...context, output: join(output, "conversion") };
  const conversion = await captureNv12Case(conversionContext, assignment, binary, (command, ctx) =>
    runStep(
      command.args[0] === "render-plan"
        ? {
            ...command,
            args: [
              ...command.args,
              "--media-authorizations",
              authorizations,
              "--ffmpeg",
              join(root, "build/ffmpeg/ffmpeg.exe"),
              "--ffprobe",
              join(root, "build/ffmpeg/ffprobe.exe"),
            ],
          }
        : command,
      ctx,
    ),
  );
  const report = {
    kind: encodedStructuralPolicy,
    input_kind: "production-diagnostic",
    case_id: assignment.case.id,
    execution_sha256: source.execution_sha256,
    binary: diagnostic.binary,
    capture: diagnostic.input,
    assignment,
    authorizations: await pin(authorizations),
    conversion: await pin(join(conversionContext.output, "report.json")),
    frames: [],
  };
  for (const rendered of conversion.frames) {
    const index = rendered.frame;
    const encoded = diagnostic.comparisons.find((f) => f.name === "native" && f.index === index);
    const raw = await reader.json(encoded.report, encoded.report_sha256);
    const stages = {
      frame: index,
      encoded: { path: encoded.report, sha256: encoded.report_sha256 },
    };
    for (const stage of ["rgb", "preencode"]) {
      const comparisonContext =
        stage === "preencode"
          ? raw.context
          : {
              case_id: assignment.case.id,
              isolated: true,
              background: [0, 0, 0, 0],
              sequence: {
                frame: index,
                first_frame: 0,
                last_frame: 2,
                previous: index ? resolve(root, frames[index - 1].reference.path) : null,
                next: index < 2 ? resolve(root, frames[index + 1].reference.path) : null,
              },
            };
      const contextPath = join(output, `${stage}-${index}.context.json`);
      await writeAtomicJson(contextPath, comparisonContext);
      const destination = join(output, `${stage}-${index}`);
      const step = await runStep(
        {
          id: `${stage}-${index}`,
          file: binary,
          args: [
            "compare",
            "--reference",
            stage === "rgb" ? resolve(root, frames[index].reference.path) : raw.reference.path,
            "--candidate",
            stage === "rgb"
              ? resolve(root, rendered.png.path)
              : join(conversionContext.output, String(index), "native.png"),
            "--tolerance",
            stage === "rgb" ? "gpu" : "yuv",
            "--context",
            contextPath,
            "--out",
            destination,
          ],
        },
        context,
      );
      stages[stage] = { report: await pin(join(destination, "report.json")), step };
    }
    report.frames.push(stages);
  }
  await reader.stable();
  report.source_unchanged = (await sourceProvenance(root)).source_sha256 === source.source_sha256;
  assert(report.source_unchanged);
  const path = join(output, "report.json");
  await writeAtomicJson(path, report);
  return pin(path);
}
