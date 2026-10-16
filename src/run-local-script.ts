#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ensureTmpDir, cleanupTmpDirSync } from './executor/file-transport.js';
import { runTrustedScript } from './executor/trusted-script.js';

const { values } = parseArgs({ options: {
  script: { type:'string' }, probe: { type:'boolean' }, timeout:{type:'string',default:'60'}, app:{type:'string'}, document:{type:'string'},
} });
const timeout=Number(values.timeout);
if (!Number.isInteger(timeout) || timeout<1 || timeout>90) throw new Error('timeout must be 1–90 seconds; use batch_cards for longer work');
if(Boolean(values.script)===Boolean(values.probe))throw new Error('Supply --script or --probe');
if(values.app)process.env.ILLUSTRATOR_MCP_APP_PATH=values.app;
await ensureTmpDir();
try {
  const result=await runTrustedScript(values.probe
    ? {script:'return {version:app.version,documents:app.documents.length};',timeout_seconds:timeout}
    : {script_path:values.script,document_path:values.document,timeout_seconds:timeout});
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) { console.error(String(error));process.exitCode=1; }
finally {cleanupTmpDirSync();}
