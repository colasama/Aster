export const CURRENT_PROJECT_SCHEMA_VERSION = 1 as const;

type ProjectDocument = Record<string, unknown>;
type ProjectMigration = (document: ProjectDocument) => ProjectDocument;

const migrations: ProjectMigration[] = [migrateV0ToV1];

export function migrateProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("project must be an object");
  const source = value as ProjectDocument;
  const version = source.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0)
    throw new Error("project.schemaVersion must be a non-negative integer");
  if ((version as number) > CURRENT_PROJECT_SCHEMA_VERSION)
    throw new Error(`Unsupported Aster project schema v${version}`);

  let document = structuredClone(source);
  while ((document.schemaVersion as number) < CURRENT_PROJECT_SCHEMA_VERSION) {
    const migration = migrations[document.schemaVersion as number];
    if (!migration)
      throw new Error(`No migration is registered for project schema v${document.schemaVersion}`);
    document = migration(document);
  }
  return document;
}

function migrateV0ToV1(document: ProjectDocument): ProjectDocument {
  return {
    ...document,
    schemaVersion: 1,
    commandLog: Array.isArray(document.commandLog) ? document.commandLog : [],
  };
}
