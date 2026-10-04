/** A caller-owned document revision within one loaded or derived snapshot lineage. */
export interface RenderSnapshotIdentity {
  readonly snapshotScope: string;
  readonly projectRevision: number;
}

export function validateRenderSnapshotIdentity(value: RenderSnapshotIdentity): void {
  const scope = value?.snapshotScope;
  if (
    typeof scope !== "string" ||
    scope.length === 0 ||
    scope.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(scope) ||
    (/^[\x20-\x7e]*$/.test(scope) ? scope.length : new TextEncoder().encode(scope).byteLength) > 256
  )
    throw new Error("Render snapshot scope must contain 1..256 valid UTF-8 bytes without NUL");
  if (
    !Number.isSafeInteger(value.projectRevision) ||
    value.projectRevision < 0 ||
    Object.is(value.projectRevision, -0)
  )
    throw new Error("Render snapshot revision must be a non-negative safe integer");
}

export function copyRenderSnapshotIdentity(value: RenderSnapshotIdentity): RenderSnapshotIdentity {
  validateRenderSnapshotIdentity(value);
  return Object.freeze({
    snapshotScope: value.snapshotScope,
    projectRevision: value.projectRevision,
  });
}

export function editorRenderSnapshotIdentity(
  editorScope: string,
  loadRevision: number,
  projectRevision: number,
): RenderSnapshotIdentity {
  if (!Number.isSafeInteger(loadRevision) || loadRevision < 0 || Object.is(loadRevision, -0))
    throw new Error("Editor load revision must be a non-negative safe integer");
  return copyRenderSnapshotIdentity({
    snapshotScope: `${editorScope}:${loadRevision}`,
    projectRevision,
  });
}
