import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeJsx } from '../../executor/jsx-runner.js';
import { formatToolResult } from '../tool-executor.js';
import { WRITE_ANNOTATIONS } from './shared.js';
import { SVG_IMPORT_JSX } from './svg-import-core.js';

/**
 * assemble_svgs — 複数 SVG を 1 回のネイティブ実行で、各アートボードへ正確に配置する。
 *
 * 2026-11-03 の火花アイコン制作で run_script により手書きした手順
 * （トップレベル複製・アクティブ文書切替・画幅矩形基準の配置・クリップ・保存・再オープン検証）
 * をツール化したもの。座標はすべて Illustrator ネイティブ座標（pt, Y 上向き）。
 */
export const jsxCode = `
var params = readParamsFile(PARAMS_PATH);
var doc = null;
if (params.document_path) {
  var wanted = new File(params.document_path).fsName;
  for (var di = 0; di < app.documents.length; di++) {
    try { if (app.documents[di].fullName.fsName === wanted) { doc = app.documents[di]; break; } } catch (unsaved) {}
  }
  if (!doc) throw new Error("DOCUMENT_NOT_OPEN: " + params.document_path);
  app.activeDocument = doc;
} else {
  if (app.documents.length === 0) throw new Error("No document is open. Please open a file in Illustrator.");
  doc = app.activeDocument;
}
var savedPath = null;
try { savedPath = doc.fullName.fsName; } catch (neverSaved) {}
if ((params.save !== false || params.reopen_verify === true) && !savedPath) throw new Error("Save the target document once (save_document) before assemble_svgs with save or reopen_verify.");

var completed = [];
for (var i = 0; i < params.items.length; i++) {
  var item = params.items[i];
  var label = item.name || item.svg_path;
  try {
    var abIndex;
    if (typeof item.artboard_index === "number") {
      abIndex = item.artboard_index;
      if (abIndex < 0 || abIndex >= doc.artboards.length) throw new Error("artboard_index out of range: " + abIndex);
    } else {
      var created = doc.artboards.add(item.artboard_rect);
      if (item.artboard_name) created.name = item.artboard_name;
      abIndex = doc.artboards.length - 1;
    }
    var rect = doc.artboards[abIndex].artboardRect;
    var layer = resolveTargetLayer(doc, item.layer_name);
    var imported = mcpSvgImport(doc, layer, item.svg_path, { anchor: "source_artboard", requirePureVector: params.require_pure_vector !== false });
    var placed = mcpSvgPlace(imported, layer, { group: true, clip: item.clip !== false, name: item.name, targetRect: rect, fit: item.fit === true, padding: item.padding, point: null });
    var exported = null;
    if (item.png_path) {
      doc.artboards.setActiveArtboardIndex(abIndex);
      var png = new ExportOptionsPNG24();
      png.artBoardClipping = true; png.antiAliasing = true; png.transparency = true;
      doc.exportFile(new File(item.png_path), ExportType.PNG24, png);
      // A white-background twin makes soft transparent glows easy to judge by eye.
      var whitePath = item.png_path.replace(/\\.png$/i, "") + ".white.png";
      png.transparency = false;
      doc.exportFile(new File(whitePath), ExportType.PNG24, png);
      exported = { transparent: item.png_path, white: whitePath };
    }
    completed.push({
      name: label, artboardIndex: abIndex, artboardRect: rect, layer: layer.name,
      source: imported.source, pathsAdded: imported.pathsAdded, pathsMatchSource: imported.pathsAdded === imported.source.topLevelPaths,
      clipped: placed.clipped, scalePercent: placed.scalePercent, translate: placed.translate, frameBounds: placed.frameBounds,
      exported: exported
    });
  } catch (itemError) {
    var done = [];
    for (var c = 0; c < completed.length; c++) done.push(completed[c].name);
    throw new Error("assemble_svgs stopped at item " + i + " (" + label + "): " + (itemError.message || itemError) + ". Already placed, unsaved: [" + done.join(", ") + "]");
  }
}

var mismatched = [];
for (var m = 0; m < completed.length; m++) if (!completed[m].pathsMatchSource) mismatched.push(completed[m].name);
if (params.save !== false) doc.save();

var verification = null;
if (params.reopen_verify === true) {
  var file = new File(savedPath);
  doc.close(SaveOptions.DONOTSAVECHANGES);
  doc = app.open(file);
  verification = {
    reopened: true, artboards: doc.artboards.length, layers: doc.layers.length, paths: doc.pathItems.length,
    compoundPaths: doc.compoundPathItems.length, groups: doc.groupItems.length,
    rasterItems: doc.rasterItems.length, placedItems: doc.placedItems.length, pluginItems: doc.pluginItems.length, meshItems: doc.meshItems.length
  };
}
writeResultFile(RESULT_PATH, {
  success: true, document: savedPath, saved: params.save !== false, placed: completed.length,
  pathCountMismatches: mismatched, items: completed, verification: verification
});
${SVG_IMPORT_JSX}`;

const rectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .describe('Native artboard rectangle [left, top, right, bottom] in points (Y up, top > bottom)')
  .refine(([l, t, r, b]) => r > l && t > b, 'Expected right > left and top > bottom');

const itemSchema = z.object({
  svg_path: z.string().regex(/\.svgz?$/i, 'Expected an .svg or .svgz file').describe('Absolute path to the SVG'),
  name: z.string().optional().describe('Name of the placed group'),
  layer_name: z.string().optional().describe('Target layer; created if missing. Defaults to the active layer.'),
  artboard_index: z.number().int().min(0).optional().describe('Existing artboard to place on (0-based)'),
  artboard_rect: rectSchema.optional().describe('Create a new artboard with this native rectangle and place on it'),
  artboard_name: z.string().optional().describe('Name for a created artboard'),
  clip: z.boolean().optional().default(true).describe('Crop to the SVG artboard with a clipping rectangle named 画幅裁切 (default true)'),
  fit: z.boolean().optional().default(false).describe('Scale the SVG artboard to fit the target artboard instead of placing at 100%'),
  padding: z.number().min(0).optional().describe('Padding in points when fit is true'),
  png_path: z.string().regex(/\.png$/i).optional().describe('Also export this artboard as a transparent PNG, plus a <name>.white.png twin on white'),
}).refine((item) => (item.artboard_index === undefined) !== (item.artboard_rect === undefined), 'Supply exactly one of artboard_index or artboard_rect');

export function register(server: McpServer): void {
  server.registerTool(
    'assemble_svgs',
    {
      title: 'Assemble SVGs onto Artboards',
      description:
        'Place many SVG files as editable native art in one Illustrator run. Each SVG artboard lands exactly on an existing or newly created artboard (overflowing glow does not shift it), optionally clipped to it; only top-level items are copied, with the target document active. By default rejects SVGs with raster/placed/plugin/mesh content, saves the document, and reports per-item source vs imported path counts. reopen_verify closes and reopens the saved file and counts native objects. Optional per-item PNG export (transparent plus white twin). Stops at the first failing item and names what was already placed. Native coordinates in points. No Computer Use.',
      inputSchema: {
        document_path: z.string().optional().describe('Absolute path of an open, saved target document. Defaults to the active document.'),
        items: z.array(itemSchema).min(1).max(200),
        require_pure_vector: z.boolean().optional().default(true),
        save: z.boolean().optional().default(true).describe('Save the target document after all items are placed'),
        reopen_verify: z.boolean().optional().default(false).describe('Close and reopen the saved document and count native objects'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (params) => {
      const timeout = Math.min(600_000, 60_000 + params.items.length * 20_000);
      return formatToolResult(await executeJsx(jsxCode, params, { timeout }));
    },
  );
}
