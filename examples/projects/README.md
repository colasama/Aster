# Reproducible project fixtures

`minimal-golden.aster.json` is Aster's smallest deterministic visual fixture. It contains no external
assets or installed-font dependency: a 320×180 composition renders one static background and one
linearly animated disc using stable IDs, rational 60 fps timing, and fixed capture frames.

`minimal-golden.manifest.json` pins the exact project bytes, dimensions, frame indices, pixel format,
color space, alpha convention, and comparison tolerance. The frontend fixture test validates the
project against the current MVP schema and verifies its SHA-256 before any renderer test uses it.

Run the fixture gate with:

```shell
pnpm vitest run src/core/project/golden-project-fixture.test.ts
```

To create backend-specific golden images, load the project without editing it, render the five frame
indices from the manifest by evaluating `frameIndex × denominator / numerator`, read back the final
premultiplied RGBA8 target, and store lossless PNGs under a directory named for the adapter backend.
Record the Aster commit, adapter, driver, backend, and manifest hash beside the images. Compare each
channel in linearized space using the manifest tolerance; never regenerate expected images as part of
the test that compares them.

This fixture proves that the input is reproducible. It does not by itself complete the Golden image or
cross-backend comparison milestones; those require committed reference PNGs captured and approved on
the corresponding GPU backends.
