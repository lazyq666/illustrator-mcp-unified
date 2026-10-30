import * as fs from 'node:fs/promises';
import { openSync, closeSync, constants } from 'node:fs';
import { dirname, basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stateDirectory, readLease, reserveJob, releaseJob } from '../executor/execution-lease.js';
import { batchSchema, type BatchPlan } from './schema.js';

export async function atomicJSON(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, path);
}

/** Consecutive [start, end) card ranges, one native run each. */
export function cardChunks(total: number, size: number): Array<{ start: number; end: number }> {
  const chunks = [];
  for (let start = 0; start < total; start += size) chunks.push({ start, end: Math.min(start + size, total) });
  return chunks;
}

export async function prepareBatch(input: BatchPlan, directory: string): Promise<BatchPlan> {
  const plan = batchSchema.parse(input);
  for (const file of [plan.template_path, ...plan.cards.flatMap(c => [...c.images.map(i => i.file_path), ...(c.name_art ? [c.name_art.pdf_path] : [])])]) {
    if (!(await fs.stat(file)).isFile()) throw new Error(`Not a file: ${file}`);
  }
  // Read-only validation finishes before output creation. No implicit overwrite.
  await fs.mkdir(dirname(plan.output_path), { recursive: true });
  await fs.copyFile(plan.template_path, plan.output_path, constants.COPYFILE_EXCL);
  const linkedCopies = new Map<string, string>();
  for (const card of plan.cards) {
    for (const image of card.images) {
      if (image.embed) continue;
      let copy = linkedCopies.get(image.file_path);
      if (!copy) {
        const links = join(dirname(plan.output_path), 'Links');
        await fs.mkdir(links, { recursive: true });
        const hash = createHash('sha256').update(await fs.readFile(image.file_path)).digest('hex').slice(0, 12);
        copy = join(links, `${basename(plan.output_path, '.ai')}_${hash}${extname(image.file_path).toLowerCase()}`);
        try { await fs.copyFile(image.file_path, copy, constants.COPYFILE_EXCL); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          const existing = createHash('sha256').update(await fs.readFile(copy)).digest('hex').slice(0, 12);
          if (existing !== hash) throw new Error(`Link destination collision: ${copy}`);
        }
        linkedCopies.set(image.file_path, copy);
      }
      image.file_path = copy;
    }
  }
  await atomicJSON(join(directory, 'prepared-plan.json'), plan);
  return plan;
}

export async function startBatch(input: unknown) {
  const plan = batchSchema.parse(input);
  const lease = await readLease();
  if (lease) throw new Error('ILLUSTRATOR_BUSY_OR_UNCONFIRMED: Read get_runtime_status before starting another batch.');
  const id = randomUUID();
  const directory = join(stateDirectory(), 'jobs', id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await reserveJob(id);
  try {
  await atomicJSON(join(directory, 'request.json'), plan);
  await atomicJSON(join(directory, 'status.json'), { id, state: 'queued', created_at: new Date().toISOString() });
  const log = openSync(join(directory, 'worker.log'), 'a', 0o600);
  const worker = resolve(dirname(fileURLToPath(import.meta.url)), '../batch-worker.js');
  const child = spawn(process.execPath, [worker, id], { detached: true, stdio: ['ignore', log, log], env: {...process.env,ILLUSTRATOR_MCP_JOB_ID:id} });
  closeSync(log);
  await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.unref();
  return { job_id: id, state: 'queued', output_path: plan.output_path, status_tool: 'get_batch_status', note: 'Runs in a detached local worker. Illustrator must stay open and the Mac awake. No UI fallback.' };
  } catch(error) {await releaseJob(id);throw error;}
}

export async function batchStatus(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job id');
  const directory = join(stateDirectory(), 'jobs', id);
  const status = JSON.parse(await fs.readFile(join(directory, 'status.json'), 'utf8'));
  let progress = null;
  try { progress = JSON.parse(await fs.readFile(join(directory, 'progress.json'), 'utf8')); } catch { /* native writer may be between writes */ }
  return { ...status, progress, prepared_plan_path: join(directory, 'prepared-plan.json'), log_path: join(directory, 'worker.log') };
}
