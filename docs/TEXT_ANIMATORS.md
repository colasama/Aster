# Text animators

Aster evaluates text animation by Unicode grapheme cluster and keeps animator properties separate
from selectors. An animator may stack Range, Wiggly, and Expression selectors. Selector Mode combines
each result with those above it using Add, Subtract, Intersect, Min, Max, or Difference, and Amount
scales the animator property's influence.

Range selectors support Percentage and Index units; Characters, Characters Excluding Spaces, Words,
and Lines domains; Start, End, and Offset; Square, Ramp Up, Ramp Down, Triangle, Round, and Smooth
shapes; Smoothness; Ease High and Ease Low; and deterministic Randomize Order with a stable seed.
Wiggly selectors use seeded, temporally interpolated noise with minimum/maximum amount, wiggles per
second, correlation, temporal phase, and spatial phase. Expression selectors receive one-based
`textIndex`, `textTotal`, `selectorValue`, and time through Aster's bounded expression host rather than
executing arbitrary JavaScript in the renderer.

Start, End, Offset, Amount, range shaping controls, Wiggly controls, and every numeric animator
property are regular Aster animation tracks. Inspector edits at an animated property create or
replace a keyframe at the addressed layer time. Removing the final selector deliberately restores
After Effects' all-characters behavior.

Animator groups and selectors carry bounded, user-editable names. The Inspector can add, duplicate,
remove, rename, and reorder both groups and selector stacks. Duplication inserts after the source and
creates independent nested tracks with fresh persistent and keyframe IDs.

Selector evaluation is time-addressable and stateless: evaluating the same text, selector stack, and
time produces the same values during interactive preview, seeking, background rendering, and export.
Randomized range order never depends on call order or frame history.

Expressions are tokenized and compiled to a bounded numeric AST once per source, with a 128-entry
LRU. Both compile and non-finite runtime failures are latched: rendering falls back to the upstream
`selectorValue`, while the Inspector exposes the same error beside the source. Selector tracks and
property tracks are evaluated once per selector/property object and time sample, not once per
grapheme. Segmentation uses a bounded 64-entry/32768-unit LRU.

Animator groups are evaluated in stack order. Position, anchor point, 3D rotation, skew, tracking,
line layout, character offset, and blur are additive; scale and opacity preserve their AE neutral
values of 100%; fill and stroke colors blend in group order. Grapheme segmentation produces all
Characters, Characters Excluding Spaces, Words, and Lines indices once per text layout, so selector
work remains linear and can be cached by text content.

The shared text raster path applies per-grapheme anchor, XYZ position, XYZ rotation, scale, skew and
axis, opacity, fill, stroke, stroke width, tracking, line anchor/spacing, character replacement, and
blur. Line Anchor is a scalar tracking alignment: 0% keeps the left edge fixed, 50% centers the
tracking expansion, and 100% keeps the right edge fixed. It offsets each line once from the total
animator tracking delta, weighted by the Line Anchor of each affected glyph gap; it never adds a
per-glyph Y offset. Line Spacing accumulates by visual line index, so the first line stays fixed and
later baselines move relative to it. Character Offset and Character Value always persist Character
Range. Preserve Case & Digits wraps uppercase Latin, lowercase Latin, and digits inside their
respective groups; Full Unicode addresses the complete valid code-point range.

X/Y rotation, Z position, Z anchor, and Z scale use a deterministic 2.5D projection into the layer
texture. This is intentionally not a claim of camera-space glyph meshes, inter-glyph depth sorting,
or occlusion. WebGPU preview, Canvas fallback, seeking, background render, and export all call the
same time-addressed evaluator; only the final texture upload differs.

When the composition and text-layer Motion Blur switches are both enabled, time-varying animator
geometry bypasses the ordinary frame-rate raster cache. The renderer evaluates the canonical shutter
samples at exact layer-source times, including time remapping and isolated 3D precomposition
namespaces. Adaptive sampling uses a conservative displacement bound across anchor, position, scale,
rotation, skew, tracking, line layout, character replacement, and blur. Static text and disabled
switches do not create a temporal pipeline, extra raster, or extra GPU pass.

Each sample includes the animator's visual Gaussian blur before motion-blur accumulation. WebGPU
accumulates linear premultiplied color and alpha in HDR precision, then resolves once to the
straight-alpha sRGB texture contract consumed by the normal text/material shader. Texture-local
glyph motion and the layer quad's world-space motion vectors remain separate, so a static layer can
show character motion, a moving layer with static characters stays on the vector-only fast path, and
both types of motion can be combined without counting either transform twice.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/desktop/animating-text/text-animation/animating-text.html>
