import { describe, expect, it } from 'vitest';
import { assertExtendScriptSyntax } from '../../src/executor/script-syntax.js';
import { buildJsx } from '../../src/executor/jsx-runner.js';
import { jsxCode as importJsx, register as registerImport } from '../../src/tools/modify/import-svg-as-editable.js';
import { jsxCode as assembleJsx, register as registerAssemble } from '../../src/tools/modify/assemble-svgs.js';
import { inspectSvgSource } from '../../src/tools/read/inspect-svg.js';
import { captureInputSchema } from './helpers/tool-schema.js';

describe('SVG import scripts', () => {
  it('compose into valid ES3 inside the full wrapper', async () => {
    for (const script of [importJsx, assembleJsx]) {
      expect(() => assertExtendScriptSyntax(script)).not.toThrow();
      const built = await buildJsx(script, '/p', '/r', '/s/receipts/x.json', 'x');
      expect(() => assertExtendScriptSyntax(built.code)).not.toThrow();
    }
  });

  it('copies only top-level items and activates the target before duplicating', () => {
    for (const script of [importJsx, assembleJsx]) {
      expect(script).toContain('parent.typename === "Layer"');
      expect(script.indexOf('app.activeDocument = targetDoc;')).toBeLessThan(script.indexOf('.duplicate(targetLayer'));
      expect(script).not.toMatch(/sourceItems\.push\(srcDoc\.pageItems/);
    }
  });
});

describe('SVG tool schemas', () => {
  it('import_svg_as_editable keeps legacy defaults and accepts the artboard anchor options', () => {
    const schema = captureInputSchema(registerImport);
    expect(schema.parse({ file_path: '/x/a.svg' })).toMatchObject({ anchor: 'geometric_bounds', clip_to_artboard: false, require_pure_vector: false });
    expect(schema.safeParse({ file_path: '/x/a.svg', anchor: 'source_artboard', artboard_index: 3, clip_to_artboard: true }).success).toBe(true);
    expect(schema.safeParse({ file_path: '/x/a.svg', anchor: 'center' }).success).toBe(false);
  });

  it('assemble_svgs needs exactly one artboard target per item and a valid native rectangle', () => {
    const schema = captureInputSchema(registerAssemble);
    expect(schema.parse({ items: [{ svg_path: '/x/a.svg', artboard_index: 0 }] })).toMatchObject({ require_pure_vector: true, save: true, reopen_verify: false, items: [{ clip: true, fit: false }] });
    expect(schema.safeParse({ items: [{ svg_path: '/x/a.svg', artboard_rect: [0, 400, 400, 0] }] }).success).toBe(true);
    expect(schema.safeParse({ items: [{ svg_path: '/x/a.svg' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ svg_path: '/x/a.svg', artboard_index: 0, artboard_rect: [0, 400, 400, 0] }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ svg_path: '/x/a.svg', artboard_rect: [0, 0, 400, 400] }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ svg_path: '/x/a.png', artboard_index: 0 }] }).success).toBe(false);
  });
});

describe('inspect_svg', () => {
  it('separates image wrappers, mixed files, filtered vectors and pure vectors', () => {
    expect(inspectSvgSource('<svg width="10" height="10"><image href="data:image/png;base64,AAA"/></svg>').kind).toBe('raster_only');
    const mixed = inspectSvgSource('<svg viewBox="0 0 4 4"><path d="M0 0"/><image xlink:href="a.png"/></svg>');
    expect(mixed).toMatchObject({ kind: 'mixed', view_box: '0 0 4 4', counts: { images: 1, embedded_images: 0, shapes: 1 } });
    expect(mixed.notes.join(' ')).toMatch(/external files/);
    expect(inspectSvgSource('<svg><filter id="f"/><circle r="1"/></svg>').kind).toBe('vector_with_filters');
    const vector = inspectSvgSource('<svg><!-- <image/> --><radialGradient><stop stop-opacity="0"/></radialGradient><rect/><g><path/></g></svg>');
    expect(vector).toMatchObject({ kind: 'vector', counts: { images: 0, shapes: 2, radial_gradients: 1, transparent_stops: 1, groups: 1 } });
    expect(inspectSvgSource('<svg></svg>').kind).toBe('empty');
  });
});

describe('SVG path counting', () => {
  it('counts copies by walking items, not by document collection deltas', () => {
    for (const script of [importJsx, assembleJsx]) {
      expect(script).toContain('pathsAdded += mcpSvgCountPaths(copies[k])');
      expect(script).toContain('imported.pathsAdded === imported.source.topLevelPaths');
      expect(script).not.toMatch(/targetDoc\.pathItems\.length - before/);
    }
    expect(importJsx).toContain('kept_source_coordinates');
  });
});
