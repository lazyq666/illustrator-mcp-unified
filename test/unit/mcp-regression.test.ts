import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('child_process', async (original) => ({ ...(await original<object>()), execFile: vi.fn() }));
import { execFile } from 'child_process';
import { runTrustedScript } from '../../src/executor/trusted-script.js';
import { executeJsx } from '../../src/executor/jsx-runner.js';
import { readLease } from '../../src/executor/execution-lease.js';
import { ensureTmpDir } from '../../src/executor/file-transport.js';
let root: string;
const nativeError = '/tmp/run.scpt:252:400: execution error: Adobe Illustrator got an error: Error 9: Illegal use of reserved word "char".\rLine: 651\r-> return {char:1}; (5001)\n';
beforeEach(async () => {
  root=await fs.mkdtemp(join(tmpdir(),'mcp-regression-'));
  vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR',root);
  vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE','0');
  vi.stubEnv('ILLUSTRATOR_MCP_TRANSPORT','osascript');
  vi.stubEnv('ILLUSTRATOR_MCP_BACKGROUND','1');
  await ensureTmpDir();
  vi.mocked(execFile).mockReset().mockImplementation(((_file: any,_args: any,_opts: any,cb: any) => {
    cb(Object.assign(new Error(nativeError),{code:1}), '', nativeError);
    return {};
  }) as any);
});
afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
it('rejects the original reserved-property failure before acquiring a lease or contacting Illustrator',async()=>{
  await expect(runTrustedScript({script:'return {char:1};'})).rejects.toThrow('SCRIPT_SYNTAX_ERROR');
  expect(execFile).not.toHaveBeenCalled();
  expect(await readLease()).toBeNull();
});
it('releases a positively identified native compile failure, and keeps diagnostic paths',async()=>{
  await expect(executeJsx('var value = 1;')).rejects.toThrow('Error 9');
  expect(await readLease()).toBeNull();
  const names=await fs.readdir(join(root,'executions'));
  const record=JSON.parse(await fs.readFile(join(root,'executions',names[0]),'utf8'));
  expect(record.failure_kind).toBe('native_compile_error');
  expect(await fs.readFile(record.artifacts.scriptPath,'utf8')).toContain('var value = 1;');
});
it('keeps timeouts locked even when the child stderr contains an old compile error',async()=>{
  vi.mocked(execFile).mockImplementation(((_file:any,_args:any,_opts:any,cb:any)=>{
    cb(Object.assign(new Error('timeout'),{code:'ETIMEDOUT',killed:true}), '', nativeError);return {};
  }) as any);
  await expect(executeJsx('var value = 1;')).rejects.toThrow('timed out');
  expect((await readLease())?.phase).toBe('uncertain');
  await expect(executeJsx('var next = 2;')).rejects.toThrow('BUSY');
  expect(execFile).toHaveBeenCalledTimes(1);
});
it('retains diagnostics but releases after a runtime error with a native receipt',async()=>{
  vi.mocked(execFile).mockImplementation(((_file:any,_args:any,_opts:any,cb:any)=>{
    void (async()=>{
      const owner=(await readLease())!;
      await fs.writeFile(owner.artifacts!.resultPath,JSON.stringify({error:true,message:'controlled runtime failure',line:12}));
      await fs.writeFile(owner.receipt,JSON.stringify({native_completed:true,execution_id:owner.id}));
      cb(null,'','');
    })().catch(e=>cb(e,'',''));
    return {};
  }) as any);
  await expect(executeJsx('var value=1;')).rejects.toThrow('controlled runtime failure');
  expect(await readLease()).toBeNull();
  const names=await fs.readdir(join(root,'executions'));
  const record=JSON.parse(await fs.readFile(join(root,'executions',names[0]),'utf8'));
  expect(record.completion).toBe('native_completion_receipt');
  expect(record.failure_kind).toBe('result_error');
  expect(JSON.parse(await fs.readFile(record.artifacts.resultPath,'utf8')).error).toBe(true);
});
it('releases a local setup failure before the native transport starts',async()=>{
  // Non-serializable params fail while writing the params file.
  const params:any={};params.self=params;
  await expect(executeJsx('var value=1;',params)).rejects.toThrow('circular');
  expect(execFile).not.toHaveBeenCalled();expect(await readLease()).toBeNull();
});
it('permits valid quoted properties through the whole generated wrapper and cleans up success',async()=>{
  let scriptPath='';
  vi.mocked(execFile).mockImplementation(((_file:any,_args:any,_opts:any,cb:any)=>{
    void (async()=>{
      const owner=(await readLease())!;scriptPath=owner.artifacts!.scriptPath;
      const script=await fs.readFile(scriptPath,'utf8');
      expect(script).toContain(owner.id);
      await fs.writeFile(owner.artifacts!.resultPath,JSON.stringify({result:{char:1}}));
      cb(null,'','');
    })().catch(e=>cb(e,'',''));return {};
  }) as any);
  await expect(runTrustedScript({script:'return {"char":1};'})).resolves.toEqual({result:{char:1}});
  expect(await readLease()).toBeNull();await expect(fs.stat(scriptPath)).rejects.toMatchObject({code:'ENOENT'});
});
it('maps native error lines back to the run_script source and adds document context and code hints',async()=>{
  vi.mocked(execFile).mockImplementation(((_file:any,_args:any,_opts:any,cb:any)=>{
    void (async()=>{
      const owner=(await readLease())!;
      const lines=(await fs.readFile(owner.artifacts!.scriptPath,'utf8')).split('\n');
      const line=lines.findIndex(text=>text.includes('tops[j].duplicate'))+1;
      await fs.writeFile(owner.artifacts!.resultPath,JSON.stringify({error:true,message:"an Illustrator error occurred: 1346458189 ('MRAP')",line,context:{documents:2,activeDocument:'/x/source.svg'}}));
      await fs.writeFile(owner.receipt,JSON.stringify({native_completed:true,execution_id:owner.id}));
      cb(null,'','');
    })().catch(e=>cb(e,'',''));return {};
  }) as any);
  const script=Array.from({length:10},(_,i)=>`var v${i}=${i};`).join('\n')+'\ntops[j].duplicate(group, ElementPlacement.PLACEATBEGINNING);';
  await expect(runTrustedScript({script})).rejects.toThrow(/user script line 11: tops\[j\]\.duplicate.*active document: \/x\/source\.svg; open documents: 2.*Hint: .*GroupItem of another document/s);
  expect(await readLease()).toBeNull();
});
