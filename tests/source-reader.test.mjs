import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { loadModule } from './helpers.mjs';
const { LocalSourceReader } = await loadModule('source-reader.ts');
const { SshSourceReader, REMOTE_READER, sshReadCommand } = await loadModule('ssh-reader.ts');
const { normalizeSource } = await loadModule('observation-source.ts');
function fixture(t) { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-')); t.after(() => fs.rmSync(cwd, { recursive: true, force: true })); const file = path.join(cwd, 'log'); fs.writeFileSync(file, '0123456789\n'); return { cwd, file }; }

test('local bounded reads preserve the real source and expose a guard/identity', async t => {
  const f = fixture(t), reader = new LocalSourceReader(); t.after(() => reader.stop());
  const before = fs.statSync(f.file); const slice = await reader.read({ path: f.file, offset: 5, maxBytes: 3, guardBytes: 3 });
  assert.equal(slice.data.toString(), '567'); assert.equal(slice.guard.toString(), '234'); assert.equal(slice.offset, 5); assert.equal(slice.size, 11); assert.match(slice.identity, /^\d+:\d+$/);
  assert.equal((await reader.read({ path: f.file, maxBytes: 4, tail: true })).data.toString(), '789\n');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '0123456789\n'); assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs);
});
test('invalid bounds, source symlinks, directories and FIFOs are rejected', async t => {
  const f = fixture(t), reader = new LocalSourceReader(); t.after(() => reader.stop());
  assert.throws(() => reader.read({ path: f.file, maxBytes: 999999 }));
  assert.throws(() => reader.read({ path: f.file, maxBytes: 10, offset: -1 }));
  await assert.rejects(reader.read({ path: f.cwd, maxBytes: 10 }));
  if (process.platform !== 'win32') {
    const link = path.join(f.cwd, 'link'); fs.symlinkSync(f.file, link); await assert.rejects(reader.read({ path: link, maxBytes: 10 }));
    const fifo = path.join(f.cwd, 'fifo'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0); await assert.rejects(reader.read({ path: fifo, maxBytes: 10 }), /regular/);
  }
});
test('stop closes local read capability and does not write/delete the source', async t => {
  const f = fixture(t), reader = new LocalSourceReader(); await reader.read({ path: f.file, maxBytes: 10 });
  assert.equal(await reader.stop(), true); assert.equal(reader.active, false);
  await assert.rejects(reader.read({ path: f.file, maxBytes: 10 }), /closed/); assert.equal(fs.existsSync(f.file), true);
});
test('job boundaries reject parent links escaping the explicitly observed directory', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), inside = path.join(f.cwd, 'inside'); fs.mkdirSync(inside); fs.symlinkSync(f.cwd, path.join(inside, 'redirect'));
  const reader = new LocalSourceReader(); t.after(() => reader.stop());
  await assert.rejects(reader.read({ path: path.join(inside, 'redirect', 'log'), root: inside, maxBytes: 10 }), /escaped/);
});
test('typed targets reject legacy execution inputs and normalize local paths', () => {
  assert.deepEqual(normalizeSource({ kind: 'file', stdout: '@x' }, '/work'), { kind: 'file', stdout: '/work/x', from: 'tail' });
  assert.deepEqual(normalizeSource({ kind: 'job', manifest: 'runs/job.json' }, '/work'), { kind: 'job', manifest: '/work/runs/job.json', from: 'tail' });
  for (const source of [{ monitorId: 'old' }, { kind: 'file', stdout: 'x', command: 'echo nope' }, { kind: 'job', manifest: 'x', pid: 1 }, { kind: 'file' }, { kind: 'file', stdout: 'x', stderr: 'x' }, { kind: 'file', host: 'server', stdout: 'relative' }]) assert.throws(() => normalizeSource(source, '/work'));
});
test('WebSocket destinations and protocol tokens remain strictly validated', () => {
  assert.equal(normalizeSource({ kind: 'ws', url: 'wss://example.com/feed', protocols: ['one'] }, '/work').kind, 'ws');
  for (const source of [{ kind: 'ws', url: 'https://x' }, { kind: 'ws', url: 'ws://user:password@x' }, { kind: 'ws', url: 'ws://x/a b' }, { kind: 'ws', url: 'ws://x', protocols: ['x', 'x'] }, { kind: 'ws', url: 'ws://x', protocols: ['bad token'] }]) assert.throws(() => normalizeSource(source, '/work'));
});
const hasPython3 = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0;
test('remote reader code compiles and is fixed, with source paths outside shell code', { skip: !hasPython3 && 'python3 unavailable in this environment' }, () => {
  const result = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], { input: REMOTE_READER, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(sshReadCommand().startsWith('python3 -u -c ')); assert.ok(REMOTE_READER.includes('select.select')); assert.ok(!REMOTE_READER.includes('subprocess')); assert.ok(!REMOTE_READER.includes('os.kill'));
});
test('fixed remote helper reads quoted/injection-shaped filenames as inert data', { skip: (process.platform === 'win32' || !hasPython3) && 'python3/POSIX unavailable' }, async t => {
  const f = fixture(t); const weird = path.join(f.cwd, "a'$(touch SHOULD_NOT_EXIST).log"); fs.writeFileSync(weird, 'REMOTE\n');
  const child = spawn('python3', ['-u', '-c', REMOTE_READER], { cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  child.stdin.end(JSON.stringify({ requestId: 1, path: weird, maxBytes: 65536 }) + '\n');
  const exit = await new Promise(resolve => child.once('close', resolve)); assert.equal(exit, 0, error);
  const lines = output.trim().split('\n').map(JSON.parse); assert.equal(lines[0].ready, true); assert.equal(Buffer.from(lines[1].data, 'base64').toString(), 'REMOTE\n'); assert.equal(fs.existsSync(path.join(f.cwd, 'SHOULD_NOT_EXIST')), false);
});
