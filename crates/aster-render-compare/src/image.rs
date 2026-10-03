use crate::error::CompareError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Result<Self, CompareError> {
        let image = Self {
            width,
            height,
            pixels,
        };
        image.validate()?;
        Ok(image)
    }

    pub fn validate(&self) -> Result<(), CompareError> {
        let required = Self::required_bytes(self.width, self.height)?;
        if self.pixels.len() != required {
            return Err(CompareError::InvalidImage(format!(
                "RGBA length {} does not match {}x{} ({required} bytes)",
                self.pixels.len(),
                self.width,
                self.height,
            )));
        }
        Ok(())
    }

    pub fn validate_pair(&self, other: &Self) -> Result<(), CompareError> {
        self.validate()?;
        other.validate()?;
        if self.width != other.width || self.height != other.height {
            return Err(CompareError::InvalidImage(format!(
                "Dimensions differ: {}x{} versus {}x{}",
                self.width, self.height, other.width, other.height,
            )));
        }
        Ok(())
    }

    pub(crate) fn required_bytes(width: u32, height: u32) -> Result<usize, CompareError> {
        if width == 0 || height == 0 {
            return Err(CompareError::InvalidImage(
                "Dimensions must be nonzero".into(),
            ));
        }
        usize::try_from(width)
            .ok()
            .zip(usize::try_from(height).ok())
            .and_then(|(width, height)| width.checked_mul(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| CompareError::InvalidImage("RGBA byte count overflow".into()))
    }
}

#[derive(Clone, Debug)]
pub struct ImageLimits {
    pub max_pixels: usize,
    pub max_file_bytes: usize,
}

impl ImageLimits {
    pub(crate) fn validate(&self) -> Result<(), CompareError> {
        if self.max_pixels == 0 || self.max_file_bytes == 0 {
            return Err(CompareError::InvalidArgument(
                "Image resource limits must be nonzero".into(),
            ));
        }
        Ok(())
    }
}
