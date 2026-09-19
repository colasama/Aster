import { animate, comp, constant, during, palette as P, place, vector } from "./authoring.mjs";

export function reunionScene(b) {
  const { scene, add, circle, tint, supporting, props: p, characters: a } = b;
  const c = scene("41 · Reunion in the spotlight", 93.8, 95.6, P.black);
  c.layers.push(
    place(
      vector(
        "Broad spotlight with ivory edges",
        [
          [-170, -40],
          [170, -40],
          [348, 860],
          [-377, 860],
        ],
        P.green,
        { stroke: P.cream, strokeWidth: 24 },
      ),
      638,
      0,
    ),
  );
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
    c.layers.push(floor);
  }
  const outerScale = [
    [0.3, 0],
    [0.6, 56],
    [0.8, 89],
    [1, 100],
    [1.2, 104],
    [1.5, 425],
  ];
  const glow = during(
    circle(c, 635, 440, 400, P.cream, "Crown light behind the riders"),
    0.3,
    0.733333333,
  );
  for (const axis of ["scale.0", "scale.1"]) animate(glow, axis, outerScale);
  const fallingCrown = add(c, p.crown, 635, 262, 42);
  during(fallingCrown, 0, 0.5);
  animate(fallingCrown, "position.1", [
    [0, 262],
    [0.2, 500],
    [0.4, 440],
  ]);

  const riders = comp("Reunion · girl and frog riding the turtle", 1280, 848, c.duration);
  add(riders, p.turtle, 602, 614, 100, -5);
  const frog = add(riders, a.profileFrog, 565, 506, 58, 12);
  frog.transform.scale[0] = constant(42);
  add(riders, a.girls.reunion, 637, 594, 90);
  supporting.push(riders);
  const tableau = add(c, riders);
  tableau.expressions = { "position.1": "424-16*min(time,0.6)" };

  // The expanding outer iris and the small central medallion have separate curves.
  const outer = during(
    circle(c, 635, 440, 400, P.cream, "Expanding outer iris"),
    0.733333333,
    1.433333333,
  );
  for (const axis of ["scale.0", "scale.1"]) animate(outer, axis, outerScale);
  const green = during(
    circle(c, 635, 440, 400, P.green, "Green iris opens into the pool"),
    0.8,
    c.duration,
  );
  const core = during(
    circle(c, 635, 440, 200, P.cream, "Crown medallion remains in the center"),
    0.933333333,
    c.duration,
  );
  for (const axis of ["scale.0", "scale.1"]) {
    animate(green, axis, [
      [0.8, 0],
      [1, 57],
      [1.2, 65],
      [1.5, 385],
      [1.8, 600],
    ]);
    animate(core, axis, [
      [0.933333333, 0],
      [1, 73],
      [1.5, 90],
      [1.8, 76],
    ]);
  }
  for (const [start, end, color] of [
    [0.5, 0.733333333, P.cream],
    [0.733333333, 1, P.turquoise],
    [1, c.duration, P.green],
  ])
    during(tint(add(c, p.crown, 635, 440, 42), color), start, end);
  return c;
}
