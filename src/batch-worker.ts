import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory, readLease, releaseJob } from './executor/execution-lease.js';
import { ensureTmpDir, cleanupTmpDirSync } from './executor/file-transport.js';
import { atomicJSON, cardChunks, prepareBatch } from './cards/jobs.js';
import { executeCardScript } from './cards/native.js';

function illustratorPath(path: string): string {
  const userRoot = process.env.HOME;
  if (process.platform === 'darwin' && userRoot && (path === userRoot || path.startsWith(userRoot + '/'))) return '~' + path.slice(userRoot.length);
  return path;
}

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
  // Each chunk is its own native run that reopens, saves and closes the output.
  let generated: { completed: string[]; template_layer_names?: string[]; original_artboards?: number } = { completed: [] };
  for (const { start, end } of cardChunks(plan.cards.length, plan.chunk_size)) {
    const chunk = { start, end, completed_before: generated.completed, template_layer_names: generated.template_layer_names, original_artboards: generated.original_artboards };
    generated = <typeof generated> await executeCardScript('writeResultFile(RESULT_PATH, cardBatch(params));', { ...plan, chunk, progress_path: illustratorPath(join(directory, 'progress.json')) }, Math.min(1_800_000, 180_000 + (end - start) * 60_000));
  }
  const previews = join(directory, 'previews'); await fs.mkdir(previews);
  const validation = await executeCardScript('writeResultFile(RESULT_PATH, cardValidate(params));', { ...plan, preview_directory: illustratorPath(previews) }, Math.min(600_000, 60_000 + plan.cards.length * 10_000));
  await atomicJSON(join(directory, 'status.json'), { id, state: validation.structural_passed ? 'ready_for_visual_review' : 'validation_failed', started_at: started, finished_at: new Date().toISOString(), generated, validation });
} catch (error) {
  const lease = await readLease().catch(() => ({ phase: 'uncertain' }));
  await atomicJSON(join(directory, 'status.json'), { id, state: lease?.phase === 'uncertain' ? 'execution_unconfirmed' : 'failed', started_at: started, finished_at: new Date().toISOString(), error: String(error) });
  process.exitCode = 1;
} finally { cleanupTmpDirSync(); await releaseJob(id); }
