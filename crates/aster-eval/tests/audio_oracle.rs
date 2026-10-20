mod support;
use aster_eval::{
    AudioAnalysis, AudioAnalysisLimits, AudioSamples, EvaluationError, MonoAudioReader,
    SpectrumPlan, SpectrumWindow,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    pcm: Vec<Vec<f32>>,
    spectra: Vec<Spectrum>,
    peaks: Vec<Peaks>,
    volumes: Vec<Volume>,
    frames: Vec<Frame>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spectrum {
    input: usize,
    fft_size: usize,
    window: SpectrumWindow,
    start_sample: usize,
    rate: f64,
    data: Vec<f32>,
}
#[derive(Deserialize)]
struct Peaks {
    input: usize,
    bins: usize,
    data: Vec<f32>,
}
#[derive(Deserialize)]
struct Volume {
    input: usize,
    gain: f64,
    muted: bool,
    data: Vec<f32>,
}
#[derive(Deserialize)]
struct Frame {
    input: usize,
    time: f64,
    present: bool,
    flags: u32,
    header: Vec<u32>,
    data: Vec<f32>,
}
struct Reader<'a>(&'a [f32]);
impl MonoAudioReader for Reader<'_> {
    fn read(&self, start: i64, output: &mut [f32]) -> Result<(), EvaluationError> {
        for (i, sample) in output.iter_mut().enumerate() {
            *sample = usize::try_from(start + i as i64)
                .ok()
                .and_then(|i| self.0.get(i))
                .copied()
                .unwrap_or(0.);
        }
        Ok(())
    }
}

#[test]
#[ignore = "requires independently captured TS audio oracle"]
fn native_audio_matches_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_AUDIO_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.spectra.len() >= 160 && oracle.frames.len() >= 70);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    let limits = AudioAnalysisLimits::default();
    for (i, sample) in oracle.spectra.iter().enumerate() {
        let plan = SpectrumPlan::compile(sample.fft_size, sample.window, &limits)?;
        let data = plan.evaluate(&oracle.pcm[sample.input], sample.rate, sample.start_sample)?;
        Comparison::compare(
            &serde_json::to_value(data)?,
            &serde_json::to_value(&sample.data)?,
            &format!("spectrum {i}"),
        );
    }
    for sample in oracle.peaks {
        let data = AudioSamples::waveform_peaks(&oracle.pcm[sample.input], sample.bins, &limits)?;
        Comparison::compare(
            &serde_json::to_value(data)?,
            &serde_json::to_value(sample.data)?,
            "waveform",
        );
    }
    for sample in oracle.volumes {
        let data = AudioSamples::apply_volume(&oracle.pcm[sample.input], sample.gain, sample.muted);
        Comparison::compare(
            &serde_json::to_value(data)?,
            &serde_json::to_value(sample.data)?,
            "volume",
        );
    }
    let analysis = AudioAnalysis::compile(&limits)?;
    for (i, sample) in oracle.frames.iter().enumerate().rev() {
        let reader = Reader(&oracle.pcm[sample.input]);
        let data = analysis.evaluate(
            if sample.present { Some(&reader) } else { None },
            sample.time,
            sample.flags,
        )?;
        assert_eq!(data.len(), 2320);
        assert_eq!(
            data[..4].iter().map(|n| n.to_bits()).collect::<Vec<_>>(),
            sample.header
        );
        Comparison::compare(
            &serde_json::to_value(&data[4..])?,
            &serde_json::to_value(&sample.data)?,
            &format!("analysis {i}"),
        );
    }
    for size in [0, 1, 3, 32769] {
        assert!(SpectrumPlan::compile(size, SpectrumWindow::Hann, &limits).is_err());
    }
    assert!(AudioSamples::waveform_peaks(&[], 0, &limits).is_err());
    assert!(analysis.evaluate(Some(&Reader(&[])), f64::MAX, 0).is_err());
    Ok(())
}
