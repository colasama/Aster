import {
  BUILTIN_PARTICLE_API_VERSION,
  BUILTIN_PARTICLE_NODE_TYPE,
  BUILTIN_PARTICLE_PLUGIN_ID,
} from "./bundled-particle";
import { sourceContentIdentity } from "./footage-source";
import { assertParticleSettings } from "./particle-settings";

export const CURRENT_PROJECT_SCHEMA_VERSION = 5 as const;

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
  [
    2,
    (document) => {
      document.schemaVersion = 3;
      return document;
    },
  ],
  [
    3,
    (document) => {
      const sources: Array<Record<string, unknown>> = [];
      const sourceByIdentity = new Map<string, Record<string, unknown>>();
      const assignments =
        document.itemFolderIds && typeof document.itemFolderIds === "object"
          ? (document.itemFolderIds as Record<string, unknown>)
          : {};
      const compositions = Array.isArray(document.compositions) ? document.compositions : [];
      for (const compositionValue of compositions) {
        if (!compositionValue || typeof compositionValue !== "object") continue;
        const composition = compositionValue as Record<string, unknown>;
        const layers = Array.isArray(composition.layers) ? composition.layers : [];
        for (const layerValue of layers) {
          if (!layerValue || typeof layerValue !== "object") continue;
          const layer = layerValue as Record<string, unknown>;
          if (!layer.asset || typeof layer.asset !== "object") continue;
          const asset = layer.asset as Record<string, unknown>;
          const kind = layer.kind === "video" ? "video" : "still";
          const deduplicationKey = legacyAssetDeduplicationKey(asset, kind);
          const identity = sourceContentIdentity({
            mimeType: String(asset.mimeType ?? "application/octet-stream"),
            dataUrl: typeof asset.dataUrl === "string" ? asset.dataUrl : undefined,
            relativePath: typeof asset.relativePath === "string" ? asset.relativePath : undefined,
            runtimeUrl: typeof asset.runtimeUrl === "string" ? asset.runtimeUrl : undefined,
            width: Number(asset.width ?? 1),
            height: Number(asset.height ?? 1),
            duration: kind === "video" ? Number(asset.duration ?? 0.001) : undefined,
          });
          let source = sourceByIdentity.get(deduplicationKey);
          if (!source) {
            const sourceId = uniqueLegacySourceId(identity, sources);
            source = {
              id: sourceId,
              kind,
              name: String(asset.name ?? layer.name ?? "Imported footage"),
              mimeType: String(asset.mimeType ?? "application/octet-stream"),
              contentIdentity: identity,
              ...(typeof asset.dataUrl === "string" ? { dataUrl: asset.dataUrl } : {}),
              ...(typeof asset.relativePath === "string"
                ? { relativePath: asset.relativePath }
                : {}),
              ...(typeof asset.runtimeUrl === "string" ? { runtimeUrl: asset.runtimeUrl } : {}),
              width: Number(asset.width ?? 1),
              height: Number(asset.height ?? 1),
              ...(kind === "video" ? { duration: Number(asset.duration ?? 0.001) } : {}),
              interpretation: { alpha: "straight", colorSpace: "srgb" },
            };
            sources.push(source);
            sourceByIdentity.set(deduplicationKey, source);
          }
          layer.sourceId = source.id;
          const layerId = typeof layer.id === "string" ? layer.id : undefined;
          if (
            layerId &&
            assignments[layerId] !== undefined &&
            assignments[String(source.id)] === undefined
          )
            assignments[String(source.id)] = assignments[layerId];
          if (layerId) delete assignments[layerId];
          delete layer.asset;
        }
      }
      document.sources = sources;
      document.itemFolderIds = assignments;
      document.schemaVersion = 4;
      return document;
    },
  ],
  [
    4,
    (document) => {
      const sources = Array.isArray(document.sources) ? document.sources : [];
      for (const sourceValue of sources) {
        if (!sourceValue || typeof sourceValue !== "object") continue;
        const source = sourceValue as Record<string, unknown>;
        if (source.kind === "audio" && source.streamIndex === undefined) source.streamIndex = 0;
      }
      const compositions = Array.isArray(document.compositions) ? document.compositions : [];
      for (const compositionValue of compositions) {
        if (!compositionValue || typeof compositionValue !== "object") continue;
        const composition = compositionValue as Record<string, unknown>;
        const layers = Array.isArray(composition.layers) ? composition.layers : [];
        for (const layerValue of layers) {
          if (!layerValue || typeof layerValue !== "object") continue;
          const layer = layerValue as Record<string, unknown>;
          if (layer.kind !== "video" && layer.kind !== "audio") continue;
          const normalizedGain =
            typeof layer.audioGain === "number" && Number.isFinite(layer.audioGain)
              ? Math.max(0, Math.min(1, layer.audioGain))
              : 1;
          const levelDb = normalizedGain <= 0 ? -192 : 20 * Math.log10(normalizedGain);
          layer.audio ??= {
            levelsDb: [levelDb, levelDb],
            pan: 0,
            muted: layer.audioEnabled === false,
            reversed: false,
          };
          delete layer.audioGain;
        }
      }
      document.schemaVersion = 5;
      return document;
    },
  ],
]);

function uniqueLegacySourceId(
  identity: string,
  sources: ReadonlyArray<Record<string, unknown>>,
): string {
  const base = `source-${identity.replace(/[^a-z0-9]/gi, "").slice(0, 32) || "legacy"}`;
  let candidate = base;
  let suffix = 2;
  while (sources.some((source) => source.id === candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function legacyAssetDeduplicationKey(asset: Record<string, unknown>, kind: string): string {
  if (typeof asset.dataUrl === "string") return asset.dataUrl;
  if (typeof asset.relativePath === "string") return `${kind}:relative:${asset.relativePath}`;
  if (typeof asset.runtimeUrl === "string") return `${kind}:runtime:${asset.runtimeUrl}`;
  return JSON.stringify([
    kind,
    asset.mimeType,
    asset.name,
    asset.width,
    asset.height,
    asset.duration,
  ]);
}

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
