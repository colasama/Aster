export const CURRENT_PROJECT_SCHEMA_VERSION = 1 as const;

type ProjectDocument = Record<string, unknown>;

export function cloneCurrentProjectDocument(value: unknown): ProjectDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("project must be an object");
  const source = value as ProjectDocument;
  if (source.schemaVersion !== CURRENT_PROJECT_SCHEMA_VERSION)
    throw new Error(
      `Unsupported Aster project schema v${String(source.schemaVersion)}; this MVP accepts only v${CURRENT_PROJECT_SCHEMA_VERSION}`,
    );
  return structuredClone(source);
}
