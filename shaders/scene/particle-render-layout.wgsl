
struct Particle { current: vec4f, previous: vec4f, appearance: vec4f }
@group(0) @binding(0) var<uniform> aster_context: AsterGeneratorContext;
@group(0) @binding(1) var<uniform> aster_parameters: AsterGeneratorParameters;
@group(0) @binding(2) var<storage, read> aster_instances: array<Particle>;

