# Semantic vector compositing

The Enchanted Love reconstruction in `examples/projects/enchanted-love` uses small native paths,
primitive shapes, articulated null hierarchies, reusable compositions, and time-addressable curves.
It does not render traced frame contours or embed the reference video as its visual output.

## GPU group effects

`needsPrecompositionSurface` is shared by scene evaluation and project render-boundary validation.
A 2D wrapper with enabled effects takes the existing precomposition surface path; its source is
evaluated at mapped local time and composited before its effect chain runs. Masks, crop, and colour
overlay therefore operate on the combined group alpha. Switching the effect off returns the group
to ordinary flattening. Wrapper size and anchor remain editable without changing source dimensions.
Flattened geometry and generators retain their evaluated local time in the render stack. Effect
parameters use that time in both the main renderer and isolated surface renderer, so a moved or
retimed shot does not sample its masks at the master timeline's time.

Source surfaces are shared by composition, time, revision, and target size. Existing count, depth,
pixel, and VRAM budgets remain in force, including the diagnostic on downgrade or exhaustion. No CPU
image readback is introduced. The reconstruction groups whole spotlight actors or a complete shadow
pass instead of allocating one effect surface per limb.

## Shape and rig corrections

Rectangle distance evaluation uses width/height relative to the smaller dimension. Circular corners
therefore retain their radius on tall or wide rectangles instead of becoming elliptical. The two
otherwise unused rectangle dash slots carry the metric aspect in the existing vertex layout. Colour
and auxiliary surface passes use the same metric. Ellipse, line dash, and mesh attributes keep their
existing interpretation; there is no plugin or project ABI change.

Parent and nested 2D transformations reverse child Z rotation under an odd number of XY reflections.
This keeps a mirrored puppet's upper and lower limbs connected. General nonuniform affine shear and
arbitrary 3D parent matrices remain outside this change.
Bezier stroke tessellation also preserves the sign when converting back from scaled coordinates;
mirroring a path no longer reflects its fill and stroke in different directions.

## Verification

Regression tests cover switching group effects on/off, mapped source time, retained wrapper size,
parent and nested reflections, and tall/wide/mirrored rectangle metrics. Native GPU captures exercise
the same features together in the spotlight, pool shadows, staircase lighting, and mirrored profile
shots. Preview measurement uses visible Electron playback at 1280 × 848, full quality and FXAA; it
records distinct 30 fps source frames in addition to GPU submissions. Submission rate alone is not a
playback-frame-rate result. Per-run data and the exported project are written under `artifacts`.
