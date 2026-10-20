use super::{
    ExpressionError, ExpressionLimits, Instruction,
    functions::{NumericFunction, Operator},
    lexer::Token,
};

pub(super) struct Parser {
    tokens: Vec<Token>,
    index: usize,
    depth: usize,
    max_depth: usize,
    instructions: Vec<Instruction>,
    selector: bool,
}

impl Parser {
    pub fn compile(
        tokens: Vec<Token>,
        limits: &ExpressionLimits,
        selector: bool,
    ) -> Result<Vec<Instruction>, ExpressionError> {
        let mut parser = Self {
            tokens,
            index: 0,
            depth: 0,
            max_depth: limits.max_expression_depth.min(32),
            instructions: Vec::new(),
            selector,
        };
        parser.expression(0)?;
        if parser.tokens.get(parser.index) != Some(&Token::End) {
            return Err(ExpressionError::Syntax("trailing token".into()));
        }
        Ok(parser.instructions)
    }

    fn expression(&mut self, minimum_power: u8) -> Result<(), ExpressionError> {
        self.depth += 1;
        if self.depth > self.max_depth {
            return Err(ExpressionError::Budget("depth"));
        }
        self.prefix()?;
        while let Some(Token::Operator(operator)) = self.tokens.get(self.index) {
            let operator = *operator;
            let (left, right) = operator.binding_power();
            if left < minimum_power {
                break;
            }
            self.index += 1;
            self.expression(right)?;
            self.instructions.push(Instruction::Binary(operator));
        }
        self.depth -= 1;
        Ok(())
    }

    fn prefix(&mut self) -> Result<(), ExpressionError> {
        let token = self
            .tokens
            .get(self.index)
            .cloned()
            .ok_or_else(|| ExpressionError::Syntax("missing value".into()))?;
        self.index += 1;
        match token {
            Token::Operator(operator @ (Operator::Add | Operator::Subtract)) => {
                self.expression(7)?;
                if operator == Operator::Subtract {
                    self.instructions.push(Instruction::Negate);
                }
            }
            Token::Number(value) => self.instructions.push(Instruction::Number(value)),
            Token::Left => {
                self.expression(0)?;
                self.expect(Token::Right)?;
            }
            Token::Identifier(name) => {
                if self.tokens.get(self.index) == Some(&Token::Left) {
                    self.index += 1;
                    let mut count = 0;
                    if self.tokens.get(self.index) != Some(&Token::Right) {
                        loop {
                            self.expression(0)?;
                            count += 1;
                            if self.tokens.get(self.index) != Some(&Token::Comma) {
                                break;
                            }
                            self.index += 1;
                        }
                    }
                    self.expect(Token::Right)?;
                    self.instructions.push(Instruction::Call(
                        if self.selector {
                            NumericFunction::resolve_selector(&name)?
                        } else {
                            NumericFunction::resolve(&name, count)?
                        },
                        count,
                    ));
                } else {
                    let instruction = match name.as_str() {
                        "time" => Instruction::Time,
                        "value" if !self.selector => Instruction::Value,
                        "selectorValue" if self.selector => Instruction::Value,
                        "textIndex" if self.selector => Instruction::TextIndex,
                        "textTotal" if self.selector => Instruction::TextTotal,
                        "PI" if self.selector => Instruction::Number(std::f64::consts::PI),
                        "E" if self.selector => Instruction::Number(std::f64::consts::E),
                        "pi" => Instruction::Number(std::f64::consts::PI),
                        "e" => Instruction::Number(std::f64::consts::E),
                        _ => return Err(ExpressionError::Syntax("unknown variable".into())),
                    };
                    self.instructions.push(instruction);
                }
            }
            _ => return Err(ExpressionError::Syntax("expected a value".into())),
        }
        Ok(())
    }

    fn expect(&mut self, token: Token) -> Result<(), ExpressionError> {
        if self.tokens.get(self.index) != Some(&token) {
            return Err(ExpressionError::Syntax("missing delimiter".into()));
        }
        self.index += 1;
        Ok(())
    }
}
