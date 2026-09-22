import { EditError, encodedBytes } from "./edit-limits.js";

/** Receipts survive workspace commits, but not an application/session reset. */
export class RequestReceipts {
  readonly #entries = new Map<
    string,
    { fingerprint: string; value: Promise<unknown>; settled: boolean }
  >();

  async run(
    name: string,
    input: Record<string, unknown>,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    if (input.requestId === undefined) return execute();
    if (typeof input.requestId !== "string" || !/^[\w.-]{1,128}$/u.test(input.requestId))
      throw new EditError(
        "invalid_request_id",
        "requestId must contain 1–128 letters, digits, dots, underscores or hyphens",
      );
    const key = input.requestId;
    const source = JSON.stringify([name, canonical(input)]);
    if (encodedBytes(source) > 2 * 1024 * 1024)
      throw new EditError("request_too_large", "Request receipt exceeds 2 MiB");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const previous = this.#entries.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new EditError(
          "request_id_conflict",
          "requestId was already used with different arguments",
        );
      return previous.value.then((value) => structuredClone(value));
    }
    if (this.#entries.size >= 64) {
      const oldest = [...this.#entries].find(([, entry]) => entry.settled);
      if (!oldest) throw new EditError("busy", "Too many pending requests");
      this.#entries.delete(oldest[0]);
    }
    const entry = { fingerprint, settled: false, value: Promise.resolve().then(execute) };
    this.#entries.set(key, entry);
    entry.value = entry.value.then(
      (value) => {
        entry.settled = true;
        return structuredClone(value);
      },
      (error: unknown) => {
        entry.settled = true;
        throw error;
      },
    );
    return entry.value.then((value) => structuredClone(value));
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
