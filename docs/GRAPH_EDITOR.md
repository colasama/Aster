# Graph Editor

Aster's Graph Editor evaluates the same `Animatable` tracks used by the timeline and renderer. Value
graphs show each evaluated scalar component. Speed graphs use the exact analytic time derivative;
Position is one non-negative vector magnitude instead of three signed component curves. Auto mode
chooses that Position Speed graph for spatial motion and value graphs for other transform properties.
The optional reference graph evaluates the other representation into an independent vertical range
so velocity units never distort the editable value range.

Bezier handles store one temporal cubic per segment. Value-graph handles edit the cubic control
points directly. Speed-graph handles convert height to units per second and horizontal reach to
normalized temporal influence, then write the equivalent cubic. Easy Ease produces zero endpoint
speed with one-third influence. Linear, Bezier, and Hold interpolation all use the canonical
time-addressed evaluator, so the graph, viewport, preview, and export cannot diverge. Moving or
easing a Position Speed key synchronizes every Position component that has a key at that time.

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
