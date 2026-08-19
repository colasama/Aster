# Security policy

Do not file public issues for vulnerabilities. Use GitHub private vulnerability reporting for the
repository, including affected versions, reproduction steps, impact, and any proposed mitigation.

## Supported versions

Until the first stable release, only the latest commit on the default branch receives security fixes.

## Security boundaries

- Project bundles are untrusted input and must be schema-validated before use.
- Plugins are denied undeclared filesystem, network, GPU, and process capabilities.
- AI providers return proposed typed operations; users review and explicitly accept them.
- API keys are read from memory or `ASTER_AI_API_KEY`, never serialized or logged.
- Native paths use canonicalization, bounded sizes, and atomic replacement where applicable.

We aim to acknowledge reports within three business days and coordinate disclosure after a fix is
available.
