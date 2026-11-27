/** Review regressions: slow relocation, honest now baselines, results and late resource release. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { fixtureGroup, createHarness, until } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';

const { FileObservation, DRAIN_MAX_READS, DRAIN_MAX_BYTES, MAX_CATCHUP_BYTES } = await loadModule('observation-source.ts');
const { LocalSourceReader, READ_CHUNK_BYTES } = await loadModule('source-reader.ts');
const { SshSourceReader } = await loadModule('ssh-reader.ts');
const { ObservationLog } = await loadModule('observation-log.ts');
const { validateHost } = await loadModule('job-protocol.ts');
const { sourceDescription, startReceipt, monitorListText } = await loadModule('monitor-view.ts');

function fileObserver(t, { contents = 'OLD\n', missing = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-fixes-'));
  const file = path.join(cwd, 'source.log'), parts = [], gaps = [], issues = [];
  if (!missing) fs.writeFileSync(file, contents);
  const observer = new FileObservation({ kind: 'file', stdout: file, from: 'now' }, {
    onData(_stream, data) { parts.push(Buffer.from(data)); }, onGap(_stream, reason) { gaps.push(reason); },
    onIssue(error) { issues.push(error); }, onJob() {}, onComplete() { assert.fail('a file is not a job'); },
  });
  t.after(async () => { await observer.stop(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, file, observer, parts, gaps, issues };
}

/** Deterministic RTT: each production read exhausts the 50 ms tick budget, without sleeping. */
async function slowReads(run) {
  const read = LocalSourceReader.prototype.read, descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let clock = 1000, reads = 0, bytes = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  LocalSourceReader.prototype.read = async function(request) {
    const slice = await read.call(this, request);
    clock += 75; reads++; bytes += slice.data.length;
    return slice;
  };
  try {
    await run({ reset() { reads = 0; bytes = 0; }, budget() { return { reads, bytes }; } });
  } finally {
    LocalSourceReader.prototype.read = read;
    if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete performance.now;
  }
}

for (const change of ['rewrite', 'rotation', 'truncate', 'backlog']) test(`a slow ${change} resumes from its saved tail relocation`, async t => {
  const f = fileObserver(t, { contents: change === 'truncate' ? 'OLD-LONG\n' : 'OLD\n' });
  await f.observer.prepare();
  let expected = Buffer.from('NEW\n');
  if (change === 'rotation') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, expected); }
  else if (change === 'backlog') {
    const data = Buffer.alloc(MAX_CATCHUP_BYTES + 2 * READ_CHUNK_BYTES, 'x');
    data.write('\nNEW-TAIL\n', data.length - 10);
    fs.appendFileSync(f.file, data); expected = data.subarray(-READ_CHUNK_BYTES);
  } else fs.writeFileSync(f.file, expected);
  await slowReads(async meter => {
    for (let tick = 0; tick < 5 && Buffer.concat(f.parts).length < expected.length; tick++) {
      meter.reset(); await f.observer.tick();
      assert.ok(meter.budget().reads <= DRAIN_MAX_READS);
      assert.ok(meter.budget().bytes <= DRAIN_MAX_BYTES);
    }
  });
  assert.deepEqual(Buffer.concat(f.parts), expected);
  assert.equal(f.gaps.length, 1, 'one relocation, not one gap on every old-cursor probe');
  assert.equal(f.observer.streams.stdout.pending, false);
  assert.deepEqual(f.issues, []);
});

for (const backlog of [false, true]) test(`slow terminal drain completes after ${backlog ? 'backlog relocation' : 'source replacement'}`, async t => {
  const h = createHarness(), job = createJob(h.cwd, { stdout: 'OLD\n' }), parts = [], gaps = [], results = [];
  const observer = new FileObservation({ ...job.source, from: 'now' }, {
    onData(stream, data) { if (stream === 'stdout') parts.push(Buffer.from(data)); }, onGap(_stream, reason) { gaps.push(reason); },
    onIssue() {}, onJob() {}, onComplete(result) { results.push(result); },
  });
  t.after(async () => { await observer.stop(); await h.close(); });
  await observer.prepare();
  const data = backlog ? Buffer.alloc(MAX_CATCHUP_BYTES + 2 * READ_CHUNK_BYTES, 'z') : Buffer.from('NEW\n');
  if (backlog) fs.appendFileSync(job.stdout, data); else fs.writeFileSync(job.stdout, data);
  job.status('succeeded');
  await slowReads(async () => { for (let tick = 0; tick < 6; tick++) await observer.tick(); });
  assert.deepEqual(Buffer.concat(parts), backlog ? data.subarray(-READ_CHUNK_BYTES) : data);
  assert.equal(gaps.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].state, 'succeeded');
});

for (const code of ['EACCES', 'ETIMEDOUT']) test(`from now rejects ${code} rather than promising an unestablished baseline`, async t => {
  const f = fileObserver(t), read = LocalSourceReader.prototype.read;
  LocalSourceReader.prototype.read = () => Promise.reject(Object.assign(new Error(code), { code }));
  try { await assert.rejects(f.observer.prepare(), error => error.code === code); }
  finally { LocalSourceReader.prototype.read = read; }
  assert.equal(Buffer.concat(f.parts).length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'OLD\n');
});

test('a confirmed missing from-now file is copied from its start when it appears', async t => {
  const f = fileObserver(t, { missing: true }); await f.observer.prepare();
  const data = Buffer.alloc(3 * READ_CHUNK_BYTES, 'n'); fs.writeFileSync(f.file, data);
  await f.observer.tick();
  assert.deepEqual(Buffer.concat(f.parts), data);
  assert.deepEqual(f.gaps, []);
});

for (const remote of [false, true]) test(`${remote ? 'SSH' : 'local'} baseline failure rolls back the unpublished runtime record`, async () => {
  const h = createHarness(), file = path.join(h.cwd, 'old.log'); fs.writeFileSync(file, 'OLD\n');
  const reader = remote ? SshSourceReader : LocalSourceReader, read = reader.prototype.read;
  reader.prototype.read = () => Promise.reject(Object.assign(new Error('baseline unavailable'), { code: remote ? 'ETIMEDOUT' : 'EACCES' }));
  try {
    await assert.rejects(h.call('Monitor', { source: { kind: 'file', stdout: file, from: 'now', ...(remote ? { host: 'fixture-host' } : {}) }, description: 'baseline failure' }), /baseline unavailable/);
    assert.deepEqual(await h.snapshots(), []);
    assert.equal(h.sent.length, 0);
  } finally { reader.prototype.read = read; await h.close(); }
});

for (const finish of ['boundary', 'retry', 'aborted', 'loop-stop']) test(`an unconfirmed terminal cleanup preserves the job fact through ${finish}`, async () => {
  let held = true;
  const active = Object.getOwnPropertyDescriptor(ObservationLog.prototype, 'active');
  Object.defineProperty(ObservationLog.prototype, 'active', { configurable: true, get() { return held || active.get.call(this); } });
  const h = createHarness({ idle: false, loop: true });
  try {
    const job = createJob(h.cwd, { stdout: 'RESULT\n' });
    const receipt = (await h.call('Monitor', { source: job.source, description: 'terminal result', loopPrompt: 'observe result' })).details;
    job.status('failed', { exitCode: 9 });
    assert.ok(await until(async () => (await h.snapshots())[0].status === 'stop_timeout'));
    assert.equal(h.sent.length, 0, 'the result waits outside the active reply');
    if (finish === 'loop-stop') await h.emitBus('loop:stopped', { observationGroups: [fixtureGroup('observe result')], reason: 'stopped' });
    held = false;
    if (finish === 'retry') assert.equal((await h.call('monitor_stop', { id: receipt.taskId })).details.stopped, true);
    assert.ok(await until(async () => (await h.snapshots())[0].status === 'completed'));
    if (finish === 'aborted') await h.emit('agent_settled', { aborted: true });
    else await h.emit('turn_end', { outcome: 'completed' });
    if (finish === 'loop-stop') assert.equal(h.sent.length, 0, 'retiring a loop still discards its pending wakeup');
    else {
      assert.equal(h.sent.length, 1);
      const { message, options } = h.sent[0];
      assert.equal(message.details.cause, 'stop_timeout');
      assert.equal(message.details.job.state, 'failed');
      assert.match(message.content, /failed, exit code 9/);
      assert.match(message.content, /RESULT/);
      assert.match(message.content, /Read and verify/);
      assert.match(message.content, /cleanup remains unconfirmed/);
      assert.equal(options.triggerTurn, false, 'neither a boundary append nor Esc restarts the reply');
      await h.emit('agent_settled', { aborted: false });
      assert.equal(h.sent.length, 1, 'late cleanup does not publish the result twice');
    }
  } finally { held = false; Object.defineProperty(ObservationLog.prototype, 'active', active); await h.close(); }
});

test('late file I/O releases a disposed runtime backstop and owner without Pi API calls', { timeout: 12000 }, async t => {
  const hold = setTimeout(() => {}, 15000); t.after(() => clearTimeout(hold));
  const h = createHarness(), file = path.join(h.cwd, 'late.log'); fs.writeFileSync(file, 'READY\n');
  const hooks = process.listenerCount('exit'), open = fs.promises.open, start = FileObservation.prototype.start;
  let release, began, observer;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  fs.promises.open = async function(target, ...args) { if (target === file) { began(); await gate; } return open.call(this, target, ...args); };
  FileObservation.prototype.start = function(...args) { observer = this; return start.apply(this, args); };
  t.after(async () => { release(); fs.promises.open = open; FileObservation.prototype.start = start; await h.close(); });
  const receipt = (await h.call('Monitor', { source: { kind: 'file', stdout: file }, description: 'late I/O', persistent: true })).details;
  await started;
  const ownerPath = path.join(path.dirname(path.dirname(receipt.outputPath)), 'owner.json');
  await h.emit('session_shutdown', { reason: 'reload' });
  assert.equal(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).closedAt, null, 'unreleased I/O remains protected');
  assert.equal(process.listenerCount('exit'), hooks + 1);
  h.pi.sendMessage = () => { throw new Error('stale Pi API'); };
  h.ctx.ui.setStatus = () => { throw new Error('stale UI API'); };
  const pending = observer.tickPromise; release(); await pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.active, false);
  assert.equal(process.listenerCount('exit'), hooks);
  assert.notEqual(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).closedAt, null);
  assert.equal(h.sent.length, 0);
});

test('a reader settling during the final tick wait is confirmed from its current inactive state', { timeout: 6000 }, async t => {
  const hold = setTimeout(() => {}, 7000); t.after(() => clearTimeout(hold));
  const f = fileObserver(t); await f.observer.prepare();
  const open = fs.promises.open, stop = LocalSourceReader.prototype.stop;
  let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  fs.promises.open = async function(target, ...args) { if (target === f.file) { began(); await gate; } return open.call(this, target, ...args); };
  LocalSourceReader.prototype.stop = async function(...args) {
    const gone = await stop.apply(this, args);
    assert.equal(gone, false, 'the reader wait exhausted its own bound');
    release();
    return gone;
  };
  try {
    f.observer.start(); await started;
    assert.equal(await f.observer.stop(), true, 'the later tick wait observes the completed release');
    assert.equal(f.observer.active, false);
  } finally { release(); fs.promises.open = open; LocalSourceReader.prototype.stop = stop; }
});

test('closed copy streams report final release exactly once', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-release-')); let releases = 0;
  const log = new ObservationLog({ stdout: path.join(cwd, 'out'), stderr: path.join(cwd, 'err') }, 1024, () => {}, () => {}, undefined, () => releases++);
  t.after(async () => { await log.close(true); fs.rmSync(cwd, { recursive: true, force: true }); });
  log.write('stdout', Buffer.from('copied\n')); await log.close(); await log.close(true);
  assert.equal(log.active, false); assert.equal(releases, 1);
});

test('source host and immutable job/run identity reach plain model receipts and lists', () => {
  const source = { kind: 'job', manifest: '/work/run/job.json', host: 'gpu-a' };
  const job = { jobId: 'run', runId: 'attempt', runner: { name: 'tmux', id: 'run' }, manifestPath: source.manifest, statusPath: '/work/run/status.json', host: 'gpu-a', createdAt: 0, state: 'running' };
  const view = { id: 'observer', kind: 'job', mode: 'completion', description: 'result', source, job, status: 'running', persistent: true, timeoutMs: 0, notify: { output: 'turn', terminal: 'turn' }, outputPath: '/copy/out', stderrPath: '/copy/err' };
  assert.equal(sourceDescription(source), 'gpu-a · /work/run/job.json');
  assert.match(startReceipt(view), /source: gpu-a · \/work\/run\/job.json/);
  assert.match(monitorListText([view]), /job run \/ attempt/);
  assert.match(monitorListText([view]), /source gpu-a · \/work\/run\/job.json/);
  assert.notEqual(sourceDescription(source), sourceDescription({ ...source, host: 'gpu-b' }));
  assert.equal(sourceDescription({ kind: 'file', stdout: '/local/log' }), '/local/log');
});

test('compressed and link-local IPv6 are safe SSH destinations, while :port, options and shell syntax fail', () => {
  for (const host of ['::1', 'user@::1', '::', 'user@2001:db8::2', 'fe80::1%en0', 'user@fe80::1%eth0.1', 'server-alias', 'user@192.168.1.2']) assert.equal(validateHost(host), host);
  for (const host of ['-oProxyCommand=x', '@::1', 'user@@::1', '::1;touch x', '::1\ncommand', '::1/path', 'ssh://[::1]', 'user@::1 -p 22', 'example.com:2222', 'user@host:22', 'fe80::1%']) assert.throws(() => validateHost(host));
});

test('clean 10s SSH helper idle-lease exit releases without backoff or false error', { skip: process.platform === 'win32' }, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-lease-'));
  const bin = path.join(cwd, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, 'ssh');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true, leaseSeconds: 10 }) + '\\n');
rl.once('line', line => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ requestId: req.requestId, identity: '1:1', size: 3, offset: 0, data: Buffer.from('ok\\n').toString('base64'), guard: '' }) + '\\n');
  setTimeout(() => process.exit(0), 20);
});
`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const reader = new SshSourceReader('fixture-host');
  t.after(async () => { process.env.PATH = oldPath; await reader.stop(true); fs.rmSync(cwd, { recursive: true, force: true }); });
  const first = await reader.read({ path: '/remote/log', maxBytes: 64 });
  assert.equal(first.data.toString(), 'ok\n');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(reader.failures, 0);
  assert.equal(reader.retryAt, 0);
  const second = await reader.read({ path: '/remote/log', maxBytes: 64 });
  assert.equal(second.data.toString(), 'ok\n');
});

test('queued jobs with uncreated log files do not emit false ENOENT source errors', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-job-')), issues = [];
  const manifestPath = path.join(cwd, 'job.json'), statusPath = path.join(cwd, 'status.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema: 'pi-cc-job', version: 1, jobId: 'j1', runId: 'r1', createdAt: 1000,
    runner: { name: 'slurm', id: '123' }, stdout: 'stdout.log', stderr: 'stderr.log', status: 'status.json',
  }));
  fs.writeFileSync(statusPath, JSON.stringify({
    schema: 'pi-cc-job.status', version: 1, jobId: 'j1', runId: 'r1', state: 'queued', updatedAt: 1000,
  }));
  const observer = new FileObservation({ kind: 'job', manifest: manifestPath }, {
    onData() {}, onGap() {}, onIssue(err) { issues.push(err); }, onJob() {}, onComplete() {},
  });
  t.after(async () => { await observer.stop(); fs.rmSync(cwd, { recursive: true, force: true }); });
  await observer.prepare();
  await observer.tick();
  assert.deepEqual(issues, []);
});
