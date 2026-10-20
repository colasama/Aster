import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createServer } from "vite";
import { sha256 } from "./m0-evidence.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function captureProjectMediaOracle(root, output, projects) {
  const sources = [];
  for (const path of [
    "src/importers/media-import-identity.ts",
    "src/importers/image-sequence.ts",
    "src/importers/image-sequence-runtime.ts",
    "scripts/migration/native-project-media-oracle.mjs",
  ])
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const { mediaBytesIdentity } = await server.ssrLoadModule(
      "/src/importers/media-import-identity.ts",
    );
    const { resolveImageSequenceFrame } = await server.ssrLoadModule(
      "/src/importers/image-sequence-runtime.ts",
    );
    const cases = [];
    for (const project of projects) {
      const path = isAbsolute(project.path) ? project.path : join(root, project.path);
      const raw = await readFile(path);
      assert.equal(sha256(raw), project.sha256);
      const document = JSON.parse(raw);
      const entries = [];
      const sequence_samples = [];
      const bundle = await realpath(dirname(path));
      const readRelative = async (name) => {
        const file = await realpath(join(bundle, name));
        const suffix = relative(bundle, file);
        assert(!suffix.startsWith("..") && !isAbsolute(suffix));
        return readFile(file);
      };
      for (const binding of document.mediaImports?.entries ?? []) {
        const payload = document.mediaImports.payloads.find((p) => p.id === binding.payloadId);
        assert(payload);
        for (const member of payload.kind === "imageSequence" ? payload.frames : [payload]) {
          const storage = member.storage;
          assert(["inline", "relative"].includes(storage.kind));
          const bytes =
            storage.kind === "inline"
              ? Buffer.from(storage.data, "base64")
              : await readRelative(storage.relativePath);
          const identity = mediaBytesIdentity(bytes);
          assert.equal(identity, storage.byteIdentity);
          entries.push({
            payload_id: payload.id,
            frame: member.frame ?? null,
            source_id: binding.sourceId,
            sha256: sha256(bytes),
            byte_identity: identity,
            byte_length: bytes.length,
            storage: storage.kind,
          });
        }
        if (payload.kind === "imageSequence") {
          const duration =
            ((payload.endFrame - payload.startFrame + 1) * payload.frameRate.denominator) /
            payload.frameRate.numerator;
          const selection = {
            ...payload,
            frames: payload.frames.map((frame) => ({ frame: frame.frame, file: frame })),
          };
          for (let i = 0; i < 72; i++) {
            const time = i === 0 ? -1 : (duration * (i - 1)) / 32;
            let expected = null;
            try {
              const selected = resolveImageSequenceFrame(selection, time, payload.frameRate, {
                loop: payload.loop,
                missingFramePolicy: payload.missingFramePolicy,
              });
              expected = {
                requested_frame: selected.requestedFrame,
                actual_frame: selected.actualFrame,
                missing: selected.missing,
              };
            } catch {}
            sequence_samples.push({ source_id: binding.sourceId, time, expected });
          }
        }
      }
      const represented = new Set((document.mediaImports?.entries ?? []).map((e) => e.sourceId));
      for (const source of document.sources ?? []) {
        if (represented.has(source.id) || !source.relativePath) continue;
        const bytes = await readRelative(source.relativePath);
        assert(
          [mediaBytesIdentity(bytes), `sha256:${sha256(bytes)}`].includes(source.contentIdentity),
        );
        entries.push({
          payload_id: null,
          frame: null,
          source_id: source.id,
          sha256: sha256(bytes),
          byte_identity: mediaBytesIdentity(bytes),
          byte_length: bytes.length,
          storage: "relative",
        });
      }
      if (entries.length)
        cases.push({ path: project.path, sha256: project.sha256, entries, sequence_samples });
      assert.equal(sha256(await readFile(path)), project.sha256);
    }
    const report = { schema_version: 1, sources, cases };
    await writeAtomicJson(output, report);
    return {
      projects: cases.length,
      storage_entries: cases.reduce((n, c) => n + c.entries.length, 0),
      sequence_samples: cases.reduce((n, c) => n + c.sequence_samples.length, 0),
    };
  } finally {
    await server.close();
  }
}
