import { evaluateAnimatable } from "./timeline";
import type { Animatable, EvaluatedTransform, Layer } from "./types";

interface ExpressionContext {
  time: number;
  value: number;
}

interface Token {
  kind: "number" | "identifier" | "operator" | "left" | "right" | "comma" | "end";
  text: string;
  value?: number;
}

export function evaluateExpression(expression: string, context: ExpressionContext): number {
  const parser = new Parser(tokenize(expression), context);
  const value = parser.parse();
  if (!Number.isFinite(value)) throw new Error("Expression produced a non-finite value");
  return value;
}

export function evaluateLayerTransform(layer: Layer, time: number): EvaluatedTransform {
  const evaluate = (path: string, property: Animatable) => {
    const value = evaluateAnimatable(property, time);
    const expression = layer.expressions?.[path];
    if (!expression) return value;
    try {
      return evaluateExpression(expression, { time, value });
    } catch {
      return value;
    }
  };
  const vector = (group: "position" | "rotation" | "scale" | "anchor") =>
    layer.transform[group].map((property, index) => evaluate(`${group}.${index}`, property)) as [
      number,
      number,
      number,
    ];
  return {
    position: vector("position"),
    rotation: vector("rotation"),
    scale: vector("scale"),
    anchor: vector("anchor"),
    opacity: Math.max(0, Math.min(100, evaluate("opacity", layer.transform.opacity))) / 100,
  };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character.trim() === "") {
      index += 1;
      continue;
    }
    if (isDigit(character) || (character === "." && isDigit(source[index + 1]))) {
      const start = index;
      index += 1;
      while (isDigit(source[index]) || source[index] === ".") index += 1;
      if (source[index]?.toLowerCase() === "e") {
        index += 1;
        if (source[index] === "+" || source[index] === "-") index += 1;
        while (isDigit(source[index])) index += 1;
      }
      const text = source.slice(start, index);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`Invalid number: ${text}`);
      tokens.push({ kind: "number", text, value });
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      tokens.push({ kind: "identifier", text: source.slice(start, index) });
      continue;
    }
    const kind =
      character === "("
        ? "left"
        : character === ")"
          ? "right"
          : character === ","
            ? "comma"
            : "+-*/%^".includes(character)
              ? "operator"
              : undefined;
    if (!kind) throw new Error(`Unexpected token: ${character}`);
    tokens.push({ kind, text: character });
    index += 1;
  }
  tokens.push({ kind: "end", text: "" });
  return tokens;
}

class Parser {
  #index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: ExpressionContext,
  ) {}

  parse(): number {
    const value = this.parseExpression(0);
    if (this.current.kind !== "end") throw new Error(`Unexpected token: ${this.current.text}`);
    return value;
  }

  private parseExpression(minimumBindingPower: number): number {
    let left = this.parsePrefix();
    while (this.current.kind === "operator") {
      const operator = this.current.text;
      const [leftPower, rightPower] = bindingPower(operator);
      if (leftPower < minimumBindingPower) break;
      this.#index += 1;
      const right = this.parseExpression(rightPower);
      left = applyOperator(operator, left, right);
    }
    return left;
  }

  private parsePrefix(): number {
    const token = this.current;
    if (token.kind === "operator" && (token.text === "+" || token.text === "-")) {
      this.#index += 1;
      const value = this.parseExpression(7);
      return token.text === "-" ? -value : value;
    }
    if (token.kind === "number") {
      this.#index += 1;
      return token.value ?? 0;
    }
    if (token.kind === "left") {
      this.#index += 1;
      const value = this.parseExpression(0);
      this.expect("right");
      return value;
    }
    if (token.kind !== "identifier") throw new Error(`Expected a value, found ${token.text}`);
    this.#index += 1;
    const name = token.text.toLowerCase();
    if (!this.at("left")) return this.variable(name);
    this.#index += 1;
    const arguments_: number[] = [];
    if (!this.at("right")) {
      while (true) {
        arguments_.push(this.parseExpression(0));
        if (!this.at("comma")) break;
        this.#index += 1;
      }
    }
    this.expect("right");
    return callFunction(name, arguments_);
  }

  private variable(name: string): number {
    if (name === "time") return this.context.time;
    if (name === "value") return this.context.value;
    if (name === "pi") return Math.PI;
    if (name === "e") return Math.E;
    throw new Error(`Unknown variable: ${name}`);
  }

  private expect(kind: Token["kind"]): void {
    if (this.current.kind !== kind) throw new Error(`Expected ${kind}, found ${this.current.text}`);
    this.#index += 1;
  }

  private at(kind: Token["kind"]): boolean {
    return this.current.kind === kind;
  }

  private get current(): Token {
    return this.tokens[this.#index];
  }
}

function bindingPower(operator: string): [number, number] {
  if (operator === "^") return [6, 6];
  if (operator === "*" || operator === "/" || operator === "%") return [4, 5];
  return [2, 3];
}

function applyOperator(operator: string, left: number, right: number): number {
  if (operator === "+") return left + right;
  if (operator === "-") return left - right;
  if (operator === "*") return left * right;
  if (operator === "/") return left / right;
  if (operator === "%") return left % right;
  return left ** right;
}

function callFunction(name: string, values: number[]): number {
  const unary: Record<string, (value: number) => number> = {
    abs: Math.abs,
    ceil: Math.ceil,
    cos: Math.cos,
    floor: Math.floor,
    round: Math.round,
    sin: Math.sin,
    sqrt: Math.sqrt,
    tan: Math.tan,
  };
  if (unary[name] && values.length === 1) return unary[name](values[0]);
  if (name === "min" && values.length >= 1) return Math.min(...values);
  if (name === "max" && values.length >= 1) return Math.max(...values);
  if (name === "pow" && values.length === 2) return values[0] ** values[1];
  if (name === "clamp" && values.length === 3)
    return Math.max(values[1], Math.min(values[2], values[0]));
  throw new Error(`Unknown function or argument count: ${name}`);
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && ((value >= "a" && value <= "z") || (value >= "A" && value <= "Z"));
}

function isIdentifierPart(value: string | undefined): boolean {
  return isIdentifierStart(value) || isDigit(value) || value === "_";
}
