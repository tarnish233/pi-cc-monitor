/** Owned observation resources are cleaned; native runner jobs are never signalled. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { createHarness, startReady, groupAlive, until, sleep } from './runtime-harness.mjs';
import { createJob, startExternal } from './observation-fixtures.mjs';
import { fakeSsh } from './ssh-fixtures.mjs';
const proc = await loadModule('process.ts');
const { FileObservation } = await loadModule('observation-source.ts');

async function remoteReady(h, host) {
  const job = createJob(h.cwd, { stdout: 'READY\n' });
  const receipt = (await h.call('Monitor', { source: { ...job.fileSource, host }, description: 'owned read-only helper', persistent: true })).details;
  // Allow the transport's 10s read deadline plus one poll/backoff under parallel cold starts.
  // The real READY bytes and the owned helper PID are still required before testing cleanup.
  const ready = await until(async () => Boolean((await h.snapshots())[0].observationPid) && fs.readFileSync(receipt.outputPath, 'utf8').includes('READY'), 15000);
  assert.ok(ready, `read-only helper did not deliver READY: ${JSON.stringify(await h.snapshots())}`);
  return { ...receipt, pid: (await h.snapshots())[0].observationPid, fixture: job };
}
test('simultaneous stops share one closing outcome and reap a TERM-ignoring SSH helper', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); const ssh = fakeSsh(t, h.cwd, { ignoreTerm: true }); t.after(() => h.close());
  const observer = await remoteReady(h, ssh.host); const a = h.call('monitor_stop', { id: observer.taskId }), b = h.call('monitor_stop', { id: observer.taskId });
  assert.equal((await h.snapshots())[0].status, 'stopping'); assert.equal((await h.snapshots())[0].endedAt, undefined);
  assert.ok((await Promise.all([a, b])).every(r => r.details.stopped)); assert.equal(groupAlive(observer.pid), false); assert.equal((await h.snapshots())[0].status, 'stopped');
  assert.equal(h.sent.filter(m => m.message.details.cause === 'stopped').length, 1); assert.equal(fs.readFileSync(observer.fixture.stdout, 'utf8'), 'READY\n');
});
test('permission-denied helper cleanup remains listed/retryable and converges without a second notice', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); const ssh = fakeSsh(t, h.cwd, { ignoreTerm: true }); t.after(() => h.close()); const observer = await remoteReady(h, ssh.host);
  const kill = process.kill, childKill = ChildProcess.prototype.kill;
  try {
    process.kill = (pid, signal) => { if (pid === -observer.pid && signal !== 0) throw Object.assign(new Error('signal denied'), { code: 'EPERM' }); return kill.call(process, pid, signal); };
    ChildProcess.prototype.kill = function(signal) { return this.pid === observer.pid ? false : childKill.call(this, signal); };
    const stopped = await h.call('monitor_stop', { id: observer.taskId }); assert.equal(stopped.details.stopped, false); assert.equal(stopped.details.status, 'stop_timeout'); assert.equal(stopped.isError, true); assert.equal(groupAlive(observer.pid), true);
  } finally { process.kill = kill; ChildProcess.prototype.kill = childKill; }
  kill.call(process, -observer.pid, 'SIGKILL'); assert.ok(await until(async () => (await h.snapshots())[0].status === 'stopped'));
  assert.equal(h.sent.filter(m => ['stopped', 'stop_timeout'].includes(m.message.details.cause)).length, 1); assert.equal(fs.existsSync(observer.fixture.manifestPath), true);
});
test('shutdown clears cleanup polls and the disposed runtime never rearms them', async t => {
  const h = createHarness(); const observer = await startReady(h); const stop = FileObservation.prototype.stop;
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, polls = new Set();
  globalThis.setTimeout = function(fn, ms, ...args) { const timer = set(() => { polls.delete(timer); fn(...args); }, ms); if (ms === 100) polls.add(timer); return timer; };
  globalThis.clearTimeout = timer => { polls.delete(timer); return clear(timer); };
  FileObservation.prototype.stop = async function(force) { return force ? stop.call(this, force) : false; };
  try { const result = await h.call('monitor_stop', { id: observer.taskId }); assert.equal(result.details.status, 'stop_timeout'); assert.ok(polls.size > 0); await h.close(); assert.equal(polls.size, 0); await sleep(250); assert.equal(polls.size, 0); }
  finally { FileObservation.prototype.stop = stop; globalThis.setTimeout = set; globalThis.clearTimeout = clear; await h.close(); }
});
test('group probe treats EPERM as alive and only ESRCH as gone', () => {
  if (process.platform === 'win32') { assert.equal(proc.processGroupAlive({ pid: 987654, exitCode: 0, signalCode: null }), false); return; }
  const kill = process.kill; try {
    process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }; assert.equal(proc.processGroupAlive({ pid: 987654 }), true);
    process.kill = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }; assert.equal(proc.processGroupAlive({ pid: 987654 }), false);
  } finally { process.kill = kill; }
});
for (const shutdown of ['graceful', 'exit-while-stopping']) test(shutdown + ': process exit reaps only the helper, leaving an independent business process alive', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); fakeSsh(t, h.cwd, { ignoreTerm: true });
  let external, owner, helperPid;
  try {
    external = await startExternal(h.cwd, "setInterval(()=>process.stdout.write('BUSINESS-ALIVE\\n'),50)");
    const program = path.join(h.cwd, 'observer-owner.mjs'); const harnessUrl = pathToFileURL(path.resolve(import.meta.dirname, 'runtime-harness.mjs')).href;
    const source = { ...external.source, host: 'fixture-host' };
    fs.writeFileSync(program, `import fs from 'node:fs';import {createHarness,until} from ${JSON.stringify(harnessUrl)};\nconst h=createHarness();const r=(await h.call('Monitor',{source:${JSON.stringify(source)},description:'read-only helper',persistent:true})).details;\nawait until(async()=>Boolean((await h.snapshots())[0].observationPid)&&fs.readFileSync(r.outputPath,'utf8').includes('BUSINESS-ALIVE'));\nconsole.log(JSON.stringify({pid:(await h.snapshots())[0].observationPid}));\n${shutdown === 'graceful' ? "await h.emit('session_shutdown',{reason:'quit'});" : "void h.call('monitor_stop',{id:r.taskId});"}\nprocess.exit(0);\n`);
    owner = spawn(process.execPath, [program], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', errors = ''; owner.stdout.on('data', b => output += b); owner.stderr.on('data', b => errors += b);
    const [code] = await once(owner, 'close'); assert.equal(code, 0, errors); helperPid = JSON.parse(output.trim()).pid;
    assert.ok(await until(() => !groupAlive(helperPid)), 'only the allocated helper group is reaped'); assert.equal(groupAlive(external.pid), true);
    const before = fs.statSync(external.stdout).size; await sleep(150); assert.ok(fs.statSync(external.stdout).size > before);
  } finally { if (owner && owner.exitCode === null) owner.kill('SIGKILL'); if (helperPid && groupAlive(helperPid)) process.kill(-helperPid, 'SIGKILL'); if (external) await external.stop(); await h.close(); }
});
