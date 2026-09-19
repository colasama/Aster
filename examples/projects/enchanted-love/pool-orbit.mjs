import {
  animate,
  continuous,
  during,
  id,
  palette as P,
  place,
  rect,
  rgba,
  track,
  vector,
} from "./authoring.mjs";
import { keyPose } from "./scenes.mjs";

export function poolOrbit(b) {
  const c = b.scene("09 · Pool orbit", 907 / 30, 33.1, P.turquoise);
  // Two successive irises recede on independent radial clocks.
  for (const [name, color, radius] of [
    ["Outer green iris", P.green, "max(0,874.184-51.78*time-70.856*time*time)"],
    [
      "Inner water iris",
      P.turquoise,
      "max(0,393.734-94.661*time-95.007*time*time+13.717*pow(time,3))",
    ],
  ]) {
    const field = b.circle(c, 640, 424, 200, color, name);
    field.expressions = { "scale.0": radius, "scale.1": radius };
  }

  const centerX = continuous([
    [0, 656],
    [0.35, 616],
    [0.7, 612],
    [1.5, 632],
    [2.1, 640],
  ]);
  const centerY = continuous([
    [0, 470],
    [0.8, 444],
    [1.5, 426],
    [2.1, 424],
  ]);
  const ring = during(b.add(c, b.props.ring, 640, 424, 97), 0, 2.1);
  keyPose(ring, {
    "position.0": centerX,
    "position.1": centerY,
    "rotation.2": [
      [0, -10],
      [2.1, 12],
    ],
  });
  for (const axis of ["scale.0", "scale.1"])
    animate(ring, axis, [
      [0, 97],
      [1.6, 97, [0.5, 0, 0.8, 0.2]],
      [2.1, 0],
    ]);

  const arc = during(
    place(
      vector(
        "Ring wake · quarter-circle",
        [
          [-100, -122, [0, 0], [75, -61]],
          [122, -100, [-61, -75]],
        ],
        null,
        { closed: false, stroke: P.green, strokeWidth: 62 },
      ),
      640,
      424,
    ),
    0,
    1.6,
  );
  c.layers.push(arc);
  keyPose(arc, { "position.0": centerX, "position.1": centerY });
  arc.expressions = { "rotation.2": "5+120*time+22*sin(time*18)" };
  animate(arc, "opacity", [
    [0, 70],
    [1.2, 70],
    [1.6, 0],
  ]);

  const ballSource = structuredClone(b.props.ball);
  ballSource.id = id("comp");
  ballSource.name = "Beach ball · water light";
  for (const part of ballSource.layers) {
    part.id = id("layer");
    if (part.name === "Sphere") part.color = rgba(P.teal);
  }
  b.supporting.push(ballSource);
  const ball = b.add(c, ballSource, 640, 424, 97);
  const radius = "(593.032-120.033*time+4.48*time*time-7.936*pow(time,3))";
  const angle =
    "(-0.988069+1.681399*time-0.528887*time*time+0.093976*pow(time,3)-0.55*pow(max(0,1-time/0.3),2))";
  ball.expressions = {
    "position.0": `640+${radius}*cos(${angle})`,
    "position.1": `424+${radius}*sin(${angle})`,
    "rotation.2": "-90+37*time",
  };
  ball.timeRemap = track([
    [0, 0.1],
    [2.2, 2.4],
    [c.duration, 2.65],
  ]);

  const frog = during(b.add(c, b.characters.frog, 640, 424, 85), 0.9, 2.866666667);
  keyPose(frog, {
    "position.0": continuous([
      [0.9, 1210],
      [1.4, 1004],
      [2, 853],
      [2.5, 718],
      [2.8, 640],
    ]),
    "position.1": continuous([
      [0.9, -220],
      [1.4, 32],
      [2, 203],
      [2.5, 299],
      [2.8, 420],
    ]),
    "rotation.2": continuous([
      [0.9, -185],
      [1.4, -169],
      [2, -108],
      [2.5, -45],
      [2.8, -20],
    ]),
  });
  for (const axis of ["scale.0", "scale.1"])
    animate(frog, axis, [
      [0.9, 85],
      [2.4, 85],
      [2.65, 50],
      [2.8, 0],
    ]);

  const girl = during(b.add(c, b.characters.girls.floatingTuck, 0, 700, 89, 29), 1.55, c.duration);
  keyPose(girl, {
    "position.0": continuous([
      [1.55, -270],
      [1.9, -38],
      [2.3, 94],
      [2.866666667, 310],
    ]),
    "position.1": continuous([
      [1.55, 895],
      [1.9, 781],
      [2.3, 704],
      [2.866666667, 620],
    ]),
    "rotation.2": [
      [1.55, 33],
      [2.3, 29],
      [c.duration, 22],
    ],
  });
  for (const axis of ["scale.0", "scale.1"])
    animate(girl, axis, [
      [1.55, 89],
      [2.3, 85],
      [c.duration, 68],
    ]);
}

export function ballAccent(b) {
  const c = b.scene("24 · Ball accent", 1817 / 30, 61.2, P.green);
  const bar = during(rect("Stretching vertical bar", 640, 332, 122, 480, P.blue), 0, 0.3);
  animate(bar, "anchor.1", 0);
  animate(bar, "scale.1", [
    [0, 38.3, [0.08, 0.9, 0.2, 1]],
    [0.1, 100],
    [8 / 30, 95],
  ]);
  c.layers.push(bar);
  c.layers.push(
    during(rect("Water colour cut", 640, 424, 1280, 848, P.turquoise), 0.3, c.duration),
  );
  const ball = during(b.add(c, b.props.ball, 640, 384, 114), 0.3, c.duration);
  animate(ball, "position.1", [
    [0.3, 385, [0.1, 0.8, 0.2, 1]],
    [13 / 30, 160, [0.7, 0, 0.9, 0.2]],
    [0.633333333, 390],
  ]);
  ball.expressions = { "rotation.2": "-28+260*(time-0.3)" };
}
