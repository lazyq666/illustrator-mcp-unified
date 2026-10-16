/**
 * 埋め込みJSX（ExtendScript）テンプレートの構文チェック
 *
 * jsxCode はテンプレート文字列のため tsc の構文チェック対象外。
 * エスケープ展開後のコードを ES3 parser (Acorn) でパースし、
 * 構文エラーの混入を CI で検出する。
 *
 * 対象: `${}` 補間を含まないテンプレートのみ（補間ありはモジュール実行時の
 * 文脈が必要なため対象外）。export / preflight-check が対象に含まれることを
 * 別テストで保証する。
 */
import { assertExtendScriptSyntax } from '../../src/executor/script-syntax.js';
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/tools');

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const targets: Array<{ file: string; code: string }> = [];
for (const file of collectTsFiles(TOOLS_DIR)) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/const jsxCode = `([\s\S]*?)\n`;/);
  if (!m || m[1].includes('${')) continue;
  try {
    // テンプレートリテラルとして評価し、\\. 等のエスケープを実際のJSXコードに展開する。
    // 入力はこのリポジトリ内のソースファイルのみ（外部入力なし）のため eval / new Function は安全。
    // new Function はパースのみで呼び出さない
    // eslint-disable-next-line no-eval
    const code = eval('`' + m[1].replace(/`/g, '\\`') + '`') as string;
    // Windowsのパス区切りを正規化（endsWith / split の比較を \\ でも通すため）
    targets.push({ file: file.replace(/\\/g, '/'), code });
  } catch {
    // 抽出失敗（テンプレート境界の誤検出等）は構文チェック対象外とする
  }
}

describe('embedded JSX syntax', () => {
  it('covers export and preflight-check templates', () => {
    const names = targets.map((t) => t.file);
    expect(names.some((n) => n.endsWith('export/export.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('utility/preflight-check.ts'))).toBe(true);
  });

  for (const t of targets) {
    it(`parses without syntax errors: ${t.file.split('/src/tools/')[1]}`, () => {
      expect(() => assertExtendScriptSyntax(t.code)).not.toThrow();
    });
  }
});
