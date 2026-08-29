# Image sequence import

Aster recognizes padded numeric image sequences without mixing prefixes, extensions, or padding
widths. Sequence playback uses rational composition time, so seeking and background rendering select
the same requested frame without accumulated floating-point frame drift.

Missing frames are explicit. The default policy holds the previous available frame; Nearest and
Error policies are available for review and strict delivery workflows. The resolver uses a binary
search over sorted frames.

Decoded frames live in a bounded LRU cache keyed by frame number plus file identity. Concurrent
requests for one frame share a decode, changed files produce a new cache entry, and playback preloads
nearest frames first with bounded concurrency. Count and byte budgets prevent long sequences from
growing memory without limit; eviction releases renderer resources through the cache disposer.

Native save and autosave stream at most 4096 picker-authorized frames into content-addressed bundle
assets. The project retains relative paths, byte identities, frame sizes, timestamps, and pattern
bounds; session object URLs are never persisted. Reopen and packed-project load fail with the exact
missing or changed frame path before replacing the active runtime sequence. Browser JSON and browser
recovery use the same metadata with a 128 MiB self-contained payload ceiling.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/using/preparing-importing-still-images.html>
