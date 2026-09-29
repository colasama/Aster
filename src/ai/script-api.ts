/** Executed inside QuickJS, never evaluated by the renderer's JavaScript engine. */
export const SCRIPT_API = `
(() => {
  const call = (name, value) => JSON.parse(globalThis[name](JSON.stringify(value)));
  const command = (command, compositionId) => call('__asterCommand', { command, compositionId });
  const query = (kind, compositionId, id, options) => call('__asterQuery', { kind, compositionId, id, options });
  const action = (action, input) => call('__asterAction', { action, input });
  const hex = (value, alpha = 1) => {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value));
    if (!match) throw new Error('Color must be #rgb, #rrggbb or #rrggbbaa: ' + value);
    let digits = match[1];
    if (digits.length === 3) digits = digits.split('').map(d => d + d).join('');
    const channel = i => parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) : alpha];
  };
  const color = value => typeof value === 'string' ? hex(value) : value;
  const property = (compositionId, layerId, path) => Object.freeze({
    set: value => command({ type: 'setProperty', layerId, path, value }, compositionId),
    setKeyframes: frames => {
      if (!Array.isArray(frames) || !frames.length) throw new Error('Keyframes must be a non-empty array');
      command({ type: 'setProperty', layerId, path, value: frames[0].value }, compositionId);
      for (const frame of frames) command({ ...frame, type: 'addKeyframe', layerId, path }, compositionId);
    },
    setExpression: expression => {
      const effect = /^effects\\.([^.]+)\\.(.+)$/.exec(path);
      return effect
        ? command({ type: 'setEffectParameterExpression', layerId, effectId: effect[1], parameter: effect[2], expression }, compositionId)
        : command({ type: 'setExpression', layerId, path, expression }, compositionId);
    },
  });
  const vectorPaths = ['position','scale','rotation','anchor'];
  const layer = (compositionId, id) => Object.freeze({
    id,
    compositionId,
    inspect: fields => query('layer', compositionId, id, fields === undefined ? undefined : { fields }),
    property: path => property(compositionId, id, path),
    opacity: property(compositionId, id, 'opacity'),
    set: values => {
      for (const [key, value] of Object.entries(values)) {
        if (key === 'name') command({ type: 'renameLayer', layerId: id, name: value }, compositionId);
        else if (key === 'text') command({ type: 'setTextContent', layerId: id, text: value }, compositionId);
        else if (key === 'textStyle') command({ type: 'setTextStyle', layerId: id, textStyle: value }, compositionId);
        else if (key === 'color') command({ type: 'setLayerColor', layerId: id, color: color(value) }, compositionId);
        else if (vectorPaths.includes(key)) {
          if (!Array.isArray(value) || value.length !== 3) throw new Error(key + ' requires three numbers');
          value.forEach((v,i) => property(compositionId,id,key+'.'+i).set(v));
        } else if (key === 'properties') {
          for (const [path, v] of Object.entries(value)) property(compositionId,id,path).set(v);
        } else if (key === 'expressions') {
          for (const [path, expression] of Object.entries(value)) property(compositionId,id,path).setExpression(expression);
        } else if (key === 'opacity') property(compositionId,id,key).set(value);
        else throw new Error('Unknown layer setting: ' + key + ' (use name, text, textStyle, color, position, scale, rotation, anchor, opacity, properties or expressions)');
      }
    },
    setTiming: (inPoint, outPoint) => command({ type: 'setLayerTiming', layerId: id, inPoint, outPoint }, compositionId),
    setTimeMapping: ({ sourceStart = 0, stretch = 1 } = {}) =>
      command({ type: 'setLayerTimeMapping', layerId: id, offset: sourceStart, stretch }, compositionId),
    setTextAnimator: settings => command({ ...settings, type: 'setTextAnimator', layerId: id }, compositionId),
    remove: () => command({ type: 'removeLayer', layerId: id }, compositionId),
    duplicate: name => layer(compositionId, command({ type: 'duplicateLayer', layerId: id, ...(name === undefined ? {} : {name}) }, compositionId).id),
    addEffect: (effectType, parameters = {}) => command({ type: 'addEffect', layerId: id, effectType, parameters }, compositionId),
    fitToCamera: (options = {}) => action('fitToCamera', { compositionId, layerId: id, options }),
    setEffectExpression: (effectId, parameter, expression) =>
      command({ type: 'setEffectParameterExpression', layerId: id, effectId, parameter, expression }, compositionId),
  });
  const composition = id => {
    const add = options => {
      const { position, scale, rotation, anchor, opacity, properties, expressions, textStyle, color: fill, ...fields } = options;
      const created = layer(id, command({ ...fields, type: 'addLayer' }, id).id);
      const values = { position, scale, rotation, anchor, opacity, properties, expressions, textStyle, color: fill };
      created.set(Object.fromEntries(Object.entries(values).filter(([,v]) => v !== undefined)));
      return created;
    };
    return Object.freeze({
      id,
      inspect: () => query('composition', id),
      activate: () => command({ type: 'setActiveComposition', compositionId: id }),
      precompose: (layerIds, name) => {
        const created = command({ type: 'precomposeLayers', layerIds, ...(name === undefined ? {} : {name}) }, id);
        return { compositionId: created.compositionId, wrapperLayerId: created.wrapperLayerId, composition: composition(created.compositionId), wrapper: layer(id, created.wrapperLayerId) };
      },
      layers: Object.freeze({
        list: filter => query('layers', id, undefined, filter),
        get: layerId => { query('layer', id, layerId, { fields: ['id'] }); return layer(id, layerId); },
        find: name => { const found = query('layers', id, undefined, { name, limit: 1 })[0]; return found ? layer(id, found.id) : undefined; },
        add,
        addText: options => add({ ...options, kind: 'text' }),
        set: (ids, values) => { for (const layerId of ids) layer(id, layerId).set(values); },
      }),
    });
  };
  const modules = {};
  globalThis.aster = Object.freeze({
    command: value => command(value),
    commands: values => values.map(value => command(value)),
    progress: (fraction, message = '') => call('__asterProgress', { fraction, message }),
    budget: () => query('budget'),
    warnings: () => query('warnings'),
    color: hex,
    require: name => {
      if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name].exports;
      const factory = globalThis.__asterRequire(String(name));
      const module = { exports: {} };
      modules[name] = module;
      const returned = factory(module, module.exports, globalThis.aster);
      if (returned !== undefined) module.exports = returned;
      return module.exports;
    },
    compositions: Object.freeze({
      list: filter => query('compositions', undefined, undefined, filter),
      active: () => composition(query('active').id),
      get: id => { query('composition', id); return composition(id); },
      find: name => { const found = query('compositions', undefined, undefined, { name, limit: 1 })[0]; return found ? composition(found.id) : undefined; },
      remove: ids => action('removeCompositions', { ids: Array.isArray(ids) ? ids : [ids] }),
      collectUnused: (options = {}) => action('collectUnusedCompositions', options),
      add: ({ name, width, height, duration, frameRate = [30, 1], activate = false }) => {
        const rate = Array.isArray(frameRate) ? frameRate : [frameRate, 1];
        return composition(command({ type: 'addComposition', name, width, height, duration, frameRateNumerator: rate[0], frameRateDenominator: rate[1], activate }).id);
      },
    }),
  });
})();
`;

export const SCRIPT_API_DOCS = {
  version: 2,
  language:
    "Synchronous JavaScript function body evaluated in QuickJS; use return for a JSON result (max 64 KiB). No imports, DOM, network, Node or filesystem APIs. Errors report line/column relative to your code.",
  workflow: [
    "execute_aster_code waits for completion by default and returns the final status (state, workspaceId, workspaceRevision, result, warnings). Only call get_execution when the result still says running.",
    "Pass baseRevision (live projectRevision) to start a workspace, or workspaceId + workspaceRevision to continue one.",
    "External automation: add commit:true (and summary) to submit and commit in the same call, or call commit_workspace, which submits automatically.",
    "Warnings (for example layers mapped outside their source media) are returned in the execution status; read them before rendering.",
  ],
  methods: [
    "aster.compositions.list({name?, namePrefix?, limit?}?) -> [{id,name,width,height,duration,frameRate,layerCount,active}] (all compositions, including nested ones)",
    "aster.compositions.active() / get(id) / find(exactName) -> composition handle (find returns undefined when missing)",
    "aster.compositions.add({name,width,height,duration,frameRate?:[num,den]|fps,activate?}) -> composition handle",
    "composition.inspect(); composition.activate(); composition.layers.list({name?, namePrefix?, kind?, limit?}?) -> [{id,name,kind,inPoint,outPoint,sourceCompositionId?}]",
    "composition.layers.get(id) / find(exactName) -> layer handle; layer.inspect(fields?) -> layer data, e.g. inspect(['name','inPoint','transform.position','sourceRange'])",
    "composition.layers.add({kind,name,...commandFields,position?,scale?,rotation?,anchor?,opacity?,color?,properties?,expressions?,textStyle?}) -> layer handle",
    "composition.layers.addText({text,...options}) -> layer handle; composition.layers.set(ids, values)",
    "composition.precompose(layerIds, name?) -> {compositionId, wrapperLayerId, composition, wrapper}",
    "aster.compositions.remove(ids) removes compositions in dependency order (parents before nested children) -> [{id,name}]",
    "aster.compositions.collectUnused({keep?: [id|name], dryRun?, sources?}) removes compositions unreachable from the active one (and keep) through precomps; sources:true also removes unused footage",
    "layer.fitToCamera({margin?, cameraId?, start?, end?, samples?, apply?: true}) -> {scaleMultiplier, criticalTime, alreadyCovered}: smallest uniform XY scale so a 3D layer covers the frame along the whole camera path",
    "layer.set({name?,text?,textStyle?,color?,position?,scale?,rotation?,anchor?,opacity?,properties?,expressions?})",
    "layer.property(path).set(number) / setKeyframes([{time,value,interpolation?,easing?}]) (replaces keys) / setExpression(expr) ('' clears)",
    "layer.setTiming(inPoint, outPoint); layer.setTimeMapping({sourceStart, stretch?}) sets the source time shown at inPoint",
    "layer.setTextAnimator({enabled?, groups:[...]}) per-character animation (see textAnimators)",
    "layer.duplicate(name?) -> layer handle; layer.remove(); layer.addEffect(effectType, parameters?) -> {id}",
    "layer.setEffectExpression(effectId, parameter, expr) or layer.property('effects.<effectId>.<parameter>').setExpression(expr) drives an effect parameter ('' clears)",
    "aster.command(typedCommand) / aster.commands(commands) -> {type,id?,...}; addLayer/addEffect/addComposition/addSource/addProjectFolder return id; precomposeLayers returns compositionId and wrapperLayerId",
    "aster.budget() -> {operations:{used,limit,remaining}, queryBytesPerCall, resultBytes, timeRemainingMs}",
    "aster.warnings() -> warnings collected so far in this execution",
    "aster.require(name) -> exports of a script module stored with put_script_module (evaluated once per execution; module body receives module, exports, aster)",
    "aster.color('#rrggbb' | '#rrggbbaa', alpha?) -> [r,g,b,a] in 0..1",
    "aster.progress(0..1, message?) reports progress without committing",
  ],
  propertyPaths: [
    "position.0|1|2",
    "rotation.0|1|2",
    "scale.0|1|2",
    "anchor.0|1|2",
    "opacity (0..100)",
    "camera.pointOfInterest.0|1|2",
    "camera.orientation.0|1|2",
    "shape.morphProgress",
  ],
  expressions: {
    appliesTo:
      "Layer property paths above (setExpression) and effect parameters (setEffectParameterExpression); value is the keyframed or static value, so value * (1 + 0.3 * sin(time * 2 * pi * 2)) pulses around it.",
    variables: ["time (composition seconds)", "value (the property's keyframed value)", "pi", "e"],
    functions: [
      "abs ceil floor round sqrt sin cos tan",
      "min(a,...) max(a,...) pow(a,b) clamp(x,lo,hi)",
    ],
    operators: "+ - * / % ^ and parentheses; max 2048 characters",
    example: "value + 12 * sin(time * 2 * pi * 128 / 60)",
  },
  textAnimators: {
    summary:
      "setTextAnimator animates characters, words or lines inside one text layer, so a lyric line needs one layer instead of one layer per character.",
    groupFields:
      "{name?, enabled?, selectors:[selector], properties:{position?:[x,y,z], scale?:[x,y,z], rotation?:[x,y,z], opacity?, blur?:[x,y], tracking?, fillColor?:[r,g,b,a], skew?}}",
    selectors: [
      "range: {kind:'range', basedOn?:'characters'|'charactersExcludingSpaces'|'words'|'lines', units?:'percentage'|'index', start?, end?, offset?, shape?:'square'|'rampUp'|'rampDown'|'triangle'|'round'|'smooth', mode?, amount?}",
      "expression: {kind:'expression', expression:'...'} with textIndex (1-based), textTotal, selectorValue, time; result 0..100 is how strongly properties apply",
      "wiggly: {kind:'wiggly', minimumAmount?, maximumAmount?, wigglesPerSecond?, correlation?}",
    ],
    values:
      "Every numeric field accepts a number or {mode:'animated', keyframes:[{time,value,interpolation?}]} (times are layer-local seconds). Properties are offsets applied at selector strength 100.",
    example:
      "layer.setTextAnimator({groups:[{selectors:[{kind:'expression', expression:'100 * (1 - clamp((time - 0.5 - (textIndex - 1) * 0.06) / 0.4, 0, 1))'}], properties:{position:[0,40,0], opacity:0, blur:[8,8]}}]})",
  },
  timeMapping:
    "setLayerTimeMapping.offset (setTimeMapping sourceStart) is the SOURCE time displayed at the layer inPoint: sourceTime = offset + (compositionTime - inPoint) / stretch. To show seconds S..S+d of a clip on a layer at inPoint T, use offset S (not S - T). Offsets beyond the source duration freeze on the last frame and produce a warning.",
  colors:
    "Colors are [r,g,b,a] with 0..1 channels equal to CSS/hex values divided by 255 (display-referred). layer.set({color:'#ff3366'}) and aster.color() accept hex strings.",
  fonts:
    "textStyle.fontFamily takes the family name; names containing spaces or punctuation are quoted automatically. Use list_fonts/check_fonts for exact names.",
  budgets:
    "Per workspace: 4096 normalized operations (setting a 3D vector costs 3). Per script: 30 s, 256 KiB source, 64 KiB return value, 1 MiB per query. Commit and continue in a new workspace when operations run low; check aster.budget().",
  commonErrors: [
    "'Layer does not exist' — the layer lives in another composition; use the handle from that composition (handles switch the active composition automatically).",
    "'Effect type does not exist' — use list_effects or search_capabilities; the error lists close matches (e.g. blur -> gaussian-blur).",
    "'revision_conflict' — reuse the workspaceRevision returned by the last successful execution.",
    "'budget_exceeded' — commit this workspace and continue in a new one, or split the script.",
  ],
  example:
    "const c = aster.compositions.active(); const ids = []; for (let i=0;i<16;i++) { const l=c.layers.addText({name:'Unit '+i,text:String(i),position:[120+i*80,300,0],color:'#ffffff'}); l.opacity.setKeyframes([{time:i*0.05,value:0},{time:i*0.05+0.3,value:100}]); ids.push(l.id); } return {ids};",
};
