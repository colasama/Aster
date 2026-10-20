// Generated effect catalog dispatch.
use crate::PixelParameter;
pub(super) struct EffectCatalog;
impl EffectCatalog {
    pub fn pixels(effect_type: &str) -> Option<Vec<PixelParameter>> {
        match effect_type.as_bytes().first().map(|b| b % 4) {
            Some(0) => Self::catalog_0(effect_type),
            Some(1) => Self::catalog_1(effect_type),
            Some(2) => Self::catalog_2(effect_type),
            Some(3) => Self::catalog_3(effect_type),
            _ => None,
        }
    }
}
