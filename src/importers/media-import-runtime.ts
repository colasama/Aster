import type { ImageSequenceSelection, SequenceFileLike } from "./image-sequence";
import type { MissingSequenceFramePolicy } from "./image-sequence-runtime";
import type { PsdImportMode } from "./psd-composition";
import type { ParsedSvgSource } from "./svg";

export interface RuntimeSequenceFile extends SequenceFileLike {
  url: string;
}

export interface RuntimePsdLayer {
  kind: "psd";
  documentIdentity: string;
  importMode: PsdImportMode;
  decodedWidth: number;
  decodedHeight: number;
  crop: readonly [number, number, number, number];
  pixels: Uint8ClampedArray;
}

export interface RuntimeSvgSource {
  kind: "svg";
  parsed: ParsedSvgSource;
}

export interface RuntimeImageSequence {
  kind: "imageSequence";
  selection: ImageSequenceSelection<RuntimeSequenceFile>;
  frameRate: { numerator: number; denominator: number };
  missingFramePolicy: MissingSequenceFramePolicy;
  loop: boolean;
}

export type RuntimeMediaImport = RuntimePsdLayer | RuntimeSvgSource | RuntimeImageSequence;

type RuntimeEntry = {
  value: RuntimeMediaImport;
  dispose?: () => void;
};

/**
 * Keeps heavyweight decoded/import-only state outside project snapshots. Project operations and
 * undo therefore clone only small immutable metadata instead of PSD planes or sequence files.
 */
class MediaImportRuntimeRegistry {
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #errors = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;

  get(sourceId: string): RuntimeMediaImport | undefined {
    return this.#entries.get(sourceId)?.value;
  }

  has(sourceId: string): boolean {
    return this.#entries.has(sourceId);
  }

  error(sourceId: string): string | undefined {
    return this.#errors.get(sourceId);
  }

  revision = (): number => this.#revision;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  register(sourceId: string, value: RuntimeMediaImport, dispose?: () => void): void {
    this.remove(sourceId);
    this.#entries.set(sourceId, { value, ...(dispose ? { dispose } : {}) });
    this.#emit();
  }

  move(fromSourceId: string, toSourceId: string): void {
    if (fromSourceId === toSourceId) return;
    const entry = this.#entries.get(fromSourceId);
    if (!entry) return;
    this.remove(toSourceId);
    this.#entries.delete(fromSourceId);
    this.#entries.set(toSourceId, entry);
    const error = this.#errors.get(fromSourceId);
    this.#errors.delete(fromSourceId);
    if (error) this.#errors.set(toSourceId, error);
    this.#emit();
  }

  reportError(sourceId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.#errors.get(sourceId) === message) return;
    this.#errors.set(sourceId, message);
    this.#emit();
  }

  clearError(sourceId: string): void {
    if (!this.#errors.delete(sourceId)) return;
    this.#emit();
  }

  remove(sourceId: string): void {
    const entry = this.#entries.get(sourceId);
    if (!entry) return;
    this.#entries.delete(sourceId);
    this.#errors.delete(sourceId);
    entry.dispose?.();
    this.#emit();
  }

  clear(): void {
    for (const sourceId of [...this.#entries.keys()]) this.remove(sourceId);
  }

  #emit(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}

export const mediaImportRuntime = new MediaImportRuntimeRegistry();

export function runtimeSourceLocator(sourceId: string): string {
  return `aster-runtime://media/${encodeURIComponent(sourceId)}`;
}
