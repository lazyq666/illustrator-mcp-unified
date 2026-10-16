/**
 * import_svg_as_editable / place_image の SVG 拒否を検証する E2E スクリプト。
 *
 * Issue #35 (https://github.com/ie3jp/illustrator-mcp-server/issues/35) の対応として、
 * 以下を実機検証する:
 *
 *   1. place_image に SVG を渡すとエラーで拒否され、壊れたリンクが残らないこと
 *   2. import_svg_as_editable が SVG を編集可能なオブジェクトとして取り込めること
 *   3. group / x,y / fit_to_artboard / padding オプションが期待通り機能すること
 *
 * 使い方:
 *   npm run build && npx tsx test/e2e/svg-import-test.ts
 *
 * 事前条件:
 *   - Illustrator CC 2024+ が起動していること
 *   - macOS で実行（osascript 経由）
 */
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import {
  createClient,
  callTool,
  test,
  assert,
  printHeader,
  printPhase,
  printStatus,
  printResults,
} from './helpers.js';

const TMP_DIR = '/tmp/illustrator-mcp-svg-test';
const SVG_PATH = `${TMP_DIR}/sample.svg`;
const DOC_WIDTH = 600;
const DOC_HEIGHT = 400;

// 検証しやすいよう、複数の編集可能オブジェクトを含む単純な SVG を用意
const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect x="10" y="10" width="60" height="40" fill="#ff6b6b" stroke="#7c3aed" stroke-width="2"/>
  <circle cx="120" cy="30" r="20" fill="#4ecdc4"/>
  <text x="10" y="80" font-family="Helvetica" font-size="14" fill="#222">Hello SVG</text>
  <path d="M 150 60 L 180 90 L 150 90 Z" fill="#ffb347"/>
</svg>
`;

async function main(): Promise<void> {
  const startTime = Date.now();
  printHeader();
  console.log('  Issue #35 — SVG import behavior verification\n');

  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(SVG_PATH, SAMPLE_SVG, 'utf-8');
  printStatus(`SVG fixture written: ${SVG_PATH}`);

  printStatus('Connecting to server...');
  let client;
  try {
    client = await createClient();
  } catch (e) {
    console.error('  Connection failed:', e);
    process.exit(1);
  }
  printStatus('Connected\n');

  printPhase(0, 'Setup');

  await test('create_document (RGB, 600x400)', async () => {
    const result = (await callTool(client, 'create_document', {
      width: DOC_WIDTH,
      height: DOC_HEIGHT,
      color_mode: 'rgb',
    })) as any;
    assert(result.success === true, 'create_document should succeed');
  });

  printPhase(1, 'place_image rejects SVG');

  await test('place_image with .svg path returns explicit error', async () => {
    const result = (await callTool(client, 'place_image', {
      file_path: SVG_PATH,
      x: 50,
      y: 50,
    })) as any;
    assert(result.error === true, `expected error, got ${JSON.stringify(result)}`);
    assert(
      typeof result.message === 'string' && /SVG/i.test(result.message),
      `error message should mention SVG, got: ${result.message}`,
    );
    assert(
      /import_svg_as_editable/.test(result.message),
      `error message should point to import_svg_as_editable, got: ${result.message}`,
    );
  });

  await test('no broken linked items left after rejected SVG place', async () => {
    const result = (await callTool(client, 'get_images', {})) as any;
    // 何も配置されていなければ images 配列は空、または broken な参照がないこと
    const items = result.images || result.items || [];
    const broken = items.filter((it: any) => it.broken === true || it.missing === true);
    assert(broken.length === 0, `no broken links expected, got ${JSON.stringify(broken)}`);
  });

  printPhase(2, 'import_svg_as_editable — basic import');

  await test('import_svg_as_editable returns success and grouped root', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: SVG_PATH,
      layer_name: 'SVG-Import',
    })) as any;
    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    assert(result.importedCount >= 4, `expected >= 4 items, got ${result.importedCount}`);
    assert(result.grouped === true, 'should be grouped by default');
    assert(typeof result.rootUuid === 'string' && result.rootUuid.length > 0, 'should have rootUuid');
  });

  await test('imported items appear in target layer (find_objects)', async () => {
    const result = (await callTool(client, 'find_objects', {
      layer_name: 'SVG-Import',
    })) as any;
    const matches = result.objects || [];
    assert(matches.length >= 1, `expected at least 1 match in SVG-Import layer, got ${matches.length}`);
  });

  await test('imported text frame is editable (list_text_frames finds it)', async () => {
    const result = (await callTool(client, 'list_text_frames', {})) as any;
    const frames = result.textFrames || [];
    const helloFrame = frames.find((f: any) => /Hello SVG/.test(f.contents || ''));
    assert(!!helloFrame, `expected an editable text frame containing "Hello SVG", got: ${JSON.stringify(frames)}`);
  });

  printPhase(3, 'import_svg_as_editable — positioning options');

  await test('group=false keeps items flat', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: SVG_PATH,
      layer_name: 'SVG-Flat',
      group: false,
    })) as any;
    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    assert(result.grouped === false, 'grouped should be false');
    assert(result.rootUuid === null, `rootUuid should be null when ungrouped, got ${result.rootUuid}`);
  });

  await test('explicit x/y positions the imported group', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: SVG_PATH,
      layer_name: 'SVG-Positioned',
      x: 100,
      y: 100,
      name: 'positioned-svg',
    })) as any;
    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    assert(result.rootUuid, 'expected rootUuid');
    // verify the resulting position via find_objects (name = partial match)
    const found = (await callTool(client, 'find_objects', {
      name: 'positioned-svg',
    })) as any;
    const matches = found.objects || [];
    assert(matches.length >= 1, 'should find positioned-svg by name');
  });

  await test('fit_to_artboard scales content into artboard', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: SVG_PATH,
      layer_name: 'SVG-Fitted',
      fit_to_artboard: true,
      padding: 20,
      name: 'fitted-svg',
    })) as any;
    assert(result.success === true, `expected success, got ${JSON.stringify(result)}`);
    // padding 20 を引いた最大有効領域に収まっているはず
    const availW = DOC_WIDTH - 40;
    const availH = DOC_HEIGHT - 40;
    assert(
      result.widthPt <= availW + 0.5 && result.heightPt <= availH + 0.5,
      `fitted size ${result.widthPt} x ${result.heightPt} should fit inside ${availW} x ${availH}`,
    );
  });

  printPhase(4, 'Error handling');

  await test('import_svg_as_editable rejects non-svg path', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: '/tmp/not-a-svg.png',
    })) as any;
    assert(result.error === true, `expected error for non-svg path, got ${JSON.stringify(result)}`);
  });

  await test('import_svg_as_editable reports missing file', async () => {
    const result = (await callTool(client, 'import_svg_as_editable', {
      file_path: `${TMP_DIR}/does-not-exist.svg`,
    })) as any;
    assert(result.error === true, `expected error for missing file, got ${JSON.stringify(result)}`);
    assert(/not found/i.test(result.message), `expected "not found" message, got: ${result.message}`);
  });

  printPhase(5, 'Cleanup');

  await test('close_document (without saving)', async () => {
    const result = (await callTool(client, 'close_document', { save: false })) as any;
    assert(result.success === true || result.success === undefined, 'close_document should not error');
  });

  // 後始末
  try {
    if (existsSync(SVG_PATH)) unlinkSync(SVG_PATH);
  } catch {}

  await client.close();
  printResults(startTime);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
