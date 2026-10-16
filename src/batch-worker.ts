import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory, readLease, releaseJob } from './executor/execution-lease.js';
import { ensureTmpDir, cleanupTmpDirSync } from './executor/file-transport.js';
import { atomicJSON, prepareBatch } from './cards/jobs.js';
import { executeCardScript } from './cards/native.js';

const id = process.argv[2];
if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job id');
const directory = join(stateDirectory(), 'jobs', id);
const started = new Date().toISOString();
await ensureTmpDir();
try {
  await atomicJSON(join(directory, 'status.json'), { id, state: 'preparing', started_at: started, pid: process.pid });
  const input = JSON.parse(await fs.readFile(join(directory, 'request.json'), 'utf8'));
  const plan = await prepareBatch(input, directory);
  await atomicJSON(join(directory, 'status.json'), { id, state: 'running', started_at: started, pid: process.pid });
  const generated = await executeCardScript('writeResultFile(RESULT_PATH, cardBatch(params));', { ...plan, progress_path: join(directory, 'progress.json') }, Math.min(1_800_000, 120_000 + plan.cards.length * 30_000));
  const previews = join(directory, 'previews'); await fs.mkdir(previews);
  const validation = await executeCardScript('writeResultFile(RESULT_PATH, cardValidate(params));', { ...plan, preview_directory: previews }, Math.min(600_000, 60_000 + plan.cards.length * 10_000));
  await atomicJSON(join(directory, 'status.json'), { id, state: validation.structural_passed ? 'ready_for_visual_review' : 'validation_failed', started_at: started, finished_at: new Date().toISOString(), generated, validation });
} catch (error) {
  const lease = await readLease().catch(() => ({ phase: 'uncertain' }));
  await atomicJSON(join(directory, 'status.json'), { id, state: lease?.phase === 'uncertain' ? 'execution_unconfirmed' : 'failed', started_at: started, finished_at: new Date().toISOString(), error: String(error) });
  process.exitCode = 1;
} finally { cleanupTmpDirSync(); await releaseJob(id); }
