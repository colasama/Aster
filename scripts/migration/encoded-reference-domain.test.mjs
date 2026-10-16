import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { decodeRgbaPng, encodeRgbaPng } from "../parity/png.mjs";
import {
  auditEncodedReferenceDomain,
  auditUniformReference,
  prepareEncodedReferences,
} from "./encoded-reference-domain.mjs";
import { M0Evidence } from "./m0-evidence.mjs";
import { hashFile } from "./source.mjs";

test("G5 uniform proof rejects invented eligibility and preserves unmeasured displacement", () => {
  const reference = {
    width: 2,
    height: 2,
    pixels: Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
  };
  const candidate = { ...reference, pixels: Buffer.from(reference.pixels) };
  candidate.pixels[0] = 1;
  const raw = {
    context: { g5_uniform_reference: true },
    comparison: {
      profile: { name: "yuv" },
      registration: {
        status: "uniform_reference_equivalence",
        shift: null,
        diagnostic: "unobservable",
      },
    },
  };
  auditUniformReference(raw, reference, candidate);
  for (const mutate of [
    (r, _ref, _c) => {
      r.context.g5_uniform_reference = false;
    },
    (r, _ref, _c) => {
      r.comparison.profile.name = "gpu";
    },
    (r, _ref, _c) => {
      r.comparison.registration.shift = { distance: 0 };
    },
    (_r, ref, _c) => {
      ref.pixels[4] = 1;
    },
    (_r, _ref, c) => {
      c.pixels[0] = 2;
    },
    (_r, _ref, c) => {
      c.pixels[3] = 254;
    },
  ]) {
    const r = structuredClone(raw),
      ref = structuredClone(reference),
      c = structuredClone(candidate);
    mutate(r, ref, c);
    assert.throws(() => auditUniformReference(r, ref, c));
  }
});

test("independent NV12 references bind original pixels, both neighbors and converter commands", {
  skip: process.platform !== "win32",
}, async () => {
  const root = process.cwd();
  await mkdir(join(root, "artifacts/migration"), { recursive: true });
  const output = await mkdtemp(join(root, "artifacts/migration/encoded-reference-test-"));
  assert(relative(root, output).startsWith("artifacts"));
  try {
    const originals = [];
    for (let frame = 0; frame < 3; frame++) {
      const path = join(output, `rgb-${frame}.png`);
      const pixels = Buffer.from([
        frame * 80,
        50,
        100,
        255,
        255,
        0,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        0,
        255,
        255,
      ]);
      await writeFile(path, encodeRgbaPng(2, 2, pixels), { flag: "wx" });
      originals.push({ derived: { path, sha256: await hashFile(path) } });
    }
    const samples = [
      {
        frame: 1,
        path: originals[1].derived.path,
        context: {
          case_id: "sample",
          isolated: false,
          background: null,
          sequence: {
            frame: 1,
            first_frame: 0,
            last_frame: 2,
            previous: originals[0].derived.path,
            next: originals[2].derived.path,
          },
        },
      },
    ];
    const prepared = await prepareEncodedReferences(
      { root, output, env: process.env },
      { name: "native", width: 2, height: 2, samples },
    );
    const { report } = prepared;
    assert.equal(report.references.length, 3);
    const sample = prepared.samples[0];
    assert.equal(sample.context.g5_uniform_reference, true);
    for (const path of [
      sample.path,
      sample.context.sequence.previous,
      sample.context.sequence.next,
    ]) {
      assert(report.references.some((r) => r.decoded.path === path));
      assert(!originals.some((r) => r.derived.path === path));
    }
    for (const record of report.references) {
      assert.equal((await readFile(record.nv12.path)).length, 6);
      assert.notDeepEqual(
        decodeRgbaPng(await readFile(record.source.path)).pixels,
        decodeRgbaPng(await readFile(record.decoded.path)).pixels,
      );
    }
    await auditEncodedReferenceDomain(new M0Evidence(root), report, originals);
    for (const mutate of [
      (r) => {
        r.references[0].source.sha256 = "0".repeat(64);
      },
      (r) => {
        r.references[0].decoded.rgba_sha256 = "0".repeat(64);
      },
      (r) => {
        r.references[0].steps[0].command[0] = "other-encoder";
      },
      (r) => {
        r.references.push(r.references[0]);
      },
    ]) {
      const bad = structuredClone(report);
      mutate(bad);
      await assert.rejects(auditEncodedReferenceDomain(new M0Evidence(root), bad, originals));
    }
    await assert.rejects(
      prepareEncodedReferences(
        { root, output, env: process.env },
        { name: "native", width: 2, height: 2, samples },
      ),
      /EEXIST/,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
