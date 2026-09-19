import {
  animate,
  comp,
  constant,
  during,
  joint,
  line,
  linear,
  palette as P,
  parent,
  place,
} from "./authoring.mjs";
import { keyPose } from "./scenes.mjs";

export function crownStaircase(book, doorwayExit) {
  const { scene, add, supporting, props: p } = book;
  const c = scene("03 · Crown descending the staircase", 13.3, 19.3, P.black);
  doorwayExit(c, 3.866666667);
  const step = comp("Stair · tread and riser", 110, 44, c.duration);
  step.layers.push(
    line(
      "One tread and one riser",
      [
        [0, 0],
        [110, 0],
        [110, 44],
      ],
      P.cream,
      4,
    ),
  );
  const flight = comp("Crown stairs · modular flight", 475, 220, c.duration);
  flight.layers.push(
    line(
      "Leading riser",
      [
        [0, -25],
        [0, 0],
      ],
      P.cream,
      4,
    ),
  );
  for (let i = 0; i < 4; i++)
    during(add(flight, step, 55 + i * 110, 22 + i * 44), i < 3 ? 0 : 2.7, c.duration);
  flight.layers.push(
    during(
      place(
        line(
          "Last short tread",
          [
            [0, 0],
            [35, 0],
          ],
          P.cream,
          4,
        ),
        440,
        176,
      ),
      2.7,
      c.duration,
    ),
  );
  supporting.push(step, flight);
  const stairs = add(c, flight);

  // All windows share one accelerating camera translation and a regular world spacing.
  const camera = joint("Window camera", 0, 0);
  camera.expressions = {
    "position.0": "1579-323*time-59.5*time*time",
    "position.1": "434-178*time-1.6*time*time-144*pow(max(0,time-4.2),2)",
  };
  c.layers.push(camera);
  for (let i = 0; i < 4; i++) {
    const window = parent(add(c, p.window, i * 1063, i * 376, 107, -0.7), camera);
    window.transform.scale[1] = constant(93.5);
  }
  const crown = add(c, p.crown, 1055, 622, 80);
  // Sparse landmark fit: accelerating roll, followed by the camera's return pan.
  const xPath = [
    [0, 1045, [0.33, 0.24, 0.67, 0.59]],
    [1.7, 793, linear],
    [3.2, 512, linear],
    [4.95, 196],
    [5.7, 448, linear],
    [6, 660],
  ];
  const yPath = [
    [0, 596],
    [0.2, 602],
    [0.95, 556],
    [1.7, 546],
    [2.95, 480],
    [4.95, 534],
    [5.7, 406],
    [6, 349],
  ];
  keyPose(crown, {
    "position.0": xPath,
    "position.1": yPath,
    "rotation.2": [
      [0, 88, [0.333, 0.221, 0.666, 0.56]],
      [3.7, 1731, linear],
      [4.2, 2076, linear],
      [4.7, 2487, linear],
      [4.95, 2746, linear],
      [5.2, 3026, linear],
      [5.45, 3372, linear],
      [5.7, 3476, linear],
      [6, 3540],
    ],
    "scale.0": [
      [0, 83],
      [2.7, 77],
      [4.95, 83],
      [6, 77],
    ],
    "scale.1": [
      [0, 83],
      [2.7, 77],
      [4.95, 83],
      [6, 77],
    ],
  });
  animate(
    stairs,
    "position.0",
    xPath.map(([t, x, curve]) => [t, x + 34.5, curve]),
  );
  animate(
    stairs,
    "position.1",
    yPath.map(([t, y]) => [t, y + 122]),
  );
}
