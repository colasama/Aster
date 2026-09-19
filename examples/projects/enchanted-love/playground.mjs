import {
  animate,
  background,
  comp,
  constant,
  during,
  instance,
  joint,
  palette as P,
  parent,
  place,
  rect,
  vector,
} from "./authoring.mjs";

// A shared ground frame keeps the rolling props and foreground occlusion in agreement.
function bank(c, angle, distance, color = P.teal) {
  const pivot = joint("Bank camera · center of rotation", 640, 424);
  pivot.expressions = { "rotation.2": angle };
  const ground = parent(rect("Foreground bank", 0, 1300, 6000, 2600, color), pivot);
  ground.expressions = { "position.1": `1300+(${distance})` };
  c.layers.push(pivot, ground);
  return pivot;
}

export function seesawScene(b) {
  const { scene, add, supporting, characters: a, props: p } = b;
  const c = comp("Seesaw · rocking stage and exit", 1280, 848, 1.5);
  background(c, P.green);
  const horizon = bank(c, "value", "0", P.turquoise);
  horizon.transform.position[1] = constant(414);
  animate(horizon, "rotation.2", [
    [0, 8],
    [0.3, 18.4],
    [0.35, 19, [0.48, 0, 0.64, 1]],
    [0.8, -22],
    [1.033333333, -11],
  ]);
  const assembly = comp("Seesaw · plank, riders, and one shared fulcrum", 1280, 848, c.duration);
  const plank = joint("Plank fulcrum", 640, 544);
  plank.expressions = {
    "rotation.2": "18*cos((time-0.2)*5.235987756)+13*pow(clamp((time-1.033333333)*30,0,1),2)",
  };
  assembly.layers.push(
    vector(
      "Triangular support",
      [
        [510, 756],
        [770, 756],
        [640, 536],
      ],
      P.teal,
    ),
    plank,
  );
  const rider = (source, x, y, scale) =>
    parent(place(instance(source), x - 640, y - 544, scale), plank);
  assembly.layers.push(
    rider(a.seesawFrog, 158, 414, 86),
    rider(p.snail, 292, 448, 80),
    rider(p.crab, 464, 451, 80),
    parent(rect("Plank", 0, -18, 1128, 62, P.teal), plank),
    rider(a.girls.seesaw, 1084, 554, 125),
  );
  supporting.push(assembly);
  during(add(c, assembly), 0, 1.1);

  // The camera whips past the fulcrum into the next bank; the actors leave together.
  c.layers.push(
    during(rect("Whip-pan background", 640, 424, 1280, 848, P.turquoise), 1.1, c.duration),
  );
  const transition = bank(c, "value", "value");
  const ground = c.layers.at(-1);
  delete ground.expressions;
  during(ground, 1.1, c.duration);
  animate(transition, "rotation.2", [
    [1.1, -152.6],
    [1.2, -102.2],
    [1.3, -86.6],
    [1.5, -70.1],
  ]);
  animate(ground, "position.1", [
    [1.033333333, 1300],
    [1.1, 1304],
    [1.3, 1375],
    [1.5, 1398.4],
  ]);
  supporting.push(c);
  const shot = scene("33 · Seesaw", 74.466666667, 76, P.green);
  b.slope(shot, P.turquoise, [0, 406, 1280, 500]);
  const entrance = b.tint(add(shot, assembly), P.blue);
  entrance.timeRemap = constant(0.5);
  during(entrance, 0, 1 / 30);
  during(add(shot, c), 1 / 30, shot.duration);
  return shot;
}

export function slideScene(b) {
  const { scene, add, characters: a, props: p } = b;
  const c = scene("34 · Sliding down the slope", 76, 79.6);
  const angle = "9.094-78.987/(1+0.623277*time)";
  const distance = "100+66*(1-pow(e,-0.9*time))";
  const camera = bank(c, angle, distance);
  const foreground = c.layers.pop();
  const onBank = (source, name, x, height, scale = 100, rotation = 0) => {
    const item = parent(add(c, source, 0, 0, scale, rotation, name), camera);
    item.expressions = { "position.0": x, "position.1": `(${distance})-(${height})` };
    return item;
  };
  const rollingDistance = "933-441*time+400*pow(max(0,1.5-time),3)";
  const ring = onBank(p.ring, "Rolling swim ring", rollingDistance, "149", 124);
  ring.expressions["rotation.2"] = `52+(${rollingDistance})/149*57.2957795`;
  const step = onBank(p.crown, "Blue right-angle block", "-83+277*time-228*time*time", "44", 90);
  // A six-corner block rolls ahead of the character on the same ground plane.
  const block = vector(
    "Right-angle block",
    [
      [-68, 52],
      [68, 52],
      [68, -52],
      [18, -52],
      [18, 0],
      [-68, 0],
    ],
    P.blue,
  );
  block.parentId = step.parentId;
  block.expressions = step.expressions;
  c.layers.splice(c.layers.indexOf(step), 1, block);
  block.expressions["rotation.2"] = "126-time*56";

  const girl = onBank(a.girls.slide, "Girl · emerge, slide, recover", "4*time", "45", 82);
  animate(girl, "position.1", [
    [0, 700],
    [1.2, 275],
    [1.5, 209],
    [2, 200],
    [2.4, 210],
    [3.3, 66],
    [3.6, 55],
  ]);
  delete girl.expressions["position.1"];
  const frog = onBank(a.seatedFrog, "Frog tumbling beside the ring", "2010-915*time", "100", 110);
  frog.expressions["rotation.2"] = `840-380*time-(${angle})`;
  const ball = onBank(p.stripedBall, "Ball rolling down the bank", "1460-520*time", "79", 105);
  ball.expressions["rotation.2"] = "-(1460-520*time)/79*57.2957795";
  const crown = onBank(p.crown, "Crown follows the ball", "1790-535*time", "80", 115);
  crown.expressions["rotation.2"] = "15+180*time";
  c.layers.push(foreground);
  return c;
}
