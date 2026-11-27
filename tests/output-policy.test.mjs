import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { fixtureGroup, createHarness, until, startReady } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
const { OutputBudget, outputLevel } = await loadModule('notification-budget.ts');
function h(t, options) { const value = createHarness(options); t.after(() => value.close()); return value; }
function jobResult(value) { return value.sent.filter(m => m.message.details.cause === 'job'); }

test('global fixed window admits 20 output messages including refill boundaries', () => {
  let now = 0; const budget = new OutputBudget({ now: () => now });
  for (let i = 0; i < 20; i++) assert.equal(budget.take(), true); assert.equal(budget.take(), false);
  now = 59999; assert.equal(budget.take(), false); assert.equal(budget.remainingMs(), 1);
  now = 60000; assert.equal(budget.take(), true); for (let i = 1; i < 20; i++) assert.equal(budget.take(), true); assert.equal(budget.take(), false);
  assert.equal(outputLevel('none', 'turn'), 'none'); assert.equal(outputLevel('context', 'turn'), 'context'); assert.equal(outputLevel('turn', 'context'), 'context');
});
test('context output does not request a turn, but the external terminal result does', async t => {
  const value = h(t), job = createJob(value.cwd, { stdout: 'CONTEXT\n' });
  await value.call('Monitor', { source: job.source, mode: 'events', description: 'context', notify: { output: 'context' } });
  assert.ok(await until(() => value.sent.some(m => m.message.details.cause === 'output'))); assert.equal(value.sent[0].options.triggerTurn, false);
  job.status('succeeded'); assert.ok(await until(() => jobResult(value).length === 1)); assert.equal(jobResult(value)[0].options.triggerTurn, true); assert.ok(value.sent.every(m => m.message.content.length <= 3000));
});
test('output none keeps copies and reports job failure without failing observation', async t => {
  const value = h(t), job = createJob(value.cwd, { stdout: 'QUIET\n', stderr: 'problem\n', state: 'failed' }); job.status('failed', { exitCode: 7 });
  const receipt = (await value.call('Monitor', { source: job.source, description: 'muted failure', notify: { output: 'none' } })).details;
  assert.ok(await until(() => jobResult(value).length === 1)); assert.equal(value.sent.length, 1); assert.equal(jobResult(value)[0].message.details.status, 'completed'); assert.equal(jobResult(value)[0].message.details.job.state, 'failed');
  assert.equal(jobResult(value)[0].options.triggerTurn, true); assert.equal(fs.readFileSync(receipt.outputPath, 'utf8'), 'QUIET\n'); assert.equal(fs.readFileSync(receipt.stderrPath, 'utf8'), 'problem\n');
  await assert.rejects(value.call('Monitor', { source: job.source, description: 'bad policy', notify: { terminal: 'none' } }), /end, failure and stop/);
});
test('events terminal survives busy aborted settlement without restarting', async t => {
  const value = h(t, { idle: false }), job = createJob(value.cwd, { stdout: 'FINAL\n', state: 'succeeded' });
  await value.call('Monitor', { source: job.source, mode: 'events', description: 'final batch' }); assert.ok(await until(async () => (await value.snapshots())[0].status === 'completed')); assert.equal(value.sent.length, 0);
  value.setIdle(true); await value.emit('agent_settled', { aborted: true }); assert.equal(value.sent.length, 1); assert.equal(value.sent[0].message.details.cause, 'job'); assert.ok(value.sent[0].message.details.finalLines.includes('FINAL')); assert.equal(value.sent[0].options.triggerTurn, false);
  await value.emit('agent_settled', { aborted: false }); assert.equal(value.sent.length, 1);
});
test('stop flushes pre-stop output in one outcome and leaves external files intact', async t => {
  const value = h(t), watched = await startReady(value, { mode: 'events' }); assert.equal(value.sent.length, 0);
  assert.equal((await value.call('monitor_stop', { id: watched.taskId })).details.stopped, true); assert.equal(value.sent.length, 1); assert.ok(value.sent[0].message.details.finalLines.includes('READY')); assert.equal(value.sent[0].options.triggerTurn, true);
  assert.equal(JSON.parse(fs.readFileSync(watched.fixture.statusPath)).state, 'running'); assert.equal(fs.readFileSync(watched.fixture.stdout, 'utf8'), 'READY\n');
});
test('live context ceiling is not raised by turn-level watch rules; job terminal remains turn', async t => {
  const value = h(t), job = createJob(value.cwd, { stdout: 'CEILING\n' });
  await value.call('Monitor', { source: job.source, mode: 'events', description: 'ceiling', watches: [{ id: 'line', text: 'CEILING', notify: 'turn' }], notify: { output: 'context' } });
  assert.ok(await until(() => value.sent.some(m => m.message.details.cause === 'output'))); assert.equal(value.sent.find(m => m.message.details.cause === 'output').options.triggerTurn, false);
  job.status('succeeded'); assert.ok(await until(() => jobResult(value).length === 1)); assert.equal(jobResult(value)[0].options.triggerTurn, true);
});
test('loop-silent stop still delivers the accounting summary for suppressed output', async t => {
  const originalTake = OutputBudget.prototype.take, originalRemaining = OutputBudget.prototype.remainingMs;
  OutputBudget.prototype.take = () => false; OutputBudget.prototype.remainingMs = () => 20;
  t.after(() => { OutputBudget.prototype.take = originalTake; OutputBudget.prototype.remainingMs = originalRemaining; });
  const value = h(t, { loop: true }), job = createJob(value.cwd, { stdout: 'SILENT_BUDGET\n' });
  await value.call('Monitor', { source: job.fileSource, description: 'silent watch', loopPrompt: 'silent budget' });
  assert.ok(await until(() => value.sent.some(m => m.message.content.includes('Session output budget'))));
  await value.emitBus('loop:stopped', { observationGroups: [fixtureGroup('silent budget')], reason: 'stopped' });
  const summary = value.sent.find(m => m.message.content.includes('Session output budget')); assert.equal(summary.options.triggerTurn, false); assert.ok(summary.message.content.length <= 3000); assert.equal(value.sent.some(m => m.message.details.cause === 'stopped'), false);
});
test('cross-source suppression never cancels jobs or swallows terminal reports', async t => {
  const original = OutputBudget.prototype.take; let slots = 2; OutputBudget.prototype.take = () => slots > 0 ? (--slots, true) : false; t.after(() => { OutputBudget.prototype.take = original; });
  const value = h(t), jobs = ['A', 'B', 'C'].map(name => createJob(value.cwd, { stdout: name + '\n' }));
  const receipts = await Promise.all(jobs.map((job, i) => value.call('Monitor', { source: job.source, mode: 'events', description: 'source ' + i })));
  assert.ok(await until(async () => (await value.snapshots()).reduce((n, r) => n + r.eventCount + r.globalSuppressedCount, 0) === 3));
  assert.equal(value.sent.filter(m => m.message.details.cause === 'output').length, 2); const records = await value.snapshots(); assert.ok(records.every(r => r.status === 'running' && r.job.state === 'running')); assert.equal(records.reduce((n, r) => n + r.globalSuppressedCount, 0), 1);
  slots = 1; jobs.forEach((job, i) => fs.appendFileSync(job.stdout, ['A', 'B', 'C'][i] + '-second\n'));
  assert.ok(await until(() => value.sent.filter(m => m.message.details.cause === 'output').length === 3)); assert.match(value.sent.filter(m => m.message.details.cause === 'output').at(-1).message.content, /Session output budget/);
  jobs.forEach(job => job.status('succeeded')); assert.ok(await until(() => jobResult(value).length === 3));
  for (let i = 0; i < receipts.length; i++) assert.equal(fs.readFileSync(receipts[i].details.outputPath, 'utf8'), ['A', 'B', 'C'][i] + '\n' + ['A', 'B', 'C'][i] + '-second\n');
});
