# Security policy

Do not file public issues for vulnerabilities. Use GitHub private vulnerability reporting for the
repository, including affected versions, reproduction steps, impact, and any proposed mitigation.

## Supported versions

Until the first stable release, only the latest commit on the default branch receives security fixes.

## Security boundaries

- Project bundles are untrusted input and must be schema-validated before use.
- Plugins are denied undeclared filesystem, network, GPU, and process capabilities.
- Pi runs in an isolated utility process with Aster-owned tools only. Project edits are typed,
  revision-addressed, staged, and merged as one undoable transaction.
- Full Access requires typed confirmation plus a native warning, is scope/expiry bound, and can be
  revoked with an emergency stop. Privileged tools remain unavailable without an effective grant;
  plugin management, project packaging, and asset linking reuse the typed native bridge.
- API keys are read from memory or `ASTER_AI_API_KEY`, never serialized or logged.
- Native paths use canonicalization, bounded sizes, and atomic replacement where applicable.

We aim to acknowledge reports within three business days and coordinate disclosure after a fix is
available.
