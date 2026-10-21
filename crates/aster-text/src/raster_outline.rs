use skrifa::{
    FontRef, MetadataProvider,
    instance::Size,
    outline::{
        DrawSettings, Engine, Hinting, HintingInstance, HintingOptions, OutlinePen, SmoothMode,
        Target,
    },
    raw::types::GlyphId,
};
use zeno::{Command, Join, Mask, Point, Stroke};

use crate::{
    GlyphHinting, GlyphImage, GlyphPaint, GlyphRasterConfig, GlyphRasterError, GlyphRasterRequest,
};

pub(crate) struct OutlineRaster {
    commands: Vec<Command>,
    maximum: usize,
    exceeded: bool,
}

impl OutlineRaster {
    pub(crate) fn render(
        face: &FontRef<'_>,
        request: &GlyphRasterRequest,
        config: &GlyphRasterConfig,
        image: &mut GlyphImage,
    ) -> Result<(), GlyphRasterError> {
        let outlines = face.outline_glyphs();
        let glyph =
            outlines
                .get(GlyphId::new(request.glyph_id))
                .ok_or(GlyphRasterError::Unsupported(
                    "no supported outline or bitmap for glyph",
                ))?;
        let variations = image
            .key
            .variations
            .iter()
            .map(|(tag, bits)| (skrifa::raw::types::Tag::new(tag), f32::from_bits(*bits)));
        let location = face.axes().location(variations);
        let hinting = if request.hinting == GlyphHinting::None {
            Hinting::None
        } else {
            Hinting::Embedded
        };
        let memory = glyph.draw_memory_size(hinting);
        if memory > config.max_outline_scratch {
            return Err(GlyphRasterError::Limit("outline scratch"));
        }
        let mut memory = vec![0; memory];
        let hinter = if request.hinting == GlyphHinting::Vertical {
            Some(HintingInstance::new(
                &outlines,
                Size::new(request.size),
                &location,
                HintingOptions {
                    engine: Engine::Interpreter,
                    target: Target::Smooth {
                        mode: SmoothMode::Normal,
                        symmetric_rendering: false,
                        preserve_linear_metrics: true,
                    },
                },
            )?)
        } else {
            None
        };
        let settings = match &hinter {
            Some(hinter) => DrawSettings::hinted(hinter, true),
            None => DrawSettings::unhinted(Size::new(request.size), &location),
        }
        .with_memory(Some(&mut memory));
        let mut pen = Self {
            commands: Vec::new(),
            maximum: config.max_outline_commands,
            exceeded: false,
        };
        glyph.draw(settings, &mut pen)?;
        if pen.exceeded {
            return Err(GlyphRasterError::Limit("outline commands or coordinates"));
        }
        if pen.commands.is_empty() {
            return Ok(());
        }
        let mut mask = Mask::new(pen.commands.as_slice());
        mask.offset(request.phase).render_offset(request.phase);
        let mut stroke;
        if let GlyphPaint::Stroke { width } = request.paint {
            stroke = Stroke::new(width);
            stroke.join(Join::Round);
            mask.style(stroke);
        }
        let mut dimensions = [0, 0];
        mask.inspect(|_, width, height| dimensions = [width, height]);
        let bytes = config.image_bytes(dimensions[0], dimensions[1], 1)?;
        if bytes == 0 {
            return Ok(());
        }
        image.data.resize(bytes, 0);
        let placement = mask.render_into(&mut image.data, None);
        image.width = placement.width;
        image.height = placement.height;
        image.origin = [placement.left, placement.top];
        Ok(())
    }

    fn push(&mut self, command: Command, points: &[[f32; 2]]) {
        if self.exceeded
            || self.commands.len() >= self.maximum
            || points
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 1_048_576.0)
        {
            self.exceeded = true;
        } else {
            self.commands.push(command);
        }
    }
}

impl OutlinePen for OutlineRaster {
    fn move_to(&mut self, x: f32, y: f32) {
        self.push(Command::MoveTo(Point::new(x, -y)), &[[x, y]]);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.push(Command::LineTo(Point::new(x, -y)), &[[x, y]]);
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.push(
            Command::QuadTo(Point::new(cx, -cy), Point::new(x, -y)),
            &[[cx, cy], [x, y]],
        );
    }
    fn curve_to(&mut self, ax: f32, ay: f32, bx: f32, by: f32, x: f32, y: f32) {
        self.push(
            Command::CurveTo(Point::new(ax, -ay), Point::new(bx, -by), Point::new(x, -y)),
            &[[ax, ay], [bx, by], [x, y]],
        );
    }
    fn close(&mut self) {
        self.push(Command::Close, &[]);
    }
}
