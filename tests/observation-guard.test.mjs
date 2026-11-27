/** Small-append rewrite guards and SSH connection-generation regressions; no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
import { createHarness } from './runtime-harness.mjs';
import { createJob } from './observation-fixtures.mjs';
import { fakeSsh } from './ssh-fixtures.mjs';

const { FileObservation } = await loadModule('observation-source.ts');
const { SshSourceReader, REMOTE_READER } = await loadModule('ssh-reader.ts');

for (const remote of [false, true]) for (const initialBytes of [0, 100]) {
  test(`${remote ? 'SSH' : 'local'} short appends retain a growing 64-byte guard (initial ${initialBytes} bytes)`, { skip: remote && process.platform === 'win32' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-guard-'));
    const ssh = remote ? fakeSsh(t, dir) : undefined;
    const file = path.join(dir, 'source.log'), parts = [], gaps = [], issues = [];
    fs.writeFileSync(file, initialBytes ? 'A'.repeat(initialBytes - 1) + '\n' : '');
    const observer = new FileObservation({ kind: 'file', stdout: file, from: 'now', ...(ssh ? { host: ssh.host } : {}) }, {
      onData(_stream, data) { parts.push(Buffer.from(data)); }, onGap(_stream, reason) { gaps.push(reason); },
      onIssue(error) { if (error) issues.push(error); }, onJob() {}, onComplete() { assert.fail('file EOF is not a job result'); },
    });
    try {
      await observer.prepare();
      let offset = initialBytes;
      for (const size of [1, 2, 10, 63]) {
        fs.appendFileSync(file, '\n'.repeat(size)); offset += size;
        await observer.tick();
        assert.equal(observer.streams.stdout.cursor.offset, offset);
        assert.equal(observer.streams.stdout.cursor.anchor.length, Math.min(64, offset), 'new data must not discard the verified old guard');
      }
      const rewritten = Buffer.from('B'.repeat(offset - 1) + '\nFINAL\n');
      fs.writeFileSync(file, rewritten);
      for (let tick = 0; tick < 10 && gaps.length === 0; tick++) await observer.tick();
      for (let tick = 0; tick < 10 && observer.streams.stdout.pending; tick++) await observer.tick();
      assert.equal(gaps.length, 1, 'same-inode rewrite must not look like an ordinary append');
      assert.ok(Buffer.concat(parts).subarray(-rewritten.length).equals(rewritten));
      assert.deepEqual(issues, []);
    } finally { await observer.stop(true); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const remote of [false, true]) test(`${remote ? 'SSH' : 'local'} terminal drain detects rewrite after a one-byte append`, { skip: remote && process.platform === 'win32' }, async t => {
  const h = createHarness(), ssh = remote ? fakeSsh(t, h.cwd) : undefined;
  const job = createJob(h.cwd, { stdout: 'A'.repeat(99) + '\n' }), parts = [], gaps = [], completed = [];
  const observer = new FileObservation({ ...job.source, from: 'now', ...(ssh ? { host: ssh.host } : {}) }, {
    onData(stream, data) { if (stream === 'stdout') parts.push(Buffer.from(data)); },
    onGap(_stream, reason) { gaps.push(reason); }, onIssue() {}, onJob() {}, onComplete(value) { completed.push(value); },
  });
  try {
    await observer.prepare(); fs.appendFileSync(job.stdout, '\n'); await observer.tick();
    const rewritten = Buffer.from('B'.repeat(100) + '\nFINAL\n');
    fs.writeFileSync(job.stdout, rewritten); job.status('succeeded');
    for (let tick = 0; tick < 10 && !completed.length; tick++) await observer.tick();
    assert.equal(gaps.length, 1);
    assert.ok(Buffer.concat(parts).subarray(-rewritten.length).equals(rewritten));
    assert.equal(completed.length, 1); assert.equal(completed[0].state, 'succeeded');
  } finally { await observer.stop(true); await h.close(); }
});

test('a released SSH stdin error cannot reject or stop a new connection read', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-generation-')), bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  // Exec the production reader directly: no grandchildren obscure helper cleanup.
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/usr/bin/env python3\nimport os,sys\nos.execvp("python3", ["python3", "-u", "-c", ' + JSON.stringify(REMOTE_READER) + '])\n', { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  const file = path.join(dir, 'source.log'); fs.writeFileSync(file, 'SSH DATA\n');
  const reader = new SshSourceReader('fixture-host');
  try {
    await reader.read({ path: file, maxBytes: 64 });
    const oldChild = reader.child;
    const closed = new Promise(resolve => oldChild.once('close', resolve));
    oldChild.stdin.end(); await closed;
    assert.equal(reader.pid, undefined);
    // Reconnect backoff is not under test; explicitly model its expiry.
    reader.retryAt = 0;
    const pending = reader.read({ path: file, maxBytes: 64 }).then(value => ({ value }), error => ({ error }));
    const newPid = reader.pid; assert.notEqual(newPid, oldChild.pid);
    oldChild.stdin.emit('error', new Error('delayed old stdin error'));
    const result = await pending;
    assert.equal(result.error, undefined, 'an old stream error must not affect the current pending request');
    assert.equal(result.value.data.toString(), 'SSH DATA\n'); assert.equal(reader.pid, newPid);
    assert.equal((await reader.read({ path: file, maxBytes: 64 })).data.toString(), 'SSH DATA\n');
  } finally { await reader.stop(true); process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); }
});
