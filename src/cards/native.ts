import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeJsx } from '../executor/jsx-runner.js';

const directory = dirname(fileURLToPath(import.meta.url));
const esm = resolve(directory, '../jsx/helpers/cards.jsx');
const helperPath = existsSync(esm) ? esm : resolve(directory, 'jsx/helpers/cards.jsx');
let helpers: string | undefined;
export function cardScript(body: string): string {
  helpers ??= readFileSync(helperPath, 'utf8');
  return `${helpers}\nvar params = readParamsFile(PARAMS_PATH);\n${body}`;
}

export function executeCardScript(body: string, params: unknown, timeout = 60_000) {
  return executeJsx(cardScript(body), params, { timeout, activate: false });
}
