export function sceneFixtures(base) {
  const output = [];
  const scalar = (value) => ({ mode: "static", value });
  const times = [-1, 0, 1 / 30 - 1e-7, 1 / 30, 1 / 30 + 1e-7, 0.5, 1, 2, 3.999999999, 4, 5];
  function create(id, edit) {
    const project = structuredClone(base);
    project.id = id;
    const composition = project.compositions[0];
    project.activeCompositionId = composition.id;
    const original = composition.layers[0];
    const layer = (id, kind = "shape") => ({
      ...structuredClone(original),
      id,
      kind,
      visible: true,
      solo: false,
      inPoint: 0,
      outPoint: 4,
    });
    edit(project, composition, layer);
    output.push({ id, project, times });
  }
  create("clock-and-solo", (_project, composition, layer) => {
    const first = layer("first");
    const second = layer("second");
    first.outPoint = second.inPoint = 1 / 30;
    second.solo = true;
    second.timeOffset = -0.25;
    second.timeStretch = 2;
    const remapped = layer("remapped");
    remapped.timeRemap = {
      mode: "animated",
      keyframes: [
        { id: "a", time: 0, value: -1, interpolation: "linear" },
        { id: "b", time: 3, value: 8, interpolation: "linear" },
      ],
    };
    composition.layers = [first, second, remapped];
  });
  create("hidden-mirrored-parent", (_project, composition, layer) => {
    const parent = layer("parent", "null");
    parent.visible = false;
    parent.transform.scale[0] = scalar(-125);
    parent.expressions = { "rotation.2": "sin(time)*45" };
    const joint = layer("joint", "null");
    joint.parentId = parent.id;
    joint.transform.rotation[2] = scalar(30);
    const child = layer("child");
    child.parentId = joint.id;
    child.transform.position = [scalar(0), scalar(100), scalar(25)];
    composition.layers = [child, joint, parent];
  });
  create("parent-cycle", (_project, composition, layer) => {
    const a = layer("a"),
      b = layer("b"),
      c = layer("c");
    a.parentId = b.id;
    b.parentId = a.id;
    c.parentId = a.id;
    composition.layers = [c, b, a];
  });
  create("active-camera-selection", (_project, composition, layer) => {
    const solo = layer("solo");
    solo.solo = true;
    const hidden = layer("hidden-camera", "camera");
    hidden.visible = false;
    const first = layer("first-camera", "camera");
    first.inPoint = 1 / 30;
    first.outPoint = 1;
    first.transform.position[2] = scalar(-700);
    const second = layer("second-camera", "camera");
    second.transform.position[2] = scalar(-2000);
    composition.layers = [solo, hidden, first, second];
  });
  create("nested-scene-resources", (project, composition, layer) => {
    const mesh = layer("mesh", "mesh");
    const light = layer("light", "light");
    light.transform.rotation[0] = scalar(45);
    project.compositions.push({
      ...structuredClone(composition),
      id: "resources",
      layers: [light, mesh],
    });
    const wrapper = layer("wrapper", "precomposition");
    wrapper.sourceCompositionId = "resources";
    wrapper.threeDimensional = false;
    wrapper.effects = [];
    wrapper.transform.rotation[2] = scalar(31);
    const second = { ...structuredClone(wrapper), id: "second" };
    second.transform.scale[0] = scalar(-120);
    composition.layers = [wrapper, second, layer("root-mesh", "mesh")];
  });
  for (const mode of ["flat", "effect", "camera", "cycle", "adjustment", "missing"]) {
    create(`nested-${mode}`, (project, composition, layer) => {
      const child = layer(
        "nested-child",
        mode === "camera" ? "camera" : mode === "adjustment" ? "adjustment" : "shape",
      );
      child.expressions = { "position.0": "value+time*100" };
      const nested = { ...structuredClone(composition), id: "nested", layers: [child] };
      project.compositions.push(nested);
      composition.layers = [0, 0, 0.0000001].map((offset, index) => {
        const wrapper = layer(`wrapper-${index}`, "precomposition");
        wrapper.sourceCompositionId =
          mode === "missing" ? "absent" : mode === "cycle" ? composition.id : nested.id;
        wrapper.timeOffset = offset;
        wrapper.timeStretch = 2;
        wrapper.size = [200, 120];
        wrapper.transform.anchor = [scalar(17), scalar(29), scalar(11)];
        wrapper.transform.scale = [scalar(-125), scalar(75), scalar(50)];
        wrapper.transform.rotation[2] = scalar(17);
        if (mode === "effect")
          wrapper.effects = [
            { id: "effect", type: "color-overlay", name: "Tint", enabled: true, parameters: {} },
          ];
        return wrapper;
      });
    });
  }
  for (const surface of [false, true]) {
    create(`nested-cloner-${surface}`, (project, composition, layer) => {
      const child = layer("cloned-child", "shape");
      child.cloner = {
        distribution: {
          kind: "radial",
          count: 5,
          radius: 30,
          startAngle: 0,
          endAngle: 180,
          axis: "y",
          alignRotation: true,
        },
        effectors: [],
      };
      const nested = { ...structuredClone(composition), id: "cloned-nested", layers: [child] };
      project.compositions.push(nested);
      const wrapper = layer("cloned-wrapper", "precomposition");
      wrapper.sourceCompositionId = nested.id;
      wrapper.cloner = {
        distribution: { kind: "grid", count: [2, 2, 1], spacing: [-70, 60, 0] },
        effectors: [],
      };
      wrapper.transform.scale = [scalar(-125), scalar(75), scalar(50)];
      wrapper.transform.rotation = [scalar(19), scalar(37), scalar(61)];
      if (surface)
        wrapper.effects = [
          { id: "effect", type: "color-overlay", name: "Tint", enabled: true, parameters: {} },
        ];
      composition.layers = [wrapper];
    });
  }
  return output;
}
