use std::collections::BTreeMap;

use crate::{FontCatalog, FontCatalogError, FontFaceId, FontFaceMetadata, FontStyle};

#[derive(Clone, Debug)]
pub struct FontRequest {
    /// Ordered, already-parsed family names; generic aliases are resolved by the caller.
    pub families: Vec<String>,
    pub weight: f32,
    pub width_percent: f32,
    pub style: FontStyle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FontSelection {
    pub face: FontFaceId,
    pub family: String,
    pub weight: f32,
    pub width_percent: f32,
    pub style: FontStyle,
    pub variations: BTreeMap<[u8; 4], f32>,
}

impl FontCatalog {
    /// Selects a physical face without synthesizing glyphs or claiming script/layout support.
    pub fn select(&self, request: &FontRequest) -> Result<Option<FontSelection>, FontCatalogError> {
        if !request.weight.is_finite()
            || !(1.0..=1000.0).contains(&request.weight)
            || !request.width_percent.is_finite()
            || request.width_percent <= 0.0
            || request.families.len() > self.config.max_name_records
        {
            return Err(FontCatalogError::Invalid(
                "font selection request is invalid",
            ));
        }
        for family in &request.families {
            let key = FontFaceMetadata::family_key(family, self.config.max_name_chars)?;
            let candidate = self
                .faces
                .values()
                .filter(|face| face.families.contains_key(&key))
                .map(|face| FontSelection::for_face(face, family, request))
                .min_by_key(|selection| selection.rank(request));
            if candidate.is_some() {
                return Ok(candidate);
            }
        }
        Ok(None)
    }
}

impl FontSelection {
    fn for_face(face: &FontFaceMetadata, family: &str, request: &FontRequest) -> Self {
        let mut variations: BTreeMap<_, _> = face
            .axes
            .values()
            .map(|axis| (axis.tag, axis.default))
            .collect();
        let mut weight = face.weight;
        let mut width_percent = face.width_percent;
        for (tag, requested, value) in [
            (*b"wght", request.weight, &mut weight),
            (*b"wdth", request.width_percent, &mut width_percent),
        ] {
            if let Some(axis) = face.axes.get(&tag) {
                *value = requested.clamp(axis.minimum, axis.maximum);
                variations.insert(tag, *value);
            }
        }
        Self {
            face: face.id,
            family: family.to_owned(),
            weight,
            width_percent,
            style: face.style,
            variations,
        }
    }

    fn rank(&self, request: &FontRequest) -> (u8, u32, u8, u8, u32, FontFaceId) {
        let width_side = u8::from(if request.width_percent <= 100.0 {
            self.width_percent > request.width_percent
        } else {
            self.width_percent < request.width_percent
        });
        let style = if self.style == request.style {
            0
        } else if self.style == FontStyle::Normal
            || (request.style == FontStyle::Normal && self.style == FontStyle::Italic)
        {
            2
        } else {
            1
        };
        let weight_side = if (400.0..=500.0).contains(&request.weight) {
            if self.weight >= request.weight && self.weight <= 500.0 {
                0
            } else if self.weight < request.weight {
                1
            } else {
                2
            }
        } else {
            u8::from(if request.weight < 400.0 {
                self.weight > request.weight
            } else {
                self.weight < request.weight
            })
        };
        (
            width_side,
            (self.width_percent - request.width_percent).abs().to_bits(),
            style,
            weight_side,
            (self.weight - request.weight).abs().to_bits(),
            self.face,
        )
    }
}
