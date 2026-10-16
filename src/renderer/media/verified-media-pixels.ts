import { requirePlan } from "../frame-plan/canonical";
import {
  contentResourceHash,
  contentResourceHashSync,
  validateResourceMessage,
} from "../frame-plan/resources";
import { type CapturedMediaPixels, validateMediaPixelLayout } from "./media-pixel-payload";

const verificationToken = Symbol("verified media pixels");

/** Process-local proof backed by private bytes, never by a caller-supplied hash alone. */
export class VerifiedMediaPixels {
  readonly #capture: CapturedMediaPixels;

  private constructor(token: symbol, capture: CapturedMediaPixels) {
    requirePlan(
      token === verificationToken,
      "invalid_resource",
      "Invalid pixel verification token",
    );
    this.#capture = capture;
  }

  static async verify(input: CapturedMediaPixels): Promise<VerifiedMediaPixels> {
    validateMediaPixelLayout(input);
    const capture = VerifiedMediaPixels.#snapshot(input);
    requirePlan(
      validateResourceMessage(capture.frame).type === "put_resource" &&
        validateResourceMessage(capture.pixels.message).type === "put_resource",
      "invalid_resource",
      "Media pixels require resource puts",
    );
    requirePlan(
      contentResourceHashSync(capture.frame) === capture.frame.hash &&
        (await contentResourceHash(capture.pixels.message, capture.pixels.bytes)) ===
          capture.pixels.message.hash,
      "hash_mismatch",
      "Media pixel payload hash differs",
    );
    return new VerifiedMediaPixels(verificationToken, capture);
  }

  // Static access authenticates the private-field brand even for forged prototypes.
  static byteLength(value: VerifiedMediaPixels): number {
    return value.#capture.pixels.bytes.length;
  }

  static frameHash(value: VerifiedMediaPixels): string {
    return value.#capture.frame.hash;
  }

  static copy(value: VerifiedMediaPixels): CapturedMediaPixels {
    return VerifiedMediaPixels.#snapshot(value.#capture);
  }

  static describe(value: VerifiedMediaPixels) {
    return {
      frame: structuredClone(value.#capture.frame),
      pixels: { message: structuredClone(value.#capture.pixels.message) },
    };
  }

  static copyResource(value: VerifiedMediaPixels) {
    return {
      message: structuredClone(value.#capture.pixels.message),
      bytes: new Uint8Array(value.#capture.pixels.bytes),
    };
  }

  /** Own only the pixel view, excluding unrelated bytes in a larger backing buffer. */
  static #snapshot(capture: CapturedMediaPixels): CapturedMediaPixels {
    return {
      frame: structuredClone(capture.frame),
      pixels: {
        message: structuredClone(capture.pixels.message),
        bytes: new Uint8Array(capture.pixels.bytes),
      },
    };
  }
}
