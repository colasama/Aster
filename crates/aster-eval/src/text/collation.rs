use crate::EvaluationError;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences, options::CollatorOptions};
use icu_locale_core::Locale;
use std::cmp::Ordering;

/// The host supplies its resolved Intl locale so standalone evaluation preserves scene tie-breaks.
pub struct TextCollation {
    collator: CollatorBorrowed<'static>,
}
impl TextCollation {
    pub fn new(locale: &str) -> Result<Self, EvaluationError> {
        if locale.len() > 256 {
            return Err(EvaluationError::InvalidScene(
                "text collation locale too long".into(),
            ));
        }
        let locale: Locale = locale
            .parse()
            .map_err(|_| EvaluationError::InvalidScene("invalid text collation locale".into()))?;
        let preferences = CollatorPreferences::from(&locale);
        let collator = Collator::try_new(preferences, CollatorOptions::default())
            .map_err(|e| EvaluationError::InvalidScene(format!("text collation: {e}")))?;
        Ok(Self { collator })
    }
    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        if a == b {
            Ordering::Equal
        } else {
            self.collator.compare(a, b)
        }
    }
}
