import { animate, comp, constant, during, palette as P, place, vector } from "./authoring.mjs";

export function reunionScene(b, c) {
  const { add, circle, tint, supporting, props: p, characters: a } = b;
  const base = 2.9;
  const floorComp = comp("Reunion · rising pool floor", 1280, 848, c.duration);
  const chevron = [
    [-21, -6],
    [-11, -16],
    [0, -4],
    [11, -16],
    [21, -6],
    [0, 15],
  ];
  for (const [x, y, color] of [
    [374, 704, P.turquoise],
    [438, 775, P.teal],
    [540, 894, P.turquoise],
    [624, 900, P.turquoise],
    [700, 900, P.turquoise],
    [768, 817, P.teal],
    [848, 725, P.turquoise],
  ]) {
    const floor = place(vector("Repeated pool-floor chevron", chevron, color), x, y);
    floor.cloner = {
      distribution: { kind: "grid", count: [1, 9, 1], spacing: [0, 36, 0] },
      effectors: [],
    };
    floorComp.layers.push(floor);
  }
  const outerScale = [
    [base + 0.3, 0],
    [base + 0.6, 56],
    [base + 0.8, 89],
    [base + 1, 100],
    [base + 1.2, 104],
  ];
  const glow = during(
    circle(c, 635, 440, 400, P.cream, "Crown light behind the riders"),
    base + 0.3,
    base + 0.733333333,
  );
  for (const axis of ["scale.0", "scale.1"]) animate(glow, axis, outerScale);
  const riders = comp("Reunion · girl and frog riding the turtle", 1280, 848, c.duration);
  add(riders, p.turtle, 602, 614, 100, -5);
  const frog = add(riders, a.profileFrog, 565, 506, 58, 12);
  frog.transform.scale[0] = constant(42);
  add(riders, a.girls.reunion, 637, 594, 90);
  supporting.push(riders);
  supporting.push(floorComp);
  const rise = "424+650*pow(e,-4.5*max(0,time-2.166666667))-30";
  for (const source of [floorComp, riders]) {
    const tableau = during(add(c, source), 65 / 30, c.duration);
    tableau.expressions = { "position.1": rise };
  }

  // The expanding outer iris and the small central medallion have separate curves.
  const outer = during(
    circle(c, 635, 440, 400, P.cream, "Expanding outer iris"),
    base + 0.733333333,
    base + 1.433333333,
  );
  for (const axis of ["scale.0", "scale.1"]) animate(outer, axis, outerScale);
  const green = during(
    circle(c, 635, 440, 400, P.green, "Green iris opens into the pool"),
    base + 0.8,
    c.duration,
  );
  const core = during(
    circle(c, 635, 440, 200, P.cream, "Crown medallion remains in the center"),
    base + 0.933333333,
    c.duration,
  );
  for (const axis of ["scale.0", "scale.1"]) {
    animate(green, axis, [
      [base + 0.8, 0],
      [base + 1, 57],
      [base + 1.2, 65],
      [base + 1.3, 65, [0, 0, 1, 1]],
      [base + 1.8, 1065],
    ]);
    animate(core, axis, [
      [base + 0.933333333, 0],
      [base + 1, 73],
      [base + 1.3, 91],
      [base + 1.8, 76],
    ]);
  }
  for (const [start, end, color] of [
    [base + 0.5, base + 0.733333333, P.cream],
    [base + 0.733333333, base + 1, P.turquoise],
    [base + 1, c.duration, P.green],
  ])
    during(tint(add(c, p.crown, 635, 440, 42), color), start, end);
  return c;
}
