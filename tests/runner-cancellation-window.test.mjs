import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { extensionDir, loadModule } from './helpers.mjs';
const { parseJobManifest, parseJobStatus } = await loadModule('job-protocol.ts');
const hasPython3 = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0;

for (const when of ['before', 'after']) test('TERM ' + when + ' child assignment reaches the ready command exactly once', { skip: (process.platform === 'win32' || !hasPython3) && 'python3/POSIX unavailable' }, t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-start-window-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, 'cancel-window'), checkpoint = path.join(cwd, 'checkpoint');
  const result = spawnSync('python3', [path.join(extensionDir, 'tests/fixtures/runner-start-cancel.py'), path.join(extensionDir, 'examples/job-wrapper.py'), root, checkpoint, when], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.checkpointSaved, true); assert.equal(report.recorderExit, 0); assert.equal(report.signal, null); assert.equal(report.termCalls, 1);
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), 'checkpoint saved');
  const manifestPath = path.join(root, 'job.json');
  const manifest = parseJobManifest(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
  const status = parseJobStatus(fs.readFileSync(manifest.status, 'utf8'), manifest);
  assert.equal(status.state, 'cancelled'); assert.equal(status.exitCode, 0); assert.equal(status.signal, undefined);
});
