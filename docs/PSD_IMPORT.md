# PSD import

Aster decodes bounded PSD v1 RGB and grayscale documents at 8 or 16 bits per channel. Raw, PackBits,
ZIP, and ZIP-with-prediction channel data, Unicode names, persistent layer IDs, visibility, opacity,
blend keys, alpha, and folder section markers are preserved. ZIP inflation streams into the exact
declared plane allocation and cancels on overflow. Input and decoded-memory budgets are both bounded
at 512 MiB.

Supported import modes:

- **Merged** uses the embedded composite as one footage source.
- **Composition** keeps layers separate on document-sized logical surfaces.
- **Composition – Retain Layer Sizes** gives each layer its own pixel bounds, centered anchor, and
  original document-space position.

Composition plans retain the decoded pixel buffers and describe upload origin and crop metadata,
avoiding a document-sized CPU allocation per layer. PSD blend modes with exact Aster equivalents are
preserved; unsupported modes produce a per-layer warning and a deterministic Normal fallback rather
than silently claiming parity.

Project persistence keeps the original compressed PSD once per document identity. Separate imported
layers reference stable plan keys, so save, autosave, reopen, recovery, and packed-project hydration
reparse one bounded document instead of duplicating original bytes or decoded planes per layer.
Native saves stream the selected document into the bundle and never persist its absolute path.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/using/preparing-importing-still-images.html>
