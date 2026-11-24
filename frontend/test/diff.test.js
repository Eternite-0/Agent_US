import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiffPresentation, computeDiff } from '../src/utils/diff.ts';

function display(before, after) {
  const { lines } = computeDiff(before, after);
  const { splitRows, spansByLine } = buildDiffPresentation(lines);
  const changed = (line) => spansByLine.get(line)?.filter((span) => span.changed).map((span) => span.text) ?? [];
  return { lines, splitRows, spansByLine, changed };
}

test('keeps separate edits on a line and the original text, whitespace and line numbers', () => {
  const before = 'unchanged\r\n\tconst item = [1, 2, 3];  \r\nend';
  const after = 'unchanged\n\tconst item = [4, 2, 5];  \nend';
  const { lines, splitRows, spansByLine, changed } = display(before, after);
  const [context, oldLine, newLine, end] = lines;
  assert.deepEqual(splitRows, [
    { left: context, right: context }, { left: oldLine, right: newLine }, { left: end, right: end },
  ]);
  assert.deepEqual([oldLine.oldLine, oldLine.newLine, newLine.oldLine, newLine.newLine], [2, null, null, 2]);
  assert.deepEqual(changed(oldLine), ['1', '3']);
  assert.deepEqual(changed(newLine), ['4', '5']);
  for (const [line, spans] of spansByLine) assert.equal(spans.map((span) => span.text).join(''), line.text);
  assert.equal(spansByLine.has(context), false);
});

test('pairs ordered replacements past extra inserts without sharing spans across context', () => {
  const { splitRows, changed } = display(
    'const retries = 2;\nconst timeout = 70;\nkeep\n    AAAA\nend',
    'log();\nconst retries = 3;\nconst timeout = 75;\nkeep\n    ZZZZ\nend\nadded',
  );
  assert.equal(splitRows[0].left, null);
  assert.equal(splitRows[0].right.text, 'log();');
  assert.deepEqual(changed(splitRows[1].left), ['2']);
  assert.deepEqual(changed(splitRows[1].right), ['3']);
  assert.deepEqual(changed(splitRows[2].left), ['0']);
  assert.deepEqual(changed(splitRows[2].right), ['5']);
  assert.equal(splitRows[3].left, splitRows[3].right);
  assert.deepEqual(changed(splitRows[4].left), []);
  assert.deepEqual(changed(splitRows[4].right), []);
  assert.equal(splitRows.at(-1).left, null);
  assert.deepEqual(changed(splitRows.at(-1).right), []);
});

test('highlights whole graphemes and does not mark an unchanged side of an insertion', () => {
  const { splitRows, changed } = display('label = "👩🏻‍💻, cafe\u0301";', 'label = "👩🏽‍🚀, cafés";');
  assert.deepEqual(changed(splitRows[0].left), ['👩🏻‍💻', 'e\u0301']);
  assert.deepEqual(changed(splitRows[0].right), ['👩🏽‍🚀', 'és']);
  const insertion = display('call(value)', 'call(\tvalue)');
  const { left, right } = insertion.splitRows[0];
  assert.deepEqual(insertion.changed(left), []);
  assert.deepEqual(insertion.changed(right), ['\t']);
  assert.equal(left.text, 'call(value)');
});

test('leaves very long lines and large hunks at row-level instead of attempting fine alignment', () => {
  const huge = 'x'.repeat(20_000);
  const long = display(`${huge}1`, `${huge}2`);
  assert.equal(long.spansByLine.size, 0);
  assert.equal(long.splitRows[0].left.text, `${huge}1`);
  assert.equal(long.splitRows[0].right.text, `${huge}2`);

  const before = Array.from({ length: 40 }, (_, i) => `setting_${i} = 1;`).join('\n');
  const after = Array.from({ length: 40 }, (_, i) => `setting_${i} = 2;`).join('\n');
  const hunk = display(before, after);
  assert.equal(hunk.splitRows.length, 40);
  assert.equal(hunk.spansByLine.size, 0);
});

test('caps fine comparisons across hunks without dropping rows', () => {
  // Supply hunk boundaries directly so this always exercises the intra-line file budget.
  const lines = Array.from({ length: 600 }, (_, i) => i * 2 + 1).flatMap((ln) => [
    { kind: 'del', oldLine: ln, newLine: null, text: `batch ${ln}: A` },
    { kind: 'add', oldLine: null, newLine: ln, text: `batch ${ln}: B` },
    { kind: 'context', oldLine: ln + 1, newLine: ln + 1, text: `anchor ${ln}` },
  ]);
  const { splitRows, spansByLine } = buildDiffPresentation(lines);
  assert.equal(splitRows.length, 1200);
  assert.ok(spansByLine.has(lines[0]));
  assert.ok(!spansByLine.has(lines.at(-2)));
});

test('the coarse line fallback preserves unchanged ends and line numbers in a large file', () => {
  const lines = Array.from({ length: 750 }, (_, i) => `line ${i + 1}`);
  const after = [...lines];
  after.splice(350, 1, 'replacement', 'insert');
  const diff = computeDiff(lines.join('\n'), after.join('\n'));
  assert.deepEqual([diff.added, diff.deleted], [2, 1]);
  assert.deepEqual(diff.lines.at(-1), { kind: 'context', oldLine: 750, newLine: 751, text: 'line 750' });
  const unchanged = computeDiff(lines.join('\n'), lines.join('\n'));
  assert.deepEqual([unchanged.added, unchanged.deleted], [0, 0]);
});
