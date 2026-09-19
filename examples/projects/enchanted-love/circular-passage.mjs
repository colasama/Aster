import {
  animate,
  comp,
  constant,
  continuous,
  during,
  id,
  palette as P,
  rgba,
  track,
} from "./authoring.mjs";
import { keyPose } from "./scenes.mjs";

const colours = [P.green, P.turquoise, P.teal, P.blue, P.green, P.turquoise];

function recedingRings(b, c) {
  // Early irises shrink in succession; later the same colour cycle recedes faster.
  const exits = [
    33.399, 34.414, 35.063, 35.544, 35.93, 36.255, 36.522, 36.752, 36.96, 37.147, 37.326, 37.48,
    37.62,
  ];
  const speeds = [480, 784, 1060, 1277, 1450, 1620, 1870, 2088, 2295, 2490, 2640, 2820, 3000];
  for (let i = exits.length - 1; i >= 0; i--) {
    const disk = during(
      b.circle(c, 639, 422, 200, colours[i % colours.length], `Receding iris ${i + 1}`),
      0,
      4.1,
    );
    const radius = `max(0,${speeds[i]}*(${exits[i] - 33.1}-time))`;
    disk.expressions = { "scale.0": radius, "scale.1": radius };
  }
  const cycle = comp("Iris · six-colour cycle", 1280, 848, 42);
  for (let i = 5; i >= 0; i--) {
    const disk = b.circle(cycle, 639, 422, 200, colours[i], `Depth ring ${i + 1}`);
    during(disk, 0, 36 + i);
    disk.expressions = {
      "scale.0": `100*pow(max(0,${36 + i}-time),1.1)`,
      "scale.1": `100*pow(max(0,${36 + i}-time),1.1)`,
    };
  }
  const field = comp("Iris · repeated depth cycles", 1280, 848, 140);
  for (let i = 22; i >= 0; i--) {
    const repeat = b.add(field, cycle);
    during(repeat, Math.max(0, i * 6 - 36), i * 6 + 5);
    repeat.timeOffset = Math.max(0, 36 - i * 6);
  }
  b.supporting.push(cycle, field);
  const camera = during(b.add(c, field), 4.1, c.duration);
  animate(camera, "anchor.0", 639);
  animate(camera, "anchor.1", 422);
  animate(camera, "position.0", 639);
  animate(camera, "position.1", 422);
  // Beat landmarks share fitted Bezier timing, including the brief radial rebound.
  camera.timeRemap = track([
    [4.1, 9.1, [0.333333, 0.307055, 0.666667, 0.472096]],
    [4.3, 10.3, [0.333333, 0.0, 0.666667, 0.171035]],
    [4.5, 11.9, [0.333333, 0.254874, 0.666667, 0.60182]],
    [4.7, 14.05, [0.333333, 0.342536, 0.666667, 0.445808]],
    [4.8, 15.68, [0.333333, 0.0, 0.666667, 1.0]],
    [4.9, 14.675, [0.333333, 0.1819, 0.666667, 0.560708]],
    [5.1, 17.7, [0.333333, 0.222731, 0.666667, 0.627214]],
    [5.3, 22.225, [0.333333, 0.434699, 0.666667, 0.612748]],
    [5.5, 27.625, [0.333333, 0.264423, 0.666667, 0.622342]],
    [5.7, 35.125, [0.333333, 0.41145, 0.666667, 0.785868]],
    [5.9, 47.2, [0.333333, 0.238433, 0.666667, 0.723827]],
    [6.1, 60.25, [0.333333, 0.342499, 0.666667, 0.676019]],
    [6.3, 75.975, [0.333333, 0.341164, 0.666667, 0.693703]],
    [6.5, 96.625],
    [6.533333333, 100.5],
  ]);

  const zoom = continuous([
    [4.1, 365],
    [4.5, 291],
    [4.9, 193],
    [5.3, 110],
    [5.7, 66.6],
    [6.1, 41.65],
    [6.5, 25.96],
  ]);
  for (const axis of ["scale.0", "scale.1"]) animate(camera, axis, zoom);
}

function floatingRiders(b, c) {
  const girl = during(b.add(c, b.characters.girls.floatingTuck, 310, 620, 68, 22), 0, 1.15);
  keyPose(girl, {
    "position.0": continuous([
      [0, 310],
      [0.4, 430],
      [0.7, 530],
      [1.15, 640],
    ]),
    "position.1": continuous([
      [0, 620],
      [0.4, 600],
      [0.7, 510],
      [1.15, 424],
    ]),
    "rotation.2": [
      [0, 22],
      [0.5, -2],
      [1.15, -20],
    ],
  });
  for (const axis of ["scale.0", "scale.1"])
    animate(
      girl,
      axis,
      continuous([
        [0, 68],
        [0.4, 61],
        [0.7, 48],
        [0.9, 33],
        [1.15, 0],
      ]),
    );
  const ball = during(b.add(c, b.props.stripedBall, 640, 533, 90, -10), 0, 0.65);
  for (const axis of ["scale.0", "scale.1"])
    animate(ball, axis, [
      [0, 95],
      [0.3, 85],
      [0.65, 0],
    ]);
  animate(
    ball,
    "position.1",
    continuous([
      [0, 533],
      [0.3, 460],
      [0.65, 424],
    ]),
  );

  const greenBall = structuredClone(b.props.ball);
  greenBall.id = id("comp");
  greenBall.name = "Beach ball · green light";
  for (const part of greenBall.layers) {
    part.id = id("layer");
    if (part.name.startsWith("Ivory")) part.color = rgba(P.green);
  }
  b.supporting.push(greenBall);
  const second = during(b.add(c, greenBall, 450, -80, 97), 0.3, 2.5);
  second.timeRemap = constant(2.4);
  keyPose(second, {
    "position.0": continuous([
      [0.3, 440],
      [0.7, 620],
      [1.1, 660],
      [1.7, 715],
      [2.5, 640],
    ]),
    "position.1": continuous([
      [0.3, -90],
      [0.7, 35],
      [1.1, 180],
      [1.7, 337],
      [2.5, 424],
    ]),
    "rotation.2": [
      [0.3, -8],
      [2.5, -20],
    ],
  });
  for (const axis of ["scale.0", "scale.1"])
    animate(second, axis, [
      [0.3, 97],
      [1.7, 92],
      [2.3, 75],
      [2.5, 0],
    ]);
  second.expressions = { "scale.0": "-value" };
}

function spirallingCrown(b, c) {
  const crown = during(b.add(c, b.props.crown), 1.9, c.duration);
  const radius = continuous([
    [1.9, 820],
    [2.1, 587],
    [2.5, 445],
    [3.1, 330],
    [3.7, 368],
    [4.3, 315],
    [4.7, 312],
    [5.3, 221],
    [5.7, 222],
    [6.1, 153],
    [6.5, 0],
  ]);
  const angle = "(-0.03932*pow(time-2.5,2)-2.13167*(time-2.5)+0.03907)";
  animate(crown, "position.0", radius);
  animate(crown, "position.1", radius);
  crown.expressions = {
    "position.0": `640+value*cos(${angle})`,
    "position.1": `424+0.9*value*sin(${angle})`,
  };
  animate(
    crown,
    "rotation.2",
    continuous([
      [1.9, -30],
      [2.1, -158],
      [2.3, -379],
      [2.5, -488],
      [3.1, -387],
      [3.5, -426],
      [3.9, -572],
      [4.3, -848],
      [4.7, -1177],
      [5.1, -1342],
      [5.5, -1422],
      [5.9, -1454],
      [6.3, -1451],
    ]),
  );
  for (const axis of ["scale.0", "scale.1"])
    animate(
      crown,
      axis,
      continuous([
        [1.9, 144],
        [3.1, 133],
        [4.9, 131],
        [5.7, 120],
        [6.1, 102],
        [6.3, 85],
        [6.5, 8],
      ]),
    );
}

export function circularPassage(b) {
  const c = b.scene("10–11 · Falling into concentric colour", 33.1, 39.633333333, P.turquoise);
  recedingRings(b, c);
  floatingRiders(b, c);
  spirallingCrown(b, c);
  return c;
}
