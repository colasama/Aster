import type { ImageSequenceSelection, SequenceFileLike } from "./image-sequence";
import type { MissingSequenceFramePolicy } from "./image-sequence-runtime";
import type { PsdImportMode } from "./psd-composition";
import type { ParsedSvgSource } from "./svg";

export interface RuntimeSequenceFile extends SequenceFileLike {
  url: string;
  /** Native source path retained only until the project bundle owns a copy. */
  path?: string;
  /** Verified byte identity populated by persisted projects. */
  byteIdentity?: string;
}

export interface RuntimePsdLayer {
  kind: "psd";
  documentIdentity: string;
  importMode: PsdImportMode;
  /** Stable plan key used to recover this layer from one deduplicated PSD document payload. */
  layerKey: string;
  /** Original compressed PSD bytes. All layers from one import share this immutable payload. */
  documentBytes?: Uint8Array;
  /** Native source path retained only until the project bundle owns a copy. */
  originalPath?: string;
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

export interface RuntimeMediaRegistration extends RuntimeEntry {
  sourceId: string;
}

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

  /** Atomically replaces project-owned runtime state after a complete hydration succeeds. */
  replace(
    registrations: readonly RuntimeMediaRegistration[],
    errors: ReadonlyMap<string, string> = new Map(),
  ): void {
    const nextIds = new Set<string>();
    for (const registration of registrations) {
      if (!registration.sourceId || nextIds.has(registration.sourceId))
        throw new Error("Runtime media hydration contains a duplicate source id");
      nextIds.add(registration.sourceId);
    }
    for (const entry of this.#entries.values()) entry.dispose?.();
    this.#entries.clear();
    this.#errors.clear();
    for (const registration of registrations)
      this.#entries.set(registration.sourceId, {
        value: registration.value,
        ...(registration.dispose ? { dispose: registration.dispose } : {}),
      });
    for (const [sourceId, message] of errors) this.#errors.set(sourceId, message);
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
    if (this.#entries.size === 0 && this.#errors.size === 0) return;
    for (const entry of this.#entries.values()) entry.dispose?.();
    this.#entries.clear();
    this.#errors.clear();
    this.#emit();
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
