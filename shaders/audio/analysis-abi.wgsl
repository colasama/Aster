
struct AsterAudioAnalysis {
  info: vec4u,
  timing: vec4f,
  levels: vec4f,
  energy: vec4f,
  spectrum: array<f32, 2048>,
  waveform: array<f32, 256>,
}
