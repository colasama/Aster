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

Selector evaluation is time-addressable and stateless: evaluating the same text, selector stack, and
time produces the same values during interactive preview, seeking, background rendering, and export.
Randomized range order never depends on call order or frame history.

Animator groups are evaluated in stack order. Position, anchor point, 3D rotation, skew, tracking,
line layout, character offset, and blur are additive; scale and opacity preserve their AE neutral
values of 100%; fill and stroke colors blend in group order. Grapheme segmentation produces all
Characters, Characters Excluding Spaces, Words, and Lines indices once per text layout, so selector
work remains linear and can be cached by text content.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/desktop/animating-text/text-animation/animating-text.html>
