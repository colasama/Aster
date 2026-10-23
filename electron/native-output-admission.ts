import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { admitNativeOutputFile, type NativeOutputFileIdentity } from "./native-output-file.js";
import {
  type NativeProjectExportExpectation,
  type NativeProjectExportReceipt,
  parseNativeProjectReceipt,
} from "./native-project-export-protocol.js";
import { readNativeProjectImages } from "./native-project-image-receipts.js";

/** Retain one authenticated receipt handle, regardless of the number of image files. */
export class NativeOutputAdmission {
  readonly #receipt: NativeProjectExportReceipt;
  readonly #expected: NativeProjectExportExpectation;
  readonly #source: string;
  readonly #path: (index: number) => string;
  #video?: NativeOutputFileIdentity;

  constructor(options: {
    receipt: NativeProjectExportReceipt;
    expected: NativeProjectExportExpectation;
    path: (index: number) => string;
  }) {
    this.#expected = structuredClone(options.expected);
    this.#source = options.expected.output;
    this.#path = options.path;
    this.#receipt = structuredClone(parseNativeProjectReceipt(options.receipt, this.#expected));
  }

  async copy(signal?: AbortSignal): Promise<void> {
    if (this.#expected.format === "mp4") {
      this.#video = await admitNativeOutputFile({
        source: this.#source,
        destination: this.#path(0),
        bytes: Number(this.#receipt.report.output_bytes),
        signal,
      });
      return;
    }
    if (this.#expected.format === "png-sequence") {
      const directory = await lstat(this.#source);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error("Native sequence directory is invalid");
    }
    for await (const image of readNativeProjectImages(
      this.#receipt,
      this.#expected,
      () => signal?.aborted ?? false,
    )) {
      await admitNativeOutputFile({
        source: image.member ? join(this.#source, image.member) : this.#source,
        destination: this.#path(image.index),
        bytes: image.bytes,
        sha256: image.png_sha256,
        size: { width: this.#expected.width, height: this.#expected.height },
        signal,
      });
    }
    signal?.throwIfAborted();
  }

  async verify(cancelled: () => boolean): Promise<void> {
    if (this.#expected.format === "mp4") {
      if (!this.#video) throw new Error("Native video not admitted");
      await admitNativeOutputFile({
        source: this.#path(0),
        ...this.#video,
        isCancelled: cancelled,
      });
      return;
    }
    for await (const image of readNativeProjectImages(this.#receipt, this.#expected, cancelled)) {
      await admitNativeOutputFile({
        source: this.#path(image.index),
        bytes: image.bytes,
        sha256: image.png_sha256,
        size: { width: this.#expected.width, height: this.#expected.height },
        isCancelled: cancelled,
      });
    }
  }
}
