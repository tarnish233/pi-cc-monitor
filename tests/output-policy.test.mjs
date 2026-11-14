import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { createHarness, until, startReady, groupAlive } from './runtime-harness.mjs';

const { OutputBudget, outputLevel } = await loadModule('notification-budget.ts');

function heldCommand(h, name, second = false) {
  const release = path.join(h.cwd, name + '-release');
  const emit = path.join(h.cwd, name + '-emit');
  const command = `printf '${name}\\n'; ${second ? `while [ ! -f ${JSON.stringify(emit)} ]; do sleep 0.02; done; printf '${name}-second\\n'; ` : ''}while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done`;
  return { command, release, emit };
}

test('global fixed window admits 20 output messages, including at refill boundaries', () => {
  let now = 0;
  const budget = new OutputBudget({ now: () => now });
  for (let i = 0; i < 20; i++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  now = 59_999; assert.equal(budget.take(), false); assert.equal(budget.remainingMs(), 1);
  now = 60_000; assert.equal(budget.take(), true);
  for (let i = 1; i < 20; i++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false);
  assert.equal(outputLevel('none', 'turn'), 'none');
  assert.equal(outputLevel('context', 'turn'), 'context');
  assert.equal(outputLevel('turn', 'context'), 'context');
});

test('context output and terminal messages never request a model turn', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const fixture = heldCommand(h, 'CONTEXT');
  await h.call('Monitor', { command: fixture.command, description: 'context', notify: { output: 'context', terminal: 'context' } });
  assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === 'output')));
  assert.equal(h.sent[0].options.triggerTurn, false);
  fs.writeFileSync(fixture.release, 'go');
  assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === 'exit')));
  assert.ok(h.sent.every((m) => m.options.triggerTurn === false));
  assert.ok(h.sent.every((m) => m.message.content.length <= 3000));
});

test('output none leaves full raw stdout/stderr and a visible failure outcome', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const receipt = await h.call('Monitor', { command: "printf 'QUIET\\n'; printf 'problem\\n' >&2; exit 7", description: 'muted failure', mode: 'completion', notify: { output: 'none', terminal: 'context' } });
  assert.ok(await until(() => h.sent.length));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.status, 'failed');
  assert.equal(h.sent[0].options.triggerTurn, false);
  assert.equal(fs.readFileSync(receipt.details.outputPath, 'utf8'), 'QUIET\n');
  assert.equal(fs.readFileSync(receipt.details.stderrPath, 'utf8'), 'problem\n');
  await assert.rejects(h.call('Monitor', { command: 'echo forbidden', description: 'bad policy', notify: { terminal: 'none' } }), /failures cannot be hidden/);
});

test('critical events-mode terminal result survives busy Esc settlement without restarting', async (t) => {
  const h = createHarness({ idle: false }); t.after(() => h.close());
  await h.call('Monitor', { command: "printf 'FINAL\\n'", description: 'final batch' });
  assert.ok(await until(async () => (await h.snapshots())[0].status === 'exited'));
  assert.equal(h.sent.length, 0, 'terminal result stays outside the busy queue');
  h.setIdle(true);
  await h.emit('agent_settled', { aborted: true });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.cause, 'exit');
  assert.ok(h.sent[0].message.details.finalLines.includes('FINAL'));
  assert.equal(h.sent[0].options.triggerTurn, false);
  await h.emit('agent_settled', { aborted: false });
  assert.equal(h.sent.length, 1);
});

test('stop preserves pre-stop buffered output in one context-only outcome', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const job = await startReady(h, { mode: 'events' });
  assert.equal(h.sent.length, 0, 'fixture stops before the 200ms batch timer');
  assert.equal((await h.call('monitor_stop', { id: job.taskId })).details.stopped, true);
  assert.equal(h.sent.length, 1);
  const message = h.sent[0];
  assert.equal(message.message.details.cause, 'stopped');
  assert.ok(message.message.details.finalLines.includes('READY'));
  assert.equal(message.options.triggerTurn, false);
  assert.equal(groupAlive(job.pid), false);
});

test('a context terminal ceiling is not raised by merged turn-level output', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const fixture = heldCommand(h, 'CEILING');
  const source = (await h.call('Monitor', { command: fixture.command, description: 'ceiling work', mode: 'completion', notify: { terminal: 'context' } })).details;
  await h.call('Monitor', { source: { monitorId: source.taskId }, description: 'loud watch', watches: [{ id: 'line', text: 'CEILING', notify: 'turn' }], notify: { terminal: 'context' } });
  assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === 'output')));
  fs.writeFileSync(fixture.release, 'go');
  assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === 'exit' && m.message.details.status === 'completed')));
  assert.equal((await h.snapshots()).find((r) => r.id === source.taskId)?.status, 'completed');
  const terminal = h.sent.filter((m) => m.message.details.cause === 'exit');
  assert.ok(terminal.length > 0);
  assert.ok(terminal.every((m) => m.options.triggerTurn === false), 'terminal=context remains a hard no-turn ceiling');
  assert.equal(terminal.filter((m) => m.message.details.status === 'exited').length, 0, 'observer does not add its own terminal outcome');
});

test('silent observer close still schedules a session-budget summary for its suppressed final batch', async (t) => {
  const originalTake = OutputBudget.prototype.take;
  const originalRemaining = OutputBudget.prototype.remainingMs;
  // No output slot is ever available; the accounting summary must not need one.
  OutputBudget.prototype.take = () => false;
  OutputBudget.prototype.remainingMs = () => 20;
  t.after(() => { OutputBudget.prototype.take = originalTake; OutputBudget.prototype.remainingMs = originalRemaining; });
  const h = createHarness(); t.after(() => h.close());
  const fixture = heldCommand(h, 'SILENT_BUDGET');
  const source = (await h.call('Monitor', { command: fixture.command, description: 'silent source', mode: 'completion' })).details;
  await h.call('Monitor', { source: { monitorId: source.taskId }, description: 'silent observer', watches: [{ id: 'match', text: 'SILENT_BUDGET' }] });
  await until(() => fs.existsSync(source.outputPath) && fs.readFileSync(source.outputPath, 'utf8').includes('SILENT_BUDGET'));
  fs.writeFileSync(fixture.release, 'go');
  assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === 'exit' && m.message.details.status === 'completed')));
  assert.ok(!h.sent.some((m) => m.message.content.includes('Session output budget')), 'summary waits for its window');
  assert.ok(await until(() => h.sent.some((m) => m.message.content.includes('Session output budget'))), 'summary bypasses output slots');
  const summary = h.sent.find((m) => m.message.content.includes('Session output budget'));
  assert.equal(summary.options.triggerTurn, false);
  assert.ok(summary.message.content.length <= 3000);
});

test('cross-source output suppression never kills work or swallows terminal outcomes', async (t) => {
  const original = OutputBudget.prototype.take;
  let slots = 2;
  OutputBudget.prototype.take = () => slots > 0 ? (--slots, true) : false;
  t.after(() => { OutputBudget.prototype.take = original; });
  const h = createHarness(); t.after(() => h.close());
  const fixtures = ['A', 'B', 'C'].map((name) => heldCommand(h, name, true));
  const receipts = await Promise.all(fixtures.map((f, i) => h.call('Monitor', { command: f.command, description: `source ${i}` })));
  assert.ok(await until(async () => (await h.snapshots()).reduce((sum, r) => sum + r.eventCount + r.globalSuppressedCount, 0) === 3));
  assert.equal(h.sent.filter((m) => m.message.details.cause === 'output').length, 2);
  const records = await h.snapshots();
  assert.ok(records.every((r) => r.status === 'running' && groupAlive(r.pid)), 'global suppression is notification-only');
  assert.equal(records.reduce((sum, r) => sum + r.globalSuppressedCount, 0), 1);
  slots = 1;
  fixtures.forEach((f) => fs.writeFileSync(f.emit, 'go'));
  assert.ok(await until(() => h.sent.filter((m) => m.message.details.cause === 'output').length === 3));
  const last = h.sent.filter((m) => m.message.details.cause === 'output').at(-1);
  assert.match(last.message.content, /Session output budget/);
  assert.ok(last.message.content.length <= 3000);
  fixtures.forEach((f) => fs.writeFileSync(f.release, 'go'));
  assert.ok(await until(() => h.sent.filter((m) => m.message.details.cause === 'exit').length === 3));
  for (let i = 0; i < receipts.length; i++) assert.equal(fs.readFileSync(receipts[i].details.outputPath, 'utf8'), `${['A', 'B', 'C'][i]}\n${['A', 'B', 'C'][i]}-second\n`);
});
