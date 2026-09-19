import {
  animate,
  comp,
  constant,
  instance,
  joint,
  linear,
  palette as P,
  parent,
  place,
  rect,
  track,
  vector,
} from "./authoring.mjs";

export function umbrellaParade(b) {
  const { scene, add, tint, supporting, props: p, characters: a } = b;
  const c = scene("29 · Umbrella parade", 68.7, 70.633333333);
  const paper = comp("Parade · diagonal striped paper", 4000, 2600, c.duration);
  const stripe = rect("Repeated stripe", 2000, 1300, 8, 2600, P.turquoise);
  stripe.cloner = {
    distribution: { kind: "grid", count: [151, 1, 1], spacing: [26.4, 0, 0] },
    effectors: [],
  };
  paper.layers.push(rect("Green paper", 2000, 1300, 4000, 2600, P.green), stripe);
  supporting.push(paper);

  const camera = joint("Parade camera · pan and settle", 0, 0);
  camera.expressions = {
    "position.0": "-1750*time+1583.333333*pow(clamp(time-1,0,0.3),2)+950*max(0,time-1.3)",
    "position.1": "-126",
  };
  c.layers.push(camera, parent(place(instance(paper), 2587, 424, 100, 21), camera));
  for (const [i, pitch] of [
    [0, -0.6],
    [1, -0.3],
    [2, 0.1],
    [3, 0.35],
    [5, 0.9],
    [6, 1.4],
    [7, 1.8],
  ]) {
    const umbrella = parent(add(c, p.paradeUmbrella, 355 + i * 315, 591 - i * 45, 88), camera);
    const poses = [[0, Math.max(0, pitch)]];
    if (pitch < 0) poses.push([-pitch, 0]);
    if (pitch + c.duration > 2) poses.push([2 - pitch, 2]);
    poses.push([c.duration, Math.min(2, pitch + c.duration)]);
    umbrella.timeRemap = track(poses, linear);
  }
  parent(add(c, a.girls.parade, 1650, 625, 88), camera);
  const held = parent(add(c, p.heldUmbrella, 1620, 407, 84), camera);
  held.timeRemap = constant(1);

  // The last canopy opens into a broad colour card for the horizon sequence.
  const bottom = [
    [5000, 720],
    [3900, 760, [400, -25], [-400, 15]],
    [2800, 878, [400, 0], [-180, 0]],
    [2250, 830, [180, 30]],
  ];
  const ground = parent(
    vector(
      "Turquoise below the passing canopy",
      [...bottom, [1850, 2600], [5000, 2600]],
      P.turquoise,
    ),
    camera,
  );
  const card = parent(
    vector(
      "Blue canopy becomes the next horizon",
      [[3040, -1000], [5000, -1000], ...bottom, [2395, 800], [2312, 670], [2405, 586], [2485, 589]],
      P.blue,
    ),
    camera,
  );
  for (const item of [ground, card]) {
    animate(item, "position.1", [
      [0, 0],
      [1.6, 0],
      [1.933333333, 60],
    ]);
    item.expressions = { "position.1": "value+126-210*time" };
  }
  c.layers.push(ground, card);
  const crown = parent(tint(add(c, p.crown, 3100, 740, 125), P.turquoise), camera);
  crown.expressions = {
    "position.0": "2978.5+280*max(0,time-1.3)",
    "position.1": "823-290*max(0,time-1.3)+126-210*time",
  };
  const heart = parent(tint(add(c, p.heart, 3640, 1028, 165), P.blue), camera);
  heart.inPoint = 1.7;
  heart.expressions = { "position.1": "1028+126-210*time" };
  return c;
}
