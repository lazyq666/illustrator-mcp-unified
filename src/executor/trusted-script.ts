import { assertExtendScriptSyntax } from './script-syntax.js';
import { readFile } from 'node:fs/promises';
import { assertBackgroundScript } from './background-policy.js';
import { executeJsx, USER_SOURCE_MARKER } from './jsx-runner.js';

export async function runTrustedScript(options: {
  script?: string; script_path?: string; params?: Record<string, unknown>;
  document_path?: string; timeout_seconds?: number;
}) {
  if (Boolean(options.script) === Boolean(options.script_path)) throw new Error('Supply exactly one of script or script_path');
  const source = options.script ?? await readFile(options.script_path!, 'utf8');
  assertBackgroundScript(source);
  assertExtendScriptSyntax(source, options.script_path ?? '<inline script>');
  const body = `var params = readParamsFile(PARAMS_PATH);
var expected = params.__document_path;
var previousDocument = app.documents.length ? app.activeDocument : null;
if (expected) {
 var matched = false;
 for(var di=0;di<app.documents.length;di++){try{if(app.documents[di].fullName.fsName === new File(expected).fsName){app.activeDocument=app.documents[di];matched=true;break;}}catch(ignore){}}
 if(!matched)throw new Error("DOCUMENT_NOT_OPEN: "+expected);
}
try {
 var answer=(function(){
${USER_SOURCE_MARKER}
${source}
 })();
 writeResultFile(RESULT_PATH, { result: answer === undefined ? null : answer });
} finally {
 if(expected && previousDocument)try{app.activeDocument=previousDocument;}catch(closed){}
}`;
  return executeJsx(body, { ...options.params, __document_path: options.document_path }, { timeout: (options.timeout_seconds ?? 60) * 1000 });
}
