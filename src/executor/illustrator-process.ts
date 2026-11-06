import { execFile } from 'node:child_process';

/** Identity of one Illustrator process lifetime. A restart changes pid or start time. */
export interface IllustratorIdentity { pid: number; started: string; executable: string }

const MAIN_EXECUTABLE = /\/Adobe Illustrator\.app\/Contents\/MacOS\/Adobe Illustrator$/;

/** Parse `ps -axo pid=,lstart=,comm=` lines and return the main Illustrator process. */
export function parseIllustratorProcess(output: string, appPath?: string): IllustratorIdentity | null {
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!match || !MAIN_EXECUTABLE.test(match[3])) continue;
    if (appPath && !match[3].startsWith(appPath.replace(/\/$/, '') + '/')) continue;
    return { pid: Number(match[1]), started: match[2].replace(/\s+/g, ' '), executable: match[3] };
  }
  return null;
}

function listProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,lstart=,comm='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

/**
 * Returns the running Illustrator identity, null when Illustrator is not running,
 * or undefined when the platform or the process table cannot tell (or ILLUSTRATOR_MCP_PROCESS_PROBE=0).
 * Replaceable for tests; never sends anything to Illustrator.
 */
export const illustratorProbe = {
  async current(appPath = process.env.ILLUSTRATOR_MCP_APP_PATH): Promise<IllustratorIdentity | null | undefined> {
    if (process.platform !== 'darwin' || process.env.ILLUSTRATOR_MCP_PROCESS_PROBE === '0') return undefined;
    try { return parseIllustratorProcess(await listProcesses(), appPath); }
    catch { return undefined; }
  },
};

export function sameIllustrator(a: IllustratorIdentity, b: IllustratorIdentity): boolean {
  return a.pid === b.pid && a.started === b.started;
}
