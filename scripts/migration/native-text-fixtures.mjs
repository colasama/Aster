export function textFixtures() {
  const scalar = (value) => ({ mode: "static", value });
  const animated = (a, b) => ({
    mode: "animated",
    keyframes: [
      { id: "a", time: 0.25, value: a, interpolation: "bezier", easing: [0.3, -0.5, 0.7, 1.5] },
      { id: "b", time: 2, value: b, interpolation: "linear" },
    ],
  });
  const range = {
    id: "range",
    name: "Range",
    enabled: true,
    kind: "range",
    mode: "add",
    amount: scalar(100),
    basedOn: "characters",
    units: "percentage",
    start: scalar(0),
    end: scalar(100),
    offset: scalar(0),
    shape: "square",
    smoothness: scalar(0),
    easeLow: scalar(0),
    easeHigh: scalar(0),
    randomizeOrder: false,
    randomSeed: 0,
  };
  const wiggly = {
    id: "wiggly😀",
    name: "Wiggly",
    enabled: true,
    kind: "wiggly",
    mode: "add",
    amount: scalar(100),
    basedOn: "characters",
    minimumAmount: scalar(-80),
    maximumAmount: scalar(90),
    wigglesPerSecond: scalar(3.1),
    correlation: scalar(0),
    temporalPhase: scalar(-41),
    spatialPhase: scalar(1.7),
    randomSeed: 0,
  };
  const expression = {
    id: "expression",
    name: "Expression",
    enabled: true,
    kind: "expression",
    mode: "add",
    amount: scalar(100),
    basedOn: "characters",
    expression: "selectorValue * textIndex / textTotal + sin(time) * 20",
    timeOffset: scalar(0.2),
  };
  const properties = {
    anchorPoint: [animated(-20, 30), scalar(3), scalar(-8)],
    position: [animated(-120, 240), scalar(20), scalar(45)],
    scale: [animated(-150, 250), scalar(75), scalar(125)],
    rotation: [animated(-90, 360), scalar(15), scalar(-45)],
    skew: animated(-40, 35),
    skewAxis: scalar(24),
    opacity: animated(20, 100),
    strokeWidth: animated(-10, 12),
    tracking: animated(-15, 45),
    lineAnchor: animated(0, 100),
    lineSpacing: [animated(-20, 50), scalar(12)],
    blur: [animated(0, 40), scalar(8)],
    fillColor: [scalar(0.2), animated(0.1, 0.9), scalar(1), scalar(0.7)],
    strokeColor: [scalar(0.8), scalar(0.1), scalar(0), scalar(1)],
    characterOffset: animated(-29, 62),
    characterValue: scalar(101),
    characterRange: "preserveCaseAndDigits",
  };
  const cases = [];
  function add(selectors, props = properties, edits = {}) {
    cases.push({
      enabled: true,
      groups: [
        {
          id: "group",
          name: "Group",
          enabled: true,
          randomSeed: -2147483648,
          selectors: structuredClone(selectors),
          properties: structuredClone(props),
          ...edits,
        },
      ],
    });
  }
  for (const shape of ["square", "rampUp", "rampDown", "triangle", "round", "smooth"])
    for (const units of ["percentage", "index"])
      for (const basedOn of ["characters", "charactersExcludingSpaces", "words", "lines"])
        for (const randomizeOrder of [false, true])
          add([
            {
              ...range,
              shape,
              units,
              basedOn,
              randomizeOrder,
              start: animated(-20, 70),
              end: scalar(units === "index" ? 8 : 45),
              offset: animated(-120, 150),
              smoothness: scalar(61),
              easeLow: scalar(-37),
              easeHigh: scalar(61),
            },
          ]);
  for (const seed of [0, 1, -1, 2147483647])
    for (const correlation of [0, 50, 100])
      add([{ ...wiggly, randomSeed: seed, correlation: scalar(correlation) }], properties, {
        randomSeed: seed,
      });
  for (const mode of ["add", "subtract", "intersect", "min", "max", "difference"]) {
    add([{ ...range, mode, amount: scalar(-63) }]);
    add([range, { ...wiggly, mode }, expression]);
  }
  for (const expr of [
    "1/0",
    "unknown(time)",
    "selectorValue/2",
    "100/(textIndex-2)",
    "beat(120)*10",
    "clamp(sqrt(-1),0,100)",
  ])
    add([{ ...expression, expression: expr }]);
  add([]);
  add([], {});
  add([{ ...range, enabled: false }]);
  add([range], properties, { enabled: false });
  add([range], { ...properties, characterRange: "fullUnicode", characterValue: scalar(55296) });
  add([range], { characterOffset: scalar(-1000000), characterRange: "fullUnicode" });
  add([range], { characterValue: scalar(1114111), characterRange: "fullUnicode" });
  add([range], { characterValue: scalar(49), characterRange: "preserveCaseAndDigits" });
  add([range], { position: [scalar(30), scalar(-20), scalar(10)] });
  add([expression], {});
  cases.push({ enabled: false, groups: structuredClone(cases[0].groups) });
  const combined = structuredClone(cases[0]);
  combined.groups.push({
    ...structuredClone(cases[1].groups[0]),
    id: "second",
    selectors: [{ ...expression, amount: scalar(-55) }],
  });
  cases.push(combined);
  return cases;
}

export function textExpressionFixtures() {
  const expressions = [
    "selectorValue",
    "textIndex/textTotal*100",
    "time",
    "PI+E+pi+e",
    "-2^2",
    "2^3^2",
    "100/(textIndex-2)",
    "1/0",
    "1%0",
    "0/0",
    "1e300*1e300",
    "sqrt(-1)",
    "clamp(3,5,1)",
    "linear(1,1,1,2,4)",
    "ease(1,1,1,2,4)",
    "ease(2,1,1,2,4)",
    "max(0,min())",
    "min(0,max())",
    "clamp(1/0,0,1)",
    "value",
    "unknown(2)",
    "",
    "time.foo",
    "1e+",
    "(1+2",
    "1 2",
    "1,",
  ];
  for (const name of [
    "abs",
    "sin",
    "cos",
    "tan",
    "sqrt",
    "ceil",
    "floor",
    "round",
    "min",
    "max",
    "pow",
    "clamp",
    "linear",
    "ease",
    "beat",
    "beatphase",
  ])
    for (const args of ["", "-0.5", "2,3", "5,1,4,2,8", "1,2,3,4,5,6", "1,1/0"])
      expressions.push(`${name}(${args})`);
  expressions.push(
    `${"(".repeat(33)}1${")".repeat(33)}`,
    Array(258).fill("1").join("+"),
    `${" ".repeat(2048)}1`,
  );
  return expressions;
}
