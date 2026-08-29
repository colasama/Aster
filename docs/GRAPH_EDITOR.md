# Graph Editor

Aster's Graph Editor consumes the same property groups used by the timeline and renderer. It
automatically exposes animated Transform properties (including Anchor Point), camera Point of
Interest, orientation and optics, and every numeric effect parameter. Multiple selected layers share
one view; track identities are namespaced by layer so identical property paths cannot collide. Effect
tracks keep registry labels, units, steps and bounds instead of converting runtime names into i18n
keys.

Value graphs show each evaluated scalar component. Speed graphs use the exact analytic time
derivative. Position, Anchor Point and camera Point of Interest each become one non-negative vector
magnitude instead of three signed component curves. Auto mode chooses speed for those spatial
vectors and value for orientation, optics, effects and other transform properties. The optional
reference graph evaluates the other representation into an independent vertical range so velocity
units never distort the editable value range.

Bezier handles store one temporal cubic per segment. Value-graph handles edit the cubic control
points directly. Speed-graph handles convert height to units per second and horizontal reach to
normalized temporal influence, then write the equivalent cubic. Easy Ease produces zero endpoint
speed with one-third influence. Linear, Bezier, and Hold interpolation all use the canonical
time-addressed evaluator, so the graph, viewport, preview, and export cannot diverge. Moving,
copying/pasting, deleting, changing interpolation, or easing a collapsed spatial Speed key
synchronizes every keyed component from that same layer atomically. Effect replacements retain their
keyframe IDs; a complete remove/add replacement is committed inside one undo transaction. Choice and
toggle tracks are quantized and use Hold interpolation, while all effect values are clamped to their
registry domains.

Keyframes snap by screen-space distance to the current time, other visible keyframes, layer In/Out,
work-area bounds, and composition bounds. Frame quantization remains the baseline and can be bypassed
temporarily with Ctrl/Cmd or persistently with Allow Keyframes Between Frames. Shift-click extends or
reduces selection; dragging a selected group commits one bounded operation while preserving relative
timing. Horizontal/vertical pan and anchor-centered zoom remain view-only state.

Curve sampling starts from the visible pixel budget, inserts visible keyframe boundaries exactly,
and adaptively subdivides segments until their quarter/midpoint deviation is below a bounded
screen-space error. The hard 16,384-sample ceiling prevents pathological expressions from creating
unbounded work, while typed sample buffers are reused across viewport changes. Analytic derivatives
support non-uniform samples without finite-difference noise. Binary lookup is used for keyframe
evaluation and curve hit values; hidden tracks are not sampled. Marker radii counteract non-uniform
SVG scaling to retain stable pointer targets.

Adobe behavior references:

- [Animation basics and Graph Editor options](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/animation-basics/animation-basics.html)
- [Control speed between keyframes](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/speed-between-keyframes/speed.html)
- [Edit and move keyframes in the Graph Editor](https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/animation-keyframes/editing-moving-copying-keyframes.html)
