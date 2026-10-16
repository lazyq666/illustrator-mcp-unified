import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runTrustedScript } from '../../executor/trusted-script.js';
import { backgroundMode } from '../../executor/background-policy.js';
import { readLease, readJobReservation, stateDirectory, recoverExecution, executionRecoveryProof } from '../../executor/execution-lease.js';
import { executeJsx } from '../../executor/jsx-runner.js';
import { formatToolResult } from '../tool-executor.js';
import { executeCardScript } from '../../cards/native.js';
import { absolutePath, layerPath, bounds, backingSchema, imageSchema, batchShape, cardSchema } from '../../cards/schema.js';
import { startBatch, batchStatus } from '../../cards/jobs.js';

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
export function register(server: McpServer) {
  server.registerTool('get_runtime_status', {
    description: 'Read background policy and cross-process execution ownership without sending a script to Illustrator. An uncertain execution must not be replayed. No Computer Use.', inputSchema: {}, annotations: readOnly,
  }, async () => {
    const execution = await readLease();
    return formatToolResult({ version: '1.8.0-local.1', revision: '20261016.1', background: backgroundMode(), computer_use_fallback: false, state_directory: stateDirectory(), execution, recovery_proof: execution ? await executionRecoveryProof(execution) : null, batch: await readJobReservation() });
  });

  server.registerTool('recover_execution', {
    description: 'Recover an uncertain execution only after a valid native completion receipt or a recognized legacy native compile failure. Requires the exact execution_id from get_runtime_status. Archives the evidence, releases only that lock, and never sends a script, cancels, or retries Illustrator work. Refuses running or unproven timeout states.',
    inputSchema: { execution_id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ execution_id }) => formatToolResult(await recoverExecution(execution_id)));

  server.registerTool('run_script', {
    description: 'Run trusted ExtendScript directly in the shared background executor. Supply script or an existing UTF-8 .jsx script_path, not both. Use ES3-compatible syntax (no E4X or preprocessor directives); quote reserved property names. Syntax is checked before native execution. Return plain data with return; params contains JSON input. JSON compatibility is provided. UI, clipboard and dynamic script requests are rejected in background mode. This is not a security sandbox. Use batch_cards for long jobs; never replay an unconfirmed timeout.',
    inputSchema: { script: z.string().optional(), script_path: absolutePath.optional(), params: z.record(z.string(), z.unknown()).optional(), document_path: absolutePath.optional(), timeout_seconds: z.number().int().min(1).max(90).default(60) }, annotations: write,
  }, async options => formatToolResult(await runTrustedScript(options)));

  server.registerTool('duplicate_layer_tree', {
    description: 'Copy a complete layer hierarchy into a new parent layer in the specified open document, preserving item order, clipping groups and child layer state. Native document coordinates in points. Refuses a duplicate target parent.',
    inputSchema: { document_path: absolutePath, source_layer_paths: z.array(layerPath).min(1), target_parent_name: z.string().min(1), offset_x: z.number().default(0), offset_y: z.number().default(0) }, annotations: write,
  }, async params => formatToolResult(await executeCardScript(`var doc=cardDocument(params.document_path);\nvar sources=[];for(var i=0;i<params.source_layer_paths.length;i++)sources.push(cardLayer(doc,params.source_layer_paths[i]));\nfor(i=0;i<doc.layers.length;i++)if(doc.layers[i].name===params.target_parent_name)throw new Error("PARENT_ALREADY_EXISTS");\nvar parent=doc.layers.add();parent.name=params.target_parent_name;\nfor(i=sources.length-1;i>=0;i--)cardCopyLayer(sources[i],parent,params.offset_x,params.offset_y);\nwriteResultFile(RESULT_PATH,{parent:parent.name,sublayers:parent.layers.length});`, params)));

  server.registerTool('import_pdf_as_paths', {
    description: 'Open a prepared outlined vector PDF and copy actual paths into an open target document, retaining compound paths and holes. No clipboard, linked PDF or raster substitute. Rejects source PDFs already open by the user. Bounds use native document points.',
    inputSchema: { document_path: absolutePath, pdf_path: absolutePath, page: z.number().int().min(1).default(1), target_layer_path: layerPath, group_name: z.string().min(1), fit_bounds: bounds.optional() }, annotations: write,
  }, async params => formatToolResult(await executeCardScript('var doc=cardDocument(params.document_path),layer=cardLayer(doc,params.target_layer_path);\nvar result=cardUnlock(layer,function(){return cardImportPDF(doc,params,layer);});\nwriteResultFile(RESULT_PATH,{name:result.group.name,bounds:cardBounds(result.group),source:result.source,imported:result.imported});',params)));

  server.registerTool('replace_masked_image', {
    description: 'Replace a named raster inside its existing clipping group while preserving the image rectangle and stacking. Explicitly choose linked or embedded. Rejects rotated/sheared/mirrored images and aspect mismatches before replacement; use a template-specific script for them.',
    inputSchema: { document_path: absolutePath, root_layer_path: layerPath, ...imageSchema.shape }, annotations: write,
  }, async params => formatToolResult(await executeCardScript('var doc=cardDocument(params.document_path);writeResultFile(RESULT_PATH,cardReplaceImage(doc,cardLayer(doc,params.root_layer_path),params));',params)));

  server.registerTool('build_name_backing', {
    description: 'Duplicate an editable name face behind itself, apply a template gradient or explicit RGB stops, and attach a live Offset Path effect. Preserves face holes and separate face/backing objects. Bounds and thickness are native document points; visual review is still required.',
    inputSchema: { document_path: absolutePath, root_layer_path: layerPath, face_name: z.string().min(1), style: backingSchema }, annotations: write,
  }, async params => formatToolResult(await executeCardScript('var doc=cardDocument(params.document_path);var style=params.style;style.face_name=params.face_name;writeResultFile(RESULT_PATH,cardBacking(doc,cardLayer(doc,params.root_layer_path),style));',params)));

  server.registerTool('batch_cards', {
    description: 'Start a detached background card job from a saved normalized AI template and confirmed content. Creates a new output, copies linked images into Links, clones complete layers, replaces named text/images, imports optional PDF name paths and builds backing. Saves each card, removes template copies, reopens for structural checks and exports previews. No image downscaling or UI fallback. Return is job acceptance, not completion; poll get_batch_status and visually inspect previews. One simple card template per source document; verify the template first.',
    inputSchema: batchShape, annotations: write,
  }, async params => formatToolResult(await startBatch(params)));

  server.registerTool('get_batch_status', {
    description: 'Read a background card job and its per-card progress, prepared plan, log and preview paths. ready_for_visual_review means structural checks passed, not visual approval. Never automatically restart failed or unconfirmed jobs.',
    inputSchema: { job_id: z.string().uuid() }, annotations: readOnly,
  }, async ({ job_id }) => formatToolResult(await batchStatus(job_id)));

  server.registerTool('validate_cards', {
    description: 'Independently reopen a saved, closed AI output, check card/layer/text/image/path correspondence, and optionally export artboard previews without the clipboard. This tool does not perform visual judgment. Use the prepared plan from get_batch_status so packaged link paths match.',
    inputSchema: { output_path: absolutePath, cards: z.array(cardSchema).min(1), expected_sublayers: z.array(z.string()).optional(), preview_directory: absolutePath.optional() }, annotations: write,
  }, async params => formatToolResult(await executeCardScript('writeResultFile(RESULT_PATH,cardValidate(params));',params,90_000)));
}
