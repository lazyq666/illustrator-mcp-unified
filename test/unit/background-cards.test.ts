import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { backgroundMode, effectiveActivation, assertBackgroundScript } from '../../src/executor/background-policy.js';
import { acquireLease, readLease, reserveJob, releaseJob } from '../../src/executor/execution-lease.js';
import { batchSchema } from '../../src/cards/schema.js';
import { prepareBatch } from '../../src/cards/jobs.js';
import { cardScript } from '../../src/cards/native.js';
import { runInNewContext } from 'node:vm';

let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if(directory) await fs.rm(directory,{recursive:true,force:true}); directory=undefined; });
async function temp() { directory=await fs.mkdtemp(join(tmpdir(),'card-test-'));return directory; }

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
    root.pageItems=[high,low];
    const library=readFileSync(new URL('../../src/jsx/helpers/cards.jsx',import.meta.url),'utf8');
    expect(runInNewContext(library+';cardChildren(root).map(function(x){return x.name;}).join(",");',{root})).toBe('front,back');
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
  it('rejects duplicate ids and inverted bounds before generating anything', () => {
    expect(()=>batchSchema.parse({template_path:'/tmp/t.ai',output_path:'/tmp/o.ai',cards:[{id:'01',name:'a'},{id:'01',name:'b'}]})).toThrow();
  });
});
