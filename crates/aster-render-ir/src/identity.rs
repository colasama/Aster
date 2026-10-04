use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::IrError;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Utf16CompositionIdentity {
    #[schemars(length(min = 1), inner(range(min = 0, max = 65535)))]
    pub utf16_units: Vec<u16>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum CompositionIdentity {
    Unicode(#[schemars(length(min = 1))] String),
    Utf16(Utf16CompositionIdentity),
}

impl CompositionIdentity {
    pub fn validate(&self) -> Result<(), IrError> {
        match self {
            Self::Unicode(value) if value.is_empty() => Err(IrError::InvalidHeader(
                "composition identifier must not be empty".to_owned(),
            )),
            Self::Utf16(value)
                if value.utf16_units.is_empty()
                    || String::from_utf16(&value.utf16_units).is_ok() =>
            {
                Err(IrError::InvalidHeader(
                    "UTF-16 composition identity requires an unpaired surrogate".to_owned(),
                ))
            }
            _ => Ok(()),
        }
    }
}
