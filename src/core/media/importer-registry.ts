import type { Composition, FootageSource } from "../types";

export interface ImportContext {
  composition: Pick<Composition, "width" | "height" | "duration">;
  currentTime: number;
  mediaOptions?: { runtimeUrl?: string; sourcePath?: string };
}

export interface SourceImporter {
  readonly id: string;
  probe(file: File): number | Promise<number>;
  validate(file: File): void | Promise<void>;
  import(file: File, context: ImportContext): Promise<FootageSource>;
}

export class ImporterRegistry {
  readonly #importers = new Map<string, SourceImporter>();

  register(importer: SourceImporter): void {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(importer.id))
      throw new Error("Importer id is invalid");
    if (this.#importers.has(importer.id))
      throw new Error(`Importer ${importer.id} is already registered`);
    this.#importers.set(importer.id, importer);
  }

  get(id: string): SourceImporter | undefined {
    return this.#importers.get(id);
  }

  async select(file: File): Promise<SourceImporter> {
    let selected: { importer: SourceImporter; score: number } | undefined;
    for (const importer of this.#importers.values()) {
      const score = await importer.probe(file);
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new Error(`Importer ${importer.id} returned an invalid probe score`);
      if (score > 0 && (!selected || score > selected.score)) selected = { importer, score };
    }
    if (!selected) throw new Error("No registered importer accepts this file");
    return selected.importer;
  }

  async import(file: File, context: ImportContext, importerId?: string): Promise<FootageSource> {
    const importer = importerId ? this.#importers.get(importerId) : await this.select(file);
    if (!importer) throw new Error(`Importer ${importerId} is not registered`);
    await importer.validate(file);
    return importer.import(file, context);
  }

  descriptors(): ReadonlyArray<{ id: string }> {
    return [...this.#importers.values()].map(({ id }) => ({ id }));
  }
}
