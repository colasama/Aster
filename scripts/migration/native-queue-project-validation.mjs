import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeRgbaPng } from "../parity/png.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Compare real exports before/after main-process queue input preparation. */
export async function validateNativeQueueProjects(context, prepared) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const { prepareNativeQueueProject } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-queue-project.js"))
  );
  const { mediaBytesIdentity } = await import(
    pathToFileURL(join(root, "dist-electron/src/importers/media-import-identity.js"))
  );
  const psdModule = join(output, "psd-runtime", "psd.js");
  const parserBuild = await runStep(
    {
      id: "queue-psd-parser-build",
      file: "node",
      args: [
        "--input-type=module",
        "-e",
        `import {build} from 'vite'; await build(${JSON.stringify({ configFile: false, build: { ssr: join(root, "src/importers/psd.ts"), outDir: join(output, "psd-runtime"), emptyOutDir: true } })});`,
      ],
    },
    context,
  );
  assert.equal(parserBuild.status, "passed");
  const { parsePsd } = await import(pathToFileURL(psdModule));
  const corpus = JSON.parse(await readFile(join(root, "tests/parity/corpus.json")));
  const provider = prepared.rasterProvider;
  const runtime = {
    executable: provider.executable,
    host: provider.arguments[0],
    bundle: provider.bundle,
    bridge: provider.bridge,
  };
  const report = { status: "failed", cases: [], steps: [parserBuild] };
  try {
    for (const id of [
      "media-png",
      "media-svg",
      "media-psd",
      "media-psd-layer",
      "media-image-sequence",
      "video-24000-1001",
      "scene-audio-spectrum-bars",
      "queue-embedded-source",
      "queue-large-sequence",
      "queue-large-document",
      "layer-text",
      "scene-lighting-directional",
    ]) {
      const fixtureId =
        {
          "queue-embedded-source": "media-png",
          "queue-large-sequence": "media-image-sequence",
          "queue-large-document": "minimal-golden",
        }[id] ?? id;
      const fixture = corpus.cases.find((c) => c.id === fixtureId);
      assert(fixture, id);
      let originalPath = resolve(root, fixture.project);
      const original = JSON.parse(await readFile(originalPath));
      if (id === "queue-large-sequence") {
        const payload = original.mediaImports.payloads[0],
          source = original.sources[0];
        const png = encodeRgbaPng(
          2,
          2,
          Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
        );
        payload.startFrame = 0;
        payload.endFrame = 4099;
        source.startFrame = 0;
        source.endFrame = 4099;
        source.width = 2;
        source.height = 2;
        payload.frames = Array.from({ length: 4100 }, (_, frame) => ({
          frame,
          name: `sequence-${String(frame).padStart(4, "0")}.png`,
          size: png.length,
          lastModified: 0,
          type: "image/png",
          storage: {
            kind: "inline",
            byteIdentity: mediaBytesIdentity(png),
            data: png.toString("base64"),
          },
        }));
        originalPath = join(output, `${id}-source.json`);
        await writeAtomicJson(originalPath, original);
      }
      const media = { version: 1, entries: [], payloads: [] };
      const payloads = new Map((original.mediaImports?.payloads ?? []).map((p) => [p.id, p]));
      for (const entry of original.mediaImports?.entries ?? []) {
        const payload = payloads.get(entry.payloadId),
          source = original.sources.find((s) => s.id === entry.sourceId);
        const base = {
          sourceId: source.id,
          sourceKind: source.kind,
          contentIdentity: source.contentIdentity,
        };
        if (entry.kind === "psd") {
          assert.equal(payload.storage.kind, "inline");
          const bytes = Buffer.from(payload.storage.data, "base64");
          const document = await parsePsd(Uint8Array.from(bytes).buffer);
          const pixels = id === "media-psd-layer" ? document.layers[0].pixels : document.composite;
          assert(pixels);
          // Exercise both original compressed documents and the supported pixel-only capture.
          const fallback = id === "media-psd-layer",
            data = fallback ? Buffer.from(pixels) : bytes;
          media.payloads.push({
            id: payload.id,
            kind: fallback ? "rgba" : "psdDocument",
            identity: mediaBytesIdentity(data),
            bytes: data.toString("base64"),
          });
          media.entries.push({
            ...base,
            kind: "psd",
            documentIdentity: entry.documentIdentity,
            importMode: entry.importMode,
            layerKey: entry.layerKey,
            payloadId: payload.id,
            fallback,
            decodedWidth: source.width,
            decodedHeight: source.height,
            crop: [0, 0, source.width, source.height],
          });
        } else if (entry.kind === "svg") {
          const sanitized = Buffer.from(payload.storage.data, "base64").toString("utf8");
          media.entries.push({
            ...base,
            kind: "svg",
            parsed: {
              sanitized,
              width: payload.width,
              height: payload.height,
              viewBox: [0, 0, payload.width, payload.height],
              nodeCount: 1 + [...sanitized.matchAll(/<[A-Za-z][^>]*>/g)].length,
            },
          });
        } else if (entry.kind === "imageSequence") {
          const {
            id: _id,
            kind: _kind,
            contentIdentity: _identity,
            frameRate,
            missingFramePolicy,
            loop,
            ...selection
          } = payload;
          media.entries.push({
            ...base,
            kind: "imageSequence",
            frameRate,
            missingFramePolicy,
            loop,
            selection: {
              ...selection,
              frames: payload.frames.map((frame) => ({
                frame: frame.frame,
                file: {
                  name: frame.name,
                  size: frame.size,
                  lastModified: frame.lastModified,
                  type: frame.type,
                  byteIdentity: frame.storage.byteIdentity,
                  locator: {
                    kind: "inline",
                    dataUrl: `data:${frame.type};base64,${frame.storage.data}`,
                  },
                },
              })),
            },
          });
        } else {
          assert.equal(payload.storage.kind, "inline");
          media.entries.push({
            ...base,
            kind: "locator",
            locator: {
              kind: "inline",
              dataUrl: `data:${source.mimeType};base64,${payload.storage.data}`,
            },
          });
        }
      }
      const manifest = {
        id,
        compositionId: fixture.composition,
        compositionName: id,
        projectRevision: 0,
        projectSnapshot: JSON.stringify(original),
        renderMediaSnapshot: JSON.stringify(media),
        width: 320,
        height: 180,
        frameRate: { numerator: 30, denominator: 1 },
        startFrame: 15,
        endFrameExclusive: 16,
        outputs: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      };
      if (id === "queue-embedded-source") {
        const clone = structuredClone(original),
          payload = clone.mediaImports.payloads[0];
        clone.sources[0].dataUrl = `data:${clone.sources[0].mimeType};base64,${payload.storage.data}`;
        delete clone.mediaImports;
        manifest.projectSnapshot = JSON.stringify(clone);
        delete manifest.renderMediaSnapshot;
      }
      if (id === "queue-large-document") {
        manifest.projectSnapshot = " ".repeat(67_108_865) + manifest.projectSnapshot;
        originalPath = join(output, `${id}-source.json`);
        await writeFile(originalPath, manifest.projectSnapshot);
      }
      const resolvePlugins = async (references) => ({
        packages: await Promise.all(
          references.map(async (reference) => {
            const directory = join(root, fixture.plugins[0]);
            const shaders = (await readdir(directory)).filter((f) => f.endsWith(".wgsl"));
            return {
              ...reference,
              manifestToml: await readFile(join(directory, "plugin.toml"), "utf8"),
              shaderSources: Object.fromEntries(
                await Promise.all(
                  shaders.map(async (f) => [f, await readFile(join(directory, f), "utf8")]),
                ),
              ),
            };
          }),
        ),
        unavailable: [],
      });
      const queue = await prepareNativeQueueProject({
        directory: join(output, id),
        manifest,
        authorizedPaths: [],
        runtime,
        resolvePlugins,
      });
      const request = JSON.parse(await readFile(queue.request));
      const baselineRequest = join(output, `${id}-baseline.json`);
      await writeAtomicJson(baselineRequest, { ...request, rasterProvider: provider });
      const exportImage = async (name, project, configuration) => {
        const path = join(output, `${name}.png`);
        const step = await runStep(
          {
            id: name,
            file: prepared.binary,
            args: [
              "export",
              "--project",
              project,
              "--composition",
              fixture.composition,
              "--request",
              configuration,
              "--out",
              path,
              "--format",
              "png",
              "--start-frame",
              "15",
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
              ...queue.runtimeArguments,
            ],
          },
          context,
        );
        report.steps.push(step);
        assert.equal(step.status, "passed", name);
        const rows = (await readFile(join(root, step.log), "utf8")).split("\n").flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
        const receipt = rows.find((row) => row.status === "passed" && row.images);
        assert(receipt, "Missing PNG export receipt");
        assert.equal(await hashFile(path), receipt.images[0].png_sha256);
        return receipt;
      };
      const baseline = await exportImage(`${id}-original`, originalPath, baselineRequest);
      const actual = await exportImage(`${id}-prepared`, queue.project, queue.request);
      assert.equal(
        actual.images[0].rgba_sha256,
        baseline.images[0].rgba_sha256,
        `${id} changed pixels`,
      );
      report.cases.push({
        id,
        status: "passed",
        exact: true,
        rgba_sha256: actual.images[0].rgba_sha256,
        queue,
      });
      if (fixture.plugins?.length) {
        const unavailable = await prepareNativeQueueProject({
          directory: join(output, `${id}-disabled`),
          manifest,
          authorizedPaths: [],
          runtime,
          resolvePlugins: async (references) => ({
            packages: [],
            unavailable: references.map((r) => ({ ...r, reason: "disabled" })),
          }),
        });
        const disabled = await exportImage(
          `${id}-disabled`,
          unavailable.project,
          unavailable.request,
        );
        assert.notEqual(
          disabled.images[0].rgba_sha256,
          actual.images[0].rgba_sha256,
          "Disabled generator was still executed",
        );
        report.cases.push({
          id: `${id}-disabled`,
          status: "passed",
          rgba_sha256: disabled.images[0].rgba_sha256,
          queue: unavailable,
        });
      }
    }
    await prepared.assertUnchanged();
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
