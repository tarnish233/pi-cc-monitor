/** Source rules now attach directly; no command-parent/subscription execution layer. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHarness, until, sleep } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
function harness(t) { const h = createHarness(); t.after(() => h.close()); return h; }
const output = h => h.sent.filter(m => m.message.details.cause === 'output');

test('default file observation matches stdout only but copies both streams', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'OUT\n', stderr: 'ERR\n' }); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'default' })).details;
  assert.ok(await until(() => output(h).length === 1)); assert.ok(output(h)[0].message.details.lines.includes('OUT')); assert.equal(output(h)[0].message.details.lines.some(line => line.includes('ERR')), false);
  assert.equal(fs.readFileSync(receipt.outputPath, 'utf8'), 'OUT\n'); assert.equal(fs.readFileSync(receipt.stderrPath, 'utf8'), 'ERR\n');
});
test('literal both-stream rules select errors without changing original logs', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'noise\nERROR stdout\n', stderr: 'noise stderr\nERROR stderr\n' }); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'errors', watches: [{ id: 'error', text: 'ERROR', stream: 'both' }] })).details;
  assert.ok(await until(() => output(h).length === 1)); assert.deepEqual(output(h)[0].message.details.lines, ['ERROR stdout', '[stderr] ERROR stderr']);
  assert.equal(fs.readFileSync(receipt.outputPath, 'utf8'), 'noise\nERROR stdout\n'); assert.equal(fs.readFileSync(receipt.stderrPath, 'utf8'), 'noise stderr\nERROR stderr\n'); assert.equal((await h.snapshots())[0].watches[0].fired, true);
});
test('stderr-only rules do not wake on matching stdout', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'MATCH out\n', stderr: 'MATCH err\n' }); await h.call('Monitor', { source: job.fileSource, description: 'stderr', watches: [{ id: 'err', text: 'MATCH', stream: 'stderr' }] });
  assert.ok(await until(() => output(h).length === 1)); assert.deepEqual(output(h)[0].message.details.lines, ['[stderr] MATCH err']);
});
test('once rules preserve consumed state when only notify changes', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'MATCH first\nMATCH second\n' }); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'once', watches: [{ id: 'once', text: 'MATCH', once: true }] })).details;
  assert.ok(await until(() => output(h).length === 1)); assert.deepEqual(output(h)[0].message.details.lines, ['MATCH first']);
  await h.call('Monitor', { action: 'update', id: receipt.taskId, watches: [{ id: 'once', text: 'MATCH', once: true, notify: 'context' }] }); assert.equal((await h.snapshots())[0].watches[0].fired, true);
  fs.appendFileSync(job.stdout, 'MATCH third\n'); await sleep(350); assert.equal(output(h).length, 1);
  await h.call('Monitor', { action: 'update', id: receipt.taskId, watches: [{ id: 'once', text: 'NEW', once: true }] }); assert.equal((await h.snapshots())[0].watches[0].fired, false);
  fs.appendFileSync(job.stdout, 'NEW condition\n'); assert.ok(await until(() => output(h).length === 2));
});
test('mute and exhausted rules do not stop capture or the source', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'retained\n' }); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'muted', watches: [] })).details;
  assert.ok(await until(() => fs.readFileSync(receipt.outputPath, 'utf8').includes('retained'))); assert.equal(output(h).length, 0); assert.equal((await h.snapshots())[0].status, 'running');
  await h.call('Monitor', { action: 'update', id: receipt.taskId, watches: [{ id: 'yes', text: 'YES' }] }); fs.appendFileSync(job.stdout, 'YES\n'); assert.ok(await until(() => output(h).length === 1));
});
test('invalid policy changes preserve the prior rules and source', async t => {
  const h = harness(t), job = createJob(h.cwd); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'atomic', watches: [{ id: 'one', text: 'A' }] })).details;
  await assert.rejects(h.call('Monitor', { action: 'update', id: receipt.taskId, watches: [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }] }), /Duplicate/);
  assert.deepEqual((await h.snapshots())[0].watches.map(rule => rule.id), ['one']); assert.equal((await h.snapshots())[0].source.stdout, job.stdout);
});
test('stopping one observer does not stop another observer of the same external file', async t => {
  const h = harness(t), job = createJob(h.cwd); const a = (await h.call('Monitor', { source: job.fileSource, description: 'A' })).details; const b = (await h.call('Monitor', { source: job.fileSource, description: 'B' })).details;
  await h.call('monitor_stop', { id: a.taskId }); fs.appendFileSync(job.stdout, 'STILL RUNNING\n'); assert.ok(await until(() => output(h).some(m => m.message.details.monitorId === b.taskId)));
  assert.equal(output(h).some(m => m.message.details.monitorId === a.taskId), false); assert.equal(fs.readFileSync(job.stdout, 'utf8'), 'STILL RUNNING\n');
});
test('external job terminal closes a filtered observation even after its rules are exhausted', async t => {
  const h = harness(t), job = createJob(h.cwd, { stdout: 'MATCH\n' }); await h.call('Monitor', { source: job.source, mode: 'events', description: 'job events', watches: [{ id: 'once', text: 'MATCH', once: true }] });
  assert.ok(await until(() => output(h).length === 1)); job.status('succeeded'); assert.ok(await until(() => h.sent.some(m => m.message.details.cause === 'job'))); assert.equal((await h.snapshots())[0].status, 'completed');
});
test('matching happens before display clipping and raw source bytes stay intact', async t => {
  const h = harness(t), raw = 'x'.repeat(1200) + 'ERROR-END\n', job = createJob(h.cwd, { stdout: raw }); const receipt = (await h.call('Monitor', { source: job.fileSource, description: 'long line', watches: [{ id: 'tail', text: 'ERROR-END' }] })).details;
  assert.ok(await until(() => output(h).length === 1)); assert.equal((await h.snapshots())[0].watches[0].fired, true); assert.ok(output(h)[0].message.content.length <= 3000); assert.equal(fs.readFileSync(receipt.outputPath, 'utf8'), raw);
});
test('split UTF-8 and independent stderr decoding do not corrupt matched lines', async t => {
  const h = harness(t), job = createJob(h.cwd); const receipt = (await h.call('Monitor', { source: { ...job.fileSource, from: 'now' }, description: 'unicode', watches: [{ id: 'char', text: '😀', stream: 'both' }] })).details;
  const bytes = Buffer.from('😀\n'); fs.appendFileSync(job.stdout, bytes.subarray(0, 2)); fs.appendFileSync(job.stderr, 'stderr noise\n');
  assert.ok(await until(() => fs.statSync(receipt.outputPath).size === 2)); fs.appendFileSync(job.stdout, bytes.subarray(2)); assert.ok(await until(() => output(h).length === 1)); assert.deepEqual(output(h)[0].message.details.lines, ['😀']);
});
