/** PID ownership is limited to the fixed local SSH observation helper. */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { loadModule } from './helpers.mjs';

const realSpawn = cp.spawn; let spawnImpl = realSpawn;
cp.spawn = (...args) => spawnImpl(...args); syncBuiltinESMExports();
const { SshSourceReader } = await loadModule('ssh-reader.ts');
const PID = 424242;
function child() {
  const value = Object.assign(new EventEmitter(), { pid: PID, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: false, kill() { throw new Error('no direct fallback expected'); } });
  value.stdin.write = line => { const request = JSON.parse(line); queueMicrotask(() => value.stdout.write(JSON.stringify({ requestId: request.requestId, identity: '1:1', size: 0, offset: request.offset ?? 0, data: '', guard: '' }) + '\n')); return true; };
  return value;
}
function fixture(t) {
  const helper = child(), originalKill = process.kill; let live = true, phase = 'owned'; const requests = [];
  spawnImpl = () => helper; process.kill = (pid, signal) => {
    assert.equal(pid, -PID, 'only the allocated observation helper group can be probed/signalled'); requests.push({ phase, signal });
    if (signal === 0) { if (!live) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true; } live = false; return true;
  };
  t.after(() => { spawnImpl = realSpawn; process.kill = originalKill; helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy(); });
  const reader = new SshSourceReader('fixture-host');
  return { helper, reader, requests, reuse() { live = true; phase = 'reused'; }, live() { return live; } };
}
test('late close after confirmed observation stop never probes/signals a reused PID', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); await f.reader.read({ path: '/literal/source', maxBytes: 10 }); assert.equal(await f.reader.stop(), true); assert.equal(f.reader.pid, undefined);
  f.reuse(); f.helper.emit('close', 0); await new Promise(r => setTimeout(r, 30)); assert.equal(f.requests.filter(r => r.phase === 'reused').length, 0); assert.equal(f.reader.active, false);
});
test('an ended SSH helper with a living owned proxy group is still cleaned up', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); await f.reader.read({ path: '/literal/source', maxBytes: 10 }); f.helper.emit('close', 0);
  const end = Date.now() + 1000; while (f.reader.pid !== undefined && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.reader.active, false); assert.ok(f.requests.some(r => r.signal === 'SIGTERM')); assert.equal(f.reader.pid, undefined);
});
test('helper stop does not accept or consult any business job PID', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); await f.reader.read({ path: '/literal/source', maxBytes: 10 }); await f.reader.stop();
  assert.ok(f.requests.length > 0); assert.ok(f.requests.every(r => r.signal === 0 || r.signal === 'SIGTERM' || r.signal === 'SIGKILL'));
});
