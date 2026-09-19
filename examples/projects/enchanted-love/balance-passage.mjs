import {
  animate,
  comp,
  constant,
  continuous,
  during,
  ellipse,
  joint,
  line,
  palette as P,
  parent,
  place,
  rect,
  vector,
} from "./authoring.mjs";

function turn(node, path, points) {
  animate(node, path, continuous(points));
}

function ground(c, color, points, y = 424) {
  const root = joint("Ground plane · one rotating horizon", 640, y);
  turn(root, "rotation.2", points);
  c.layers.push(root, parent(rect("Lower half-plane", 0, 1500, 5000, 3000, color), root));
  return root;
}

function swimmingFrog() {
  const c = comp("Frog · folded swimming profile", 400, 340);
  const root = joint("Folded hip", 200, 210);
  c.layers.push(root);
  const shape = (name, points, fill) => c.layers.push(parent(vector(name, points, fill), root));
  shape(
    "Far folded leg",
    [
      [-10, 40, [0, 0], [-28, -65]],
      [70, -158, [-51, 42], [19, -24]],
      [86, -123, [16, -38], [-1, 69]],
      [21, 17, [51, -34]],
    ],
    P.teal,
  );
  shape(
    "Near folded leg",
    [
      [-10, 40, [0, 0], [44, -77]],
      [100, -143, [-4, 16], [20, 8]],
      [97, -58, [15, -40], [-18, 49]],
      [27, 23, [44, -17]],
    ],
    P.turquoise,
  );
  shape(
    "Bent neck",
    [
      [-10, 40],
      [-91, -33, [0, 0], [-15, -2]],
      [-75, -64],
      [4, -8],
    ],
    P.teal,
  );
  c.layers.push(
    parent(place(ellipse("Profile head", -97, -26, 73, 96, P.teal), -97, -26, 100, -29), root),
  );
  shape(
    "Cream throat",
    [
      [-106, 15, [0, 0], [0, 37]],
      [-91, 73, [-14, 10], [23, -5]],
      [-79, 2, [13, 35]],
    ],
    P.cream,
  );
  c.layers.push(
    parent(ellipse("Single eye", -105, -13, 28, 36, P.cream), root),
    parent(place(rect("Eye slit", -104, -13, 10, 28, P.teal, 5), -104, -13, 100, 10), root),
  );
  for (const [x, y] of [
    [70, -130],
    [92, -117],
  ])
    c.layers.push(parent(place(rect("Folded toe", x, y, 8, 33, P.cream, 4), x, y, 100, 12), root));
  return c;
}

export function balancePassage(b) {
  const { add, tint, props: p, characters: a } = b;
  {
    const c = b.scene("31 · Balancing and the wing-shaped arm accent", 72.6, 73.133333333, P.green);
    ground(
      c,
      P.teal,
      [
        [0, -30.6],
        [0.2, -34],
        [0.4, -22.9],
        [0.5, -5.34],
        [8 / 15, 10],
      ],
      382,
    );
    const girl = add(c, a.girls.spread, 650, 611, 82);
    turn(girl, "rotation.2", [
      [0, 0],
      [0.2, -2],
      [0.4, 0],
      [0.5, 12],
    ]);
    const heart = tint(add(c, p.heart, 155, 536, 150), P.blue);
    const crown = tint(add(c, p.crown, 1120, 296, 145), P.green);
    turn(heart, "position.1", [
      [0, 536],
      [0.2, 526],
      [0.4, 510],
      [0.5, 355],
    ]);
    turn(crown, "position.1", [
      [0, 296],
      [0.2, 290],
      [0.4, 345],
      [0.5, 444],
    ]);
    for (const item of [heart, crown]) {
      animate(item, "scale.0", [
        [0, 80],
        [0.1, 150],
      ]);
      animate(item, "scale.1", [
        [0, 180],
        [0.1, 90],
      ]);
    }
    for (const sign of [-1, 1]) {
      const wing = place(
        vector(
          "Sweeping arm accent",
          [
            [0, 0],
            [sign * 232, -43, [0, 0], [sign * 30, 22]],
            [sign * 260, 86, [sign * 3, -27]],
          ],
          P.cream,
        ),
        656,
        405,
      );
      animate(wing, "scale.1", [
        [0.466666667, 0],
        [0.5, 100],
      ]);
      c.layers.push(during(wing, 14 / 30, c.duration));
    }
  }
  {
    const c = b.scene(
      "32 · Swimming through rotating parentheses",
      73.133333333,
      74.5,
      P.turquoise,
    );
    const angles = [
      [0, -112],
      [2 / 30, -84.02],
      [4 / 15, -61.44],
      [2 / 3, -45],
      [1.066666667, -33.61],
      [1.266666667, -15.01],
      [1.366666667, 6],
    ];
    ground(c, P.teal, angles);
    const brackets = joint("Parenthesis pair · shared orbit", 640, 424);
    turn(brackets, "rotation.2", [
      [0, -85],
      [2 / 30, -25],
      [4 / 15, 0],
      [2 / 3, 30],
      [1.066666667, 63],
      [1.266666667, 115],
      [1.366666667, 150],
    ]);
    c.layers.push(brackets);
    for (const [sign, color] of [
      [-1, P.blue],
      [1, P.turquoise],
    ])
      c.layers.push(
        parent(
          place(
            line(
              "Parenthesis · single cubic arc",
              [
                [sign * 400, -220, [0, 0], [sign * 80, 145]],
                [sign * 400, 220, [sign * 80, -145]],
              ],
              color,
              106,
            ),
            0,
            0,
          ),
          brackets,
        ),
      );
    const frog = swimmingFrog();
    b.supporting.push(frog);
    const swimmer = add(c, frog, 640, 410);
    swimmer.transform.anchor[0] = constant(190);
    swimmer.transform.anchor[1] = constant(250);
    turn(swimmer, "rotation.2", [
      [0, -105],
      [2 / 30, -45],
      [4 / 15, 0],
      [2 / 3, 25],
      [1.066666667, 40],
      [1.266666667, 55],
    ]);
    turn(swimmer, "position.0", [
      [0, 638],
      [4 / 15, 666],
      [2 / 3, 631],
      [1.066666667, 580],
      [1.266666667, 550],
    ]);
    turn(swimmer, "position.1", [
      [0, 410],
      [4 / 15, 382],
      [2 / 3, 435],
      [1.066666667, 468],
      [1.266666667, 454],
    ]);
    return c;
  }
}
