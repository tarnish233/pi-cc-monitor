import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
const { isWaitResultVisible } = await loadModule('wait-delivery.ts');
const value = {
  action: 'wait', waitId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924', ids: ['taskA'],
  completed: true, timedOut: false, allSucceeded: false, pendingIds: [], waitedMs: 10,
  monitors: [{ id: 'taskA', status: 'failed', exitCode: null, signal: 'SIGTERM', cause: 'exit',
    stdout: { text: 'quoted "text", braces { and } and array [ ] — 尾部', truncated: false },
    stderr: { text: '', truncated: false }, outputPath: '/tmp/a.out', stderrPath: '/tmp/a.err' }],
};
const expected = JSON.stringify(value);
const receipt = `Collected task results\nWait receipt: ${value.waitId}\nfailed — signal SIGTERM`;
const content = text => [{ type: 'text', text }];

test('the complete emitted receipt is delivery, not its id or a done marker', () => {
  assert.equal(isWaitResultVisible(content(receipt), expected, receipt), true);
  assert.equal(isWaitResultVisible(content('done'), expected, receipt), false);
  assert.equal(isWaitResultVisible(content(`Wait receipt: ${value.waitId}`), expected, receipt), false);
  assert.equal(isWaitResultVisible([], expected, receipt), false);
});

test('normal codemode pretty JSON and multiple-item/wrapper output prove full transfer', () => {
  for (const text of [expected, JSON.stringify(value, null, 2), `Script completed\nWall time 1s\nOutput:\n${JSON.stringify(value, null, 2)}`,
    `==> text 1/2 <==\n{"other":"data"}\n==> text 2/2 <==\n${JSON.stringify({ results: [value] }, null, 2)}`]) {
    assert.equal(isWaitResultVisible(content(text), expected, receipt), true, text);
  }
});

test('key order and extra debug fields are allowed, but all actual result fields remain required', () => {
  const sorted = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(isWaitResultVisible(content(JSON.stringify({ ...sorted, debug: 'extra' })), expected), true);
  for (const changed of [
    { action: 'wait', waitId: value.waitId },
    { ...value, allSucceeded: true },
    { ...value, monitors: [{ ...value.monitors[0], signal: 'SIGKILL' }] },
    { ...value, monitors: [] },
  ]) assert.equal(isWaitResultVisible(content(JSON.stringify(changed)), expected), false);
  const omitted = structuredClone(value);
  delete omitted.monitors[0].stdout;
  assert.equal(isWaitResultVisible(content(JSON.stringify(omitted)), expected), false);
});

test('quoted strings and escaped structural characters do not confuse JSON scanning', () => {
  const encoded = JSON.stringify({ before: 'not a result: { " } [ ]', actual: value });
  assert.equal(isWaitResultVisible(content(encoded), expected), true);
  assert.equal(isWaitResultVisible(content(`{non-json prefix\n${expected}`), expected), true);
  assert.equal(isWaitResultVisible(content(JSON.stringify(expected)), expected), false, 'a quoted JSON string is not a result object');
});

test('truncated, malformed, unrelated and unsupported output are conservative failures', () => {
  assert.equal(isWaitResultVisible(content(expected.slice(0, -2)), expected), false);
  assert.equal(isWaitResultVisible(content(expected.replace(value.waitId, 'a different receipt')), expected), false);
  assert.equal(isWaitResultVisible(content('not json'), 'invalid json'), false);
  assert.equal(isWaitResultVisible(content(expected), 'null'), false);
  assert.equal(isWaitResultVisible(content(expected), undefined), false);
  assert.equal(isWaitResultVisible([{ type: 'image', text: expected }], expected), false);
});

test('proof parsing has bounded text and nesting budgets', () => {
  assert.equal(isWaitResultVisible(content(' '.repeat(100001) + expected), expected), false);
  const deep = '['.repeat(20) + expected + ']'.repeat(20);
  assert.equal(isWaitResultVisible(content(deep), expected), false);
});
