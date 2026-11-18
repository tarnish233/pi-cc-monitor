import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

// jiti captures the named spawn import when process.ts first loads, so the
// fake must be reachable through a delegate installed before that load.
const realSpawn = cp.spawn;
let spawnImpl = realSpawn;
cp.spawn = (...args) => spawnImpl(...args);
syncBuiltinESMExports();
const { createHarness, until, sleep } = await import('./runtime-harness.mjs');

const FAKE_PID = 424242;
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: FAKE_PID, stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
    kill() { throw new Error('no direct child fallback expected'); },
  });
}

// These fakes model POSIX process groups; Windows would use real taskkill.
test('late close after a confirmed stop never probes or signals a reused PID', { skip: process.platform === 'win32' }, async (t) => {
  const h = createHarness();
  const child = fakeChild();
  const kill = process.kill;
  let live = true, phase = 'owned';
  const requests = [];
  spawnImpl = () => child;
  process.kill = (pid, signal) => {
    assert.equal(pid, -FAKE_PID, 'no real PID may be signalled');
    requests.push({ phase, signal });
    if (signal === 0) { if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true; }
    live = false; return true;
  };
  syncBuiltinESMExports();
  t.after(() => { spawnImpl = realSpawn; process.kill = kill; syncBuiltinESMExports(); child.stdout.destroy(); child.stderr.destroy(); });
  try {
    const job = (await h.call('Monitor', { mode: 'completion', command: ':', description: 'fake PID lifetime', persistent: true })).details;
    const stopped = await h.call('monitor_stop', { id: job.taskId });
    assert.equal(stopped.details.stopped, true);
    assert.equal((await h.snapshots())[0].resourceActive, undefined);
    // The stopped group is gone and a different group has reused the ID.
    phase = 'reused'; live = true;
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    assert.ok(await until(async () => (await h.snapshots())[0].exitCode === 0), 'the late exit code still corrects the record');
    await sleep(50);
    assert.equal(requests.filter((r) => r.phase === 'reused').length, 0, 'a released resource must not be probed or signalled again');
    const record = (await h.snapshots())[0];
    assert.equal(record.status, 'stopped');
    assert.equal(h.sent.filter((m) => m.message.details.cause === 'stopped').length, 1, 'exactly one closing notice');
    assert.equal(h.sent.length, 1);
  } finally { await h.close(); }
});

test('natural exit with a living same-group child still cleans the group up', { skip: process.platform === 'win32' }, async (t) => {
  const h = createHarness();
  const child = fakeChild();
  const kill = process.kill;
  let live = true;
  const requests = [];
  spawnImpl = () => child;
  process.kill = (pid, signal) => {
    assert.equal(pid, -FAKE_PID, 'no real PID may be signalled');
    requests.push({ signal });
    if (signal === 0) { if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true; }
    live = false; return true;
  };
  syncBuiltinESMExports();
  t.after(() => { spawnImpl = realSpawn; process.kill = kill; syncBuiltinESMExports(); child.stdout.destroy(); child.stderr.destroy(); });
  try {
    const job = (await h.call('Monitor', { mode: 'completion', command: ':', description: 'natural exit, living group', persistent: true })).details;
    // The shell exits but a background child keeps the group alive.
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
    assert.ok(await until(async () => (await h.snapshots())[0].resourceActive === undefined), 'the living group must be released');
    assert.ok(requests.some((r) => r.signal === 'SIGTERM'), 'exit-path cleanup must still signal the owned group');
    const record = (await h.snapshots())[0];
    assert.equal(record.status, 'completed');
    assert.equal(record.exitCode, 0);
    assert.equal(h.sent.length, 1);
    assert.equal(job.taskId, record.id);
  } finally { await h.close(); }
});