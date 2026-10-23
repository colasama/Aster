import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";

/** Reuse current-run native files to qualify one atomic mixed-output publication transaction. */
export async function validateNativeQueuePublication(context, processReport) {
  const { root, output } = context;
  await mkdir(output, { recursive: true });
  const { AtomicRenderOutputPublisher } = await import(
    pathToFileURL(join(root, "dist-electron/electron/render-queue-output.js"))
  );
  const original = processReport.manifest;
  const report = { status: "failed", cases: [] };
  const publishers = [];
  const make = async (name) => {
    const directory = join(output, name);
    await mkdir(directory);
    const manifest = {
      ...original,
      outputs: original.outputs.map((item) => ({
        ...item,
        destination: join(directory, basename(item.destination)),
      })),
    };
    for (const item of manifest.outputs) {
      if (item.kind === "pngSequence") {
        await mkdir(item.destination);
        await writeFile(join(item.destination, "old.txt"), "old");
      } else await writeFile(item.destination, "old");
    }
    const publisher = new AtomicRenderOutputPublisher(manifest, `native-${name}`);
    publishers.push(publisher);
    await publisher.prepare();
    return { publisher, manifest };
  };
  const originalsIntact = async (manifest) => {
    for (const item of manifest.outputs)
      assert.equal(
        await readFile(
          item.kind === "pngSequence" ? join(item.destination, "old.txt") : item.destination,
          "utf8",
        ),
        "old",
      );
  };
  const fill = async (state) => {
    for (const [index, item] of original.outputs.entries()) {
      const receipt = processReport.cases.find((c) => c.id === item.id).receipt;
      await state.publisher.importNativeOutput(item.id, item.destination, receipt);
      await originalsIntact(state.manifest);
      if (index === 0) await assert.rejects(state.publisher.publish(), /sequence/);
    }
  };
  try {
    const success = await make("complete");
    await fill(success);
    await success.publisher.publish();
    for (const item of success.manifest.outputs) {
      const native = original.outputs.find((o) => o.id === item.id);
      const receipt = processReport.cases.find((c) => c.id === item.id).receipt;
      if (item.kind === "pngSequence") {
        for (const image of receipt.images) {
          const name = `frame_${String(original.startFrame + image.index + 1).padStart(6, "0")}.png`;
          assert.equal(await hashFile(join(item.destination, name)), image.png_sha256);
        }
        assert.equal(existsSync(join(item.destination, "old.txt")), false);
      } else assert.equal(await hashFile(item.destination), await hashFile(native.destination));
    }
    report.cases.push({
      id: "atomic-mixed-native-outputs",
      status: "passed",
      incomplete_publish_rejected: true,
      exact: true,
    });
    const cancelled = await make("cancelled");
    await fill(cancelled);
    const first = cancelled.manifest.outputs[0].destination;
    await assert.rejects(
      cancelled.publisher.publish(() => existsSync(first) && statSync(first).size !== 3),
      /cancelled/,
    );
    await originalsIntact(cancelled.manifest);
    await cancelled.publisher.cleanup();
    await originalsIntact(cancelled.manifest);
    report.cases.push({
      id: "cancel-during-native-publication-restores-all-originals",
      status: "passed",
    });
    const changed = await make("changed");
    await fill(changed);
    const video = processReport.cases.find((c) => c.id === "video");
    await writeFile(
      changed.publisher.mp4StagingPath("video"),
      Buffer.alloc(video.receipt.report.output_bytes),
    );
    await assert.rejects(changed.publisher.publish(), /bytes differ/);
    await originalsIntact(changed.manifest);
    report.cases.push({ id: "changed-staged-video-rejected", status: "passed" });
    report.status = "passed";
  } catch (error) {
    report.error = String(error?.stack ?? error);
  } finally {
    await Promise.all(publishers.map((p) => p.cleanup()));
  }
  await writeAtomicJson(join(output, "report.json"), report);
  return report;
}
