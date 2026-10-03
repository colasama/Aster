import { SyntaxKind as Kind } from "typescript/unstable/ast";

const WGSL_SYNTAX =
  /@(?:group|binding|location|builtin|vertex|fragment|compute|workgroup_size)\b|\bfn\s+[A-Za-z_]\w*\s*\(|\bstruct\s+[A-Za-z_]\w*\s*\{|\bcase\s+\d+u\s*:|\b(?:var(?:\s*<[^>]+>)?|let|const|override)\s+[A-Za-z_]\w*\s*:\s*(?:vec[234]|mat[234]x[234]|f32|u32|i32|array\s*<|texture_|sampler|[A-Z]\w*)/;

function literal(node) {
  return node.kind === Kind.StringLiteral || node.kind === Kind.NoSubstitutionTemplateLiteral;
}

function sourceParts(node) {
  if (literal(node)) return { text: node.text, derived: true };
  if (node.kind === Kind.TemplateExpression) {
    return {
      text:
        node.head.text +
        node.templateSpans
          .map((span) => {
            const expression = sourceParts(span.expression);
            return (expression.derived ? expression.text : "interpolated") + span.literal.text;
          })
          .join(""),
      derived: true,
    };
  }
  if (
    node.kind === Kind.ParenthesizedExpression ||
    node.kind === Kind.AsExpression ||
    node.kind === Kind.SatisfiesExpression
  )
    return sourceParts(node.expression);
  if (node.kind === Kind.BinaryExpression && node.operatorToken.kind === Kind.PlusToken) {
    const left = sourceParts(node.left);
    const right = sourceParts(node.right);
    return { text: left.text + right.text, derived: left.derived || right.derived };
  }
  if (node.kind === Kind.ConditionalExpression) {
    const yes = sourceParts(node.whenTrue);
    const no = sourceParts(node.whenFalse);
    return { text: `${yes.text}\n${no.text}`, derived: yes.derived || no.derived };
  }
  if (
    node.kind === Kind.CallExpression &&
    node.expression.kind === Kind.PropertyAccessExpression &&
    node.expression.name.text === "join" &&
    node.expression.expression.kind === Kind.ArrayLiteralExpression
  ) {
    const parts = node.expression.expression.elements.map(sourceParts);
    const separator = node.arguments.length ? sourceParts(node.arguments[0]).text : ",";
    return {
      text: parts.map((part) => part.text).join(separator),
      derived: parts.some((part) => part.derived),
    };
  }
  return { text: "", derived: false };
}

function assertionOperand(node, text) {
  if (text.length > 200 || /[\r\n]/.test(text) || /\b(?:fn|struct)\b[^{}]*\{/.test(text))
    return false;
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (
      parent.kind === Kind.ArrayLiteralExpression ||
      parent.kind === Kind.ObjectLiteralExpression ||
      parent.kind === Kind.PropertyAssignment ||
      parent.kind === Kind.ParenthesizedExpression
    )
      continue;
    if (parent.kind !== Kind.CallExpression || !parent.arguments.includes(child)) return false;
    const matcher = parent.expression;
    if (
      matcher.kind !== Kind.PropertyAccessExpression ||
      !["toContain", "toEqual", "toStrictEqual", "toBe", "toMatch", "toMatchObject"].includes(
        matcher.name.text,
      )
    )
      return false;
    let receiver = matcher.expression;
    while (
      receiver.kind === Kind.PropertyAccessExpression &&
      ["not", "resolves", "rejects"].includes(receiver.name.text)
    )
      receiver = receiver.expression;
    return (
      receiver.kind === Kind.CallExpression &&
      receiver.expression.kind === Kind.Identifier &&
      receiver.expression.text === "expect"
    );
  }
  return false;
}

function marked(node, file) {
  const trivia = file.text.slice(node.pos, node.getStart(file));
  return (
    /\/\*\s*wgsl\s*\*\//i.test(trivia) ||
    (node.parent?.kind === Kind.TaggedTemplateExpression &&
      /^(?:wgsl|WGSL)$/.test(node.parent.tag.getText(file)))
  );
}

export function inspectShaderLiterals(file) {
  let literalCount = 0;
  let assertionCount = 0;
  const violations = [];
  const report = (node, reason) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.push({ line, reason });
  };
  const visit = (node) => {
    if (literal(node) || node.kind === Kind.TemplateExpression) literalCount += 1;
    const value = sourceParts(node);
    if (value.derived && marked(node, file)) report(node, "WGSL-marked inline source");
    else if (value.derived && WGSL_SYNTAX.test(value.text)) {
      if (assertionOperand(node, value.text)) assertionCount += 1;
      else report(node, "Executable inline WGSL source or fragment");
    }
    if (
      node.kind === Kind.CallExpression &&
      ((node.expression.kind === Kind.PropertyAccessExpression &&
        node.expression.name.text === "createShaderModule") ||
        (node.expression.kind === Kind.ElementAccessExpression &&
          node.expression.argumentExpression.text === "createShaderModule"))
    ) {
      let descriptor = node.arguments[0];
      while (
        descriptor?.kind === Kind.ParenthesizedExpression ||
        descriptor?.kind === Kind.AsExpression ||
        descriptor?.kind === Kind.SatisfiesExpression
      )
        descriptor = descriptor.expression;
      if (descriptor?.kind === Kind.ObjectLiteralExpression) {
        for (const property of descriptor.properties) {
          const name =
            property.name?.kind === Kind.ComputedPropertyName
              ? property.name.expression.text
              : property.name?.text;
          if (
            property.kind === Kind.PropertyAssignment &&
            name === "code" &&
            sourceParts(property.initializer).derived
          )
            report(property.initializer, "Literal-derived createShaderModule code");
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return { literal_count: literalCount, assertion_count: assertionCount, violations };
}
