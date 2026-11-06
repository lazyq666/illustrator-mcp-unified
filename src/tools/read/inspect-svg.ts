import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { formatToolResult } from '../tool-executor.js';
import { READ_ANNOTATIONS } from '../modify/shared.js';

/**
 * inspect_svg — Illustrator を使わずに SVG の中身を分類する。
 * 拡張子が .svg でも位図を包んだだけのファイルがあるため、再利用・取り込み前の素材確認に使う。
 */
export type SvgKind = 'vector' | 'vector_with_filters' | 'mixed' | 'raster_only' | 'empty';

export interface SvgInspection {
  file_path: string; kind: SvgKind; bytes: number;
  width: string | null; height: string | null; view_box: string | null;
  counts: Record<string, number>;
  notes: string[];
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function attribute(tag: string | undefined, name: string): string | null {
  if (!tag) return null;
  return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1] ?? null;
}

export function inspectSvgSource(source: string, filePath = '<inline>'): SvgInspection {
  const text = source.replace(/<!--[\s\S]*?-->/g, '');
  const counts = {
    shapes: count(text, /<(?:[\w-]+:)?(?:path|rect|circle|ellipse|polygon|polyline|line)\b/g),
    text: count(text, /<(?:[\w-]+:)?text\b/g),
    images: count(text, /<(?:[\w-]+:)?image\b/g),
    embedded_images: count(text, /<(?:[\w-]+:)?image\b[^>]*?href\s*=\s*["']data:image\//g),
    filters: count(text, /<(?:[\w-]+:)?filter\b/g),
    linear_gradients: count(text, /<(?:[\w-]+:)?linearGradient\b/g),
    radial_gradients: count(text, /<(?:[\w-]+:)?radialGradient\b/g),
    transparent_stops: count(text, /stop-opacity\s*[:=]\s*["']?\s*(?:0?\.\d+|0)\b/g),
    clip_paths: count(text, /<(?:[\w-]+:)?clipPath\b/g),
    masks: count(text, /<(?:[\w-]+:)?mask\b/g),
    uses: count(text, /<(?:[\w-]+:)?use\b/g),
    groups: count(text, /<(?:[\w-]+:)?g\b/g),
  };
  const vector = counts.shapes + counts.text;
  const kind: SvgKind = counts.images > 0 ? (vector > 0 ? 'mixed' : 'raster_only')
    : vector === 0 ? 'empty' : counts.filters > 0 ? 'vector_with_filters' : 'vector';
  const notes: string[] = [];
  if (counts.images > 0) notes.push(`${counts.images} <image> element(s): opened in Illustrator they become raster or linked items, not editable paths.`);
  if (counts.images > counts.embedded_images) notes.push('Some images reference external files; they may be missing when opened elsewhere.');
  if (counts.filters > 0) notes.push('Filters usually become rasterized appearance or SVG filter effects on import, not editable geometry.');
  if (counts.masks > 0) notes.push('Masks import as opacity masks; check them after import.');
  if (counts.text > 0) notes.push('Text needs the referenced fonts installed to stay editable and unchanged.');
  if (counts.uses > 0) notes.push('<use> references expand on import; check symbol or duplicate counts.');
  const root = /<(?:[\w-]+:)?svg\b[^>]*>/.exec(text)?.[0];
  return {
    file_path: filePath, kind, bytes: Buffer.byteLength(source),
    width: attribute(root, 'width'), height: attribute(root, 'height'), view_box: attribute(root, 'viewBox'),
    counts, notes,
  };
}

export function register(server: McpServer): void {
  server.registerTool(
    'inspect_svg',
    {
      title: 'Inspect SVG',
      description:
        'Classify SVG files without Illustrator: vector, vector_with_filters, mixed (vector plus <image>), raster_only (an image wrapped in SVG) or empty, with counts of shapes, images, filters, gradients (including transparent stops), masks and text. Use before treating an .svg as reusable editable vector art or before assemble_svgs/import_svg_as_editable. Text-level scan, not a renderer.',
      inputSchema: {
        file_paths: z.array(z.string()).min(1).max(500).describe('Absolute paths to .svg files'),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ file_paths }) => {
      const results = await Promise.all(file_paths.map(async (file) => {
        try { return inspectSvgSource(await readFile(file, 'utf8'), file); }
        catch (error) { return { file_path: file, error: String((error as Error).message ?? error) }; }
      }));
      const summary: Record<string, number> = {};
      for (const result of results) {
        const key = 'kind' in result ? result.kind : 'unreadable';
        summary[key] = (summary[key] ?? 0) + 1;
      }
      return formatToolResult({ summary, files: results });
    },
  );
}
