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
Flattening applies the wrapper's evaluated anchor offset before the source-to-wrapper size ratio,
including rotation and reflection. Animated off-center pivots therefore keep the same GPU corners
when an effect is enabled or disabled; ordinary groups still allocate no intermediate surface.
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

Analytic shape antialiasing uses the screen-space derivative of its signed distance instead of a
fixed UV width. Ellipses and rounded rectangles keep a pixel-sized edge when enlarged for a camera
move or iris transition. Derivatives execute before divergent fragment branches; this requires no
extra texture, render pass, or CPU work. In the 104-second native iris capture, three off-axis edge
samples reduced their intermediate-color span from 19 pixels to 1–2 pixels at 1280 × 848 with FXAA.

Parent and nested 2D transformations reverse child Z rotation under an odd number of XY reflections.
This keeps a mirrored puppet's upper and lower limbs connected. General nonuniform affine shear and
arbitrary 3D parent matrices remain outside this change.
Bezier stroke tessellation also preserves the sign when converting back from scaled coordinates;
mirroring a path no longer reflects its fill and stroke in different directions.

## Reusable motion assemblies

The example keeps pose parameters separate from character construction. A seated seesaw pose,
front-facing umbrella grip, and a sliding/recovery sequence use the same torso, head, tunic, and
joint hierarchy. The seesaw's riders share a rotating fulcrum. The sliding sequence evaluates one
camera angle and a ground distance; its foreground plane provides occlusion, while ring rotation
comes from travel divided by radius. These ordinary 2D hierarchies need no intermediate surface.

An umbrella pose strip morphs six canopy anchors between top, profile, and underside views and
foreshortens the handle. Instance time remapping chooses and advances each pitch. A single camera
pan moves the parade and its cloner-generated striped paper. The construction is independent of
frame sampling and adds no project schema or plugin ABI fields.

The crown staircase repeats a three-anchor tread/riser module beneath a sparse rolling path. A
single accelerating camera moves regularly spaced windows. The pool pose animates the head and
free arm within the existing joint hierarchy. Reunion riders share a turtle composition made from
a short shell path and analytic ellipses; staggered cloner columns form the floor. Independent iris
radius curves separate the outer wipe from the central crown medallion. These additions use the
existing project format and renderer, with no bitmap frame sequences or new runtime allocation path.

The dive sequence uses a periodic running rig, a foot-height anchor, a four-anchor retracting ledge,
and a shared destination camera. Position curves separate the airborne descent from water entry;
one reused rig surface supplies the submerged colour pass. Crop coordinates are relative to the
destination composition after placement, so the waterline crop follows its projected screen height.
The authoring morph helper converts target tangents and positions to the base path's units before
assigning the target. This prevents large paths with different normalization scales from shrinking
unexpectedly during a morph; it does not change the runtime path format or renderer.

## Verification

Regression tests cover switching group effects on/off, animated off-center pivots, mapped source time,
retained wrapper size, parent and nested reflections, and tall/wide/mirrored rectangle metrics.
Native GPU captures exercise
the same features together in the spotlight, pool shadows, staircase lighting, and mirrored profile
shots. Preview measurement uses visible Electron playback at 1280 × 848, full quality and FXAA; it
records distinct 30 fps source frames in addition to GPU submissions. Submission rate alone is not a
playback-frame-rate result. Per-run data and the exported project are written under `artifacts`.
