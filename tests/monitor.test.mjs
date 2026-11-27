/** Observation-only public API, schema, socket and resource contracts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixtureGroup, createHarness, until, sleep } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
import { assertJsonRoundTrip, jsonSchemaProblems, loadModule, loadValidators, unsupportedTypeboxUsages } from './helpers.mjs';
const mod = await loadModule('index.ts');
const stream = await loadModule('stream.ts');
const { compile, validateToolArguments } = await loadValidators();
const check = (schema, value) => compile(schema).check(value);

function socketFixture(t) {
  const saved = globalThis.WebSocket, sockets = [];
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 1; this.handlers = new Map(); sockets.push(this); }
    addEventListener(name, callback) { const list = this.handlers.get(name) ?? []; list.push(callback); this.handlers.set(name, list); }
    emit(name, event) { for (const callback of this.handlers.get(name) ?? []) callback(event); }
    close() { this.readyState = 3; this.emit('close', { code: 1000 }); }
  }
  globalThis.WebSocket = Socket; t.after(() => { globalThis.WebSocket = saved; }); return sockets;
}
function harness(t, options) { const h = createHarness(options); t.after(() => h.close()); return h; }

 test('registers only observation/start-policy, stop and list tools', t => {
  const h = harness(t); assert.deepEqual([...h.tools.keys()], ['Monitor', 'monitor_stop', 'monitor_list']); assert.ok(h.handlers.has('session_shutdown'));
  assert.equal(h.tools.get('Monitor').annotations.readOnlyHint, true); assert.equal(h.tools.get('monitor_stop').annotations.destructiveHint, false);
});
test('public parameters expose typed sources, not command/legacy ws/monitorId execution', t => {
  const h = harness(t), schema = h.tools.get('Monitor').parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['action', 'description', 'id', 'loopPrompt', 'mode', 'notify', 'persistent', 'source', 'timeout_ms', 'watches']);
  assert.equal(schema.properties.timeout_ms.minimum, 1000); assert.equal(schema.properties.timeout_ms.maximum, 7200000);
  for (const args of [{ description: 'x' }, { command: 'echo nope', description: 'x' }, { ws: { url: 'ws://x' }, description: 'x' }, { source: { monitorId: 'old' }, description: 'x' }]) assert.equal(check(schema, args), false);
});
test('WebSocket watch notify is a string, while the top-level policy is an object', t => {
  const schema = harness(t).tools.get('Monitor').parameters;
  const watch = { id: 'signal', text: 'READY', notify: 'context' };
  const args = { source: { kind: 'ws', url: 'ws://127.0.0.1:8765/qa' }, description: 'ready', watches: [watch], notify: { output: 'turn' } };
  assert.match(schema.properties.watches.items.properties.notify.description, /string, not an object/);
  assert.match(schema.properties.notify.description, /Live output object/);
  assert.equal(check(schema, args), true);
  assert.equal(check(schema, { ...args, watches: [{ ...watch, notify: args.notify }] }), false);
  assert.equal(check(schema, { ...args, source: { ...args.source, from: 'tail' } }), false);
});
test('invalid inputs are rejected before allocating an observation', async t => {
  const h = harness(t);
  for (const args of [{ description: 'x' }, { source: { kind: 'file' }, description: 'x' }, { source: { kind: 'file', stdout: 'x\rhidden' }, description: 'x' }, { source: { kind: 'file', stdout: 'x', script: 'touch NO' }, description: 'x' }, { source: { kind: 'job', manifest: 'x', pid: process.pid }, description: 'x' }, { source: { kind: 'file', stdout: 'x' }, description: 'x', id: 'old' }]) await assert.rejects(h.call('Monitor', args));
  assert.deepEqual(await h.snapshots(), []);
});
test('all tool schemas are JSON-visible and use only features Pi validates', t => {
  const h = harness(t); for (const tool of h.tools.values()) { assertJsonRoundTrip(tool.parameters); assertJsonRoundTrip(tool.outputSchema); assert.deepEqual(jsonSchemaProblems(tool.parameters), []); assert.deepEqual(jsonSchemaProblems(tool.outputSchema), []); }
  assert.deepEqual(unsupportedTypeboxUsages(), []);
});
test('Pi argument coercion is honored while file metadata remains strict', async t => {
  const h = harness(t), job = createJob(h.cwd), tool = h.tools.get('Monitor');
  const args = validateToolArguments(tool, { name: 'Monitor', arguments: { source: job.source, description: 'coerced', timeout_ms: '1000', persistent: 'true' } });
  assert.equal(args.timeout_ms, 1000); assert.equal(args.persistent, true);
  const receipt = (await h.call('Monitor', args)).details; assert.equal(receipt.persistent, true); assert.equal(receipt.timeoutMs, 0);
});
test('observation deadline bounds follow mode and never become job timeouts', async t => {
  const h = harness(t), job = createJob(h.cwd);
  await assert.rejects(h.call('Monitor', { source: job.fileSource, description: 'short', timeout_ms: 999 }));
  await assert.rejects(h.call('Monitor', { source: job.fileSource, description: 'long', timeout_ms: 3600001 }));
  await assert.rejects(h.call('Monitor', { source: job.source, description: 'long', timeout_ms: 7200001 }));
  // One source of truth: prompts.ts MONITOR_TIMEOUTS, not a second exported alias.
  assert.equal((await h.call('Monitor', { source: job.source, description: 'allowed', timeout_ms: 7200000 })).details.timeoutMs, (await loadModule('prompts.ts')).MONITOR_TIMEOUTS.completion.maxMs);
});
test('completion requires a status-bearing job, not EOF or a socket close', async t => {
  const h = harness(t), job = createJob(h.cwd);
  for (const source of [job.fileSource, { kind: 'ws', url: 'ws://x.example' }]) await assert.rejects(h.call('Monitor', { source, mode: 'completion', description: 'no result inference' }), /job manifest/);
});
test('structured receipts/list/stop match schemas and contain no bare business PID/exit', async t => {
  const h = harness(t), job = createJob(h.cwd); const tool = h.tools.get('Monitor');
  const started = await h.call('Monitor', { source: job.source, description: 'structured' }); assert.deepEqual(started.structuredContent, started.details); assert.ok(check(tool.outputSchema, started.structuredContent));
  const list = await h.call('monitor_list', {}); assert.ok(check(h.tools.get('monitor_list').outputSchema, list.structuredContent)); assertJsonRoundTrip(list.structuredContent); structuredClone(list.structuredContent);
  assert.equal('pid' in list.details.monitors[0], false); assert.equal('exitCode' in list.details.monitors[0], false);
  const stop = await h.call('monitor_stop', { id: started.details.taskId }); assert.ok(check(h.tools.get('monitor_stop').outputSchema, stop.structuredContent)); assert.match(stop.content[0].text, /not cancelled/);
});
test('only events support rule updates; update never changes source or lifetime', async t => {
  const h = harness(t), job = createJob(h.cwd); const observed = (await h.call('Monitor', { source: job.fileSource, description: 'rules' })).details;
  const updated = await h.call('Monitor', { action: 'update', id: observed.taskId, watches: [], notify: { output: 'context' } }); assert.equal(updated.details.updated, true); assert.equal(updated.details.source.stdout, job.stdout);
  await assert.rejects(h.call('Monitor', { action: 'update', id: observed.taskId, source: job.source }), /source\/lifetime/);
  const completion = (await h.call('Monitor', { source: job.source, description: 'result' })).details; await assert.rejects(h.call('Monitor', { action: 'update', id: completion.taskId, watches: [] }), /events/);
  await assert.rejects(h.call('Monitor', { action: 'update', id: 'missing', notify: { output: 'none' } }));
});
test('notify accepts live output only and cannot silence terminal outcomes', async t => {
  const h = harness(t), job = createJob(h.cwd);
  await assert.rejects(h.call('Monitor', { source: job.source, description: 'invalid policy', notify: { terminal: 'context' } }), /end, failure and stop/);
  const observed = (await h.call('Monitor', { source: job.source, description: 'quiet', notify: { output: 'none' } })).details; job.status('succeeded'); assert.ok(await until(() => h.sent.some(s => s.message.details?.cause === 'job')));
  assert.equal(h.sent.find(s => s.message.details?.cause === 'job').options.triggerTurn, true); assert.equal(observed.notify.terminal, 'turn');
});
test('planned source creation is observed even with from=now', async t => {
  const h = harness(t), file = path.join(h.cwd, 'later.log'); await h.call('Monitor', { source: { kind: 'file', stdout: file, from: 'now' }, description: 'new file' });
  fs.writeFileSync(file, 'NEW FILE EVENT\n'); assert.ok(await until(() => h.sent.some(s => s.message.details?.lines?.includes('NEW FILE EVENT'))));
});
test('a source failure is not a business verdict and stop is sent exactly once', async t => {
  const h = harness(t), file = path.join(h.cwd, 'missing.log'); const observed = (await h.call('Monitor', { source: { kind: 'file', stdout: file }, description: 'missing source' })).details;
  assert.ok(await until(async () => Boolean((await h.snapshots())[0].sourceError))); assert.equal((await h.snapshots())[0].status, 'running');
  await h.call('monitor_stop', { id: observed.taskId }); await sleep(40); assert.equal(h.sent.filter(s => s.message.details?.cause === 'stopped').length, 1);
  assert.equal((await h.call('monitor_stop', { id: observed.taskId })).details.stopped, false);
});
for (const loaded of [true, false]) test('loop binding is ' + (loaded ? 'kept' : 'ignored') + ' according to binding response', async t => {
  const h = harness(t, { loop: loaded }), job = createJob(h.cwd);
  if (!loaded) h.tools.set('cron_delete', { name: 'cron_delete' });
  const response = await h.call('Monitor', { source: job.fileSource, description: 'binding', loopPrompt: 'watch job', persistent: true });
  const observed = response.details;
  assert.equal(response.content[0].text.includes('No Loop activity bound'), !loaded);
  const snapshot = (await h.snapshots())[0]; assert.equal(snapshot.loopPrompt, loaded ? 'watch job' : undefined);
  if (loaded) { await h.emitBus('loop:stopped', { observationGroups: [fixtureGroup('watch job')], reason: 'stopped' }); assert.equal(h.sent.filter(s => s.message.details?.cause === 'stopped').length, 0); assert.equal((await h.snapshots())[0].status, 'stopped'); }
  assert.ok(observed.taskId);
});
test('a different binding protocol version cannot assign affinity', async t => {
  const h = harness(t), job = createJob(h.cwd);
  h.pi.events.on('loop:bind-observation', request => { request.acceptedVersion = 2; request.observationGroup = 'other-version'; });
  const response = await h.call('Monitor', { source: job.fileSource, description: 'binding', loopPrompt: 'watch job', persistent: true });
  assert.match(response.content[0].text, /No Loop activity bound/);
  await h.emitBus('loop:stopped', { observationGroups: ['other-version'] });
  assert.equal((await h.snapshots())[0].status, 'running');
});
test('an unrelated loop stop leaves observation alone', async t => {
  const h = harness(t, { loop: true }), job = createJob(h.cwd); await h.call('Monitor', { source: job.fileSource, description: 'binding', loopPrompt: 'keep', persistent: true }); await h.emitBus('loop:stopped', { observationGroups: [fixtureGroup('other')], reason: 'stopped' }); assert.equal((await h.snapshots())[0].status, 'running');
});
test('shutdown/reload disarms callbacks; no source output reaches the stale session', async t => {
  const h = harness(t), job = createJob(h.cwd); await h.call('Monitor', { source: job.fileSource, description: 'reload', persistent: true });
  await h.emit('session_shutdown', { reason: 'reload' }); const before = h.sent.length; fs.appendFileSync(job.stdout, 'AFTER RELOAD\n'); await sleep(300); assert.equal(h.sent.length, before); await assert.rejects(h.call('Monitor', { source: job.source, description: 'stale' }), /ended/);
});
test('copy allocation failure leaves no running record and does not touch real sources', async t => {
  const h = harness(t), job = createJob(h.cwd), saved = fs.openSync;
  fs.openSync = (file, ...args) => { if (String(file).endsWith('.out.log')) throw new Error('ENOSPC fixture'); return saved(file, ...args); };
  try { await assert.rejects(h.call('Monitor', { source: job.fileSource, description: 'copy failure' }), /ENOSPC/); }
  finally { fs.openSync = saved; }
  assert.equal((await h.snapshots()).some(s => s.status === 'running'), false); assert.equal(fs.readFileSync(job.stdout, 'utf8'), '');
});
test('one WebSocket text frame with newlines is one event; blank frames are copy-only', async t => {
  const sockets = socketFixture(t), h = harness(t); const observed = (await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example' }, description: 'frames' })).details;
  sockets[0].emit('message', { data: 'first\nsecond' }); sockets[0].emit('message', { data: '   ' });
  assert.ok(await until(() => h.sent.some(s => s.message.details?.eventCount === 1))); assert.equal((await h.snapshots())[0].eventCount, 1);
  sockets[0].close(); assert.ok(await until(() => h.sent.some(s => s.message.details?.cause === 'closed'))); assert.match(fs.readFileSync(observed.outputPath, 'utf8'), /first\nsecond\n   /);
});
test('socket cancellation closes only the local connection and confirms cleanup', async t => {
  const sockets = socketFixture(t), h = harness(t); const observed = (await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example', protocols: ['feed'] }, description: 'frames', persistent: true })).details;
  assert.deepEqual(sockets[0].protocols, ['feed']); const stopped = await h.call('monitor_stop', { id: observed.taskId }); assert.equal(stopped.details.stopped, true); assert.equal(sockets[0].readyState, 3); assert.match(stopped.content[0].text, /remote service not stopped/);
});
test('failed socket construction is a launch failure, not a zombie', async t => {
  const saved = globalThis.WebSocket; globalThis.WebSocket = class { constructor() { throw new Error('connection construction failed'); } }; t.after(() => globalThis.WebSocket = saved);
  const h = harness(t); await assert.rejects(h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example' }, description: 'bad socket' }), /construction failed/); assert.equal((await h.snapshots()).some(s => s.status === 'running'), false);
});
test('event text/envelope budgets preserve counts and safe descriptions', async t => {
  const sockets = socketFixture(t), h = harness(t); await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example' }, description: 'wide\n\u001b[31m'.repeat(100), persistent: true });
  for (let i = 0; i < 40; i++) sockets[0].emit('message', { data: 'ROW' + i + 'x'.repeat(1000) }); assert.ok(await until(() => h.sent.some(s => s.message.details?.eventCount === 40)));
  const message = h.sent.find(s => s.message.details?.eventCount === 40).message; assert.ok(message.content.length <= stream.MAX_BATCH_CHARS); assert.equal(message.content.split('\n')[0].includes('\u001b'), false);
});
test('start text is an observation receipt, not a business launch or result', async t => {
  const h = harness(t), job = createJob(h.cwd); const result = await h.call('Monitor', { source: job.source, description: 'observe', persistent: true });
  assert.match(result.content[0].text, /Observation only/); assert.match(result.content[0].text, /Observation receipt only/); assert.match(result.content[0].text, /until you stop it or the session ends/);
  assert.match(h.tools.get('Monitor').description, /never starts, cancels, restarts/); assert.match(h.tools.get('Monitor').description, /external runner/);
});

test('structured source snapshots cannot mutate the live socket observation', async t => {
  socketFixture(t); const h = harness(t);
  const started = (await h.call('Monitor', { source: { kind: 'ws', url: 'ws://x.example', protocols: ['feed'] }, description: 'immutable source' })).details;
  started.source.protocols.push('not-live'); const list = await h.snapshots(); assert.deepEqual(list[0].source.protocols, ['feed']);
  list[0].source.protocols.push('also-not-live'); assert.deepEqual((await h.snapshots())[0].source.protocols, ['feed']);
});
