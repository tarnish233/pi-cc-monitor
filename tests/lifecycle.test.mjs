import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadModule } from './helpers.mjs';
import { createHarness, startReady, groupAlive, until } from './runtime-harness.mjs';

const proc = await loadModule('process.ts');

test('stop waits for TERM-ignoring owned process; simultaneous requests share one closing outcome', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const job = await startReady(h);
  const a = h.call('monitor_stop', { id: job.taskId });
  const b = h.call('monitor_stop', { id: job.taskId });
  assert.equal((await h.snapshots())[0].status, 'stopping');
  assert.equal((await h.snapshots())[0].endedAt, undefined);
  const results = await Promise.all([a, b]);
  assert.ok(results.every((r) => r.details.stopped));
  assert.equal(groupAlive(job.pid), false);
  assert.equal((await h.snapshots())[0].status, 'stopped');
  assert.equal(h.sent.filter((r) => r.message.details.cause === 'stopped').length, 1);
});

test('permission failure is not disappearance; failed stop stays listed and retryable', async (t) => {
  const h = createHarness(); t.after(() => h.close());
  const job = await startReady(h);
  const kill = process.kill, childKill = ChildProcess.prototype.kill;
  try {
    process.kill = function(pid, signal) {
      if (pid === -job.pid && signal !== 0) throw Object.assign(new Error('injected signal denial'), { code: 'EPERM' });
      return kill.call(process, pid, signal);
    };
    ChildProcess.prototype.kill = function(signal) { return this.pid === job.pid ? false : childKill.call(this, signal); };
    const result = await h.call('monitor_stop', { id: job.taskId });
    assert.equal(result.details.stopped, false);
    assert.equal(result.details.status, 'stop_timeout');
    assert.equal(result.isError, true);
    const record = (await h.snapshots())[0];
    assert.equal(record.status, 'stop_timeout');
    assert.equal(record.endedAt, undefined);
    assert.equal(groupAlive(job.pid), true);
  } finally { process.kill = kill; ChildProcess.prototype.kill = childKill; }
  // Let the owned resource disappear without a retry: status converges, but
  // this same logical stop must not deliver a second terminal notice.
  assert.equal(h.sent.filter((m) => m.message.details.cause === 'stopped' || m.message.details.cause === 'stop_timeout').length, 1);
  process.kill(-job.pid, 'SIGKILL');
  assert.ok(await until(async () => (await h.snapshots())[0].status === 'stopped'));
  assert.equal(h.sent.filter((m) => m.message.details.cause === 'stopped' || m.message.details.cause === 'stop_timeout').length, 1);
  assert.equal((await h.call('monitor_stop', { id: job.taskId })).details.stopped, false);
  assert.equal(groupAlive(job.pid), false);
});

test('group probe distinguishes ESRCH from EPERM without root/permission-dependent skips', () => {
  if (process.platform === 'win32') {
    assert.equal(proc.processGroupAlive({ pid: 987654, exitCode: 0, signalCode: null }), false);
    return;
  }
  const original = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('injected'), { code: 'EPERM' }); };
    assert.equal(proc.processGroupAlive({ pid: 987654 }), true);
    process.kill = () => { throw Object.assign(new Error('injected'), { code: 'ESRCH' }); };
    assert.equal(proc.processGroupAlive({ pid: 987654 }), false);
  } finally { process.kill = original; }
});

for (const shutdown of ['graceful', 'exit-while-stopping']) {
  test(`${shutdown}: host exit cannot lose the SIGKILL backstop`, async (t) => {
    const h = createHarness(); t.after(() => h.close());
    const file = path.join(h.cwd, 'owner.mjs');
    const harnessUrl = pathToFileURL(path.resolve(import.meta.dirname, 'runtime-harness.mjs')).href;
    fs.writeFileSync(file, `import {createHarness,startReady} from ${JSON.stringify(harnessUrl)};\nconst h=createHarness(); const j=await startReady(h); console.log(JSON.stringify(j));\n${shutdown === 'graceful' ? "await h.close();" : "void h.call('monitor_stop',{id:j.taskId});"}\nprocess.exit(0);\n`);
    const owner = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', pid;
    owner.stdout.on('data', (b) => { output += b; }); owner.stderr.on('data', (b) => { errors += b; });
    t.after(() => { owner.kill('SIGKILL'); if (pid && groupAlive(pid)) process.kill(-pid, 'SIGKILL'); });
    const [code] = await once(owner, 'exit');
    const job = JSON.parse(output.trim()); pid = job.pid;
    assert.equal(code, 0, errors);
    assert.ok(await until(() => !groupAlive(pid)), 'owned group must not survive host exit');
  });
}
