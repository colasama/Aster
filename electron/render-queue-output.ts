import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import type { RenderJobManifest, RenderOutputModule } from "../src/core/render-queue.js";

const MAX_PNG_BYTES = 512 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface OutputTarget {
  output: RenderOutputModule;
  destination: string;
  stagingPath: string;
  backupPath: string;
  writtenFrames: Set<number>;
}

/** Stages every module beside its destination and publishes only after all modules are complete. */
export class AtomicRenderOutputPublisher {
  readonly #manifest: RenderJobManifest;
  readonly #targets: Map<string, OutputTarget>;
  #prepared = false;
  #published = false;

  constructor(manifest: RenderJobManifest, leaseId: string) {
    this.#manifest = structuredClone(manifest);
    const destinations = new Set<string>();
    this.#targets = new Map(
      manifest.outputs.map((output) => {
        validateOutput(output, manifest);
        const destination = resolveOutputDestination(output.destination);
        const destinationKey =
          process.platform === "win32" ? destination.toLocaleLowerCase() : destination;
        if (destinations.has(destinationKey))
          throw new Error("Render outputs cannot publish to the same destination");
        destinations.add(destinationKey);
        const token = createHash("sha256")
          .update(`${manifest.id}:${leaseId}:${output.id}`)
          .digest("hex")
          .slice(0, 20);
        const parent = dirname(destination);
        const name = basename(destination);
        const stagingName =
          output.kind === "pngSequence"
            ? `.${name}.aster-${token}.tmp`
            : `.${name}.aster-${token}.tmp${extname(destination)}`;
        return [
          output.id,
          {
            output,
            destination,
            stagingPath: join(parent, stagingName),
            backupPath: join(parent, `.${name}.aster-${token}.backup`),
            writtenFrames: new Set<number>(),
          },
        ];
      }),
    );
  }

  async prepare(): Promise<void> {
    if (this.#prepared) throw new Error("Render output publisher is already prepared");
    try {
      for (const target of this.#targets.values()) {
        const parent = await stat(dirname(target.destination)).catch(() => undefined);
        if (!parent?.isDirectory()) throw new Error("Render output parent must exist");
        await rm(target.stagingPath, { recursive: true, force: true });
        await rm(target.backupPath, { recursive: true, force: true });
        if (target.output.kind === "pngSequence")
          await mkdir(target.stagingPath, { recursive: false });
      }
      this.#prepared = true;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  mp4StagingPath(outputId: string): string {
    const target = this.#target(outputId, "mp4");
    return target.stagingPath;
  }

  async writePng(outputId: string, frame: number, value: ArrayBuffer): Promise<void> {
    this.#requirePrepared();
    const target = this.#targets.get(outputId);
    if (!target || (target.output.kind !== "pngSequence" && target.output.kind !== "still"))
      throw new Error("Render PNG output is invalid");
    if (!(value instanceof ArrayBuffer) || value.byteLength < PNG_SIGNATURE.length)
      throw new Error("Render PNG payload is invalid");
    if (value.byteLength > MAX_PNG_BYTES) throw new Error("Render PNG payload exceeds its bound");
    const bytes = new Uint8Array(value);
    if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte))
      throw new Error("Render PNG payload has an invalid signature");
    if (!Number.isSafeInteger(frame)) throw new Error("Render PNG frame index is invalid");
    if (target.output.kind === "still") {
      if (frame !== target.output.frame)
        throw new Error("Render still frame does not match output");
    } else if (frame < this.#manifest.startFrame || frame >= this.#manifest.endFrameExclusive)
      throw new Error("Render sequence frame is outside the manifest range");
    if (target.writtenFrames.has(frame)) throw new Error("Render PNG frame was written twice");
    const path =
      target.output.kind === "still"
        ? target.stagingPath
        : join(target.stagingPath, sequenceFileName(target.output.fileNamePattern, frame));
    await writeFile(path, bytes, { flag: "wx" });
    target.writtenFrames.add(frame);
  }

  async publish(aborted: () => boolean = () => false): Promise<void> {
    this.#requirePrepared();
    if (this.#published) throw new Error("Render outputs are already published");
    await this.#verifyComplete();
    assertPublishActive(aborted);
    const backedUp: OutputTarget[] = [];
    const published: OutputTarget[] = [];
    try {
      for (const target of this.#targets.values()) {
        assertPublishActive(aborted);
        const existing = await lstat(target.destination).catch(() => undefined);
        if (existing) {
          const expectedDirectory = target.output.kind === "pngSequence";
          if (existing.isSymbolicLink() || existing.isDirectory() !== expectedDirectory)
            throw new Error("Existing render destination has an incompatible type");
          await rename(target.destination, target.backupPath);
          backedUp.push(target);
        }
        assertPublishActive(aborted);
      }
      for (const target of this.#targets.values()) {
        assertPublishActive(aborted);
        await rename(target.stagingPath, target.destination);
        published.push(target);
        assertPublishActive(aborted);
      }
      this.#published = true;
      await Promise.all(
        backedUp.map((target) => rm(target.backupPath, { recursive: true, force: true })),
      );
    } catch (error) {
      for (const target of published.reverse())
        await rm(target.destination, { recursive: true, force: true }).catch(() => undefined);
      for (const target of backedUp.reverse())
        await rename(target.backupPath, target.destination).catch(() => undefined);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      [...this.#targets.values()].flatMap((target) => [
        rm(target.stagingPath, { recursive: true, force: true }),
        rm(target.backupPath, { recursive: true, force: true }),
      ]),
    );
  }

  async #verifyComplete(): Promise<void> {
    for (const target of this.#targets.values()) {
      if (target.output.kind === "pngSequence") {
        const expected = this.#manifest.endFrameExclusive - this.#manifest.startFrame;
        if (target.writtenFrames.size !== expected)
          throw new Error("PNG sequence did not render every manifest frame");
      } else if (target.output.kind === "still") {
        if (!target.writtenFrames.has(target.output.frame))
          throw new Error("Still output was not rendered");
      } else {
        const metadata = await stat(target.stagingPath).catch(() => undefined);
        if (!metadata?.isFile() || metadata.size < 1)
          throw new Error("MP4 staging output is incomplete");
      }
    }
  }

  #target<Kind extends RenderOutputModule["kind"]>(
    outputId: string,
    kind: Kind,
  ): OutputTarget & { output: Extract<RenderOutputModule, { kind: Kind }> } {
    const target = this.#targets.get(outputId);
    if (!target || target.output.kind !== kind) throw new Error(`Render ${kind} output is invalid`);
    return target as OutputTarget & { output: Extract<RenderOutputModule, { kind: Kind }> };
  }

  #requirePrepared(): void {
    if (!this.#prepared || this.#published)
      throw new Error("Render output publisher is not writable");
  }
}

function assertPublishActive(aborted: () => boolean): void {
  if (aborted()) throw new Error("Render output publish was cancelled");
}

function validateOutput(output: RenderOutputModule, manifest: RenderJobManifest): void {
  if (output.kind === "mp4") {
    if (output.codec !== "h264") throw new Error("Background RenderHost currently supports H.264");
    if (manifest.width % 2 !== 0 || manifest.height % 2 !== 0)
      throw new Error("H.264 output dimensions must be even");
  } else if (output.kind === "still") {
    if (output.format !== "png")
      throw new Error("Background RenderHost currently supports PNG stills");
    if (output.frame < manifest.startFrame || output.frame >= manifest.endFrameExclusive)
      throw new Error("Still output frame must be inside the manifest range");
  } else sequenceFileName(output.fileNamePattern, manifest.startFrame);
}

function resolveOutputDestination(value: string): string {
  if (!value || value.includes("\0") || !isAbsolute(value))
    throw new Error("Render output destination must be an absolute path");
  return resolve(value);
}

function sequenceFileName(pattern: string, frame: number): string {
  if (!pattern || basename(pattern) !== pattern || extname(pattern).toLowerCase() !== ".png")
    throw new Error("PNG sequence pattern must be a plain .png file name");
  const match = pattern.match(/\[(#+)\]/);
  const number = String(frame + 1).padStart(match?.[1].length ?? 6, "0");
  const fileName = match
    ? pattern.replace(match[0], number)
    : `${parse(pattern).name}_${number}.png`;
  if (fileName === "." || fileName === "..") throw new Error("PNG sequence pattern is invalid");
  return fileName;
}
