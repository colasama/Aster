use crate::{
    GlyphImage, GlyphPaint, GlyphRasterConfig, GlyphRasterError, GlyphRasterRequest, NativeFont,
};
use std::mem::ManuallyDrop;
use windows::{Win32::Graphics::DirectWrite::*, core::Interface};

pub(crate) struct WindowsGlyphRaster {
    factory: IDWriteFactory6,
    loader: IDWriteInMemoryFontFileLoader,
}

impl WindowsGlyphRaster {
    pub fn render(
        font: &NativeFont,
        request: &GlyphRasterRequest,
        config: &GlyphRasterConfig,
        image: &mut GlyphImage,
    ) -> Result<(), GlyphRasterError> {
        if !matches!(request.paint, GlyphPaint::Fill) {
            return Err(GlyphRasterError::Unsupported(
                "platform glyph stroke requires outline raster",
            ));
        }
        if font.data.len() > config.max_platform_font_bytes {
            return Err(GlyphRasterError::Limit("platform font copy"));
        }
        (|| -> Result<(), GlyphRasterError> {
            // Every pointer below refers to a live bounded allocation for the synchronous call.
            // A null owner makes the loader copy font bytes; no borrowed font memory escapes.
            unsafe {
                let factory: IDWriteFactory6 = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
                let loader = factory.CreateInMemoryFontFileLoader()?;
                factory.RegisterFontFileLoader(&loader)?;
                let backend = Self { factory, loader };
                let file = backend.loader.CreateInMemoryFontFileReference(
                    &backend.factory,
                    font.data.as_ptr().cast(),
                    font.data.len() as u32,
                    None,
                )?;
                let axes = font
                    .selection
                    .variations
                    .iter()
                    .map(|(tag, value)| DWRITE_FONT_AXIS_VALUE {
                        axisTag: DWRITE_FONT_AXIS_TAG(u32::from_le_bytes(*tag)),
                        value: *value,
                    })
                    .collect::<Vec<_>>();
                let face = backend
                    .factory
                    .CreateFontFaceReference(
                        &file,
                        font.selection.face.index,
                        DWRITE_FONT_SIMULATIONS_NONE,
                        &axes,
                    )?
                    .CreateFontFace()?;
                let glyph = u16::try_from(request.glyph_id)
                    .map_err(|_| GlyphRasterError::Invalid("platform glyph index"))?;
                let factory: IDWriteFactory3 = backend.factory.cast()?;
                let run = DWRITE_GLYPH_RUN {
                    fontFace: ManuallyDrop::new(Some(face.cast()?)),
                    fontEmSize: request.size,
                    glyphCount: 1,
                    glyphIndices: &glyph,
                    glyphAdvances: std::ptr::null(),
                    glyphOffsets: std::ptr::null(),
                    isSideways: false.into(),
                    bidiLevel: 0,
                };
                let matrix = DWRITE_MATRIX {
                    m11: 1.,
                    m12: 0.,
                    m21: 0.,
                    m22: 1.,
                    dx: request.phase[0],
                    dy: request.phase[1],
                };
                let analysis = factory.CreateGlyphRunAnalysis(
                    &run,
                    Some(&matrix),
                    DWRITE_RENDERING_MODE1_NATURAL_SYMMETRIC,
                    DWRITE_MEASURING_MODE_NATURAL,
                    DWRITE_GRID_FIT_MODE_ENABLED,
                    DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE,
                    0.,
                    0.,
                );
                // The ABI struct does not drop its owned COM field automatically.
                let mut run = run;
                ManuallyDrop::drop(&mut run.fontFace);
                let analysis = analysis?;
                let bounds = analysis.GetAlphaTextureBounds(DWRITE_TEXTURE_CLEARTYPE_3x1)?;
                let width = bounds
                    .right
                    .checked_sub(bounds.left)
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or(GlyphRasterError::Invalid("platform glyph width"))?;
                let height = bounds
                    .bottom
                    .checked_sub(bounds.top)
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or(GlyphRasterError::Invalid("platform glyph height"))?;
                let bytes = config.image_bytes(width, height, 3)?;
                if bytes == 0 {
                    return Ok(());
                }
                let mut coverage = vec![0; bytes];
                analysis.CreateAlphaTexture(
                    DWRITE_TEXTURE_CLEARTYPE_3x1,
                    &bounds,
                    &mut coverage,
                )?;
                image.width = width;
                image.height = height;
                image.origin = [bounds.left, bounds.top];
                image.data = coverage
                    .chunks_exact(3)
                    .map(|p| ((u16::from(p[0]) + u16::from(p[1]) + u16::from(p[2])) / 3) as u8)
                    .collect();
            }
            Ok(())
        })()
    }
}
impl Drop for WindowsGlyphRaster {
    fn drop(&mut self) {
        // The registration is owned by this scope, including every failed analysis path.
        let _ = unsafe { self.factory.UnregisterFontFileLoader(&self.loader) };
    }
}
