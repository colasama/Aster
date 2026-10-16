import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exercise production whole-job admission and compressed replay for a captured quality clip. */
export async function exportNativeQualityJob(root, output, manifest, packets) {
  const { NativeExportJob } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-export-job.js"))
  );
  const job = new NativeExportJob({
    manifest,
    authorizedPaths: [],
    temporaryRoot: join(output, "native-temporary"),
    outputPath: join(output, "native.mp4"),
    binary: join(root, "target/release/aster-render-cli.exe"),
    compiler: join(root, "node_modules/electron/dist/dxcompiler.dll"),
    ffmpeg: join(root, "build/ffmpeg/ffmpeg.exe"),
    ffprobe: join(root, "build/ffmpeg/ffprobe.exe"),
  });
  try {
    const prepared = await job.prepare();
    assert.equal(prepared.accepted, true, prepared.reason);
    for (const [index, packet] of packets.entries()) {
      const admitted = await job.admit(index, {
        plan: Uint8Array.from(packet.plan).buffer,
        resources: packet.resources.map(({ message, bytes }) => ({
          message,
          bytes: Uint8Array.from(bytes).buffer,
        })),
      });
      assert.equal(admitted.accepted, true, admitted.reason);
    }
    const sealed = await job.seal();
    assert.equal(sealed.accepted, true, sealed.reason);
    await job.start();
    for (let index = 0; index < packets.length; index++) await job.render(index);
    return { output: await job.finish(), transport: job.transport };
  } finally {
    await job.dispose();
  }
}
