import { circularPassage } from "./circular-passage.mjs";
import { crownStaircase } from "./crown-staircase.mjs";
import { createDoorwayExit } from "./doorway.mjs";
import { earlyMotifs } from "./early-motifs.mjs";
import { poolOrbit } from "./pool-orbit.mjs";
import {
  animate,
  during,
  keyPose,
  line,
  linear,
  P,
  place,
  rect,
  title,
  vector,
} from "./scenes.mjs";

export function actOne(book) {
  const { scene, add, tint, morph, props: p } = book;
  const doorwayExit = createDoorwayExit(book);
  {
    const c = scene("01 · A line becomes a crown", 0, 9.433333333, P.black);
    const straight = [
      [-45, 0],
      [-23, 0],
      [0, 0],
      [23, 0],
      [45, 0],
    ];
    const zigzag = [
      [-45, 11],
      [-23, -11],
      [0, 11],
      [23, -11],
      [45, 11],
    ];
    const gesture = place(
      morph(c, "Five-point folding line", straight, zigzag, 2.65, 3.9, null, {
        closed: false,
        stroke: P.green,
        strokeWidth: 8,
      }),
      640,
      424,
    );
    during(gesture, 0.6, 7.8);
    keyPose(gesture, {
      "scale.0": [
        [0.6, 1],
        [2, 58],
        [3.1, 100],
        [4, 85],
        [5.1, 92],
        [6.2, 113],
        [7.1, 25],
        [7.8, 100],
      ],
      "scale.1": [
        [0.6, 1],
        [3.2, 100],
        [4.1, 100],
        [5.15, 12],
        [6.2, 0],
        [7.1, 100],
      ],
      "rotation.2": [
        [0, 0],
        [5.7, 0],
        [6.6, 0],
        [7.1, -25],
        [7.8, 0],
      ],
    });
    const outline = place(
      line(
        "Crown drawn in one gesture",
        [
          [-46, 28],
          [-46, -25],
          [-23, -4],
          [0, -25],
          [26, -4],
          [46, -25],
          [46, 28],
          [-40, 28],
        ],
        P.green,
        8,
      ),
      640,
      426,
    );
    c.layers.push(during(outline, 7.8, 8.6));
    const crown = tint(add(c, p.crown, 640, 420, 72), P.green);
    during(crown, 8.6, c.duration);
    animate(crown, "position.1", [
      [8.6, 420],
      [9.3, 384],
    ]);
  }
  {
    const c = scene("02 · The frog's doorway", 9.433333333, 13.3, P.black);
    doorwayExit(c);
    const crown = add(c, p.crown, 630, 435, 76);
    for (const axis of ["scale.0", "scale.1"])
      animate(crown, axis, [
        [0, 72],
        [0.8, 72],
        [1.1, 84],
      ]);
    keyPose(crown, {
      "position.0": [
        [0, 630],
        [0.8, 630, [0.2, 0, 0.3, 1]],
        [1.1, 935],
        [1.5, 1070],
        [3.866666667, 1055],
      ],
      "position.1": [
        [0, 420],
        [0.8, 435],
        [1.1, 552],
        [1.266666667, 663],
        [1.866666667, 611],
        [2.216666667, 589],
        [2.466666667, 610],
        [2.866666667, 611],
        [3.066666667, 627],
        [3.566666667, 593],
        [3.866666667, 596],
      ],
      "rotation.2": [
        [0, -2],
        [0.8, -2, linear],
        [1.1, 70, linear],
        [1.266666667, 179, [0.33, 0.7, 0.67, 0.85]],
        [1.766666667, 270, [0.33, 0.18, 0.67, 0.45]],
        [2.366666667, 358, [0.33, 0.29, 0.67, 0.625]],
        [3.866666667, 808],
      ],
    });
    const steps = during(add(c, p.stair, 1115, 770, 100), 1.266666667, c.duration);
    keyPose(steps, {
      "position.0": [
        [1.266666667, 1140],
        [2.566666667, 1110],
        [c.duration, 1025],
      ],
      "position.1": [
        [1.266666667, 763],
        [2.566666667, 710],
        [c.duration, 714],
      ],
    });
  }
  crownStaircase(book, doorwayExit);
  {
    const c = scene("04 · Beyond the last step", 19.3, 605 / 30, P.black);
    const cliff = line(
      "Last step and drop",
      [
        [60, 308],
        [60, 336],
        [180, 336],
        [180, 388],
        [300, 388],
        [300, 920],
      ],
      P.cream,
      4,
    );
    c.layers.push(during(cliff, 0, 0.23));
    const crown = add(c, p.crown, 410, 353, 77, 75);
    keyPose(crown, {
      "position.0": [
        [0, 410],
        [0.9, 370],
      ],
      "position.1": [
        [0, 353],
        [0.7, 545],
        [0.9, 590],
      ],
      "rotation.2": [
        [0, 75],
        [0.9, 150],
      ],
    });
  }
  {
    const c = scene("05 · A ribbon crosses the water", 605 / 30, 22.7);
    const ribbon = vector(
      "Ribbon · six curve anchors",
      [
        [-800, 12, [0, 0], [280, 35]],
        [0, -45, [-240, 0], [240, 0]],
        [800, -5, [-280, -10]],
        [800, 18, [0, 0], [-280, -30]],
        [0, 25, [240, 0], [-240, 0]],
        [-800, 62, [280, 0]],
      ],
      P.cream,
    );
    c.layers.push(place(ribbon, 640, 424));
    keyPose(ribbon, {
      "scale.1": [
        [0, 0],
        [0.3, 8],
        [0.8, 100],
        [1.4, 38],
        [1.8, 2],
        [2.5, 1],
      ],
      "rotation.2": [
        [0, -1],
        [1, -1],
        [1.7, 0],
        [2.5, 3],
      ],
    });
    const sine = place(
      line(
        "Ribbon centerline",
        [
          [-700, 72, [0, 0], [210, -10]],
          [0, -32, [-220, 0], [220, 0]],
          [700, 72, [-210, -10]],
        ],
        P.cream,
        3,
      ),
      640,
      424,
    );
    c.layers.push(during(sine, 1.55, 2.5));
  }
  earlyMotifs(book);
  poolOrbit(book);
  circularPassage(book);
  {
    const c = scene("12 · Enchanted Love title card", 39.633333333, 40.3, P.cream);
    c.layers.push(rect("Picture frame", 640, 424, 660, 668, P.turquoise));
    c.layers.push(rect("Frame inset", 640, 424, 600, 612, P.green));
    c.layers.push(
      line(
        "Broken glass gesture",
        [
          [370, 720],
          [470, 268],
          [730, 300],
          [752, 150],
          [908, 360],
          [374, 723],
        ],
        P.turquoise,
        6,
      ),
    );
    tint(add(c, p.heart, 640, 406, 87), P.blue);
    title(c);
  }
}
