/** Real fixed-helper/client transport with a private fake ssh CLI, no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHarness, until, sleep, groupAlive } from './runtime-harness.mjs';
import { createJob, startExternal } from './observation-fixtures.mjs';
import { fakeSsh } from './ssh-fixtures.mjs';
import { loadModule } from './helpers.mjs';
const { sshReadCommand } = await loadModule('ssh-reader.ts');

 test('SSH options/command are fixed and quoted source filenames remain stdin data', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); const ssh = fakeSsh(t, h.cwd); t.after(() => h.close());
  const file = path.join(h.cwd, "quote'$(touch SHOULD_NOT_EXIST).log"); fs.writeFileSync(file, 'REMOTE DATA\n');
  const r = (await h.call('Monitor', { source: { kind: 'file', stdout: file, host: ssh.host }, description: 'remote literal file' })).details;
  assert.ok(await until(() => fs.readFileSync(r.outputPath, 'utf8').includes('REMOTE DATA')));
  const args = JSON.parse(fs.readFileSync(ssh.capture)); assert.deepEqual(args.slice(0, 3), ['-T', '-o', 'BatchMode=yes']); assert.equal(args.at(-2), ssh.host); assert.equal(args.at(-1), sshReadCommand()); assert.equal(args.at(-1).includes('SHOULD_NOT_EXIST'), false);
  assert.equal(fs.existsSync(path.join(h.cwd, 'SHOULD_NOT_EXIST')), false); assert.equal((await h.call('monitor_stop', { id: r.taskId })).details.stopped, true);
});
test('remote status observation and its helper PID never control an independent job', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); const ssh = fakeSsh(t, h.cwd); let external;
  try {
    external = await startExternal(h.cwd, "setInterval(()=>process.stdout.write('REMOTE TICK\\n'),50)");
    const r = (await h.call('Monitor', { source: { ...external.source, host: ssh.host }, description: 'remote external task', persistent: true })).details;
    assert.ok(await until(() => fs.readFileSync(r.outputPath, 'utf8').includes('REMOTE TICK'))); const snapshot = (await h.snapshots())[0]; assert.notEqual(snapshot.observationPid, external.pid); assert.equal(snapshot.job.host, ssh.host);
    const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(r.outputPath), 'task.json'))); assert.equal(marker.resourcePid, snapshot.observationPid);
    assert.equal((await h.call('monitor_stop', { id: r.taskId })).details.stopped, true); const before = fs.statSync(external.stdout).size; await sleep(150); assert.equal(groupAlive(external.pid), true); assert.ok(fs.statSync(external.stdout).size > before);
  } finally { if (external) await external.stop(); await h.close(); }
});
test('remote parent links cannot redirect a job status outside its manifest directory', { skip: process.platform === 'win32' }, async t => {
  const h = createHarness(); const ssh = fakeSsh(t, h.cwd); t.after(() => h.close());
  const job = createJob(h.cwd), other = createJob(h.cwd); other.status('succeeded', { jobId: job.manifest.jobId, runId: job.manifest.runId });
  fs.symlinkSync(other.root, path.join(job.root, 'redirect')); fs.writeFileSync(job.manifestPath, JSON.stringify({ ...job.manifest, status: 'redirect/status.json' }));
  await h.call('Monitor', { source: { ...job.source, host: ssh.host }, description: 'bounded job metadata' });
  assert.ok(await until(async () => Boolean((await h.snapshots())[0].job.error))); assert.equal((await h.snapshots())[0].job.state, 'unknown'); assert.equal(h.sent.some(m => m.message.details.cause === 'job'), false);
});
test('malformed SSH destinations fail before creating readers or observations', async t => {
  const h = createHarness(); t.after(() => h.close());
  for (const host of ['-oProxyCommand=bad', 'host;touch bad', 'host/path', 'host\ncommand']) await assert.rejects(h.call('Monitor', { source: { kind: 'file', stdout: '/some/log', host }, description: 'invalid' }));
  assert.deepEqual(await h.snapshots(), []);
});
