import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { backgroundMode, effectiveActivation, assertBackgroundScript } from '../../src/executor/background-policy.js';
import { acquireLease, readLease, reserveJob, releaseJob } from '../../src/executor/execution-lease.js';
import { batchSchema } from '../../src/cards/schema.js';
import { cardChunks, prepareBatch } from '../../src/cards/jobs.js';
import { cardScript } from '../../src/cards/native.js';
import { runInNewContext } from 'node:vm';

let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if(directory) await fs.rm(directory,{recursive:true,force:true}); directory=undefined; });
async function temp() { directory=await fs.mkdtemp(join(tmpdir(),'card-test-'));return directory; }
const cards = readFileSync(new URL('../../src/jsx/helpers/cards.jsx', import.meta.url), 'utf8');

/** Illustrator-like layers and items whose z-order reads are counted; zOrderPosition always throws (30.2.1). */
function zTree() {
  let reads = 0;
  function node(typename: string, name: string, parent: any, z: number) {
    return {
      typename, name, parent, layers: [] as any[], pageItems: [] as any[], note: '',
      get absoluteZOrderPosition() { reads++; return z; },
      get zOrderPosition(): number { throw new Error('Internal error'); },
    };
  }
  return {
    reads: () => reads,
    layer: (name: string, parent: any = { typename: 'Document' }, z = 0) => node('Layer', name, parent, z),
    item: (typename: string, name: string, parent: any, z = 0) => node(typename, name, parent, z),
  };
}

describe('background execution contract', () => {
  it('does not activate on the default path, including legacy activation requests', () => {
    vi.stubEnv('ILLUSTRATOR_MCP_BACKGROUND','');
    expect(backgroundMode()).toBe(true); expect(effectiveActivation(true)).toBe(false);
    vi.stubEnv('ILLUSTRATOR_MCP_BACKGROUND','0'); expect(effectiveActivation(true)).toBe(true);
  });
  it('rejects UI and clipboard scripts before native execution', () => {
    vi.stubEnv('ILLUSTRATOR_MCP_BACKGROUND','1');
    for(const code of ['app.copy();','app.executeMenuCommand("paste");','alert("hi");','$.evalFile(new File("x"));','new Window("dialog");']) expect(()=>assertBackgroundScript(code)).toThrow('BACKGROUND_UNSUPPORTED');
    expect(()=>assertBackgroundScript('return {version:app.version,count:app.documents.length};')).not.toThrow();
  });
  it('parses the complete native card library', () => { expect(()=>new Function(cardScript('return params;'))).not.toThrow(); });
  it('preserves mixed layer/item order when Illustrator zOrderPosition throws', () => {
    const root: any = { typename:'Layer', layers:[], pageItems:[] };
    const low = { name:'back', parent:root, absoluteZOrderPosition:1, get zOrderPosition(){throw new Error('Internal error');} };
    const high = { name:'front', parent:root, absoluteZOrderPosition:8, zOrderPosition:0 };
    const sub = { typename:'Layer', name:'sub', parent:root, layers:[], pageItems:[], absoluteZOrderPosition:5, get zOrderPosition(){throw new Error('Internal error');} };
    root.pageItems=[high,low]; root.layers=[sub];
    expect(runInNewContext(cards+';cardChildren(root).map(function(x){return x.name;}).join(",");',{root})).toBe('front,sub,back');
  });
  it('reads z-order once per child, and only where sublayers and items interleave', () => {
    // A 1,800-object template took 3.3 s and 3.3 GB per walk when every sort comparison read z-order.
    const tree = zTree();
    const mixed = tree.layer('mixed');
    const items = Array.from({length:40},(_,i)=>tree.item('PathItem','item '+i,mixed,100-i*2));
    const subs = [tree.layer('sub a',mixed,99), tree.layer('sub b',mixed,20)];
    mixed.pageItems=items; mixed.layers=subs;
    const order = runInNewContext(cards+';cardChildren(root).map(function(x){return x.name;});',{root:mixed});
    expect(Array.from(order).slice(0,3)).toEqual(['item 0','sub a','item 1']);
    expect(Array.from(order)).toContain('sub b');
    expect(tree.reads()).toBe(42);
  });
  it('walks groups and single-kind layers in collection order without reading z-order', () => {
    const tree = zTree();
    const root = tree.layer('root'), sub = tree.layer('sub', root), group = tree.item('GroupItem', 'group', sub), nested = tree.item('GroupItem', 'nested', group);
    root.layers=[sub];
    sub.pageItems=[tree.item('PathItem','sub front',sub), group, tree.item('PathItem','sub back',sub)];
    group.pageItems=[tree.item('PathItem','group front',group), nested, tree.item('PathItem','group back',group)];
    nested.pageItems=[tree.item('PathItem','deep',nested)];
    const visited = runInNewContext(cards+';var seen=[];cardWalk(root,function(x){seen.push(x.name);});seen;',{root});
    expect(Array.from(visited)).toEqual(['sub','sub front','group','group front','nested','deep','group back','sub back']);
    const each = runInNewContext(cards+';var seen=[];cardEach(root,function(x){seen.push(x.name);});seen;',{root});
    expect(Array.from(each).sort()).toEqual(Array.from(visited).sort());
    expect(runInNewContext(cards+';cardItem(root,"deep").name;',{root})).toBe('deep');
    expect(tree.reads()).toBe(0);
  });
  it('resets copied object IDs without reading z-order, even inside mixed layers', () => {
    const tree = zTree();
    const layer = tree.layer('copy'), sub = tree.layer('sub', layer, 9), group = tree.item('GroupItem','group',layer,3);
    const path = tree.item('PathItem','path',group); path.note = 'old-uuid-0000-0000-0000-000000000000|rest';
    layer.layers=[sub]; layer.pageItems=[group]; group.pageItems=[path];
    const context = { root: layer, extractUUIDFromNote: (note: string) => note.substring(0, 36), generateUUID: () => 'new-uuid-0000-0000-0000-000000000000' };
    runInNewContext(cards+';cardResetIDs(root);', context);
    expect(path.note).toBe('new-uuid-0000-0000-0000-000000000000|rest');
    expect(tree.reads()).toBe(0);
  });
  it('ignores pageItems that belong to a nested container', () => {
    const tree = zTree();
    const root = tree.layer('root'), group = tree.item('GroupItem','group',root), inner = tree.item('PathItem','inner',group);
    group.pageItems=[inner]; root.pageItems=[group, inner];
    expect(runInNewContext(cards+';cardChildren(root).map(function(x){return x.name;}).join(",");',{root})).toBe('group');
    expect(runInNewContext(cards+';var n=0;cardEach(root,function(){n++;});n;',{root})).toBe(2);
  });
  it('temporarily selects the target layer for native placement and restores state', () => {
    const original = {name:'hidden previous'};
    const doc: any = {typename:'Document',activeLayer:original};
    const layer = {typename:'Layer',parent:doc,locked:true,visible:false};
    const item = {typename:'PlacedItem',parent:layer,locked:false,hidden:false};
    const library=readFileSync(new URL('../../src/jsx/helpers/cards.jsx',import.meta.url),'utf8');
    expect(runInNewContext(library+';cardUnlock(item,function(){return doc.activeLayer===layer && !layer.locked && layer.visible;});',{item,layer,doc})).toBe(true);
    expect(doc.activeLayer).toBe(original);expect(layer.locked).toBe(true);expect(layer.visible).toBe(false);
  });
  it('fits the painted PDF name instead of its empty page clipping boundary', () => {
    const group:any={typename:'GroupItem',clipped:true,pageItems:[]};
    group.pageItems=[
      {typename:'PathItem',parent:group,absoluteZOrderPosition:2,clipping:true,filled:false,geometricBounds:[0,100,200,0]},
      {typename:'PathItem',parent:group,absoluteZOrderPosition:1,clipping:false,filled:true,geometricBounds:[10,80,160,55]},
    ];
    const library=readFileSync(new URL('../../src/jsx/helpers/cards.jsx',import.meta.url),'utf8');
    expect(Array.from(runInNewContext(library+';cardArtworkBounds(group);',{group}))).toEqual([10,80,160,55]);
  });
});

describe('chunked batch generation', () => {
  // Minimal Illustrator DOM: layers added on top, artboards appended, saves and closes recorded.
  function fakeHost() {
    const saves: boolean[] = []; let closes = 0;
    function layer(name: string, parent: any): any {
      const l: any = { typename:'Layer', name, parent, locked:false, visible:true, layers:[], pageItems:[], absoluteZOrderPosition:0 };
      l.layers.add = () => { const c = layer('', l); l.layers.unshift(c); return c; };
      l.remove = () => { const s = l.parent.layers; s.splice(s.indexOf(l), 1); };
      return l;
    }
    const doc: any = { typename:'Document', fullName:{ fsName:'/out.ai' }, activeLayer:null, layers:[], placedItems:[] };
    doc.layers.add = () => { const c = layer('', doc); doc.layers.unshift(c); return c; };
    for (const name of ['01 文案', '02 背景']) doc.layers.push(layer(name, doc));
    doc.artboards = [{ artboardRect:[0,100,60,0], name:'template' }];
    doc.artboards.add = (rect: number[]) => { const b: any = { artboardRect:rect, name:'' }; doc.artboards.push(b); return b; };
    doc.artboards.forEach((b: any) => { b.remove = () => doc.artboards.splice(doc.artboards.indexOf(b), 1); });
    doc.saveAs = (_f: unknown, o: any) => { saves.push(o.pdfCompatible); };
    doc.close = () => { closes++; };
    const context: any = {
      app:{ documents:[], open:() => doc }, SaveOptions:{ DONOTSAVECHANGES:0 },
      IllustratorSaveOptions:function(){}, File:function(this: any, p: string){ this.fsName = p; },
      jsonStringify:(v: unknown) => JSON.stringify(v),
    };
    return { doc, context, saves, closes:() => closes };
  }
  it('reopens one output per chunk, keeps the template until the last chunk and saves PDF compatibility once', () => {
    const { doc, context, saves, closes } = fakeHost();
    const library = readFileSync(new URL('../../src/jsx/helpers/cards.jsx', import.meta.url), 'utf8');
    const cards = ['a','b','c','d','e'].map((id, i) => ({ id, name:'卡'+i }));
    let generated: any = { completed:[] };
    for (const { start, end } of cardChunks(cards.length, 2)) {
      context.plan = { output_path:'/out.ai', cards, columns:4, pdf_compatible:true,
        chunk:{ start, end, completed_before:generated.completed, template_layer_names:generated.template_layer_names, original_artboards:generated.original_artboards } };
      generated = runInNewContext(library + ';cardBatch(plan);', context);
    }
    expect(generated.state).toBe('generated'); expect(Array.from(generated.completed)).toEqual(['a','b','c','d','e']);
    expect(saves).toEqual([false, false, true]); expect(closes()).toBe(3);
    expect(doc.layers.map((l: any) => l.name)).toEqual(['e 卡4','d 卡3','c 卡2','b 卡1','a 卡0']);
    expect(doc.layers[0].layers.map((l: any) => l.name)).toEqual(['01 文案','02 背景']);
    expect(doc.artboards.map((b: any) => b.name)).toEqual(['a 卡0','b 卡1','c 卡2','d 卡3','e 卡4']);
  });
  it('refuses a later chunk when the template layers at the bottom were changed', () => {
    const { doc, context } = fakeHost();
    const library = readFileSync(new URL('../../src/jsx/helpers/cards.jsx', import.meta.url), 'utf8');
    doc.layers[1].name = '改过的背景';
    context.plan = { output_path:'/out.ai', cards:[{ id:'a', name:'x' },{ id:'b', name:'y' }],
      chunk:{ start:1, end:2, completed_before:['a'], template_layer_names:['01 文案','02 背景'], original_artboards:1 } };
    expect(() => runInNewContext(library + ';cardBatch(plan);', context)).toThrow('TEMPLATE_LAYERS_CHANGED');
  });
});

describe('cross-process lease and uncertain completion', () => {
  it('reserves the whole batch, including preparation and independent validation', async () => {
    vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR',await temp());vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE','0');
    await reserveJob('job-one');
    await expect(acquireLease()).rejects.toThrow('BUSY');
    await expect(reserveJob('job-two')).rejects.toThrow('BUSY');
    vi.stubEnv('ILLUSTRATOR_MCP_JOB_ID','job-one');const lease=await acquireLease();await lease.finish(true);
    await releaseJob('job-one');vi.stubEnv('ILLUSTRATOR_MCP_JOB_ID','');
    const next=await acquireLease();await next.finish(true);
  });
  it('rejects overlap; an uncertain timeout stays locked until a native receipt exists', async () => {
    vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR',await temp()); vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE','0');
    const first=await acquireLease();
    await expect(acquireLease()).rejects.toThrow('BUSY');
    await first.finish(false,'timeout'); expect((await readLease())?.phase).toBe('uncertain');
    await expect(acquireLease()).rejects.toThrow('BUSY');
    await fs.writeFile(first.record.receipt,JSON.stringify({native_completed:true,execution_id:first.record.id}));
    const second=await acquireLease(); expect(second.record.id).not.toBe(first.record.id);
    await second.finish(true); expect(await readLease()).toBeNull();
  });
  it('does not treat a dead process or elapsed time as completion', async () => {
    const dir=await temp();vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR',dir);vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE','0');
    const lease=await acquireLease(); await lease.finish(false,'client gone');
    await expect(acquireLease()).rejects.toThrow('BUSY');
  });
});

describe('batch preparation', () => {
  it('preserves template bytes, packages only linked images, and refuses overwrite', async () => {
    const dir=await temp();const tpl=join(dir,'template.ai'),img=join(dir,'source.png');
    await fs.writeFile(tpl,'fixture-template');await fs.writeFile(img,'fixture-image');
    const job=join(dir,'job');await fs.mkdir(job);
    const plan=batchSchema.parse({template_path:tpl,output_path:join(dir,'out.ai'),cards:[{id:'01',name:'test',images:[{item_name:'main',file_path:img,embed:false},{item_name:'icon',file_path:img,embed:true}]}]});
    const prepared=await prepareBatch(plan,job);
    expect(await fs.readFile(tpl,'utf8')).toBe('fixture-template');
    expect(prepared.cards[0].images[0].file_path).toContain('/Links/');
    expect(prepared.cards[0].images[1].file_path).toBe(img);
    await expect(prepareBatch(plan,job)).rejects.toMatchObject({code:'EEXIST'});
  });
  it('defaults to chunks of four and a PDF-compatible final save', () => {
    const plan=batchSchema.parse({template_path:'/tmp/t.ai',output_path:'/tmp/o.ai',cards:[{id:'01',name:'a'}]});
    expect(plan.chunk_size).toBe(4);expect(plan.pdf_compatible).toBe(true);
    expect(cardChunks(10,4)).toEqual([{start:0,end:4},{start:4,end:8},{start:8,end:10}]);
    expect(cardChunks(3,4)).toEqual([{start:0,end:3}]);
  });
  it('rejects duplicate ids and inverted bounds before generating anything', () => {
    expect(()=>batchSchema.parse({template_path:'/tmp/t.ai',output_path:'/tmp/o.ai',cards:[{id:'01',name:'a'},{id:'01',name:'b'}]})).toThrow();
  });
});
