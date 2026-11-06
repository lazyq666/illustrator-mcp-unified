import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isConfirmedCompileFailure } from './native-failure.js';
import { illustratorProbe, sameIllustrator, type IllustratorIdentity } from './illustrator-process.js';
import type { TempFiles } from './file-transport.js';

export function stateDirectory(): string {
  return process.env.ILLUSTRATOR_MCP_STATE_DIR || join(tmpdir(), `illustrator-mcp-unified-${process.getuid?.() ?? 'user'}`);
}

export interface LeaseRecord {
  id: string; pid: number; started_at: string; phase: 'running' | 'uncertain' | 'finished';
  receipt: string; error?: string; receipt_version?: 1;
  artifacts?: TempFiles; transport?: string; failure_kind?: string;
  /** Diagnosis only: which tool/job started this and what it was asked to do. */
  tool?: string; job_id?: string; params_summary?: string;
  /** The Illustrator process lifetime the script was sent to. */
  illustrator?: IllustratorIdentity;
}

export interface LeaseMetadata { tool?: string; params?: unknown; appPath?: string }

/** Written by the JSX preamble before user code runs; distinguishes "never started" from "started, not finished". */
export function startedMarkerPath(record: Pick<LeaseRecord, 'receipt'>): string {
  return record.receipt.replace(/\.json$/, '.started.json');
}

export async function readStartedMarker(record: LeaseRecord): Promise<{ started_at: string; activeDocument?: string | null; documents?: number } | null> {
  try {
    const file = startedMarkerPath(record);
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { started_at: stat.mtime.toISOString(), ...JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch { return null; }
}

function summarizeParams(params: unknown): string | undefined {
  if (params === undefined) return undefined;
  try {
    const text = JSON.stringify(params, (key, value) => key === 'script' && typeof value === 'string' ? `<${value.length} chars>` : value);
    return text.length > 600 ? text.slice(0, 600) + '…' : text;
  } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
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

const TERMINAL_JOB_STATES = new Set(['ready_for_visual_review', 'validation_failed', 'failed', 'execution_unconfirmed', 'abandoned_outcome_unknown', 'completed_after_timeout_unvalidated']);

async function readJobStatus(id: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(join(stateDirectory(), 'jobs', id, 'status.json'), 'utf8')); }
  catch { return null; }
}

/** Reservation plus whether its detached worker can still be running. */
export async function describeJobReservation() {
  const reservation = await readJobReservation();
  if (!reservation) return null;
  const status = await readJobStatus(reservation.id);
  const pid = typeof status?.pid === 'number' ? status.pid : null;
  return { ...reservation, state: status?.state ?? null, worker_pid: pid, worker_alive: pid === null ? null : processAlive(pid) };
}

/**
 * Release a batch reservation whose worker was killed before its finally block ran.
 * Refuses while the worker may still be alive or an execution owns Illustrator.
 */
export async function releaseStaleJob(id: string) {
  return withGate(async () => {
    const reservation = await readJobReservation();
    if (!reservation) return { released: false, reason: 'no_batch_reservation' };
    if (reservation.id !== id) throw new Error('BATCH_ID_MISMATCH: Read get_runtime_status before releasing.');
    if (await readLease()) throw new Error('EXECUTION_PRESENT: Resolve the execution lock first (recover_execution or abandon_execution).');
    const status = await readJobStatus(id);
    const pid = typeof status?.pid === 'number' ? status.pid : null;
    if (pid !== null && processAlive(pid)) throw new Error(`BATCH_WORKER_ALIVE: Worker ${pid} is still running; poll get_batch_status.`);
    const age = Date.now() - Date.parse(reservation.created_at);
    if (pid === null && !TERMINAL_JOB_STATES.has(String(status?.state)) && age < 120_000) throw new Error('BATCH_STARTING: The worker may still be starting; retry in two minutes.');
    await fs.rm(join(stateDirectory(), 'batch.lock'), { recursive: true });
    if (status && !TERMINAL_JOB_STATES.has(String(status.state))) {
      await atomicJson(join(stateDirectory(), 'jobs', id, 'status.json'), { ...status, state: 'abandoned_outcome_unknown', resolution: 'worker_gone', resolved_at: new Date().toISOString() });
    }
    return { released: true, job_id: id, previous_state: status?.state ?? null };
  });
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

async function archiveExecution(record: LeaseRecord, completion: string, extra: Record<string, unknown> = {}): Promise<string> {
  const directory = join(stateDirectory(), 'executions');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${record.id}.json`);
  await atomicJson(file, { ...record, completion, ...extra, recorded_at: new Date().toISOString() });
  return file;
}

/** Proofs after which the native outcome (saved or not) is still unknown. */
const OUTCOME_UNKNOWN = new Set(['illustrator_restarted']);

export async function executionRecoveryProof(record: LeaseRecord): Promise<string | null> {
  if (record.phase !== 'uncertain') return null;
  if (await hasCompletionReceipt(record)) return 'native_completion_receipt';
  // A compile diagnostic means the script never ran. Timeouts never record one: their error is the timeout message.
  if (isConfirmedCompileFailure(record.error ?? '')) return record.failure_kind === undefined ? 'legacy_native_compile_error' : 'native_compile_error';
  // The Illustrator process that received the script has exited, so the script cannot still be running.
  // This proves "stopped", not "completed"; it is never inferred from MCP client PIDs or age.
  if (record.illustrator) {
    const appPath = record.illustrator.executable.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    const current = await illustratorProbe.current(appPath);
    if (current === null || (current && !sameIllustrator(current, record.illustrator))) return 'illustrator_restarted';
  }
  return null;
}

/** Point a batch that depended on this execution at the recovery outcome instead of a stale "running". */
async function markJob(record: LeaseRecord, state: string, detail: Record<string, unknown>): Promise<void> {
  if (!record.job_id || !/^[a-f0-9-]{36}$/.test(record.job_id)) return;
  const file = join(stateDirectory(), 'jobs', record.job_id, 'status.json');
  try {
    const status = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!['running', 'preparing', 'execution_unconfirmed'].includes(status.state)) return;
    await atomicJson(file, { ...status, state, execution_id: record.id, ...detail, resolved_at: new Date().toISOString() });
  } catch { /* job directory removed or unreadable: the execution archive still records the outcome */ }
}

/** State-only recovery. Never cancels/replays scripts or infers completion from MCP PID/age. */
export async function recoverExecution(executionId: string) {
  return withGate(async () => {
    const record = await readLease();
    if (!record) return { recovered: false, reason: 'no_execution' };
    if (record.id !== executionId) throw new Error('EXECUTION_ID_MISMATCH: Read current runtime status before recovery.');
    const proof = await executionRecoveryProof(record);
    if (!proof) throw new Error('EXECUTION_UNCONFIRMED: No verified completion, native compile-failure or Illustrator-restart evidence; lock retained. If the user explicitly decides to give up on this execution, use abandon_execution.');
    const outcomeKnown = !OUTCOME_UNKNOWN.has(proof);
    const archive = await archiveExecution(record, proof, { outcome_known: outcomeKnown });
    await fs.rm(join(stateDirectory(), 'execution.lock'), { recursive: true });
    if (!outcomeKnown) await markJob(record, 'abandoned_outcome_unknown', { resolution: proof });
    return {
      recovered: true, execution_id: record.id, proof, outcome_known: outcomeKnown, archive_path: archive,
      ...(outcomeKnown ? {} : { note: 'Illustrator restarted before the script finished. Whether it saved anything is unknown: inspect the target files before redoing the work.' }),
    };
  });
}

/**
 * User-authorized release of an execution whose outcome cannot be proven. The lock directory is
 * moved, never deleted, and the record says the native outcome is unknown. Never marks completion.
 */
export async function abandonExecution(executionId: string, reason: string) {
  return withGate(async () => {
    const record = await readLease();
    if (!record) return { abandoned: false, reason: 'no_execution' };
    if (record.id !== executionId) throw new Error('EXECUTION_ID_MISMATCH: Read current runtime status before abandoning.');
    if (record.phase === 'running' && processAlive(record.pid)) {
      throw new Error('EXECUTION_ACTIVE: The owning MCP process is still waiting on Illustrator. Wait for it to finish or time out.');
    }
    const directory = join(stateDirectory(), 'executions');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = join(directory, `abandoned-${record.id}`);
    await fs.rename(join(stateDirectory(), 'execution.lock'), archive);
    await atomicJson(join(archive, 'clearance.json'), {
      reason, cleared_at: new Date().toISOString(), previous_phase: record.phase,
      native_completion_confirmed: false, original_record_preserved: true,
    });
    await markJob(record, 'abandoned_outcome_unknown', { resolution: 'user_abandoned', resolution_reason: reason });
    return { abandoned: true, execution_id: record.id, outcome_known: false, archive_path: archive, job_id: record.job_id ?? null };
  });
}

/** Human-readable description of the current owner, for BUSY errors and status. */
export async function describeLease(record: LeaseRecord) {
  const started = Date.parse(record.started_at);
  return {
    execution_id: record.id, phase: record.phase, tool: record.tool ?? null, job_id: record.job_id ?? null,
    started_at: record.started_at, age_minutes: Number.isFinite(started) ? Math.round((Date.now() - started) / 60_000) : null,
    script_started: await readStartedMarker(record), params_summary: record.params_summary ?? null,
    error: record.error ?? null, recovery_proof: await executionRecoveryProof(record),
  };
}

export async function acquireLease(metadata: LeaseMetadata = {}): Promise<{
  record: LeaseRecord;
  update: (details: Pick<LeaseRecord, 'artifacts' | 'transport'>) => Promise<void>;
  finish: (confirmed: boolean, error?: string, failureKind?: string) => Promise<void>;
}> {
  const root = stateDirectory();
  const lock = join(root, 'execution.lock');
  const ownerPath = join(lock, 'owner.json');
  const id = randomUUID();
  const record: LeaseRecord = {
    id, pid: process.pid, started_at: new Date().toISOString(), phase: 'running', receipt: join(root, 'receipts', `${id}.json`), receipt_version: 1,
    tool: metadata.tool, job_id: process.env.ILLUSTRATOR_MCP_JOB_ID || undefined, params_summary: summarizeParams(metadata.params),
  };
  const illustrator = await illustratorProbe.current(metadata.appPath);
  if (illustrator) record.illustrator = illustrator;
  let busy: LeaseRecord | null = null;
  await withGate(async () => {
    await fs.mkdir(join(root, 'receipts'), { recursive: true, mode: 0o700 });
    const job = await readJobReservation();
    if (job && job.id !== process.env.ILLUSTRATOR_MCP_JOB_ID) throw new Error('ILLUSTRATOR_BUSY: A background card job owns the document; use get_batch_status.');
    const previous = await readLease();
    if (previous?.phase === 'uncertain' && await hasCompletionReceipt(previous)) {
      await archiveExecution(previous, 'late_native_completion_receipt', { outcome_known: true });
      await fs.rm(lock, { recursive: true });
      await markJob(previous, 'completed_after_timeout_unvalidated', { resolution: 'late_native_completion_receipt' });
    }
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      busy = await readLease().catch(() => null);
      return;
    }
    await atomicJson(ownerPath, record);
  });
  if (busy) {
    // Described outside the gate: the proof may consult the process table.
    const owner = await describeLease(busy).catch(() => null);
    throw new Error('ILLUSTRATOR_BUSY_OR_UNCONFIRMED: Another unified MCP execution owns Illustrator. Do not replay a potentially completed batch. '
      + (owner?.recovery_proof ? `Recovery proof "${owner.recovery_proof}" is available: call recover_execution. ` : 'Read get_runtime_status. ')
      + 'Owner: ' + JSON.stringify(owner));
  }
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
          record.phase = 'finished';
          if (error) await archiveExecution(record, receipt ? 'native_completion_receipt' : 'confirmed_terminal');
          await fs.rm(lock, { recursive: true });
          // Clean successes leave no evidence to keep; failures keep receipt and marker beside the archive.
          if (!error) await Promise.all([record.receipt, startedMarkerPath(record)].map((file) => fs.rm(file, { force: true })));
        } else {
          record.phase = 'uncertain';
          await atomicJson(ownerPath, record);
          await archiveExecution(record, 'execution_unconfirmed');
        }
      }, true);
    },
  };
}
