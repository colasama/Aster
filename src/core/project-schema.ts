import {
  BUILTIN_PARTICLE_API_VERSION,
  BUILTIN_PARTICLE_NODE_TYPE,
  BUILTIN_PARTICLE_PLUGIN_ID,
} from "./bundled-particle";
import { assertParticleSettings } from "./particle-settings";

export const CURRENT_PROJECT_SCHEMA_VERSION = 2 as const;

type ProjectDocument = Record<string, unknown>;
type ProjectMigration = (document: ProjectDocument) => ProjectDocument;

/** Add one deterministic vN -> vN+1 transform for every supported historical project schema. */
const PROJECT_MIGRATIONS = new Map<number, ProjectMigration>([
  [
    1,
    (document) => {
      const compositions = Array.isArray(document.compositions) ? document.compositions : [];
      for (const compositionValue of compositions) {
        if (!compositionValue || typeof compositionValue !== "object") continue;
        const composition = compositionValue as Record<string, unknown>;
        const layers = Array.isArray(composition.layers) ? composition.layers : [];
        for (const layerValue of layers) {
          if (!layerValue || typeof layerValue !== "object") continue;
          const layer = layerValue as Record<string, unknown>;
          if (layer.kind !== "particle" || !layer.particle) continue;
          assertParticleSettings(layer.particle, "legacy particle settings");
          layer.kind = "generator";
          layer.generator = {
            pluginId: BUILTIN_PARTICLE_PLUGIN_ID,
            nodeType: BUILTIN_PARTICLE_NODE_TYPE,
            apiVersion: BUILTIN_PARTICLE_API_VERSION,
            parameters: layer.particle,
          };
          delete layer.particle;
        }
      }
      document.schemaVersion = 2;
      return document;
    },
  ],
]);

export function cloneCurrentProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("project must be an object");
  const source = value as ProjectDocument;
  if (!Number.isSafeInteger(source.schemaVersion) || Number(source.schemaVersion) < 0)
    throw new Error(
      `Unsupported Aster project schema v${String(source.schemaVersion)}; the version must be a non-negative integer`,
    );
  let version = Number(source.schemaVersion);
  if (version > CURRENT_PROJECT_SCHEMA_VERSION)
    throw new Error(
      `Aster project schema v${version} is newer than this build (v${CURRENT_PROJECT_SCHEMA_VERSION})`,
    );
  let document = structuredClone(source);
  while (version < CURRENT_PROJECT_SCHEMA_VERSION) {
    const migration = PROJECT_MIGRATIONS.get(version);
    if (!migration)
      throw new Error(
        `No Aster project migration is registered from v${version} to v${version + 1}`,
      );
    document = migration(document);
    version += 1;
    if (document.schemaVersion !== version)
      throw new Error(`Aster project migration to v${version} produced an invalid document`);
  }
  return document;
}
