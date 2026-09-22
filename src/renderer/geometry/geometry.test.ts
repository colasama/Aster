import { describe, expect, it } from "vitest";
import { createLayerForComposition } from "../../core/layers/layer-factory";
import { createBlankProject } from "../../core/project/project";
import { flattenSceneLayers } from "../../core/scene/scene-evaluation";
import { setLayerSizeAndCenterAnchor, staticValue } from "../../core/types";
import { localToComposition } from "../../viewport/transform-interaction";
import { evaluateSceneCamera } from "../scene/scene-camera";
import { expandTextSceneGeometry } from "../text/text-scene-geometry";
import { buildSceneGeometry, FLOATS_PER_VERTEX, VERTEX_FLOAT_OFFSETS } from "./geometry";
import { createDefaultBezierPath } from "./vector-path";

describe("GPU scene geometry", () => {
  it("expands text geometry around its original anchor and preserves texture UVs", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const layer = createLayerForComposition("text", composition);
    layer.size = [100, 50];
    layer.transform.anchor = [staticValue(30), staticValue(20), staticValue(0)];
    layer.transform.scale = [staticValue(-150), staticValue(200), staticValue(100)];
    layer.transform.rotation[2] = staticValue(30);
    composition.layers = [layer];
    const scene = flattenSceneLayers(composition, project, 0);
    const bounds = { x: -40, y: -30, width: 250, height: 140 };
    const cached = buildSceneGeometry(composition, scene);
    const cachedData = cached.data.slice();
    const geometry = expandTextSceneGeometry(composition, scene, cached, undefined, () => bounds);
    expect(cached.data).toEqual(cachedData);
    const corners = [
      [-40, -30],
      [210, -30],
      [-40, 110],
    ] as const;
    for (let index = 0; index < corners.length; index += 1) {
      const transform = scene[0].transform;
      const point = localToComposition(corners[index], {
        position: [transform.position[0], transform.position[1]],
        scale: [transform.scale[0], transform.scale[1]],
        rotation: transform.rotation[2],
        anchor: [transform.anchor[0], transform.anchor[1]],
        size: layer.size,
      });
      const offset = index * FLOATS_PER_VERTEX;
      expect(geometry.data[offset]).toBeCloseTo((point[0] / composition.width) * 2 - 1);
      expect(geometry.data[offset + 1]).toBeCloseTo(1 - (point[1] / composition.height) * 2);
    }
    expect(Array.from(geometry.data.slice(3, 5))).toEqual([0, 0]);
    expect(Array.from(geometry.data.slice(FLOATS_PER_VERTEX + 3, FLOATS_PER_VERTEX + 5))).toEqual([
      1, 0,
    ]);
    expect(layer.size).toEqual([100, 50]);
  });
  it.each([125, -125])(
    "keeps a resized 2D group's animated anchor when toggling effects at scale %s",
    (scaleX) => {
      const project = createBlankProject();
      const composition = project.compositions[0];
      const nested = {
        ...structuredClone(composition),
        id: "anchored-source",
        width: 400,
        height: 200,
      };
      const shape = createLayerForComposition("shape", nested);
      setLayerSizeAndCenterAnchor(shape, [400, 200]);
      nested.layers = [shape];
      project.compositions.push(nested);
      const wrapper = createLayerForComposition("precomposition", composition);
      wrapper.sourceCompositionId = nested.id;
      setLayerSizeAndCenterAnchor(wrapper, [640, 320]);
      wrapper.transform.position = [staticValue(400), staticValue(300), staticValue(0)];
      wrapper.transform.rotation[2] = staticValue(32);
      wrapper.transform.scale = [staticValue(scaleX), staticValue(125), staticValue(100)];
      wrapper.transform.anchor[0] = {
        mode: "animated",
        keyframes: [
          { id: "start", time: 0, value: 320, interpolation: "linear" },
          { id: "end", time: 2, value: 0, interpolation: "linear" },
        ],
      };
      wrapper.transform.anchor[1] = staticValue(80);
      composition.layers = [wrapper];
      const flat = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 1));
      wrapper.effects = [
        {
          id: "identity",
          type: "color-overlay",
          name: "Tint",
          enabled: true,
          parameters: { opacity: 0 },
        },
      ];
      const isolated = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 1));
      expect(flat.data.length).toBe(isolated.data.length);
      for (let vertex = 0; vertex < 6; vertex++)
        for (let axis = 0; axis < 3; axis++) {
          const offset = vertex * FLOATS_PER_VERTEX + VERTEX_FLOAT_OFFSETS.position + axis;
          expect(flat.data[offset]).toBeCloseTo(isolated.data[offset]);
        }
      const corner = localToComposition([0, 0], {
        position: [400, 300],
        scale: [scaleX, 125],
        rotation: 32,
        anchor: [160, 80],
        size: [640, 320],
      });
      expect(flat.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(
        (2 * corner[0]) / composition.width - 1,
      );
      expect(flat.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(
        1 - (2 * corner[1]) / composition.height,
      );
    },
  );

  it.each([0, 1] as const)("reflects stroke and fill together along axis %s", (axis) => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const shape = createLayerForComposition("shape", composition);
    if (!shape.shape) throw new Error("Expected shape settings");
    setLayerSizeAndCenterAnchor(shape, [100, 100]);
    shape.transform.position = [staticValue(200), staticValue(200), staticValue(0)];
    shape.shape.kind = "bezier";
    shape.shape.path = {
      closed: true,
      vertices: [
        [0.1, 0.1],
        [0.4, 0.1],
        [0.4, 0.4],
        [0.1, 0.4],
      ].map(([x, y]) => ({
        position: [x, y],
        inTangent: [0, 0],
        outTangent: [0, 0],
      })),
    };
    shape.shape.strokeWidth = 4;
    composition.layers = [shape];
    const bounds = () => {
      const { data } = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
      const values = Array.from(
        { length: data.length / FLOATS_PER_VERTEX },
        (_, index) => data[index * FLOATS_PER_VERTEX + VERTEX_FLOAT_OFFSETS.worldPosition + axis],
      );
      return [Math.min(...values), Math.max(...values)];
    };
    const original = bounds();
    shape.transform.scale[axis] = staticValue(-100);
    const reflected = bounds();
    expect(reflected[0]).toBeCloseTo(400 - original[1]);
    expect(reflected[1]).toBeCloseTo(400 - original[0]);
  });

  it("keeps the edited dimensions of a 2D group when effects isolate its source", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const nested = structuredClone(composition);
    nested.id = "effect-source";
    const wrapper = createLayerForComposition("precomposition", composition);
    wrapper.sourceCompositionId = nested.id;
    setLayerSizeAndCenterAnchor(wrapper, [400, 200]);
    wrapper.effects.push({
      id: "tint",
      type: "color-overlay",
      name: "Tint",
      enabled: true,
      parameters: {},
    });
    composition.layers = [wrapper];
    project.compositions.push(nested);
    const { data } = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(data[0]).toBeCloseTo(-400 / composition.width);
    expect(data[1]).toBeCloseTo(200 / composition.height);
  });

  it("preserves circular corner radii on tall, wide, and mirrored rectangles", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const rectangle = createLayerForComposition("shape", composition);
    if (!rectangle.shape) throw new Error("Expected shape settings");
    rectangle.shape.kind = "rectangle";
    rectangle.shape.roundness = 10;
    composition.layers = [rectangle];
    for (const [width, height, expected] of [
      [40, 200, [1, 5]],
      [200, 40, [5, 1]],
    ] as const) {
      rectangle.size = [width, height];
      rectangle.transform.scale[0] = staticValue(-100);
      const { data } = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
      expect(
        Array.from(
          data.slice(
            VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 2,
            VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 4,
          ),
        ),
      ).toEqual(expected);
      expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 1]).toBeCloseTo(0.25);
    }
  });

  it("keeps transparent fill, stroke alpha, and animated layer opacity independent", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const ring = createLayerForComposition("shape", composition);
    ring.color = [0, 0, 0, 0];
    if (!ring.shape) throw new Error("Expected shape settings");
    ring.shape.kind = "ellipse";
    ring.shape.strokeWidth = 4;
    ring.shape.strokeColor = [1, 0, 0, 0.8];
    ring.transform.opacity = staticValue(35);
    composition.layers = [ring];
    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.color + 3]).toBe(0);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.shapeStyleColor + 3]).toBeCloseTo(0.8);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.material + 3]).toBeCloseTo(0.35);
  });

  it("emits an untextured solid quad and never emits null pixels or effect geometry", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const solid = createLayerForComposition("solid", composition);
    const nullLayer = createLayerForComposition("null", composition);
    if (!solid.solid) throw new Error("Expected solid settings");
    solid.solid = { width: 640, height: 320, color: [0.2, 0.4, 0.6, 0.8] };
    solid.size = [1, 1];
    solid.transform.anchor = [staticValue(320), staticValue(160), staticValue(0)];
    solid.color = [1, 0, 0, 1];
    nullLayer.effects.push({
      id: "null-glow",
      type: "glow",
      name: "Glow",
      enabled: true,
      parameters: {},
    });
    nullLayer.threeDimensional = true;
    composition.layers = [nullLayer, solid];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches).toHaveLength(1);
    expect(geometry.batches[0]).toMatchObject({ layer: solid, vertexCount: 6 });
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.mediaType]).toBe(0);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(1);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.color]).toBeCloseTo(0.2);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.color + 3]).toBeCloseTo(0.8);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(-640 / composition.width);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(320 / composition.height);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(0);

    solid.threeDimensional = true;
    const geometry3d = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry3d.data[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(1);
    expect(geometry3d.data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(0);
  });

  it.each(["shape", "text"] as const)(
    "keeps %s GPU corners aligned with the anchor-aware viewport box",
    (kind) => {
      const project = createBlankProject();
      const composition = project.compositions[0];
      const layer = createLayerForComposition(kind, composition);
      setLayerSizeAndCenterAnchor(layer, [200, 100]);
      layer.transform.position = [staticValue(400), staticValue(300), staticValue(0)];
      layer.transform.scale = [staticValue(150), staticValue(50), staticValue(100)];
      layer.transform.anchor = [staticValue(50), staticValue(25), staticValue(0)];
      composition.layers = [layer];

      const scene = flattenSceneLayers(composition, project, 0)[0];
      const geometry = buildSceneGeometry(composition, [scene]);
      const corner = localToComposition([0, 0], {
        position: [scene.transform.position[0], scene.transform.position[1]],
        scale: [scene.transform.scale[0], scene.transform.scale[1]],
        rotation: scene.transform.rotation[2],
        anchor: [scene.transform.anchor[0], scene.transform.anchor[1]],
        size: layer.size,
      });
      expect(geometry.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(
        (corner[0] / composition.width) * 2 - 1,
      );
      expect(geometry.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(
        1 - (corner[1] / composition.height) * 2,
      );
    },
  );

  it("projects 3D rotation and depth into screen-space vertices", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    if (!mesh.material) throw new Error("Expected mesh material");
    mesh.material.alphaMode = "mask";
    mesh.material.alphaCutoff = 0.42;
    composition.layers = [mesh];
    const flatGeometry = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
    );
    const flat = flatGeometry.data;
    expect(flatGeometry.batches[0].vertexCount).toBe(36);
    expect(
      new Set(Array.from({ length: 36 }, (_, index) => flat[index * FLOATS_PER_VERTEX + 2])).size,
    ).toBeGreaterThan(1);
    mesh.transform.rotation[0] = { mode: "static", value: 58 };
    mesh.transform.position[2] = { mode: "static", value: 480 };
    const projected = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
    ).data;
    expect(projected[0]).not.toBeCloseTo(flat[0]);
    expect(projected[1]).not.toBeCloseTo(flat[1]);
    expect(projected[VERTEX_FLOAT_OFFSETS.material + 3]).toBe(1);
    expect(projected[VERTEX_FLOAT_OFFSETS.worldPosition + 2]).not.toBe(0);
    expect(projected[VERTEX_FLOAT_OFFSETS.gradientStyleParameters]).toBe(1);
    expect(projected[VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 1]).toBeCloseTo(0.42);
  });

  it("projects 3D geometry relative to the active camera transform", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const camera = createLayerForComposition("camera", composition);
    composition.layers = [mesh, camera];
    const scene = flattenSceneLayers(composition, project, 0);
    const centered = buildSceneGeometry(
      composition,
      scene,
      evaluateSceneCamera(composition, 0),
    ).data;
    camera.transform.position[0] = { mode: "static", value: composition.width * 0.35 };
    camera.transform.rotation[1] = { mode: "static", value: 14 };
    const moved = buildSceneGeometry(composition, scene, evaluateSceneCamera(composition, 0)).data;
    expect(moved[0]).not.toBeCloseTo(centered[0]);
    expect(Math.abs(moved[2] - centered[2])).toBeGreaterThan(1e-7);
  });

  it("supports orthographic camera projection without perspective depth scaling", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    const camera = createLayerForComposition("camera", composition);
    if (!camera.camera) throw new Error("Expected camera settings");
    camera.camera.projection = "orthographic";
    composition.layers = [mesh, camera];
    const scene = flattenSceneLayers(composition, project, 0);
    const baseCamera = evaluateSceneCamera(composition, 0);
    const centered = buildSceneGeometry(composition, scene, baseCamera).data;
    mesh.transform.position[2] = { mode: "static", value: 600 };
    const depthMoved = buildSceneGeometry(
      composition,
      flattenSceneLayers(composition, project, 0),
      baseCamera,
    ).data;
    expect(depthMoved[0]).toBeCloseTo(centered[0]);
    expect(depthMoved[1]).toBeCloseTo(centered[1]);
    expect(Math.abs(depthMoved[2] - centered[2])).toBeGreaterThan(1e-6);
  });

  it("packs explicit vector kind, roundness, and stroke style attributes", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const ellipse = createLayerForComposition("shape", composition);
    ellipse.size = [480, 480];
    ellipse.shape = {
      kind: "ellipse",
      roundness: 24,
      strokeWidth: 12,
      strokeColor: [1, 0.5, 0.25, 0.8],
      fillMode: "radial",
      gradientColor: [0.1, 0.2, 0.8, 1],
      gradientAngle: 45,
      dashLength: 16,
      dashGap: 8,
      lineCap: "butt",
      lineJoin: "bevel",
    };
    composition.layers = [ellipse];
    const data = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0)).data;
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleColor]).toBe(1);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters]).toBeCloseTo(0.05);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 1]).toBeCloseTo(0.05);
    expect(data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(2);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleColor + 2]).toBeCloseTo(0.8);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleParameters]).toBe(2);
    expect(data[VERTEX_FLOAT_OFFSETS.gradientStyleParameters + 1]).toBeCloseTo(Math.PI / 4);
  });

  it("tessellates Bezier paths into the shared GPU vertex stream", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const path = createLayerForComposition("shape", composition);
    if (!path.shape) throw new Error("Expected shape settings");
    path.size = [760, 480];
    path.shape.kind = "bezier";
    path.shape.path = createDefaultBezierPath();
    path.shape.strokeWidth = 12;
    path.shape.lineJoin = "round";
    composition.layers = [path];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches[0].vertexCount).toBeGreaterThan(12);
    expect(geometry.data).toHaveLength(geometry.batches[0].vertexCount * FLOATS_PER_VERTEX);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.shapeStyleParameters + 2]).toBe(4);
    expect(Array.from(geometry.data).every(Number.isFinite)).toBe(true);

    path.shape.trim = { start: 0, end: 50, offset: 0 };
    const trimmed = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(trimmed.batches[0].vertexCount).toBeGreaterThan(0);
    expect(trimmed.batches[0].vertexCount).toBeLessThan(geometry.batches[0].vertexCount);
  });

  it("includes text quads so cached glyph textures share the layer effect graph", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const text = createLayerForComposition("text", composition);
    composition.layers = [text];
    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches).toHaveLength(1);
    expect(geometry.batches[0].layer.kind).toBe("text");
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.mediaType]).toBe(0);
  });

  it("sizes a 3D precomposition quad from its source composition", () => {
    const project = createBlankProject();
    const root = project.compositions[0];
    const nested = structuredClone(root);
    nested.id = crypto.randomUUID();
    nested.width = 320;
    nested.height = 160;
    const wrapper = createLayerForComposition("precomposition", root);
    wrapper.sourceCompositionId = nested.id;
    wrapper.threeDimensional = true;
    wrapper.transform.anchor = [staticValue(160), staticValue(80), staticValue(0)];
    expect(wrapper.size).toEqual([720, 720]);
    root.layers = [wrapper];
    project.compositions.push(nested);

    const geometry = buildSceneGeometry(root, flattenSceneLayers(root, project, 0));
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position]).toBeCloseTo(-320 / root.width);
    expect(geometry.data[VERTEX_FLOAT_OFFSETS.position + 1]).toBeCloseTo(160 / root.height);
  });

  it("keeps clone effect instances distinct while sharing their media resource", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const image = createLayerForComposition("image", composition);
    image.cloner = {
      distribution: { kind: "grid", count: [3, 1, 1], spacing: [200, 0, 0] },
      effectors: [],
    };
    composition.layers = [image];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(new Set(geometry.batches.map((batch) => batch.instanceId)).size).toBe(3);
    expect(new Set(geometry.batches.map((batch) => batch.selectionId))).toEqual(
      new Set([image.id]),
    );
    expect(new Set(geometry.batches.map((batch) => batch.resourceInstanceId))).toEqual(
      new Set([`root/${image.id}`]),
    );
  });

  it("expands imported indexed meshes into the shared GPU vertex stream", () => {
    const project = createBlankProject();
    const composition = project.compositions[0];
    const mesh = createLayerForComposition("mesh", composition);
    mesh.mesh = {
      name: "Triangle",
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
    };
    composition.layers = [mesh];

    const geometry = buildSceneGeometry(composition, flattenSceneLayers(composition, project, 0));
    expect(geometry.batches[0].vertexCount).toBe(3);
    expect(geometry.data).toHaveLength(FLOATS_PER_VERTEX * 3);
    expect(
      new Set([
        geometry.data[0],
        geometry.data[FLOATS_PER_VERTEX],
        geometry.data[FLOATS_PER_VERTEX * 2],
      ]).size,
    ).toBe(2);
  });
});
