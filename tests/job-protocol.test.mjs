import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModule } from './helpers.mjs';
import { createJob } from './observation-fixtures.mjs';
const p = await loadModule('job-protocol.ts');
function fixture(t, extra = {}) { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); const f = createJob(cwd, extra); const job = p.parseJobManifest(fs.readFileSync(f.manifestPath, 'utf8'), f.manifestPath); return { ...f, job }; }

test('manifest resolves relative sources at the manifest, not the agent cwd', t => {
  const f = fixture(t); assert.equal(f.job.stdout, f.stdout); assert.equal(f.job.status, f.statusPath);
  assert.deepEqual(p.jobSnapshot(f.job).runner, f.manifest.runner); assert.equal(p.jobSnapshot(f.job).state, 'unknown');
});
test('metadata is pure data: commands, PIDs and arbitrary extras are not copied or executed', t => {
  const f = fixture(t, { manifest: { command: 'touch NEVER', pid: process.pid, environment: { TOKEN: 'not-a-real-secret' } } });
  assert.equal('command' in f.job, false); assert.equal('pid' in f.job, false); assert.equal('environment' in p.jobSnapshot(f.job), false);
});
test('all valid states preserve external results separately', t => {
  const f = fixture(t);
  for (const state of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    const value = f.status(state); const status = p.parseJobStatus(JSON.stringify(value), f.job);
    assert.equal(status.state, state); assert.equal(p.jobSnapshot(f.job, status).state, state);
  }
  const value = f.status('failed', { exitCode: null, signal: 'SIGKILL' }); assert.equal(p.parseJobStatus(JSON.stringify(value), f.job).signal, 'SIGKILL');
});
test('mismatched jobId or attempt runId never becomes a terminal result', t => {
  const f = fixture(t); const value = f.status('succeeded');
  for (const key of ['jobId', 'runId']) assert.throws(() => p.parseJobStatus(JSON.stringify({ ...value, [key]: 'other' }), f.job), /identity/);
});
test('invalid terminal results and premature exit fields are rejected', t => {
  const f = fixture(t);
  for (const value of [f.status('succeeded', { exitCode: 1 }), f.status('succeeded', { signal: 'SIGTERM' }), f.status('failed', { exitCode: 0 }), f.status('failed', { exitCode: null }), f.status('running', { exitCode: 0 }), f.status('queued', { endedAt: Date.now() })]) assert.throws(() => p.parseJobStatus(JSON.stringify(value), f.job));
  const value = f.status('succeeded'); delete value.endedAt; assert.throws(() => p.parseJobStatus(JSON.stringify(value), f.job), /requires/);
});
test('timestamp types and ordering are strict, no coercion of external files', t => {
  const f = fixture(t); const value = f.status('succeeded');
  for (const changes of [{ updatedAt: '123' }, { endedAt: true }, { startedAt: value.updatedAt + 1 }, { endedAt: f.job.createdAt - 1 }, { exitCode: '0' }, { exitCode: -1 }]) assert.throws(() => p.parseJobStatus(JSON.stringify({ ...value, ...changes }), f.job));
});
test('schemas, malformed JSON and metadata size limits fail closed', t => {
  const f = fixture(t);
  for (const text of ['{', '[]', 'null', JSON.stringify({ ...f.manifest, version: 2 }), JSON.stringify({ ...f.manifest, schema: 'foreign' }), JSON.stringify({ ...f.manifest, jobId: '' })]) assert.throws(() => p.parseJobManifest(text, f.manifestPath));
  assert.throws(() => p.parseJobManifest(' '.repeat(65537), f.manifestPath), /64 KiB/);
  assert.throws(() => p.parseJobStatus(JSON.stringify({ ...f.status('succeeded'), state: 'unknown' }), f.job), /state/);
});
test('manifest control/log paths must not alias each other', t => {
  const f = fixture(t); for (const changes of [{ status: 'job.json' }, { stderr: 'stdout.log' }, { stdout: 'status.json' }]) assert.throws(() => p.parseJobManifest(JSON.stringify({ ...f.manifest, ...changes }), f.manifestPath), /distinct/);
});
test('job metadata cannot redirect reads outside the manifest directory', t => {
  const f = fixture(t);
  for (const changes of [{ stdout: '../outside.log' }, { status: '/outside/status.json' }]) assert.throws(() => p.parseJobManifest(JSON.stringify({ ...f.manifest, ...changes }), f.manifestPath), /inside/);
});
test('remote relative references resolve against an absolute manifest path', t => {
  const f = fixture(t); const job = p.parseJobManifest(JSON.stringify(f.manifest), '/work/runs/one/job.json', 'user@server'); assert.equal(job.stdout, '/work/runs/one/stdout.log');
  assert.throws(() => p.sourcePath('relative/log', '/local', 'server'), /absolute/);
});
test('paths and SSH destinations are data, never option or command fragments', () => {
  assert.equal(p.sourcePath('@~/logs/file', '/work'), path.join(os.homedir(), 'logs/file'));
  assert.equal(p.sourcePath("literal'$(touch x).log", '/work'), "/work/literal'$(touch x).log");
  for (const host of ['-oProxyCommand=x', 'user@host;touch x', 'ssh://host', 'host\ncmd', 'host/path']) assert.throws(() => p.validateHost(host));
  for (const file of ['', '@', 'a\0b', 'a\nb']) assert.throws(() => p.sourcePath(file, '/work'));
  assert.equal(p.validateHost('user@192.168.1.2'), 'user@192.168.1.2'); assert.equal(p.validateHost('server-alias'), 'server-alias');
});
