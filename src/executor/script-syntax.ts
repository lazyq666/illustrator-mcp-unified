import { parse } from 'acorn';

/** Parse, never execute. This is an ES3 subset, not a complete Adobe runtime emulator.
 * E4X and preprocessor directives are intentionally outside the supported profile.
 * allowReserved:'never' matters: ES3 otherwise accepts reserved property names.
 */
export function assertExtendScriptSyntax(source: string, label = '<generated JSX>'): void {
  try {
    parse(source, { ecmaVersion: 3, allowReserved: 'never', allowReturnOutsideFunction: true, locations: true });
  } catch (error) {
    const detail = error as Error & { loc?: { line: number; column: number } };
    const location = detail.loc ? `:${detail.loc.line}:${detail.loc.column + 1}` : '';
    throw new Error(`SCRIPT_SYNTAX_ERROR: ${label}${location}: ${detail.message}. Use ES3-compatible ExtendScript; quote reserved property names (for example "char"). No script was sent to Illustrator.`, { cause: error });
  }
}
