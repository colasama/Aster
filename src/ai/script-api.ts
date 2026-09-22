/** Executed inside QuickJS, never evaluated by the renderer's JavaScript engine. */
export const SCRIPT_API = `
(() => {
  const call = (name, value) => JSON.parse(globalThis[name](JSON.stringify(value)));
  const command = (command, compositionId) => call('__asterCommand', { command, compositionId });
  const query = (kind, compositionId, id) => call('__asterQuery', { kind, compositionId, id });
  const property = (compositionId, layerId, path) => Object.freeze({
    set: value => command({ type: 'setProperty', layerId, path, value }, compositionId),
    setKeyframes: frames => {
      if (!Array.isArray(frames) || !frames.length) throw new Error('Keyframes must be a non-empty array');
      command({ type: 'setProperty', layerId, path, value: frames[0].value }, compositionId);
      for (const frame of frames) command({ ...frame, type: 'addKeyframe', layerId, path }, compositionId);
    },
  });
  const layer = (compositionId, id) => Object.freeze({
    id,
    inspect: () => query('layer', compositionId, id),
    property: path => property(compositionId, id, path),
    opacity: property(compositionId, id, 'opacity'),
    set: values => {
      for (const [key, value] of Object.entries(values)) {
        if (key === 'name') command({ type: 'renameLayer', layerId: id, name: value }, compositionId);
        else if (key === 'text') command({ type: 'setTextContent', layerId: id, text: value }, compositionId);
        else if (key === 'textStyle') command({ type: 'setTextStyle', layerId: id, textStyle: value }, compositionId);
        else if (['position','scale','rotation','anchor'].includes(key)) {
          if (!Array.isArray(value) || value.length !== 3) throw new Error(key + ' requires three numbers');
          value.forEach((v,i) => property(compositionId,id,key+'.'+i).set(v));
        } else if (key === 'properties') {
          for (const [path, v] of Object.entries(value)) property(compositionId,id,path).set(v);
        } else if (key === 'opacity') property(compositionId,id,key).set(value);
        else throw new Error('Unknown layer setting: ' + key);
      }
    },
    remove: () => command({ type: 'removeLayer', layerId: id }, compositionId),
    duplicate: name => layer(compositionId, command({ type: 'duplicateLayer', layerId: id, ...(name === undefined ? {} : {name}) }, compositionId).id),
    addEffect: (effectType, parameters = {}) => command({ type: 'addEffect', layerId: id, effectType, parameters }, compositionId),
  });
  const composition = id => {
    const add = options => {
      const { position, scale, rotation, anchor, opacity, properties, textStyle, ...fields } = options;
      const created = layer(id, command({ ...fields, type: 'addLayer' }, id).id);
      const values = { position, scale, rotation, anchor, opacity, properties, textStyle };
      created.set(Object.fromEntries(Object.entries(values).filter(([,v]) => v !== undefined)));
      return created;
    };
    return Object.freeze({
      id,
      inspect: () => query('composition', id),
      layers: Object.freeze({
        list: () => query('layers', id),
        get: layerId => { query('layer', id, layerId); return layer(id, layerId); },
        add,
        addText: options => add({ ...options, kind: 'text' }),
        set: (ids, values) => { for (const layerId of ids) layer(id, layerId).set(values); },
      }),
    });
  };
  globalThis.aster = Object.freeze({
    command: value => command(value),
    commands: values => values.map(value => command(value)),
    progress: (fraction, message = '') => call('__asterProgress', { fraction, message }),
    compositions: Object.freeze({
      list: () => query('compositions'),
      active: () => composition(query('active').id),
      get: id => { query('composition', id); return composition(id); },
    }),
  });
})();
`;

export const SCRIPT_API_DOCS = {
  version: 1,
  language:
    "Synchronous JavaScript function body; use return for a JSON result. No imports, DOM, network, Node or filesystem APIs.",
  methods: [
    "aster.compositions.list() -> composition metadata[]",
    "aster.compositions.active() / get(id) -> composition handle",
    "composition.inspect() -> metadata; composition.layers.list() -> {id,name,kind}[]",
    "composition.layers.get(id) -> layer handle; layer.inspect() -> layer data",
    "composition.layers.add({kind,name,...commandFields,position?,scale?,rotation?,opacity?,properties?,textStyle?}) -> layer handle",
    "composition.layers.addText({text,...options}) -> layer handle",
    "composition.layers.set(ids, values) / layer.set({name?,text?,textStyle?,position?,scale?,rotation?,anchor?,opacity?,properties?})",
    "layer.property(path).set(number); layer.property(path).setKeyframes([{time,value,interpolation?,easing?}]) replaces that property's keys",
    "layer.opacity.set(number) / setKeyframes(frames)",
    "layer.duplicate(name?) -> layer handle; layer.remove(); layer.addEffect(effectType, parameters?) -> {id}",
    "aster.command(typedCommand) / aster.commands(commands) -> operation references; discover schemas with get_command_schemas",
    "aster.progress(0..1, message?) reports progress without committing",
  ],
  example:
    "const c = aster.compositions.active(); const ids = []; for (let i=0;i<16;i++) { const l=c.layers.addText({name:'Unit '+i,text:String(i),position:[120+i*80,300,0]}); l.opacity.setKeyframes([{time:i*0.05,value:0},{time:i*0.05+0.3,value:100}]); ids.push(l.id); } return {ids};",
};
