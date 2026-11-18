import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadModule, loadValidators, assertJsonRoundTrip } from './helpers.mjs';
import { createHarness, until, sleep, groupAlive } from './runtime-harness.mjs';
const { RateLimiter } = await loadModule('stream.ts');
const { compile, validateToolArguments } = await loadValidators();

async function producer(h) {
  const inbox = path.join(h.cwd, 'inbox.json'), finish = path.join(h.cwd, 'finish');
  const code = `const fs=require('fs');process.on('SIGTERM',()=>{});console.log('BEFORE');setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))process.exit(0);if(!fs.existsSync(${JSON.stringify(inbox)}))return;let m=JSON.parse(fs.readFileSync(${JSON.stringify(inbox)},'utf8'));fs.unlinkSync(${JSON.stringify(inbox)});for(let r of m.lines)(r.stream==='stderr'?process.stderr:process.stdout).write(r.text+'\\n');console.log('ACK_'+m.id)},10)`;
  const job = (await h.call('Monitor', { mode: 'completion', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`, description: 'producer', persistent: true })).details;
  assert.ok(await until(() => fs.existsSync(job.outputPath) && fs.readFileSync(job.outputPath, 'utf8').includes('BEFORE')));
  const pid = (await h.snapshots())[0].pid;
  let id = 0;
  return { job, pid, finish,
    async emit(...lines) {
      const message = { id: ++id, lines: lines.map((line) => typeof line === 'string' ? { stream: 'stdout', text: line } : line) };
      fs.writeFileSync(inbox + '.tmp', JSON.stringify(message)); fs.renameSync(inbox + '.tmp', inbox);
      assert.ok(await until(() => fs.readFileSync(job.outputPath, 'utf8').includes(`ACK_${message.id}`)));
    },
  };
}
const attach = (h, p, extra = {}) => h.call('Monitor', { source: { monitorId: p.job.taskId }, description: 'observer', persistent: true, ...extra });
const outputs = (h, id) => h.sent.filter((m) => m.message.details.monitorId === id && m.message.details.cause === 'output');

test('attachment owns no process, sees future output only, and matches stdout/stderr before clipping', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  const rules = [{ id: 'out', text: 'OUT', notify: 'context' }, { id: 'error', text: 'ERROR', stream: 'both', notify: 'turn' }];
  const observer = (await attach(h, p, { watches: rules })).details;
  const snapshot = (await h.snapshots()).find((r) => r.id === observer.taskId);
  assert.equal(snapshot.pid, undefined); assert.equal(snapshot.kind, 'source');
  assert.equal(snapshot.sourceId, p.job.taskId); assert.equal(observer.outputPath, p.job.outputPath);
  await p.emit('OUT progress', { stream: 'stderr', text: 'X'.repeat(800) + 'ERROR at tail' });
  assert.ok(await until(() => outputs(h, observer.taskId).length));
  const message = outputs(h, observer.taskId)[0];
  assert.ok(!message.message.content.includes('BEFORE'));
  assert.ok(message.message.content.includes('OUT progress'));
  assert.ok(message.message.content.includes('[stderr]'));
  assert.equal(message.message.details.eventCount, 2, 'a match beyond the displayed 500 chars is still observed');
  assert.equal(message.options.triggerTurn, true);
  assert.ok(message.message.content.length <= 3000);
  assertJsonRoundTrip((await h.call('monitor_list', {})).structuredContent);
  assert.ok(compile(h.tools.get('Monitor').outputSchema).check({ ...observer }));
  assert.equal((await h.snapshots()).find((r) => r.id === p.job.taskId).pid, p.pid);
});

test('explicit update changes rules atomically without restarting work or resetting unchanged once state', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  const ready = { id: 'ready', text: 'READY', once: true, notify: 'context' };
  const observer = (await attach(h, p, { watches: [ready] })).details;
  await p.emit('READY'); assert.ok(await until(() => outputs(h, observer.taskId).length === 1));
  const before = (await h.snapshots()).find((r) => r.id === observer.taskId);
  const args = { action: 'update', id: observer.taskId, watches: [ready, { id: 'new', text: 'NEW', notify: 'context' }] };
  assert.ok(compile(h.tools.get('Monitor').parameters).check(args), 'update needs id but no description');
  const updated = await h.call('Monitor', args);
  assert.equal(updated.details.updated, true);
  assert.equal(updated.details.taskId, observer.taskId);
  const after = (await h.snapshots()).find((r) => r.id === observer.taskId);
  assert.equal(after.createdAt, before.createdAt); assert.equal(after.timeoutMs, before.timeoutMs);
  assert.equal(after.watches.find((r) => r.id === 'ready').fired, true);
  await p.emit('READY again', 'NEW'); assert.ok(await until(() => outputs(h, observer.taskId).length === 2));
  assert.equal(outputs(h, observer.taskId).at(-1).message.details.eventCount, 2, 'old once did not trigger again');
  assert.ok(outputs(h, observer.taskId).every((m) => m.options.triggerTurn === false));
  assert.equal((await h.snapshots()).find((r) => r.id === p.job.taskId).pid, p.pid);
  const state = (await h.snapshots()).find((r) => r.id === observer.taskId);
  await assert.rejects(h.call('Monitor', { ...args, watches: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }] }), /Duplicate/);
  assert.deepEqual((await h.snapshots()).find((r) => r.id === observer.taskId), state);
  await h.call('Monitor', { action: 'update', id: observer.taskId, watches: [] });
  await p.emit('NEW hidden'); await sleep(250);
  assert.equal(outputs(h, observer.taskId).length, 2);
  assert.equal(groupAlive(p.pid), true);
});

test('omitted rules observe stdout; [] explicitly mutes, and policy ceiling cannot be bypassed', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  const observer = (await attach(h, p, { notify: { output: 'context' } })).details;
  await p.emit('VISIBLE', { stream: 'stderr', text: 'IGNORED_STDERR' });
  assert.ok(await until(() => outputs(h, observer.taskId).length));
  assert.ok(outputs(h, observer.taskId).every((m) => m.options.triggerTurn === false));
  assert.ok(!outputs(h, observer.taskId).some((m) => m.message.content.includes('IGNORED_STDERR')));
  await h.call('Monitor', { action: 'update', id: observer.taskId, watches: [{ id: 'loud', text: 'LOUD', notify: 'turn' }], notify: { output: 'none' } });
  const count = outputs(h, observer.taskId).length;
  await p.emit('LOUD'); await sleep(250); assert.equal(outputs(h, observer.taskId).length, count);
});

test('stopping the source preserves buffered observer matches as context, never as a wakeup', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  const observer = (await attach(h, p, { watches: [{ id: 'pending', text: 'PENDING_MATCH' }] })).details;
  await p.emit('PENDING_MATCH');
  assert.equal((await h.call('monitor_stop', { id: p.job.taskId })).details.stopped, true);
  const match = outputs(h, observer.taskId).find((m) => m.message.content.includes('PENDING_MATCH'));
  assert.ok(match, 'source stop must not discard the observer batch that already arrived');
  assert.equal(match.options.triggerTurn, false, 'a user stop is context-only');
  assert.equal((await h.snapshots()).find((r) => r.id === observer.taskId).status, 'exited');
  assert.equal((await h.snapshots()).find((r) => r.id === p.job.taskId).status, 'stopped');
  assert.equal(groupAlive(p.pid), false);
});

for (const reason of ['stop', 'timeout', 'flood']) {
  test(`${reason} ends only the observer, never the source command`, async (t) => {
    const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
    const observer = (await attach(h, p, { watches: [{ id: 'go', text: 'GO' }], ...(reason === 'timeout' ? { persistent: false, timeout_ms: 1000 } : {}) })).details;
    if (reason === 'stop') assert.equal((await h.call('monitor_stop', { id: observer.taskId })).details.stopped, true);
    if (reason === 'flood') {
      const original = RateLimiter.prototype.take;
      try {
        RateLimiter.prototype.take = () => ({ deliver: false, flood: true, suppressedForMs: 31000 });
        await p.emit('GO');
        assert.ok(await until(async () => (await h.snapshots()).find((r) => r.id === observer.taskId).status === 'flooded'));
      } finally { RateLimiter.prototype.take = original; }
    }
    const expected = reason === 'timeout' ? 'timed_out' : reason === 'flood' ? 'flooded' : 'stopped';
    assert.ok(await until(async () => (await h.snapshots()).find((r) => r.id === observer.taskId).status === expected));
    const work = (await h.snapshots()).find((r) => r.id === p.job.taskId);
    assert.equal(work.status, 'running'); assert.equal(work.pid, p.pid); assert.equal(groupAlive(p.pid), true);
    await p.emit('AFTER_OBSERVER_END');
    assert.ok(fs.readFileSync(p.job.outputPath, 'utf8').includes('AFTER_OBSERVER_END'));
    await assert.rejects(h.call('Monitor', { action: 'update', id: observer.taskId, watches: [] }), /not running/);
  });
}

test('source completion closes observations silently and reports the authoritative work result once', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  const observer = (await attach(h, p, { watches: [{ id: 'end', text: 'LAST', notify: 'context' }] })).details;
  await p.emit('LAST'); fs.writeFileSync(p.finish, 'finish');
  assert.ok(await until(async () => (await h.snapshots()).find((r) => r.id === p.job.taskId).status === 'completed'));
  assert.equal((await h.snapshots()).find((r) => r.id === observer.taskId).status, 'exited');
  assert.equal(h.sent.filter((m) => m.message.details.cause === 'exit' && m.message.details.monitorId === p.job.taskId).length, 1);
  assert.equal(h.sent.filter((m) => m.message.details.cause === 'exit' && m.message.details.monitorId === observer.taskId).length, 0);
  assert.equal(h.sent.filter((m) => m.options.triggerTurn === true).length, 1);
  assert.equal(groupAlive(p.pid), false);
});

test('update is explicit, narrow and never falls back to creating work; exactly three tools remain', async (t) => {
  const h = createHarness(); t.after(() => h.close()); const p = await producer(h);
  assert.deepEqual([...h.tools.keys()].sort(), ['Monitor', 'monitor_list', 'monitor_stop']);
  for (const args of [{ action: 'update', id: 'missing', notify: {} }, { id: p.job.taskId, command: 'echo BAD', description: 'bad' }, { action: 'update', id: p.job.taskId, command: 'echo BAD' }, { action: 'update', id: p.job.taskId, timeout_ms: 5000 }, { action: 'update', id: p.job.taskId, watches: [] }]) await assert.rejects(h.call('Monitor', args));
  assert.equal((await h.snapshots()).length, 1);
  assert.equal((await h.snapshots())[0].pid, p.pid);
  await assert.rejects(attach(h, { job: { taskId: 'foreign' } }), /in this session/);
  await assert.rejects(attach(h, p, { mode: 'completion' }), /requires command/);
  const observer = (await attach(h, p)).details;
  await assert.rejects(attach(h, { job: { taskId: observer.taskId } }), /running command/);
  assert.ok(!compile(h.tools.get('Monitor').parameters).check({ action: 'update', notify: {} }));
});

test('shutdown disarms a timed source observer: timeout and batch timers cannot outlive monitors.clear()', async (t) => {
  const h = createHarness();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await h.close(); } };
  t.after(close);
  const p = await producer(h);
  const timeoutMs = 123456; // distinctive: only the observer's deadline uses it
  const { BATCH_WINDOW_MS } = await loadModule('index.ts');
  const setT = globalThis.setTimeout, clearT = globalThis.clearTimeout;
  const armed = new Set();
  globalThis.setTimeout = function(fn, ms, ...rest) {
    const wrapped = typeof fn === 'function' ? (...args) => { armed.delete(timer); fn(...args); } : fn;
    // Park the batch window so a slow ACK write cannot let the real 200ms timer fire before the assertion; the handle stays real and clearable.
    const timer = setT.call(globalThis, wrapped, ms === BATCH_WINDOW_MS ? 60000 : ms, ...rest);
    if (ms === timeoutMs || ms === BATCH_WINDOW_MS) armed.add(timer);
    return timer;
  };
  globalThis.clearTimeout = function(timer) { armed.delete(timer); return clearT.call(globalThis, timer); };
  try {
    await attach(h, p, { persistent: false, timeout_ms: timeoutMs, watches: [{ id: 'out', text: 'OUT', notify: 'context' }] });
    await p.emit('OUT now'); // arms the batch window without waiting for the flush
    assert.ok(await until(() => armed.size === 2), 'observer timeout and batch window are armed');
    await close();
    assert.equal(armed.size, 0, 'shutdown must disarm source-observer timers');
  } finally {
    globalThis.setTimeout = setT; globalThis.clearTimeout = clearT;
  }
});
