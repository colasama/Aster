export const CURRENT_PROJECT_SCHEMA_VERSION = 1 as const;

type ProjectDocument = Record<string, unknown>;
type ProjectMigration = (document: ProjectDocument) => ProjectDocument;

/** Add one deterministic vN -> vN+1 transform for every supported historical project schema. */
const PROJECT_MIGRATIONS = new Map<number, ProjectMigration>();

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
