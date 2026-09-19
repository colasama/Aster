import { comp, during, effect, id, palette as P, rect, track } from "./authoring.mjs";
import { keyPose } from "./scenes.mjs";

function reveal(node, keys, fromRight = true, bend = 145) {
  const wipe = effect("linear-wipe", {
    completion: 0,
    angle: fromRight ? 180 : 0,
    feather: 1,
    bend,
    bendWidth: 1800,
    bendPhase: fromRight ? -90 : 90,
    bendSpeed: 0,
  });
  wipe.parameterKeyframes = {
    completion: track(
      keys.map(([t, edge, curve]) => [t, fromRight ? 100 - edge / 12.8 : edge / 12.8, curve]),
    ).keyframes,
  };
  node.effects.push(wipe);
}

export function stripedPassage(b) {
  const c = b.scene("20–21 · Striped passage and reversing pan", 53, 55.6, P.green);
  const pattern = (name, spacing, width, fill, angle, phase) => {
    const p = comp(name, 1280, 848, c.duration);
    p.layers.push(rect("Pattern ground", 640, 424, 1280, 848, P.teal));
    const root = b.stripes(p, { angle, spacing, width, fill });
    const theta = (angle * Math.PI) / 180;
    const originalPhase =
      ((1500 - 640 * Math.cos(theta) - 424 * Math.sin(theta)) * 2 * Math.PI) / spacing;
    const delta =
      ((((originalPhase - phase + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
      Math.PI;
    root.transform.position[0] = {
      mode: "static",
      value: 640 + (delta * spacing) / (2 * Math.PI * Math.cos(theta)),
    };
    b.supporting.push(p);
    return p;
  };
  const coarse = pattern(
    "Water · broad diagonal bands",
    83.1353,
    41.56765,
    P.turquoise,
    -62.2865,
    -2.1107,
  );
  const fine = pattern(
    "Water · fine diagonal bands",
    23.7472,
    11.8736,
    P.blue,
    -61.7882,
    2.0205 + Math.PI,
  );
  const broadEntry = b.add(c, coarse);
  reveal(broadEntry, [
    [0, 1450],
    [0.033333333, 860],
    [0.133333333, 130],
    [0.233333333, -250],
  ]);
  during(broadEntry, 1 / 30, c.duration);
  const fineEntry = b.add(c, fine);
  reveal(fineEntry, [
    [0.166666667, 1450],
    [0.3, 750],
    [0.6, 160],
    [0.866666667, -250],
  ]);
  during(fineEntry, 5 / 30, c.duration);
  const clear = comp("Water · clear teal field", 1280, 848, c.duration);
  clear.layers.push(rect("Clear water", 640, 424, 1280, 848, P.teal));
  b.supporting.push(clear);
  const clearEntry = b.add(c, clear);
  reveal(clearEntry, [
    [0.633333333, 1450],
    [0.8, 1080],
    [1, 680],
    [1.4, 540],
    [1.8, 690],
    [2.033333333, 1100],
    [2.233333333, 1450],
  ]);
  during(clearEntry, 19 / 30, 67 / 30);
  const broadReturn = b.add(c, coarse);
  reveal(
    broadReturn,
    [
      [1.666666667, -250],
      [1.866666667, 0],
      [2.1, 280],
      [2.333333333, 980],
      [2.433333333, 1450],
    ],
    false,
  );
  during(broadReturn, 50 / 30, c.duration);

  for (const [source, x, y, scale, angle] of [
    [b.props.ring, 565, 362, 100, 0],
    [b.props.ball, 1130, 740, 95, 24],
  ]) {
    for (const [node, dx, dy] of [
      [b.shadow(c, source, x, y, scale, angle), 24, 30],
      [b.add(c, source, x, y, scale, angle), 0, 0],
    ]) {
      node.expressions = {
        "position.0":
          source === b.props.ring ? `${x + dx}-1800*(1-pow(e,-2.1*time))` : `${x + dx}-1900*time`,
        "position.1": `${y + dy}-40*sin(time*10)`,
        "rotation.2": `${angle}-time*48`,
      };
      during(node, 0, 0.666666667);
    }
  }
  const crown = b.add(c, b.props.crown, 1360, 550, 120, -3);
  during(crown, 0.466666667, 1.15);
  keyPose(crown, {
    "position.0": [
      [0.466666667, 1400],
      [0.6, 968],
      [0.8, 470],
      [1.033333333, -10],
      [1.15, -240],
    ],
    "position.1": [
      [0.466666667, 530],
      [0.6, 610],
      [0.8, 430],
      [1.033333333, 360],
    ],
    "rotation.2": [
      [0.466666667, -3],
      [0.6, -20],
      [0.8, 50],
      [1.033333333, 100],
    ],
  });
  for (const [node, dx, dy] of [
    [b.shadow(c, b.props.heart, 0, 0, 93, 0, P.blue), 30, 29],
    [b.tint(b.add(c, b.props.heart, 0, 0, 93), P.green), 0, 0],
  ]) {
    during(node, 0.7, 2.333333333);
    keyPose(node, {
      "position.0": [
        [0.7, 1390 + dx],
        [1, 870 + dx],
        [1.4, 570 + dx],
        [1.8, 670 + dx],
        [2, 900 + dx],
        [2.333333333, 1470 + dx],
      ],
      "position.1": [
        [0.7, 615 + dy],
        [1, 536 + dy],
        [1.2, 475 + dy],
        [1.4, 449 + dy],
        [1.8, 473 + dy],
        [2, 505 + dy],
        [2.333333333, 650 + dy],
      ],
      "rotation.2": [
        [0.7, -55],
        [1, -68],
        [1.4, -5],
        [1.6, -18],
        [1.8, -51],
        [2, -70],
        [2.333333333, -102],
      ],
    });
  }
  return c;
}

export function poolArrival(b, passage, pool) {
  // Extend the existing drift backwards for the brief reveal, keeping one set of pool assets.
  const arrival = structuredClone(pool);
  arrival.id = id("comp");
  arrival.name = "Pool · lead-in to the shared drift";
  arrival.duration = 4 / 15;
  arrival.workArea.end = arrival.duration;
  for (const node of arrival.layers) {
    node.id = id("layer");
    for (const [property, expression] of Object.entries(node.expressions ?? {}))
      node.expressions[property] = expression.replaceAll(/\btime\b/g, "(time-0.266666667)");
    for (const value of Object.values(node.transform).flat())
      for (const key of value.keyframes ?? []) key.time += 4 / 15;
  }
  b.supporting.push(arrival);
  const node = b.add(passage, arrival);
  during(node, 7 / 3, passage.duration);
  reveal(
    node,
    [
      [7 / 3, -220],
      [2.4, 40],
      [2.5, 810],
      [2.6, 1450],
    ],
    false,
  );
  return node;
}
