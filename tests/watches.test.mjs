import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
const { WatchRules, OutputLines } = await loadModule('watches.ts');

test('literal matching, stream selection, once/repeat and overlapping rules count occurrences not text', () => {
  const rules = new WatchRules([{ id: 'once', text: 'ERROR', once: true }, { id: 'repeat', text: 'ERROR', stream: 'both', notify: 'context' }]);
  assert.deepEqual(rules.match('ERROR one', 'stdout'), { ids: ['once', 'repeat'], level: 'turn' });
  assert.deepEqual(rules.match('ERROR one', 'stdout'), { ids: ['repeat'], level: 'context' });
  assert.deepEqual(rules.match('ERROR two', 'stderr'), { ids: ['repeat'], level: 'context' });
  assert.equal(rules.match('normal', 'stdout'), undefined);
  const literal = new WatchRules([{ id: 'literal', text: '.*' }]);
  assert.equal(literal.match('anything', 'stdout'), undefined);
  assert.ok(literal.match('contains .* literally', 'stdout'));
});

test('unchanged ID/conditions keep once state; new/changed/removed rules have explicit lifecycle', () => {
  const original = { id: 'ready', text: 'READY', once: true };
  const rules = new WatchRules([original]); rules.match('READY', 'stdout');
  rules.update([{ ...original, notify: 'context' }, { id: 'errors', text: 'ERROR' }]);
  assert.equal(rules.match('READY', 'stdout'), undefined);
  assert.equal(rules.snapshot()[0].fired, true);
  assert.ok(rules.match('ERROR', 'stdout'));
  rules.update([{ ...original, text: 'NEW' }]);
  assert.equal(rules.snapshot()[0].fired, false);
  assert.ok(rules.match('NEW', 'stdout'));
  rules.update([]); assert.equal(rules.hasRules(), false);
  rules.update([original]); assert.equal(rules.snapshot()[0].fired, false);
});

test('validation is atomic and snapshots cannot mutate live state', () => {
  const rules = new WatchRules([{ id: 'a', text: 'A', once: true }]);
  rules.match('A', 'stdout'); const before = rules.snapshot();
  assert.throws(() => rules.update([{ id: 'a', text: 'B' }, { id: 'a', text: 'C' }]), /Duplicate/);
  assert.deepEqual(rules.snapshot(), before);
  assert.throws(() => rules.update([{ id: 'b', text: '' }]), /characters/);
  assert.throws(() => rules.update(Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, text: 'A' }))), /at most/);
  before[0].fired = false; assert.equal(rules.snapshot()[0].fired, true);
});

test('raw complete lines match before clipping, preserve split UTF8, finish and clear boundaries', () => {
  const lines = []; const parser = new OutputLines((line) => lines.push(line));
  const bytes = Buffer.from('😀' + 'X'.repeat(700) + 'ERROR\nPART');
  parser.push(bytes.subarray(0, 2)); parser.push(bytes.subarray(2));
  assert.equal(lines.length, 1); assert.ok(lines[0].endsWith('ERROR'));
  assert.ok(new WatchRules([{ id: 'tail', text: 'ERROR' }]).match(lines[0], 'stdout'));
  parser.finish(); assert.equal(lines.at(-1), 'PART');
  parser.push(Buffer.from('OLD')); parser.clear(); parser.push(Buffer.from('NEW\n'));
  assert.equal(lines.at(-1), 'NEW');
});

test('partial-line tail clipping never starts with an orphan low surrogate; ASCII tail unchanged', async () => {
  const { MAX_PARTIAL_LINE_CHARS } = await loadModule('stream.ts');
  const rogue = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const raw = Buffer.from('😀' + 'x'.repeat(MAX_PARTIAL_LINE_CHARS - 1));
  const lines = [];
  const push = new OutputLines((line) => lines.push(line));
  push.push(raw); push.push(Buffer.from('\n'));
  assert.ok(!rogue.test(lines[0]), 'clipped head must be a whole code point');
  assert.equal(lines[0], 'x'.repeat(MAX_PARTIAL_LINE_CHARS - 1));
  const finish = new OutputLines((line) => lines.push(line));
  finish.push(raw); finish.finish();
  assert.ok(!rogue.test(lines[1]));
  const ascii = new OutputLines((line) => lines.push(line));
  ascii.push(Buffer.from('X'.repeat(MAX_PARTIAL_LINE_CHARS + 5))); ascii.push(Buffer.from('\n'));
  assert.equal(lines[2], 'X'.repeat(MAX_PARTIAL_LINE_CHARS));
});
