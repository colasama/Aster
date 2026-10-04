use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::IrError;

pub(crate) struct CanonicalJson;

impl CanonicalJson {
    pub(crate) fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, IrError> {
        let value =
            serde_json::to_value(value).map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let mut output = Vec::new();
        Self::write(&value, &mut output)?;
        Ok(output)
    }

    fn write(value: &Value, output: &mut Vec<u8>) -> Result<(), IrError> {
        match value {
            Value::Object(object) => {
                let ordered: BTreeMap<_, _> = object.iter().collect();
                output.push(b'{');
                for (index, (key, value)) in ordered.into_iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    serde_json::to_writer(&mut *output, key)
                        .map_err(|error| IrError::InvalidJson(error.to_string()))?;
                    output.push(b':');
                    Self::write(value, output)?;
                }
                output.push(b'}');
            }
            Value::Array(array) => {
                output.push(b'[');
                for (index, value) in array.iter().enumerate() {
                    if index != 0 {
                        output.push(b',');
                    }
                    Self::write(value, output)?;
                }
                output.push(b']');
            }
            _ => serde_json::to_writer(output, value)
                .map_err(|error| IrError::InvalidJson(error.to_string()))?,
        }
        Ok(())
    }
}
