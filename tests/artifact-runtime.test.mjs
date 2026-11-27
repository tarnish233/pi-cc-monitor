/** Observation-copy ownership/GC, independent from stable runner storage. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { createHarness, until } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
const config = await loadModule('config.ts');
const { LOG_CLEANUP_INTERVAL_MS } = await loadModule('log-store.ts');
const { FileObservation } = await loadModule('observation-source.ts');
const { parseJobStatus, jobSnapshot } = await loadModule('job-protocol.ts');
const DAY = 86400000;
async function settings(body, values = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-runtime-policy-')), old = process.env.PI_CC_CONFIG_FILE;
  try { process.env.PI_CC_CONFIG_FILE = path.join(dir, 'settings.json'); fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify(values)); config.invalidateConfig(); await body(); }
  finally { if (old === undefined) delete process.env.PI_CC_CONFIG_FILE; else process.env.PI_CC_CONFIG_FILE = old; config.invalidateConfig(); fs.rmSync(dir, { recursive: true, force: true }); }
}
async function feedSource(h, fixture) {
  const original = FileObservation.prototype.start;
  // Exercise the production source callbacks and copy writer independently from
  // the bounded filesystem replay window. No command is executed by Monitor.
  FileObservation.prototype.start = function() {
    queueMicrotask(() => {
      this.callbacks.onData('stdout', fs.readFileSync(fixture.stdout)); this.callbacks.onData('stderr', fs.readFileSync(fixture.stderr));
      const status = parseJobStatus(fs.readFileSync(fixture.statusPath, 'utf8'), this.job); this.callbacks.onComplete(jobSnapshot(this.job, status));
    });
  };
  try { return (await h.call('Monitor', { source: fixture.source, description: 'source callback copy' })).details; }
  finally { FileObservation.prototype.start = original; }
}
test('source callbacks keep copy bytes bounded and retain final markers without touching runner files', async () => {
  await settings(async () => {
    const h = createHarness(); try {
      const stdout = 'x'.repeat(1500000) + '\nFINAL_STDOUT=ok\n', stderr = 'y'.repeat(1500000) + '\nFINAL_STDERR=ok\n';
      const job = createJob(h.cwd, { state: 'succeeded', stdout, stderr }); const r = await feedSource(h, job); assert.equal(r.logLimitBytes, 1024 * 1024);
      assert.ok(await until(() => h.sent.some(m => m.message.details.cause === 'job'))); const ending = h.sent.find(m => m.message.details.cause === 'job'); assert.equal(ending.message.details.logTruncated, true); assert.match(ending.message.content, /Logs truncated/);
      const files = fs.readdirSync(path.dirname(r.outputPath)).filter(name => name.includes('.log')); assert.ok(files.length <= 4); assert.ok(files.reduce((n, file) => n + fs.statSync(path.join(path.dirname(r.outputPath), file)).size, 0) <= r.logLimitBytes);
      assert.ok(fs.readFileSync(r.outputPath, 'utf8').endsWith('FINAL_STDOUT=ok\n')); assert.ok(fs.readFileSync(r.stderrPath, 'utf8').endsWith('FINAL_STDERR=ok\n'));
      assert.equal(fs.readFileSync(job.stdout, 'utf8'), stdout); assert.equal(fs.readFileSync(job.stderr, 'utf8'), stderr); assert.equal(path.dirname(r.outputPath).startsWith(job.root + path.sep), false);
    } finally { await h.close(); }
  }, { logMaxMiB: 1 });
});
test('first copy rotation exposes archive and completion tail bridges .1 into current segment', async () => {
  await settings(async () => {
    const h = createHarness(); try {
      const raw = 'z'.repeat(262127) + '\nBEFORE_ROTATION\nAFTER_ROTATION\n', job = createJob(h.cwd, { state: 'succeeded', stdout: raw }); const r = await feedSource(h, job);
      assert.ok(await until(() => h.sent.some(m => m.message.details.cause === 'job'))); const ending = h.sent.find(m => m.message.details.cause === 'job'); assert.equal(ending.message.details.logTruncated, false); assert.match(ending.message.content, /Rotated logs/);
      assert.ok(fs.existsSync(r.outputArchivePath));
      assert.equal(Buffer.concat([fs.readFileSync(r.outputArchivePath), fs.readFileSync(r.outputPath)]).toString(), raw); assert.equal(fs.readFileSync(job.stdout, 'utf8'), raw);
      assert.match(ending.message.details.stdoutTail, /BEFORE_ROTATION/);
      assert.match(ending.message.details.stdoutTail, /AFTER_ROTATION/);
    } finally { await h.close(); }
  }, { logMaxMiB: 1 });
});
test('separate observers own separate disposable copies, never the runner directory', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd); const a = (await h.call('Monitor', { source: job.fileSource, description: 'A' })).details, b = (await h.call('Monitor', { source: job.fileSource, description: 'B' })).details;
    assert.notEqual(a.outputPath, b.outputPath); assert.equal(path.dirname(a.outputPath).startsWith(job.root), false); assert.equal(a.source.stdout, job.stdout); assert.equal(b.source.stdout, job.stdout);
    await h.call('monitor_stop', { id: a.taskId }); assert.equal(fs.existsSync(job.statusPath), true);
  } finally { await h.close(); }
});
test('GC protects pending result, honors read grace and reclaims only observation copies', async () => {
  await settings(async () => {
    const h = createHarness({ idle: false }), originalNow = Date.now;
    try {
      const job = createJob(h.cwd, { state: 'succeeded', stdout: 'result\n' }); fs.writeFileSync(path.join(job.root, 'checkpoint'), 'formal');
      const r = (await h.call('Monitor', { source: job.source, description: 'pending result' })).details; assert.ok(await until(async () => (await h.snapshots())[0].status === 'completed')); assert.equal(h.sent.length, 0);
      const now = originalNow(); Date.now = () => now + 5 * DAY; await h.emit('session_start'); assert.ok(fs.existsSync(r.outputPath));
      Date.now = originalNow; h.setIdle(true); await h.emit('agent_settled', { aborted: false }); assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(path.dirname(r.outputPath), 'task.json'))).readyAt !== null));
      Date.now = () => now + 60000; await h.emit('session_start'); assert.ok(fs.existsSync(r.outputPath));
      Date.now = () => now + 5 * DAY; await h.emit('session_start'); assert.equal(fs.existsSync(r.outputPath), false); assert.equal((await h.snapshots())[0].logRemoved, true);
      assert.equal(fs.readFileSync(path.join(job.root, 'checkpoint'), 'utf8'), 'formal'); assert.equal(fs.readFileSync(job.stdout, 'utf8'), 'result\n'); assert.equal(fs.existsSync(job.manifestPath), true);
    } finally { Date.now = originalNow; await h.close(); }
  });
});
test('maintenance starts on use/session only, is unrefed and stops at shutdown', async () => {
  await settings(async () => {
    const set = globalThis.setInterval, clear = globalThis.clearInterval, timers = [], cleared = new Set(); let h;
    try {
      globalThis.setInterval = (fn, ms, ...args) => { const timer = set(fn, ms, ...args); if (ms === LOG_CLEANUP_INTERVAL_MS) timers.push(timer); return timer; }; globalThis.clearInterval = timer => { cleared.add(timer); return clear(timer); };
      h = createHarness(); assert.equal(timers.length, 0); await h.emit('session_start'); await h.emit('session_start'); assert.equal(timers.length, 1); assert.equal(timers[0].hasRef(), false); await h.close(); h = undefined; assert.ok(cleared.has(timers[0]));
    } finally { if (h) await h.close(); globalThis.setInterval = set; globalThis.clearInterval = clear; }
  });
});
