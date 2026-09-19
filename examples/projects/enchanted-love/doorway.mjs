import { animate, comp, constant, during, effect, linear, place, track } from "./authoring.mjs";
import { keyPose, P, prop } from "./scenes.mjs";

// One continuous tableau is sampled by both shots, so the exit has no camera reset.
export function createDoorwayExit(book) {
  const { add, doorway, group, supporting, characters: a } = book;
  const stage = comp("Doorway · light and falling frog", 1280, 848, 7);
  doorway(stage, 640, 0, 240, 1400);
  const sparkle = stage.layers.at(-1);
  sparkle.transform.scale[0] = constant(150);
  sparkle.transform.scale[1] = constant(150);
  sparkle.expressions = {
    "position.0": "640+60*sin(time*3.8-2.8)",
    "position.1": "310+170*cos(time*4.1-0.9)",
    "rotation.2": "0",
  };
  const seated = during(prop(a.seatedFrog, 640, 580), 0, 0.833333333);
  const frog = during(prop(a.fallingFrog, 640, 580), 0.833333333, stage.duration);
  for (const pose of [seated, frog])
    keyPose(pose, {
      "position.0": [
        [0, 640],
        [0.8, 640, [0.2, 0, 0.3, 1]],
        [1.1, 790],
      ],
      "position.1": [
        [0, 580],
        [0.8, 580],
        [1.1, 644],
      ],
      "rotation.2": [
        [0, 0],
        [0.8, 0, [0.2, 0, 0.3, 1]],
        [1.1, 90],
      ],
    });
  group(stage, "Frog crossing the rectangular light", [seated, frog], P.teal, {
    shape: "rectangle",
    center: [50, 50],
    size: [18.75, 100],
    feather: 0,
    opacity: 100,
    invert: true,
  });
  supporting.push(stage);

  const camera = comp("Doorway · continuous exit camera", 1280, 848, 7);
  const tableau = add(camera, stage);
  tableau.transform.anchor = [constant(640), constant(700), constant(0)];
  place(tableau, 640, 700);
  // The pan is a post-composite transform: the beam mask is evaluated in
  // the doorway's source space before the camera moves the finished tableau.
  const pan = effect(
    "transform",
    { positionX: 0, positionY: 0, scale: 100, rotation: 0, shutter: 0 },
    "Camera pan after lighting",
  );
  pan.parameterKeyframes = {
    positionX: track([
      [0, 0],
      [0.866666667, 0, [1 / 3, 0, 2 / 3, 0.19743]],
      [4.766666667, -1023.633],
    ]).keyframes,
  };
  tableau.effects.push(pan);
  tableau.expressions = {
    "position.1": "700-40*pow(max(0,time-0.866666667),2)+5*pow(max(0,time-0.866666667),3)",
    "rotation.2": "-0.28*pow(max(0,time-0.866666667),2)",
  };
  animate(tableau, "scale.0", [
    [0, 1],
    [0.067, 61],
    [0.267, 86],
    [0.867, 100],
    [2.667, 101.5],
    [3.267, 106.5],
    [3.667, 114.5],
    [4.267, 124],
  ]);
  animate(tableau, "scale.1", [
    [0, 100],
    [2.667, 101.5],
    [3.267, 106.5],
    [3.667, 114.5],
    [4.267, 124],
  ]);
  supporting.push(camera);
  return (scene, offset = 0) => {
    const view = add(scene, camera);
    view.timeRemap = track(
      [
        [0, offset],
        [scene.duration, offset + scene.duration],
      ],
      linear,
    );
    during(view, 0, Math.min(scene.duration, 5 - offset));
    return view;
  };
}
