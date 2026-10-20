use serde_json::Number;

pub(crate) struct JavaScriptNumber;

impl JavaScriptNumber {
    /// Material identity and selector coercion share ECMAScript rounding and notation.
    pub(crate) fn number(value: &Number) -> String {
        let value = value.as_f64().unwrap_or(f64::NAN);
        let mut buffer = ryu_js::Buffer::new();
        buffer.format(value).to_owned()
    }
}
