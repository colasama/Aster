import {
  BUILTIN_PARTICLE_API_VERSION,
  BUILTIN_PARTICLE_NODE_TYPE,
  BUILTIN_PARTICLE_PLUGIN_ID,
} from "./bundled-particle";
import { sourceContentIdentity } from "./footage-source";
import { assertParticleSettings } from "./particle-settings";

export const CURRENT_PROJECT_SCHEMA_VERSION = 7 as const;

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
  [
    5,
    (document) => {
      const compositions = Array.isArray(document.compositions) ? document.compositions : [];
      for (const compositionValue of compositions) {
        if (!compositionValue || typeof compositionValue !== "object") continue;
        const composition = compositionValue as Record<string, unknown>;
        const width = positiveNumber(composition.width, 1920);
        const height = positiveNumber(composition.height, 1080);
        const layers = Array.isArray(composition.layers) ? composition.layers : [];
        for (const layerValue of layers) {
          if (!layerValue || typeof layerValue !== "object") continue;
          const layer = layerValue as Record<string, unknown>;
          if (layer.kind !== "camera" || !layer.camera || typeof layer.camera !== "object")
            continue;
          const legacy = layer.camera as Record<string, unknown>;
          if (typeof legacy.zoom === "number") continue;
          const fieldOfView = boundedNumber(legacy.fieldOfView, 1, 179, 50);
          const zoom = height / (2 * Math.tan((fieldOfView * Math.PI) / 360));
          const filmSize = 36;
          const focalLength = (zoom * filmSize) / width;
          layer.camera = {
            mode: "oneNode",
            projection: legacy.projection === "orthographic" ? "orthographic" : "perspective",
            zoom,
            filmSize,
            focalLength,
            orthographicSize: boundedNumber(legacy.orthographicSize, 1, 10_000_000, height),
            pointOfInterest: [
              staticProperty(width * 0.5),
              staticProperty(height * 0.5),
              staticProperty(0),
            ],
            orientation: [staticProperty(0), staticProperty(0), staticProperty(0)],
            depthOfField: false,
            focusDistance: zoom,
            lockFocusToZoom: true,
            aperture: focalLength / 2.8,
            fStop: 2.8,
            blurLevel: 100,
            focusAreaWidth: 0,
            nearBlurLevel: 100,
            farBlurLevel: 100,
            renderQuality: 50,
          };
          const transform =
            layer.transform && typeof layer.transform === "object"
              ? (layer.transform as Record<string, unknown>)
              : undefined;
          if (transform && Array.isArray(transform.position) && transform.position.length === 3)
            transform.position[2] = offsetProperty(transform.position[2], -zoom);
        }
      }
      document.schemaVersion = 6;
      return document;
    },
  ],
  [
    6,
    (document) => {
      const compositions = Array.isArray(document.compositions) ? document.compositions : [];
      for (const compositionValue of compositions) {
        if (!compositionValue || typeof compositionValue !== "object") continue;
        const composition = compositionValue as Record<string, unknown>;
        composition.motionBlur = {
          enabled: false,
          shutterAngle: 180,
          shutterPhase: -90,
          samplesPerFrame: 8,
          adaptiveSampleLimit: 32,
        };
        const layers = Array.isArray(composition.layers) ? composition.layers : [];
        for (const layerValue of layers) {
          if (!layerValue || typeof layerValue !== "object") continue;
          (layerValue as Record<string, unknown>).motionBlur = false;
        }
      }
      document.schemaVersion = 7;
      return document;
    },
  ],
]);

function staticProperty(value: number): Record<string, unknown> {
  return { mode: "static", value };
}

function offsetProperty(value: unknown, offset: number): unknown {
  if (!value || typeof value !== "object") return staticProperty(offset);
  const property = value as Record<string, unknown>;
  if (property.mode === "static")
    return { ...property, value: finiteNumber(property.value, 0) + offset };
  if (property.mode !== "animated" || !Array.isArray(property.keyframes)) return value;
  return {
    ...property,
    keyframes: property.keyframes.map((keyframe) =>
      keyframe && typeof keyframe === "object"
        ? {
            ...(keyframe as Record<string, unknown>),
            value: finiteNumber((keyframe as Record<string, unknown>).value, 0) + offset,
          }
        : keyframe,
    ),
  };
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Math.max(minimum, Math.min(maximum, finiteNumber(value, fallback)));
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

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
