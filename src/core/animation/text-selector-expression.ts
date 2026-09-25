import type { TextExpressionSelectorContext } from "./text-selectors";

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "left" | "right" | "comma" | "end" };

type ExpressionNode =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; operator: "+" | "-"; value: ExpressionNode }
  | { kind: "binary"; operator: string; left: ExpressionNode; right: ExpressionNode }
  | { kind: "call"; name: string; values: ExpressionNode[] };

interface CompiledExpression {
  evaluate?: (context: TextExpressionSelectorContext) => number;
  error?: string;
}

const MAX_EXPRESSION_LENGTH = 2_048;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const MAX_COMPILED_EXPRESSIONS = 128;
const expressionCache = new Map<string, CompiledExpression>();
const FUNCTIONS: Readonly<Record<string, (...values: number[]) => number>> = {
  abs: (value) => Math.abs(value ?? 0),
  ceil: (value) => Math.ceil(value ?? 0),
  clamp: (value, minimum, maximum) => Math.min(maximum ?? 1, Math.max(minimum ?? 0, value ?? 0)),
  cos: (value) => Math.cos(value ?? 0),
  ease: (value, start, end, from, to) => {
    const progress = clamp01(((value ?? 0) - (start ?? 0)) / ((end ?? 1) - (start ?? 0)));
    const smooth = progress * progress * (3 - 2 * progress);
    return (from ?? 0) + ((to ?? 1) - (from ?? 0)) * smooth;
  },
  floor: (value) => Math.floor(value ?? 0),
  linear: (value, start, end, from, to) => {
    const progress = ((value ?? 0) - (start ?? 0)) / ((end ?? 1) - (start ?? 0));
    return (from ?? 0) + ((to ?? 1) - (from ?? 0)) * progress;
  },
  max: (...values) => Math.max(...values),
  min: (...values) => Math.min(...values),
  pow: (base, exponent) => (base ?? 0) ** (exponent ?? 0),
  round: (value) => Math.round(value ?? 0),
  sin: (value) => Math.sin(value ?? 0),
  sqrt: (value) => Math.sqrt(Math.max(0, value ?? 0)),
  tan: (value) => Math.tan(value ?? 0),
};

/** Evaluates a bounded numeric subset of expressions without executing JavaScript. */
export function evaluateTextSelectorExpression(
  source: string,
  context: TextExpressionSelectorContext,
): number {
  const compiled = compiledExpression(source);
  if (!compiled.evaluate) throw new Error(compiled.error ?? "Text selector expression is invalid");
  return compiled.evaluate(context);
}

export function safeEvaluateTextSelectorExpression(
  source: string,
  context: TextExpressionSelectorContext,
): number {
  const compiled = compiledExpression(source);
  if (!compiled.evaluate || compiled.error) return context.selectorValue;
  try {
    return compiled.evaluate(context);
  } catch {
    // Runtime failures depend on the per-glyph context (NaN, Infinity, out-of-domain
    // arguments), so fall back for this evaluation without disabling the expression.
    return context.selectorValue;
  }
}

/** Returns a compile error or t=0 probe failure for inspector feedback without executing user JavaScript. */
export function textSelectorExpressionError(source: string): string | undefined {
  const compiled = compiledExpression(source);
  if (compiled.error || !compiled.evaluate)
    return compiled.error ?? "Text selector expression is invalid";
  try {
    compiled.evaluate({ textIndex: 1, textTotal: 1, selectorValue: 100, time: 0 });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function compiledExpression(source: string): CompiledExpression {
  const cached = expressionCache.get(source);
  if (cached) {
    expressionCache.delete(source);
    expressionCache.set(source, cached);
    return cached;
  }
  let compiled: CompiledExpression;
  try {
    if (!source.trim() || source.length > MAX_EXPRESSION_LENGTH)
      throw new Error("Text selector expression is empty or exceeds 2048 characters");
    const root = new TextExpressionParser(tokenize(source)).parse();
    compiled = {
      evaluate: (context) => {
        const result = evaluateNode(root, context);
        if (!Number.isFinite(result)) throw new Error("Text selector expression is not finite");
        return Math.min(10_000, Math.max(-10_000, result));
      },
    };
  } catch (error) {
    compiled = { error: error instanceof Error ? error.message : String(error) };
  }
  expressionCache.set(source, compiled);
  while (expressionCache.size > MAX_COMPILED_EXPRESSIONS) {
    const oldest = expressionCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    expressionCache.delete(oldest);
  }
  return compiled;
}

class TextExpressionParser {
  #index = 0;
  #depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): ExpressionNode {
    const value = this.expression(0);
    if (this.current.kind !== "end") throw new Error("Text selector expression has extra input");
    return value;
  }

  private expression(minimumPower: number): ExpressionNode {
    const depth = ++this.#depth;
    if (depth > MAX_DEPTH) throw new Error("Text selector expression is too deeply nested");
    let left = this.prefix();
    while (this.current.kind === "operator") {
      const operator = this.current.value;
      const [leftPower, rightPower] = bindingPower(operator);
      if (leftPower < minimumPower) break;
      this.#index += 1;
      left = { kind: "binary", operator, left, right: this.expression(rightPower) };
    }
    this.#depth -= 1;
    return left;
  }

  private prefix(): ExpressionNode {
    const token = this.current;
    if (token.kind === "operator" && (token.value === "+" || token.value === "-")) {
      this.#index += 1;
      return {
        kind: "unary",
        operator: token.value as "+" | "-",
        value: this.expression(7),
      };
    }
    if (token.kind === "number") {
      this.#index += 1;
      return { kind: "number", value: token.value };
    }
    if (token.kind === "left") {
      this.#index += 1;
      const value = this.expression(0);
      this.expect("right");
      return value;
    }
    if (token.kind !== "identifier") throw new Error("Text selector expression expects a value");
    this.#index += 1;
    if (this.current.kind === "left") return this.call(token.value);
    return { kind: "variable", name: token.value };
  }

  private call(name: string): ExpressionNode {
    if (!FUNCTIONS[name]) throw new Error(`Unsupported text selector function ${name}`);
    this.expect("left");
    const values: ExpressionNode[] = [];
    if (this.current.kind !== "right") {
      while (true) {
        values.push(this.expression(0));
        if (this.current.kind !== "comma") break;
        this.#index += 1;
      }
    }
    this.expect("right");
    return { kind: "call", name, values };
  }

  private expect(kind: Token["kind"]): void {
    if (this.current.kind !== kind) throw new Error(`Text selector expression expects ${kind}`);
    this.#index += 1;
  }

  private get current(): Token {
    return this.tokens[this.#index] ?? { kind: "end" };
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token) => {
    if (tokens.length >= MAX_TOKENS)
      throw new Error("Text selector expression has too many tokens");
    tokens.push(token);
  };
  while (index < source.length) {
    const character = source[index] as string;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (/\d|\./u.test(character)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iu.exec(source.slice(index));
      if (!match) throw new Error("Text selector expression contains an invalid number");
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new Error("Text selector expression number is not finite");
      push({ kind: "number", value });
      index += match[0].length;
      continue;
    }
    if (/[a-z_]/iu.test(character)) {
      const match = /^[a-z_][a-z0-9_]*/iu.exec(source.slice(index));
      const value = match?.[0] ?? "";
      push({ kind: "identifier", value });
      index += value.length;
      continue;
    }
    const kind =
      character === "("
        ? "left"
        : character === ")"
          ? "right"
          : character === ","
            ? "comma"
            : undefined;
    if (kind) {
      push({ kind });
      index += 1;
      continue;
    }
    if (!"+-*/%^".includes(character))
      throw new Error(`Unsupported text selector expression token ${character}`);
    push({ kind: "operator", value: character });
    index += 1;
  }
  push({ kind: "end" });
  return tokens;
}

function variable(name: string, context: TextExpressionSelectorContext): number {
  if (name === "textIndex") return context.textIndex;
  if (name === "textTotal") return context.textTotal;
  if (name === "selectorValue") return context.selectorValue;
  if (name === "time") return context.time;
  if (name === "pi" || name === "PI") return Math.PI;
  if (name === "e" || name === "E") return Math.E;
  throw new Error(`Unsupported text selector variable ${name}`);
}

function evaluateNode(node: ExpressionNode, context: TextExpressionSelectorContext): number {
  if (node.kind === "number") return node.value;
  if (node.kind === "variable") return variable(node.name, context);
  if (node.kind === "unary") {
    const value = evaluateNode(node.value, context);
    return node.operator === "-" ? -value : value;
  }
  if (node.kind === "binary")
    return applyOperator(
      node.operator,
      evaluateNode(node.left, context),
      evaluateNode(node.right, context),
    );
  const implementation = FUNCTIONS[node.name];
  if (!implementation) throw new Error(`Unsupported text selector function ${node.name}`);
  return implementation(...node.values.map((value) => evaluateNode(value, context)));
}

function bindingPower(operator: string): [number, number] {
  if (operator === "+" || operator === "-") return [1, 2];
  if (operator === "*" || operator === "/" || operator === "%") return [3, 4];
  if (operator === "^") return [6, 5];
  return [-1, -1];
}

function applyOperator(operator: string, left: number, right: number): number {
  if (operator === "+") return left + right;
  if (operator === "-") return left - right;
  if (operator === "*") return left * right;
  if (operator === "/") return right === 0 ? Number.NaN : left / right;
  if (operator === "%") return right === 0 ? Number.NaN : left % right;
  if (operator === "^") return left ** right;
  throw new Error(`Unsupported text selector operator ${operator}`);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
