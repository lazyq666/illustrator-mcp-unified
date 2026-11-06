import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLease, recoverExecution, readLease, executionRecoveryProof, abandonExecution, describeLease, releaseStaleJob, reserveJob, describeJobReservation } from '../../src/executor/execution-lease.js';
import { illustratorProbe, parseIllustratorProcess } from '../../src/executor/illustrator-process.js';
import { runInToolContext, currentTool } from '../../src/executor/tool-context.js';
import { effectiveJobState } from '../../src/cards/jobs.js';

const APP = '/Applications/Adobe Illustrator 2026/Adobe Illustrator.app';
const first = { pid: 100, started: 'Thu Oct 30 15:40:00 2026', executable: `${APP}/Contents/MacOS/Adobe Illustrator` };
let root: string;
let probe: typeof illustratorProbe.current;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'abandon-test-'));
  vi.stubEnv('ILLUSTRATOR_MCP_STATE_DIR', root); vi.stubEnv('ILLUSTRATOR_MCP_KEEP_AWAKE', '0');
  probe = illustratorProbe.current;
});
afterEach(async () => { illustratorProbe.current = probe; vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

async function uncertainLease(running: typeof first | null | undefined) {
  illustratorProbe.current = async () => first;
  const lease = await acquireLease({ tool: 'batch_cards', params: { output_path: '/x/out.ai', script: 'x'.repeat(5000) } });
  await lease.finish(false, 'AppleEvent timed out. (-1712)', 'execution_unconfirmed');
  illustratorProbe.current = async () => running;
  return lease;
}

it('parses the main Illustrator process and ignores its helpers', () => {
  const ps = [
    `48851 Tue Nov  3 16:24:16 2026     ${APP}/Contents/MacOS/AIMonitor.app/Contents/MacOS/AIMonitor`,
    `48649 Tue Nov  3 16:24:12 2026     ${APP}/Contents/MacOS/Adobe Illustrator`,
  ].join('\n');
  expect(parseIllustratorProcess(ps)).toEqual({ pid: 48649, started: 'Tue Nov 3 16:24:12 2026', executable: `${APP}/Contents/MacOS/Adobe Illustrator` });
  expect(parseIllustratorProcess(ps, '/Applications/Adobe Illustrator 2025/Adobe Illustrator.app')).toBeNull();
  expect(parseIllustratorProcess('')).toBeNull();
});

it('records tool, params summary and Illustrator identity; BUSY errors name the owner', async () => {
  const lease = await uncertainLease(first);
  const record = (await readLease())!;
  expect(record.tool).toBe('batch_cards');
  expect(record.illustrator).toEqual(first);
  expect(record.params_summary).toContain('<5000 chars>');
  expect(record.params_summary!.length).toBeLessThanOrEqual(601);
  await expect(acquireLease()).rejects.toThrow(/BUSY_OR_UNCONFIRMED.*"tool":"batch_cards"/);
  expect(await executionRecoveryProof(record)).toBeNull();
  await expect(recoverExecution(lease.record.id)).rejects.toThrow('abandon_execution');
});

it('proves a stopped script when Illustrator exited or restarted, and reports the outcome as unknown', async () => {
  for (const running of [null, { ...first, pid: 200 }, { ...first, started: 'Mon Nov  3 16:24:12 2026' }]) {
    const lease = await uncertainLease(running);
    await expect(acquireLease()).rejects.toThrow('recover_execution');
    const result = await recoverExecution(lease.record.id);
    expect(result).toMatchObject({ recovered: true, proof: 'illustrator_restarted', outcome_known: false });
    expect(JSON.parse(await fs.readFile(result.archive_path!, 'utf8')).outcome_known).toBe(false);
    expect(await readLease()).toBeNull();
  }
});

it('never treats an unknown process table as a restart', async () => {
  const lease = await uncertainLease(undefined);
  expect(await executionRecoveryProof((await readLease())!)).toBeNull();
  await lease.finish(true);
});

it('abandons only the named, non-active execution, archiving instead of deleting and marking its batch', async () => {
  const job = '11111111-2222-4333-8444-555555555555';
  await fs.mkdir(join(root, 'jobs', job), { recursive: true });
  await fs.writeFile(join(root, 'jobs', job, 'status.json'), JSON.stringify({ id: job, state: 'execution_unconfirmed' }));
  vi.stubEnv('ILLUSTRATOR_MCP_JOB_ID', job);
  const lease = await uncertainLease(first);
  await expect(abandonExecution('other-id', 'user asked')).rejects.toThrow('ID_MISMATCH');
  const result = await abandonExecution(lease.record.id, 'user asked to clear stale occupancy');
  expect(result).toMatchObject({ abandoned: true, outcome_known: false, job_id: job });
  expect(await readLease()).toBeNull();
  expect(JSON.parse(await fs.readFile(join(result.archive_path!, 'owner.json'), 'utf8')).id).toBe(lease.record.id);
  expect(JSON.parse(await fs.readFile(join(result.archive_path!, 'clearance.json'), 'utf8'))).toMatchObject({ native_completion_confirmed: false, previous_phase: 'uncertain' });
  expect(JSON.parse(await fs.readFile(join(root, 'jobs', job, 'status.json'), 'utf8'))).toMatchObject({ state: 'abandoned_outcome_unknown', execution_id: lease.record.id });
  expect(await abandonExecution(lease.record.id, 'again')).toEqual({ abandoned: false, reason: 'no_execution' });
});

it('refuses to abandon an execution whose MCP process is still waiting', async () => {
  const lease = await acquireLease();
  await expect(abandonExecution(lease.record.id, 'user asked')).rejects.toThrow('EXECUTION_ACTIVE');
  await lease.finish(true);
});

it('archives result errors as finished rather than running', async () => {
  const lease = await acquireLease();
  await fs.writeFile(lease.record.receipt, JSON.stringify({ native_completed: true, execution_id: lease.record.id }));
  await lease.finish(true, 'controlled', 'result_error');
  const record = JSON.parse(await fs.readFile(join(root, 'executions', `${lease.record.id}.json`), 'utf8'));
  expect(record.phase).toBe('finished');
});

it('describes the started marker written by the JSX preamble', async () => {
  const lease = await acquireLease();
  expect((await describeLease(lease.record)).script_started).toBeNull();
  await fs.writeFile(lease.record.receipt.replace(/\.json$/, '.started.json'), JSON.stringify({ documents: 1, activeDocument: '/x/a.ai' }));
  expect((await describeLease(lease.record)).script_started).toMatchObject({ documents: 1, activeDocument: '/x/a.ai' });
  await lease.finish(true);
});

it('releases a batch reservation only after its worker is gone', async () => {
  const job = '21111111-2222-4333-8444-555555555555';
  await fs.mkdir(join(root, 'jobs', job), { recursive: true });
  await reserveJob(job);
  await fs.writeFile(join(root, 'jobs', job, 'status.json'), JSON.stringify({ id: job, state: 'running', pid: process.pid }));
  expect(await describeJobReservation()).toMatchObject({ id: job, worker_alive: true });
  await expect(releaseStaleJob(job)).rejects.toThrow('WORKER_ALIVE');
  await fs.writeFile(join(root, 'jobs', job, 'status.json'), JSON.stringify({ id: job, state: 'running', pid: 2 ** 22 + 12345 }));
  await expect(releaseStaleJob('31111111-2222-4333-8444-555555555555')).rejects.toThrow('BATCH_ID_MISMATCH');
  expect(await releaseStaleJob(job)).toMatchObject({ released: true, previous_state: 'running' });
  expect(JSON.parse(await fs.readFile(join(root, 'jobs', job, 'status.json'), 'utf8')).state).toBe('abandoned_outcome_unknown');
  expect(await describeJobReservation()).toBeNull();
});

it('keeps the authoritative worker state over a stale progress checkpoint', () => {
  expect(effectiveJobState({ state: 'execution_unconfirmed' }, { state: 'running' })).toBe('execution_unconfirmed');
  expect(effectiveJobState({ state: 'running' }, { state: 'failed' })).toBe('failing');
  expect(effectiveJobState({ state: 'running' }, null)).toBe('running');
});

it('carries the tool name through async handlers', async () => {
  expect(currentTool()).toBeUndefined();
  await runInToolContext('run_script', async () => { await Promise.resolve(); expect(currentTool()).toBe('run_script'); });
});

it('removes the receipt and started marker after a clean success but keeps them after a failure', async () => {
  const ok = await acquireLease();
  const marker = ok.record.receipt.replace(/\.json$/, '.started.json');
  await fs.writeFile(ok.record.receipt, '{}'); await fs.writeFile(marker, '{}');
  await ok.finish(true);
  await expect(fs.stat(ok.record.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const failed = await acquireLease();
  await fs.writeFile(failed.record.receipt, JSON.stringify({ native_completed: true, execution_id: failed.record.id }));
  await failed.finish(true, 'boom', 'result_error');
  await expect(fs.stat(failed.record.receipt)).resolves.toBeTruthy();
});

it('flags a server whose entry file was rebuilt after it started', async () => {
  const { serverStatus } = await import('../../src/tools/utility/background-cards.js');
  const entry = join(root, 'index.js');
  await fs.writeFile(entry, '');
  expect(await serverStatus(entry, new Date(Date.now() + 60_000))).toMatchObject({ restart_required: false });
  expect(await serverStatus(entry, new Date(Date.now() - 60_000))).toMatchObject({ restart_required: true, note: expect.stringContaining('new client session') });
  expect(await serverStatus(join(root, 'missing.js'))).toMatchObject({ restart_required: null });
});
