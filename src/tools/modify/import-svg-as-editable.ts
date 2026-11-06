import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeToolJsx } from '../tool-executor.js';
import { coordinateSystemSchema } from '../session.js';
import { WRITE_ANNOTATIONS } from './shared.js';
import { SVG_IMPORT_JSX } from './svg-import-core.js';

/**
 * import_svg_as_editable — SVG を編集可能な Illustrator オブジェクトとしてインポート
 *
 * @see https://ai-scripting.docsforadobe.dev/jsobjref/Application/ — Application.open()
 * @see https://ai-scripting.docsforadobe.dev/jsobjref/PageItem/ — PageItem.duplicate()
 *
 * 内部フロー（svg-import-core.ts）:
 *   1. SVG を一時ドキュメントとして app.open() で開く
 *   2. レイヤー直下のトップレベル項目だけを、対象ドキュメントをアクティブにしてから duplicate
 *      （Document.pageItems はネスト項目も含むため全件複製すると重複する）
 *   3. 一時ドキュメントを保存せずに閉じ、アクティブを元のドキュメントに復元
 *   4. グループ化 / 指定位置・アートボード基準で移動 / フィット / 画幅クリップ
 *
 * place_image (PlacedItems.add) は SVG をリンクとして取り込み、編集できない上に
 * 失敗時に壊れたリンクが残るため、本ツールで明示的なルートを用意する。
 */
export const jsxCode = `
var preflight = preflightChecks();
if (preflight) {
  writeResultFile(RESULT_PATH, preflight);
} else {
  var params = readParamsFile(PARAMS_PATH);
  var coordSystem = params.coordinate_system || "artboard-web";
  if (!/\\.svgz?$/i.test(params.file_path)) {
    writeResultFile(RESULT_PATH, { error: true, message: "import_svg_as_editable expects an .svg or .svgz file. Got: " + params.file_path });
  } else {
    var targetDoc = app.activeDocument;
    var abIndex = (typeof params.artboard_index === "number") ? params.artboard_index : targetDoc.artboards.getActiveArtboardIndex();
    if (abIndex < 0 || abIndex >= targetDoc.artboards.length) throw new Error("artboard_index out of range: " + abIndex);
    var abRect = targetDoc.artboards[abIndex].artboardRect;
    var targetLayer = resolveTargetLayer(targetDoc, params.layer_name);
    var anchor = params.anchor || "geometric_bounds";
    var imported = mcpSvgImport(targetDoc, targetLayer, params.file_path, { anchor: anchor, requirePureVector: params.require_pure_vector === true });
    var point = null;
    if (params.fit_to_artboard !== true && typeof params.x === "number" && typeof params.y === "number") {
      point = webToAiPoint(params.x, params.y, coordSystem, coordSystem === "artboard-web" ? abRect : null);
    }
    var placed = mcpSvgPlace(imported, targetLayer, {
      group: params.group !== false, clip: anchor === "source_artboard" && params.clip_to_artboard === true, name: params.name,
      targetRect: (params.fit_to_artboard === true || anchor === "source_artboard") ? abRect : null,
      fit: params.fit_to_artboard === true, padding: params.padding, point: point
    });
    var itemSummaries = [];
    var top = placed.root ? [placed.root] : imported.copies;
    for (var u = 0; u < top.length; u++) itemSummaries.push({ uuid: ensureUUID(top[u]), type: top[u].typename, name: top[u].name || "" });
    var b = placed.bounds;
    writeResultFile(RESULT_PATH, {
      success: true,
      sourcePath: params.file_path,
      anchor: anchor,
      artboardIndex: abIndex,
      grouped: !!placed.root,
      clipped: placed.clipped,
      rootUuid: placed.root ? ensureUUID(placed.root) : null,
      importedCount: imported.copies.length,
      source: imported.source,
      pathsAdded: imported.pathsAdded,
      pathsMatchSource: imported.pathsAdded === imported.source.topLevelPaths,
      placement: placed.placement,
      placementNote: placed.placement === "kept_source_coordinates" ? "No x/y, fit_to_artboard or anchor=source_artboard was given, so the art keeps the SVG's own coordinates and may lie outside the target artboard." : undefined,
      scalePercent: placed.scalePercent,
      translate: placed.translate,
      frameBounds: placed.frameBounds,
      widthPt: b[2] - b[0],
      heightPt: b[1] - b[3],
      items: itemSummaries,
      verified: placed.root ? verifyItem(placed.root, coordSystem, abRect) : null
    });
  }
}
${SVG_IMPORT_JSX}`;

export function register(server: McpServer): void {
  server.registerTool(
    'import_svg_as_editable',
    {
      title: 'Import SVG as Editable',
      description:
        'Import an SVG file into the active document as editable Illustrator paths/text/groups (NOT as a linked image). Opens the SVG, copies its top-level items into the target document, then closes the source. Use anchor="source_artboard" to land the SVG artboard exactly on a target artboard (glow outside the artboard does not shift it) and clip_to_artboard to crop to it. Without x/y, fit_to_artboard or anchor=source_artboard the art keeps the coordinates from the SVG (result.placement says which rule applied). Returns source object counts and whether imported path counts match. Use assemble_svgs for many SVGs. Use this instead of place_image for SVG. Runs without activating Illustrator in default background mode; never invokes Computer Use.',
      inputSchema: {
        file_path: z.string().describe('Absolute path to the .svg or .svgz file'),
        x: z
          .number()
          .optional()
          .describe('X position of the imported content (top-left of bounding box). Ignored when fit_to_artboard is true.'),
        y: z
          .number()
          .optional()
          .describe('Y position of the imported content (top-left of bounding box). Ignored when fit_to_artboard is true.'),
        layer_name: z
          .string()
          .optional()
          .describe('Target layer name in the active document. Created if missing.'),
        group: z
          .boolean()
          .optional()
          .default(true)
          .describe('Wrap imported items in a single GroupItem (default: true). Set false to keep items flat in the target layer.'),
        fit_to_artboard: z
          .boolean()
          .optional()
          .default(false)
          .describe('Scale and center the imported content to fit the active artboard (default: false).'),
        padding: z
          .number()
          .optional()
          .describe('Padding in points from the artboard edges when fit_to_artboard is true.'),
        name: z
          .string()
          .optional()
          .describe('Name to assign to the root group (only when group=true and multiple items are imported).'),
        anchor: z
          .enum(['geometric_bounds', 'source_artboard'])
          .optional()
          .default('geometric_bounds')
          .describe('What x/y, fit and placement refer to. geometric_bounds: the imported art (default, legacy). source_artboard: the SVG artboard rectangle; without x/y it is placed on the target artboard top-left.'),
        artboard_index: z.number().int().min(0).optional().describe('Target artboard (0-based). Defaults to the active artboard.'),
        clip_to_artboard: z.boolean().optional().default(false).describe('With anchor=source_artboard: keep a clipping rectangle named 画幅裁切 so overflow is cropped to the SVG artboard.'),
        require_pure_vector: z.boolean().optional().default(false).describe('Fail before copying if the SVG opens with raster, placed, plugin or mesh items.'),
        coordinate_system: coordinateSystemSchema,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (params) => {
      // Opening and copying a large SVG can exceed the 30 s default; a timeout leaves an unconfirmed lock.
      return executeToolJsx(jsxCode, params, { activate: true, resolveCoordinate: true, timeout: 90_000 });
    },
  );
}
