/** This is an execution policy for trusted scripts, not a JavaScript sandbox. */
export function backgroundMode(): boolean {
  return process.env.ILLUSTRATOR_MCP_BACKGROUND !== '0';
}

export function effectiveActivation(requested = false): boolean {
  return !backgroundMode() && requested;
}

export function assertBackgroundScript(script: string): void {
  if (!backgroundMode()) return;
  // Conservatively inspect source, including strings: nested/evaluated scripts must
  // not silently regain UI access. Known internal JSON parsing lives in helpers.
  const forbidden = [
    /\bexecuteMenuCommand\s*\(/, /\bapp\s*\.\s*(activate|copy|cut|paste|pasteInPlace|pasteInFront|pasteInBack)\s*\(/,
    /\b(alert|confirm|prompt|Window|BridgeTalk)\s*\(/,
    /\.(openDlg|saveDlg|openDialog|saveDialog|selectDialog|execute)\s*\(/,
    /\$\s*\.\s*(evalFile|eval)\s*\(/, /\b(system|eval|Function)\s*\(/,
    /\bDISPLAYALERTS\b/, /\buserInteractionLevel\s*=/,
  ];
  if (forbidden.some(pattern => pattern.test(script))) {
    throw new Error('BACKGROUND_UNSUPPORTED: This script requests UI, clipboard, dynamic code or interaction changes. Use direct Illustrator object operations. No Computer Use fallback was invoked.');
  }
}
