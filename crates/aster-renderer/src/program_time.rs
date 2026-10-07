pub(crate) struct ProgramTime;

impl ProgramTime {
    /// Keep time for every shared opcode that reads or changes the local effect clock.
    /// Unknown revisions remain conservative until the shader-consumer audit is updated.
    pub fn depends(code: f32) -> bool {
        if !code.is_finite() || code.fract() != 0.0 || !(1.0..=268.0).contains(&code) {
            return true;
        }
        matches!(
            code as u32,
            7 | 10
                | 16
                | 25
                | 26
                | 30
                | 36
                | 40
                | 62
                | 68
                | 69
                | 75
                | 78
                | 79
                | 80
                | 84
                | 85
                | 86
                | 87
                | 88
                | 104
                | 105
                | 140
                | 143
                | 145
                | 147
                | 156
                | 157
                | 158
                | 159
                | 160
                | 162
                | 163
                | 182
                | 184
                | 185
                | 187
                | 200
                | 215
                | 221
                | 246
                | 250
                | 251
                | 252
                | 253
                | 255
                | 256
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::ProgramTime;

    #[test]
    fn static_cache_time_dependencies_match_the_shared_shader()
    -> Result<(), Box<dyn std::error::Error>> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let source = &catalog.program("post-process")?.source;
        let mut consumers = BTreeSet::new();
        for case in source.split("case ").skip(1) {
            let start = case.find('{').ok_or("case body absent")?;
            let mut depth = 0;
            let mut end = start;
            for (index, character) in case.char_indices().skip(start) {
                if character == '{' {
                    depth += 1;
                }
                if character == '}' {
                    depth -= 1;
                }
                if depth == 0 {
                    end = index;
                    break;
                }
            }
            if case[start..end].contains("time") {
                consumers.insert(
                    case.split('u')
                        .next()
                        .ok_or("opcode absent")?
                        .parse::<u32>()?,
                );
            }
        }
        assert_eq!(
            consumers,
            (1..=268)
                .filter(|code| ProgramTime::depends(*code as f32))
                .collect()
        );
        // Helpers may read resolution, but cannot bypass the audited local time variable.
        let uniform_reads = source
            .lines()
            .filter(|line| line.contains("settings.resolution_time_exposure"))
            .map(str::trim)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            uniform_reads,
            BTreeSet::from([
                "let pixel = vec2f(1.0) / settings.resolution_time_exposure.xy;",
                "let offset = vec2f(max(radius, 0.35)) / settings.resolution_time_exposure.xy;",
                "let resolution = settings.resolution_time_exposure.xy;",
                "let time = settings.resolution_time_exposure.z;",
                "let exposure = settings.resolution_time_exposure.w;",
            ])
        );
        for unknown in [0.0, 269.0, 2.5, f32::NAN, f32::INFINITY] {
            assert!(ProgramTime::depends(unknown));
        }
        Ok(())
    }
}
