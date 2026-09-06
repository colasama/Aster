# AI operation API

This document describes the current bounded version-1 agent command surface. Multi-turn Pi sessions,
staged edit workspaces, access modes, Full Access safeguards, visual observation, and external-service
rollout are specified in [Pi agent integration design](PI_AGENT_INTEGRATION.md).

AI is an operator, not an alternate mutation path. Pi discovers command descriptors and exact schemas
on demand, executes them in an isolated workspace, and submits a cumulative typed operation diff.

## Lifecycle

1. Read a compact editor context at an exact live revision.
2. Discover capabilities and load only the schemas needed for the request.
3. Begin a bounded workspace from that revision.
4. Validate and atomically execute small typed command batches.
5. Query, evaluate at explicit times, inspect diagnostics, and record visual-verification limits.
6. Freeze one cumulative semantic diff and reject a stale live revision.
7. Apply accepted work as one undoable transaction and append a secret-free audit record.

The registry covers all 62 variants in the live TypeScript `Operation` union. Asset import, project
I/O, plugin installation, export, filesystem, process, and network actions remain separate services
because they have different authority, cancellation, and audit requirements.

| Operation | Domain | Result |
| --- | --- | --- |
| `setActiveComposition` | Compositions | Activates an existing composition. |
| `addComposition` | Compositions | Creates a bounded blank composition. |
| `addProjectFolder` | Project | Creates a project-panel folder. |
| `renameProjectItem` | Project | Renames a composition, footage source, or project folder. |
| `moveProjectItem` | Project | Moves a composition or media item between folders. |
| `moveProjectFolder` | Project | Moves a project folder within the folder hierarchy. |
| `removeProjectFolder` | Project | Removes an empty project folder. |
| `removeComposition` | Compositions | Removes a non-active composition. |
| `setCompositionSettings` | Compositions | Changes name, dimensions, frame rate, and duration. |
| `setCompositionMotionBlur` | Compositions | Sets the bounded shutter and adaptive sample policy. |
| `setCompositionEnvironment` | Compositions | Updates or clears an imported HDR environment. |
| `setCompositionWorkArea` | Compositions | Sets the frame-aligned work area. |
| `precomposeLayers` | Compositions | Creates a nested composition and wrapper layer. |
| `addLayer` | Layers | Creates any supported layer kind at the current time. |
| `removeLayer` | Layers | Removes an existing layer. |
| `renameLayer` | Layers | Renames an existing layer. |
| `reorderLayer` | Layers | Moves a layer to a bounded stack index. |
| `setBlendMode` | Layers | Sets a supported blend mode. |
| `setParent` | Layers | Sets or clears a cycle-checked layer parent. |
| `setLayerTiming` | Layers | Sets in and out points. |
| `setLayerTimeMapping` | Layers | Sets source-time offset and stretch. |
| `setLayerTimeRemap` | Animation | Replaces or clears a time-remap track. |
| `setLayerAudioGain` | Layers | Sets normalized preview audio gain. |
| `setLayerAudioSettings` | Layers | Replaces stereo dB levels, pan, mute, and reverse settings. |
| `setMaterial3d` | 3D | Replaces bounded material settings. |
| `setLightSettings` | 3D | Replaces light settings. |
| `setLayerColor` | Layers | Sets linear RGBA layer color. |
| `setSolidSettings` | Layers | Replaces bounded solid dimensions and normalized RGBA color. |
| `addSource` | Assets | Adds one validated project footage source. |
| `removeSource` | Assets | Removes an unreferenced footage source. |
| `cleanupOrphanSources` | Assets | Removes every unreferenced footage source. |
| `setLayerSource` | Assets | Sets or clears a layer source reference. |
| `relinkSource` | Assets | Replaces a source locator and content identity. |
| `reloadSource` | Assets | Reloads source metadata while preserving its stable identity. |
| `interpretSource` | Assets | Replaces source alpha, color-space, and frame-rate interpretation. |
| `setCameraSettings` | 3D | Replaces camera settings. |
| `setSceneGenerator` | Scene generators | Replaces a generator plugin instance and its bounded parameters. |
| `setClonerSettings` | Cloners | Replaces or clears cloner distribution and effectors. |
| `setShapeSettings` | Shapes | Replaces primitive, path, fill, stroke, and trim settings. |
| `setShapeGraph` | Shapes | Replaces or clears a validated reusable shape graph. |
| `setTextContent` | Typography | Sets bounded text content. |
| `setTextStyle` | Typography | Replaces typography and stroke settings. |
| `setTextAnimator` | Typography | Configures per-character text animation. |
| `toggleLayer` | Layers | Toggles visibility, solo, lock, audio, 3D, or motion blur state. |
| `setProperty` | Animation | Sets a finite transform or opacity property. |
| `addKeyframe` | Animation | Adds a transform keyframe. |
| `moveKeyframe` | Animation | Moves an existing transform keyframe. |
| `updateKeyframe` | Animation | Updates keyframe value and interpolation metadata. |
| `removeKeyframe` | Animation | Removes a transform keyframe. |
| `easeLayer` | Animation | Applies the standard easing preset to a layer. |
| `setExpression` | Animation | Sets or clears a bounded property expression. |
| `addEffect` | Effects | Creates a registered GPU effect. |
| `removeEffect` | Effects | Removes an owned effect. |
| `moveEffect` | Effects | Reorders an owned effect. |
| `setEffectMask` | Effects | Replaces or clears a validated effect mask. |
| `toggleEffect` | Effects | Toggles an owned effect. |
| `setEffectLut` | Effects | Replaces or clears a bounded 3D LUT resource. |
| `setEffectParameterAtTime` | Effects | Sets an effect parameter at an explicit time. |
| `addEffectParameterKeyframe` | Effects | Adds an effect-parameter keyframe. |
| `removeEffectParameterKeyframe` | Effects | Removes an effect-parameter keyframe. |
| `moveEffectParameterKeyframe` | Effects | Moves an effect-parameter keyframe. |
| `setEffectParameter` | Effects | Sets a finite owned effect parameter. |

`schemas/ai-commands.v1.json` is the source for TypeScript discovery and input validation, Pi tool
schemas, parity tests, and this table. The application service normalizes IDs, property paths, layer
kinds, effect ownership, finite numbers, and bounds before a workspace revision advances. The Pi
application service is the only AI mutation path; the native desktop bridge does not expose a second
planner or provider endpoint.

Provider keys are accepted in memory or through `ASTER_AI_API_KEY`. They cross directly to the
isolated utility process and are excluded from project logs and tool audit payloads. HTTPS is required
except for localhost development. Errors redact credentials and response bodies are size/time bounded.

## External clients

Aster 0.2.1 provides an MCP stdio adapter over the same twelve meta-tool definitions. External clients
also receive reference-media, comparison, live import, save and render-queue tools. Submitted
workspaces require explicit `commit_workspace`, which checks the current live revision and records
one undoable transaction. `render_preview` supports bounded resolution, normalized crop and layer
isolation for both Pi and external clients. See [External Automation](AUTOMATION.md).
