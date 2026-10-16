import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLease, recoverExecution, readLease, executionRecoveryProof } from '../../src/executor/execution-lease.js';
import { assertExtendScriptSyntax } from '../../src/executor/script-syntax.js';
let root: string;
beforeEach(async()=>{root=await fs.mkdtemp(join(tmpdir(),'recovery-test-'));vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR',root);vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE','0');});
afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
it('refuses a running execution and stale recovery requests',async()=>{
 const lease=await acquireLease();
 await expect(recoverExecution(lease.record.id)).rejects.toThrow('UNCONFIRMED');
 await expect(recoverExecution('other-id')).rejects.toThrow('ID_MISMATCH');
 expect((await readLease())?.id).toBe(lease.record.id);
 await lease.finish(true);
});
it('validates receipt contents and identity; mere existence cannot release a timeout',async()=>{
 const lease=await acquireLease();await lease.finish(false,'timeout','execution_unconfirmed');
 for(const value of ['', '{', '{"native_completed":false}', '{"native_completed":true}', '{"native_completed":true,"execution_id":"wrong-id"}']){
  await fs.writeFile(lease.record.receipt,value);
  await expect(recoverExecution(lease.record.id)).rejects.toThrow('UNCONFIRMED');
  await expect(acquireLease()).rejects.toThrow('BUSY');
 }
 await fs.writeFile(lease.record.receipt,JSON.stringify({native_completed:true,execution_id:lease.record.id}));
 const result=await recoverExecution(lease.record.id);
 expect(result.recovered).toBe(true);expect(result.proof).toBe('native_completion_receipt');
 expect(JSON.parse(await fs.readFile(result.archive_path!,'utf8')).error).toBe('timeout');
 expect(await readLease()).toBeNull();
 const next=await acquireLease();await next.finish(true);
});
it('recovers the exact legacy compile diagnostic and archives evidence before releasing',async()=>{
 const lease=await acquireLease();await lease.finish(false,'legacy');
 const record=(await readLease())!;
 delete record.receipt_version;delete record.failure_kind;
 record.error='Error: /var/folders/test/run.scpt:252:400: execution error: Adobe Illustrator got an error: Error 9: 非法使用保留字“char”.\rLine: 651\r-> return {char:1}; (5001)\n';
 await fs.writeFile(join(root,'execution.lock','owner.json'),JSON.stringify(record));
 expect(await executionRecoveryProof(record)).toBe('legacy_native_compile_error');
 const result=await recoverExecution(record.id);
 expect(result.recovered).toBe(true);
 expect(JSON.parse(await fs.readFile(result.archive_path!,'utf8')).error).toBe(record.error);
 expect(await readLease()).toBeNull();
});
it('never upgrades unknown native errors, dead clients or code excerpts into completion proof',async()=>{
 const lease=await acquireLease();await lease.finish(false,'client gone');
 const record=(await readLease())!;
 for(const message of ['timeout', 'Error 9: char (5001)', '/tmp/a.scpt:1:2: execution error: Adobe Illustrator got an error: Error 25: script exception\rLine: 1\r-> "Error 9"; (5001)', 'client died']){
  record.error=message;record.pid=99999999;record.started_at='2000-01-01T00:00:00.000Z';
  expect(await executionRecoveryProof(record)).toBeNull();
 }
 await lease.finish(true);
});
it('rejects unsupported syntax, retaining original source line numbers and quoted names',()=>{
 for(const script of ['return {char:1};','let value=1;', 'return ()=>1;', 'return {value,};', '#include "x.jsx"'])expect(()=>assertExtendScriptSyntax(script,'source.jsx')).toThrow('SCRIPT_SYNTAX_ERROR');
 expect(()=>assertExtendScriptSyntax('var value=1;\nreturn {char:value};','source.jsx')).toThrow('source.jsx:2:');
 expect(()=>assertExtendScriptSyntax('var value=1; return {"char":value};')).not.toThrow();
});
