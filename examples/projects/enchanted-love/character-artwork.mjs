import { comp, constant, ellipse, id, line, palette as P, place, vector } from "./authoring.mjs";

export function createGirlArtwork(assets) {
  const head = comp("Girl · head", 160, 180);
  head.layers = [
    place(
      vector(
        "Hair silhouette",
        [
          [-59, 30, [0, 0], [-1, -46]],
          [-43, -62, [-18, 26], [25, -28]],
          [41, -65, [-24, -25], [24, 10]],
          [62, 20, [0, -26], [-1, 27]],
          [50, 58, [10, -3], [-2, -9]],
          [41, 53, [2, 4], [-14, 15]],
          [-43, 53, [12, 16], [-1, 8]],
          [-61, 61, [4, -1], [7, -24]],
        ],
        P.turquoise,
      ),
      80,
      92,
    ),
    place(
      vector(
        "Face",
        [
          [-48, -15, [0, 0], [0, -9]],
          [-36, -41, [0, 0], [0, 0]],
          [-11, -10, [0, 0], [0, 0]],
          [6, -17, [0, 0], [0, 0]],
          [48, -9, [0, 0], [-3, 44]],
          [0, 49, [29, 0], [-30, 0]],
          [-48, -15, [-3, 38]],
        ],
        P.cream,
      ),
      80,
      83,
    ),
    place(
      vector(
        "Forelock",
        [
          [0, -15],
          [10, -29],
          [18, -26],
          [10, -10],
        ],
        P.blue,
      ),
      80,
      83,
    ),
    place(
      vector(
        "Hair tuft",
        [
          [0, 0],
          [-2, -18],
          [13, -31],
          [13, -12],
        ],
        P.turquoise,
      ),
      88,
      10,
    ),
    ellipse("Left iris", 52, 88, 13, 29, P.blue),
    ellipse("Right iris", 110, 88, 13, 29, P.blue),
    line(
      "Left eyelid",
      [
        [33, 74],
        [71, 78],
      ],
      P.blue,
      5,
    ),
    line(
      "Right eyelid",
      [
        [91, 77],
        [129, 73],
      ],
      P.blue,
      5,
    ),
    line(
      "Left eyebrow",
      [
        [45, 60],
        [60, 60],
      ],
      P.turquoise,
      2,
    ),
  ];
  assets.push(head);
  const closedHead = structuredClone(head);
  closedHead.id = id("comp");
  closedHead.name = "Girl · closed eyes";
  closedHead.layers = closedHead.layers.filter((part) => !part.name.endsWith("iris"));
  for (const part of closedHead.layers) {
    part.id = id("layer");
  }
  assets.push(closedHead);
  const swimmingHead = structuredClone(closedHead);
  swimmingHead.id = id("comp");
  swimmingHead.name = "Girl · relaxed swimming expression";
  for (const part of swimmingHead.layers) {
    part.id = id("layer");
    if (part.name.endsWith("eyelid")) part.transform.position[1] = constant(18);
  }
  assets.push(swimmingHead);
  const profile = comp("Girl · profile head", 140, 180);
  profile.layers = [
    place(
      vector(
        "Hair silhouette",
        [
          [-40, 36, [-4, 5], [-16, -54]],
          [-36, -50, [-14, 19], [34, -42]],
          [47, -34, [-11, -25], [12, 16]],
          [43, 21, [14, -35]],
          [16, 44, [14, -2]],
          [-13, 45, [12, 2]],
          [-27, 35],
          [-43, 54],
        ],
        P.green,
      ),
      70,
      90,
    ),
    place(
      vector(
        "Profile face",
        [
          [18, -9],
          [41, -16],
          [46, 11],
          [58, 24],
          [46, 28],
          [42, 53],
          [13, 49],
        ],
        P.cream,
      ),
      65,
      71,
    ),
    ellipse("Profile eye", 103, 77, 7, 23, P.blue),
    place(
      vector(
        "Hair tuft",
        [
          [0, 0],
          [-5, -14],
          [10, -26],
          [8, -8],
        ],
        P.green,
      ),
      60,
      19,
    ),
  ];
  assets.push(profile);
  const dress = comp("Girl · tunic", 140, 190);
  dress.layers = [
    place(
      vector(
        "Sleeveless tunic",
        [
          [-38, -85, [0, 0], [-5, 34]],
          [-49, 63, [8, -34], [-4, 10]],
          [0, 82, [-35, -3], [32, -2]],
          [50, 65, [0, 14], [-9, -40]],
          [38, -85, [5, 34], [0, 0]],
          [22, -84],
          [17, -72, [0, 0], [-4, 5]],
          [-17, -72, [4, 4], [-4, -3]],
          [-22, -85],
        ],
        P.blue,
      ),
      70,
      95,
    ),
  ];
  assets.push(dress);

  return { head, closedHead, swimmingHead, profile, dress };
}
