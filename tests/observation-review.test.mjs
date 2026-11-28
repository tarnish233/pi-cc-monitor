/** Review regressions: burst catch-up, terminal tails, contract parity and failed-start ownership. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadModule, loadValidators } from './helpers.mjs';
import { createHarness, until } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
import { fakeSsh } from './ssh-fixtures.mjs';

const { FileObservation, DRAIN_MAX_READS, DRAIN_MAX_BYTES, MAX_CATCHUP_BYTES } = await loadModule('observation-source.ts');
const { LocalSourceReader } = await loadModule('source-reader.ts');
const { ObservationLog } = await loadModule('observation-log.ts');
const { parseJobManifest } = await loadModule('job-protocol.ts');
const digest = value => createHash('sha256').update(value).digest('hex');
function burst(size = 1258496) {
  const data = Buffer.alloc(size, 'x');
  data.write('EARLY-RESULT\n', 0);
  data.write('MIDDLE-RESULT\n', Math.min(150000, size - 100));
  data.write('\nFINAL-RESULT\n', size - 14);
  return data;
}

for (const remote of [false, true]) test(`${remote ? 'SSH' : 'local'}: a 1.2 MiB burst is fully copied without a source gap`, async t => {
  const h = createHarness();
  try {
    const ssh = remote ? fakeSsh(t, h.cwd) : undefined;
    const job = createJob(h.cwd);
    const receipt = (await h.call('Monitor', { source: { ...job.fileSource, from: 'now', ...(ssh ? { host: ssh.host } : {}) }, description: 'finite burst', persistent: true, notify: { output: 'none' } })).details;
    const data = burst(); fs.appendFileSync(job.stdout, data);
    assert.ok(await until(() => fs.statSync(receipt.outputPath).size === data.length, 15000));
    assert.equal(digest(fs.readFileSync(receipt.outputPath)), digest(data));
    const snapshot = (await h.snapshots())[0];
    assert.equal(snapshot.sourceGap, undefined); assert.equal(snapshot.sourceError, undefined); assert.equal(snapshot.status, 'running');
    assert.equal(h.sent.length, 0); assert.equal(fs.statSync(job.stdout).size, data.length);
  } finally { await h.close(); }
});

test('each drain yields within its byte/read budget and keeps its cursor instead of jumping to tail', async () => {
  const h = createHarness(), job = createJob(h.cwd), data = burst(), parts = [], gaps = [];
  const observer = new FileObservation({ kind: 'file', stdout: job.stdout, from: 'now' }, {
    onData(_stream, bytes) { parts.push(Buffer.from(bytes)); }, onGap(_stream, reason) { gaps.push(reason); }, onIssue() {}, onJob() {}, onComplete() { assert.fail('file EOF is not a job result'); },
  });
  const read = LocalSourceReader.prototype.read;
  let reads = 0, bytes = 0;
  try {
    await observer.prepare(); fs.appendFileSync(job.stdout, data);
    LocalSourceReader.prototype.read = async function(request) {
      const result = await read.call(this, request); reads++; bytes += result.data.length;
      assert.ok(request.maxBytes <= 65536); return result;
    };
    for (let ticks = 0; ticks < 100 && Buffer.concat(parts).length < data.length; ticks++) {
      reads = 0; bytes = 0; await observer.tick();
      assert.ok(reads <= DRAIN_MAX_READS); assert.ok(bytes <= DRAIN_MAX_BYTES);
    }
    assert.equal(digest(Buffer.concat(parts)), digest(data)); assert.deepEqual(gaps, []);
  } finally { LocalSourceReader.prototype.read = read; await observer.stop(); await h.close(); }
});

test('a burst at terminal publication is drained before completion and remains available in the copy', async () => {
  const h = createHarness();
  try {
    const job = createJob(h.cwd), data = burst();
    const receipt = (await h.call('Monitor', { source: { ...job.source, from: 'now' }, description: 'terminal burst' })).details;
    fs.appendFileSync(job.stdout, data); job.status('succeeded');
    assert.ok(await until(() => h.sent.some(s => s.message.details?.cause === 'job')));
    assert.equal(digest(fs.readFileSync(receipt.outputPath)), digest(data));
    const result = h.sent.find(s => s.message.details?.cause === 'job');
    assert.equal(result.message.details.job.state, 'succeeded'); assert.equal(result.message.details.sourceGap, undefined);
    assert.match(result.message.details.stdoutTail, /FINAL-RESULT/);
    assert.equal(h.sent.filter(s => s.message.details?.cause === 'job').length, 1);
  } finally { await h.close(); }
});

test('an excessive backlog warns immediately, context-only and throttled, without inventing job failure', async () => {
  const h = createHarness();
  try {
    const job = createJob(h.cwd), data = Buffer.alloc(MAX_CATCHUP_BYTES + 65536, 'z');
    const receipt = (await h.call('Monitor', { source: { ...job.fileSource, from: 'now' }, description: 'bounded backlog', persistent: true, notify: { output: 'none' } })).details;
    fs.appendFileSync(job.stdout, data);
    assert.ok(await until(() => h.sent.some(s => s.message.details?.cause === 'source_gap')));
    assert.ok(await until(() => fs.statSync(receipt.outputPath).size === 65536));
    const warning = h.sent.find(s => s.message.details?.cause === 'source_gap');
    assert.equal(warning.options.triggerTurn, false); assert.equal(warning.message.details.notifyLevel, 'context');
    assert.match(warning.message.content, /runner's original logs/);
    const snapshot = (await h.snapshots())[0];
    assert.equal(snapshot.sourceGap, true); assert.equal(snapshot.sourceError, undefined); assert.equal(snapshot.status, 'running'); assert.equal(snapshot.eventCount, 0);
    fs.appendFileSync(job.stdout, data);
    assert.ok(await until(() => fs.statSync(receipt.outputPath).size === 2 * 65536));
    assert.equal(h.sent.filter(s => s.message.details?.cause === 'source_gap').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(job.statusPath)).state, 'running');
  } finally { await h.close(); }
});

test('failed setup leaves no inaccessible record or terminal notice after confirmed cleanup', async () => {
  const h = createHarness();
  try {
    const source = { kind: 'job', manifest: h.cwd + '/missing-job.json' };
    await assert.rejects(h.call('Monitor', { source, description: 'unavailable manifest' }), /Could not start observation/);
    assert.deepEqual(await h.snapshots(), []); assert.equal(h.sent.length, 0);
  } finally { await h.close(); }
});

test('failed setup with unconfirmed resources keeps a retryable identity until cleanup is really released', async () => {
  const h = createHarness(), active = Object.getOwnPropertyDescriptor(ObservationLog.prototype, 'active');
  let held = true;
  Object.defineProperty(ObservationLog.prototype, 'active', { configurable: true, get() { return held || active.get.call(this); } });
  try {
    await assert.rejects(h.call('Monitor', { source: { kind: 'job', manifest: h.cwd + '/missing-job.json' }, description: 'retained cleanup' }), /cleanup unconfirmed for observation/);
    const snapshot = (await h.snapshots())[0];
    assert.ok(snapshot.id); assert.equal(snapshot.status, 'stop_timeout'); assert.equal(snapshot.resourceActive, true); assert.equal(h.sent.length, 0);
    held = false; assert.ok(await until(async () => (await h.snapshots()).length === 0));
  } finally { Object.defineProperty(ObservationLog.prototype, 'active', active); await h.close(); }
});

test('schema and runtime agree on mode-dependent timeouts, source modes and WebSocket lexical bounds', async () => {
  const h = createHarness();
  try {
    const { compile } = await loadValidators(), check = compile(h.tools.get('Monitor').parameters), job = createJob(h.cwd);
    const bad = [
      { source: job.fileSource, timeout_ms: 3600001 },
      { source: { kind: 'ws', url: 'ws://localhost/events' }, timeout_ms: 7200000 },
      { source: job.source, mode: 'events', timeout_ms: 7200001 },
      { source: job.fileSource, mode: 'completion' },
      { source: job.source, watches: [] },
      { action: 'update', id: 'observer', source: job.source },
      ...['ws://host/a b', 'ws://host/中文', 'ws://host/path#fragment', 'ws://user:secret@host', 'ws://host/path\n', 'ws://host/' + 'x'.repeat(4096)].map(url => ({ source: { kind: 'ws', url } })),
    ];
    for (const value of bad) {
      const args = { description: 'invalid contract', ...value };
      if (value.action === 'update') delete args.description;
      assert.equal(check.check(args), false, JSON.stringify(value)); await assert.rejects(h.call('Monitor', args));
    }
    assert.deepEqual(await h.snapshots(), []);
    for (const args of [
      { source: job.source, timeout_ms: 7200000 },
      { source: job.source, mode: 'events', timeout_ms: 7200000 },
      { source: job.fileSource, timeout_ms: 3600000, watches: [] },
      { source: { kind: 'ws', url: 'wss://example.com/events?q=a%20b' }, timeout_ms: 3600000 },
    ]) assert.equal(check.check({ ...args, description: 'valid contract' }), true);
  } finally { await h.close(); }
});

test('manifest parsing requires an already-absolute source path, not process cwd', async () => {
  const h = createHarness();
  try {
    const job = createJob(h.cwd), text = fs.readFileSync(job.manifestPath, 'utf8');
    assert.throws(() => parseJobManifest(text, 'relative/job.json'), /absolute/);
    assert.equal(parseJobManifest(text, job.manifestPath).status, job.statusPath);
  } finally { await h.close(); }
});

test('terminal log read failure stays an explicit observation diagnostic, not an endless catch-up', async () => {
  const h = createHarness(), read = LocalSourceReader.prototype.read;
  let attempts = 0;
  try {
    const job = createJob(h.cwd);
    await h.call('Monitor', { source: { ...job.source, from: 'now' }, description: 'terminal IO error' });
    LocalSourceReader.prototype.read = async function(request) {
      if (request.path === job.stdout) { attempts++; await new Promise(r => setTimeout(r, 75)); throw new Error('read unavailable'); }
      return read.call(this, request);
    };
    job.status('succeeded');
    assert.ok(await until(() => h.sent.some(s => s.message.details?.cause === 'job')));
    assert.equal(attempts, 1);
    const result = h.sent.find(s => s.message.details?.cause === 'job');
    assert.equal(result.message.details.job.state, 'succeeded'); assert.match(result.message.details.sourceError, /read unavailable/);
  } finally { LocalSourceReader.prototype.read = read; await h.close(); }
});

test('WebSocket constructor failure releases its copy before discarding the unpublished record', async () => {
  const h = createHarness(), WebSocketClass = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error('fixture startup failure'); } };
  try {
    await assert.rejects(h.call('Monitor', { source: { kind: 'ws', url: 'ws://localhost/events' }, description: 'failed socket' }), /fixture startup failure/);
    assert.deepEqual(await h.snapshots(), []); assert.equal(h.sent.length, 0);
  } finally { globalThis.WebSocket = WebSocketClass; await h.close(); }
});

test('receipts and snapshots share immutable identity, policy and copy-path fields', async () => {
  const h = createHarness();
  try {
    const job = createJob(h.cwd), receipt = (await h.call('Monitor', { source: job.source, description: 'shared view' })).details;
    const snapshot = (await h.snapshots())[0];
    for (const key of Object.keys(receipt).filter(key => key !== 'taskId')) assert.deepEqual(receipt[key], snapshot[key], key);
    receipt.job.runner.name = 'mutated'; receipt.source.manifest = '/changed'; receipt.notify.output = 'none';
    const next = (await h.snapshots())[0];
    assert.equal(next.job.runner.name, 'fixture'); assert.equal(next.source.manifest, job.manifestPath); assert.equal(next.notify.output, 'turn');
  } finally { await h.close(); }
});
