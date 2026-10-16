import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isConfirmedCompileFailure } from './native-failure.js';
import type { TempFiles } from './file-transport.js';

export function stateDirectory(): string {
  return process.env.ILLUSTRATOR_MCP_STATE_DIR || join(tmpdir(), `illustrator-mcp-unified-${process.getuid?.() ?? 'user'}`);
}

export interface LeaseRecord {
  id: string; pid: number; started_at: string; phase: 'running' | 'uncertain';
  receipt: string; error?: string; receipt_version?: 1;
  artifacts?: TempFiles; transport?: string; failure_kind?: string;
}

export async function readLease(): Promise<LeaseRecord | null> {
  try { return JSON.parse(await fs.readFile(join(stateDirectory(), 'execution.lock', 'owner.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(join(stateDirectory(), 'execution.lock'))) return null;
    throw new Error('EXECUTION_UNCONFIRMED: Lock exists without readable ownership. Inspect the runtime directory before another write.');
  }
}

export async function readJobReservation(): Promise<{id:string; created_at:string} | null> {
  const directory=join(stateDirectory(),'batch.lock');
  try {return JSON.parse(await fs.readFile(join(directory,'owner.json'),'utf8'));}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT' && !existsSync(directory))return null;
    throw new Error('BATCH_STATE_UNCONFIRMED: Inspect the batch reservation before writing.');
  }
}

export async function reserveJob(id:string):Promise<void> {
  const root=stateDirectory();await fs.mkdir(root,{recursive:true,mode:0o700});
  const gate=join(root,'lease-gate');
  try{await fs.mkdir(gate,{mode:0o700});}catch{throw new Error('ILLUSTRATOR_BUSY');}
  try {
    if(await readLease() || await readJobReservation())throw new Error('ILLUSTRATOR_BUSY_OR_UNCONFIRMED');
    const directory=join(root,'batch.lock');await fs.mkdir(directory,{mode:0o700});
    await fs.writeFile(join(directory,'owner.json'),JSON.stringify({id,created_at:new Date().toISOString()}),{mode:0o600});
  } finally {await fs.rmdir(gate);}
}

export async function releaseJob(id:string):Promise<void> {
  if((await readJobReservation())?.id===id)await fs.rm(join(stateDirectory(),'batch.lock'),{recursive:true});
}

async function withGate<T>(action: () => Promise<T>, wait = false): Promise<T> {
  const root = stateDirectory();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const gate = join(root, 'lease-gate');
  for (let attempt = 0; ; attempt++) {
    try { await fs.mkdir(gate, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!wait || attempt >= 49) throw new Error('ILLUSTRATOR_BUSY: Execution state is being updated.');
      await delay(20);
    }
  }
  try { return await action(); } finally { await fs.rmdir(gate); }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function hasCompletionReceipt(record: LeaseRecord): Promise<boolean> {
  // File existence alone is not proof: a write may be partial or from another run.
  if (record.receipt !== join(stateDirectory(), 'receipts', `${record.id}.json`)) return false;
  try {
    const receipt = JSON.parse((await fs.readFile(record.receipt, 'utf8')).replace(/^\uFEFF/, ''));
    return receipt.native_completed === true && (receipt.execution_id === record.id ||
      (record.receipt_version === undefined && receipt.execution_id === undefined));
  } catch { return false; }
}

async function archiveExecution(record: LeaseRecord, completion: string): Promise<string> {
  const directory = join(stateDirectory(), 'executions');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${record.id}.json`);
  await atomicJson(file, { ...record, completion, recorded_at: new Date().toISOString() });
  return file;
}

export async function executionRecoveryProof(record: LeaseRecord): Promise<string | null> {
  if (record.phase !== 'uncertain') return null;
  if (await hasCompletionReceipt(record)) return 'native_completion_receipt';
  // Compatibility for the captured local.1 failure. New timeouts never enter this branch.
  if (record.failure_kind === undefined && isConfirmedCompileFailure(record.error ?? '')) return 'legacy_native_compile_error';
  return null;
}

/** State-only recovery. Never cancels/replays scripts or infers completion from PID/age. */
export async function recoverExecution(executionId: string) {
  return withGate(async () => {
    const record = await readLease();
    if (!record) return { recovered: false, reason: 'no_execution' };
    if (record.id !== executionId) throw new Error('EXECUTION_ID_MISMATCH: Read current runtime status before recovery.');
    const proof = await executionRecoveryProof(record);
    if (!proof) throw new Error('EXECUTION_UNCONFIRMED: No verified completion or native compile-failure evidence; lock retained.');
    const archive = await archiveExecution(record, proof);
    await fs.rm(join(stateDirectory(), 'execution.lock'), { recursive: true });
    return { recovered: true, execution_id: record.id, proof, archive_path: archive };
  });
}

export async function acquireLease(): Promise<{
  record: LeaseRecord;
  update: (details: Pick<LeaseRecord, 'artifacts' | 'transport'>) => Promise<void>;
  finish: (confirmed: boolean, error?: string, failureKind?: string) => Promise<void>;
}> {
  const root = stateDirectory();
  const lock = join(root, 'execution.lock');
  const ownerPath = join(lock, 'owner.json');
  const id = randomUUID();
  const record: LeaseRecord = { id, pid: process.pid, started_at: new Date().toISOString(), phase: 'running', receipt: join(root, 'receipts', `${id}.json`), receipt_version: 1 };
  await withGate(async () => {
    await fs.mkdir(join(root, 'receipts'), { recursive: true, mode: 0o700 });
    const job = await readJobReservation();
    if (job && job.id !== process.env.ILLUSTRATOR_MCP_JOB_ID) throw new Error('ILLUSTRATOR_BUSY: A background card job owns the document; use get_batch_status.');
    const previous = await readLease();
    if (previous?.phase === 'uncertain' && await hasCompletionReceipt(previous)) {
      await archiveExecution(previous, 'late_native_completion_receipt');
      await fs.rm(lock, { recursive: true });
    }
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('ILLUSTRATOR_BUSY_OR_UNCONFIRMED: Another unified MCP execution owns Illustrator. Read get_runtime_status; do not replay a potentially completed batch.');
      throw error;
    }
    await atomicJson(ownerPath, record);
  });
  const awake = process.platform === 'darwin' && process.env.ILLUSTRATOR_MCP_KEEP_AWAKE !== '0'
    ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  awake?.on('error', () => {});
  return {
    record,
    async update(details) {
      await withGate(async () => {
        if ((await readLease())?.id !== id) throw new Error('EXECUTION_OWNERSHIP_LOST');
        Object.assign(record, details);
        await atomicJson(ownerPath, record);
      }, true);
    },
    async finish(confirmed, error, failureKind) {
      awake?.kill();
      await withGate(async () => {
        if ((await readLease())?.id !== id) return;
        record.error = error || undefined;
        record.failure_kind = failureKind;
        const receipt = await hasCompletionReceipt(record);
        if (confirmed || receipt) {
          if (error) await archiveExecution(record, receipt ? 'native_completion_receipt' : 'confirmed_terminal');
          await fs.rm(lock, { recursive: true });
        } else {
          record.phase = 'uncertain';
          await atomicJson(ownerPath, record);
          await archiveExecution(record, 'execution_unconfirmed');
        }
      }, true);
    },
  };
}
