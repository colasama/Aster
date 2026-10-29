import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

interface SurfaceBridge {
  open(service: string): unknown;
  receive(endpoint: unknown, pid: number, sequence: number, width: number, height: number): Buffer;
  release(endpoint: unknown, sequence: number): void;
  close(endpoint: unknown): void;
}

/** Only the main process owns native pointers; the child sends audited Mach rights. */
export class MacosPreviewSurface {
  readonly service = `io.aster.preview.${randomUUID()}`;
  readonly #bridge: SurfaceBridge;
  readonly #endpoint: unknown;

  constructor() {
    this.#bridge = createRequire(import.meta.url)("../native/macos-surface.node") as SurfaceBridge;
    this.#endpoint = this.#bridge.open(this.service);
  }

  receive(pid: number, sequence: number, width: number, height: number): Buffer {
    return this.#bridge.receive(this.#endpoint, pid, sequence, width, height);
  }

  release(sequence: number): void {
    this.#bridge.release(this.#endpoint, sequence);
  }

  close(): void {
    this.#bridge.close(this.#endpoint);
  }
}
