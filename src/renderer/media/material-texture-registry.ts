import { hash, requirePlan } from "../frame-plan/canonical";

type MaterialTextureRole = "normal" | "environment";

/** Index validated upload owners by content; lifetime remains with the acquisition cache. */
export class MaterialTextureRegistry {
  readonly #entries = new Map<string, { role: MaterialTextureRole; owners: Set<GPUTexture> }>();

  register(identity: string, role: MaterialTextureRole, texture: GPUTexture): void {
    hash(identity);
    let entry = this.#entries.get(identity);
    requirePlan(
      !entry || entry.role === role,
      "resource_conflict",
      "Material texture role differs",
    );
    if (!entry) {
      entry = { role, owners: new Set() };
      this.#entries.set(identity, entry);
    }
    entry.owners.add(texture);
  }

  retire(identity: string | undefined, texture: GPUTexture | undefined): void {
    if (!identity || !texture) return;
    const entry = this.#entries.get(identity);
    if (!entry) return;
    entry.owners.delete(texture);
    if (entry.owners.size === 0) this.#entries.delete(identity);
  }

  resolve(identity: string, role: MaterialTextureRole): GPUTexture {
    hash(identity);
    const entry = this.#entries.get(identity);
    requirePlan(entry, "missing_resource", "Prepared material texture is no longer resident");
    requirePlan(entry.role === role, "resource_conflict", "Material texture role differs");
    const texture = entry.owners.values().next().value;
    requirePlan(texture, "missing_resource", "Missing material texture owner");
    return texture;
  }
}
