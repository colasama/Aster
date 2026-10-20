use super::{ExpressionError, ExpressionLimits, functions::Operator};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Token {
    Number(f64),
    Identifier(String),
    Operator(Operator),
    Left,
    Right,
    Comma,
    End,
}

pub(super) struct Tokens;

impl Tokens {
    pub fn scan(source: &str, limits: &ExpressionLimits) -> Result<Vec<Token>, ExpressionError> {
        Self::scan_with_case(source, limits, false)
    }

    pub fn scan_selector(
        source: &str,
        limits: &ExpressionLimits,
    ) -> Result<Vec<Token>, ExpressionError> {
        Self::scan_with_case(source, limits, true)
    }

    fn scan_with_case(
        source: &str,
        limits: &ExpressionLimits,
        preserve_case: bool,
    ) -> Result<Vec<Token>, ExpressionError> {
        if source.encode_utf16().count() > limits.max_expression_units.min(2048) {
            return Err(ExpressionError::Budget("character"));
        }
        let chars: Vec<char> = source.chars().collect();
        let mut index = 0;
        let mut tokens = Vec::new();
        while index < chars.len() {
            let character = chars[index];
            // ECMAScript trim whitespace differs from Rust's Unicode whitespace at
            // U+0085 and U+FEFF. Preserve the source language's lexical boundary.
            if matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
            {
                index += 1;
                continue;
            }
            let token = if character.is_ascii_digit()
                || (character == '.' && chars.get(index + 1).is_some_and(char::is_ascii_digit))
            {
                let start = index;
                index += 1;
                while chars
                    .get(index)
                    .is_some_and(|c| c.is_ascii_digit() || *c == '.')
                {
                    index += 1;
                }
                if chars.get(index).is_some_and(|c| matches!(c, 'e' | 'E')) {
                    index += 1;
                    if chars.get(index).is_some_and(|c| matches!(c, '+' | '-')) {
                        index += 1;
                    }
                    while chars.get(index).is_some_and(char::is_ascii_digit) {
                        index += 1;
                    }
                }
                let number: String = chars[start..index].iter().collect();
                let value = number
                    .parse::<f64>()
                    .map_err(|_| ExpressionError::Syntax("invalid number".into()))?;
                if !value.is_finite() {
                    return Err(ExpressionError::Syntax("invalid number".into()));
                }
                Token::Number(value)
            } else if character.is_ascii_alphabetic() {
                let start = index;
                index += 1;
                while chars
                    .get(index)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    index += 1;
                }
                let name = chars[start..index].iter().collect::<String>();
                Token::Identifier(if preserve_case {
                    name
                } else {
                    name.to_ascii_lowercase()
                })
            } else {
                index += 1;
                match character {
                    '(' => Token::Left,
                    ')' => Token::Right,
                    ',' => Token::Comma,
                    '+' => Token::Operator(Operator::Add),
                    '-' => Token::Operator(Operator::Subtract),
                    '*' => Token::Operator(Operator::Multiply),
                    '/' => Token::Operator(Operator::Divide),
                    '%' => Token::Operator(Operator::Remainder),
                    '^' => Token::Operator(Operator::Power),
                    _ => return Err(ExpressionError::Syntax("unexpected character".into())),
                }
            };
            if tokens.len() >= limits.max_expression_tokens.min(512) {
                return Err(ExpressionError::Budget("token"));
            }
            tokens.push(token);
        }
        if tokens.len() >= limits.max_expression_tokens.min(512) {
            return Err(ExpressionError::Budget("token"));
        }
        tokens.push(Token::End);
        Ok(tokens)
    }
}
