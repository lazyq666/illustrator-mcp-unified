import { expect, it } from 'vitest';
import { buildJsx, locateJsxLine, nativeErrorHint, USER_SOURCE_MARKER } from '../../src/executor/jsx-runner.js';
import { assertExtendScriptSyntax } from '../../src/executor/script-syntax.js';

it('builds an ES3 wrapper that writes a started marker and reports tool and user line offsets', async () => {
  const built = await buildJsx(`var prepared = 1;\n${USER_SOURCE_MARKER}\nfirst();\nsecond();`, '/p.json', '/r.json', '/state/receipts/abc.json', 'abc');
  expect(() => assertExtendScriptSyntax(built.code)).not.toThrow();
  expect(built.code).toContain('/state/receipts/abc.started.json');
  const lines = built.code.split('\n');
  expect(lines[built.toolStart - 1]).toBe('var prepared = 1;');
  expect(locateJsxLine(built, built.userStart! + 1)).toEqual({ jsx_line: built.userStart! + 1, scope: 'user', line: 2, text: 'second();' });
  expect(locateJsxLine(built, built.toolStart)).toMatchObject({ scope: 'tool', line: 1 });
  expect(locateJsxLine(built, 2)).toMatchObject({ scope: 'helpers', line: 1 });
  expect(locateJsxLine(built, 0)).toBeNull();
  expect(locateJsxLine(built, lines.length + 1)).toBeNull();
});

it('leaves userStart undefined for tool scripts without a marker', async () => {
  const built = await buildJsx('var only = 1;', '/p.json', '/r.json', '/state/receipts/abc.json', 'abc');
  expect(built.userStart).toBeUndefined();
});

it('only hints for known four-character codes', () => {
  expect(nativeErrorHint("an Illustrator error occurred: 1346458189 ('MRAP')")).toMatch(/GroupItem of another document/);
  expect(nativeErrorHint("an Illustrator error occurred: 1 ('ZZZZ')")).toBeUndefined();
  expect(nativeErrorHint('plain error')).toBeUndefined();
});
