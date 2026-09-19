import { animate, constant, during, palette as P, place, vector } from "./authoring.mjs";

export function poolFlash(b, raft) {
  const c = b.scene(
    "23 · Pool flash, closing card, and crown toss",
    59.833333333,
    60.566666667,
    P.blue,
  );
  const card = place(
    vector(
      "Cream card · gently bowed sides",
      [
        [-640, -424, [0, 0], [28, 280]],
        [-640, 424, [28, -280]],
        [640, 424, [0, 0], [-28, -280]],
        [640, -424, [-28, 280]],
      ],
      P.cream,
    ),
    640,
    424,
  );
  animate(card, "scale.0", [
    [0, 110],
    [1 / 30, 90.625],
    [2 / 30, 15],
    [4 / 30, 6.5],
  ]);
  c.layers.push(during(card, 0, 5 / 30));
  for (const [riders, dy] of [
    [b.shadow(c, raft, 640, 424, 100, 22, P.turquoise), 40],
    [b.add(c, raft, 640, 424, 100, 22), 0],
  ]) {
    riders.timeRemap = constant(4.2);
    animate(riders, "position.1", [
      [0, 424 + dy],
      [1 / 30, 354 + dy],
    ]);
    during(riders, 0, 2 / 30);
  }
  const crown = during(b.add(c, b.props.crown, 640, 320, 109), 5 / 30, c.duration);
  // The toss has a steep launch, a suspended apex, and an accelerating fall.
  animate(crown, "position.1", [
    [5 / 30, 320, [0, 0.905124, 0.511831, 1]],
    [13 / 30, 106, [0.800874, 0.027552, 1, 0.671934]],
    [21 / 30, 285],
  ]);
  animate(crown, "rotation.2", [
    [5 / 30, -8, [0.131115, 0, 0.15404, 0.813392]],
    [13 / 30, -264, [0, 0.039855, 0.55257, 0.111738]],
    [21 / 30, -366],
  ]);
  return c;
}
