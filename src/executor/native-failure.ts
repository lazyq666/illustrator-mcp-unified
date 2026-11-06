import type { ExecFileException } from 'node:child_process';

/** Only the observed, terminal Apple-event compile diagnostics are recognized:
 * Error 8 (syntax error) and Error 9 (reserved word). The message text may be localized or mangled.
 * Do not infer completion from generic (5001), process exit, age or a line of user code.
 */
export function isConfirmedCompileFailure(message: string): boolean {
  return /^(?:Error: )?[^\r\n]+:\d+:\d+: execution error: Adobe Illustrator got an error: Error (?:8|9):[^\r\n]*\r?\n?\r?Line: \d+\r?\n?\r?-> [\s\S]*\(5001\)\s*$/.test(message);
}

export function nativeFailureKind(error: ExecFileException, stderr: string): string {
  if (error.code === 'ETIMEDOUT' || error.killed || error.signal) return 'execution_unconfirmed';
  if (error.code === 'ENOENT' || error.code === 'EACCES') return 'transport_not_started';
  if (isConfirmedCompileFailure(stderr)) return 'native_compile_error';
  if (/ILLUSTRATOR_NOT_RUNNING|not authorized to send Apple events|\(-1743\)/i.test(stderr)) return 'automation_not_started';
  return 'execution_unconfirmed';
}
