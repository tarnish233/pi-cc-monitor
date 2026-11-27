import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fixtureGroup, createHarness, until, sleep, groupAlive } from './runtime-harness.mjs';
import { createJob, startExternal } from './observation-fixtures.mjs';
import { loadValidators, assertJsonRoundTrip } from './helpers.mjs';

const ticker = "let n=0;setInterval(()=>process.stdout.write('tick '+(++n)+'\\n'),50)";
function terminal(h) { return h.sent.filter(s => s.message.details?.cause === 'job'); }

test('public schema and execute both reject command/legacy sources before work starts', async () => {
  const h = createHarness(); try {
    const { compile } = await loadValidators(), schema = h.tools.get('Monitor').parameters;
    for (const args of [{ command: 'touch NEVER', description: 'legacy' }, { source: { monitorId: 'legacy' }, description: 'legacy' }, { source: { kind: 'file', stdout: 'x' }, command: 'touch NEVER', description: 'legacy' }]) {
      assert.equal(compile(schema).check(args), false); await assert.rejects(h.call('Monitor', args));
    }
    assert.deepEqual(await h.snapshots(), []);
    const job = createJob(h.cwd); assert.equal(compile(schema).check({ source: job.source, description: 'job' }), true);
  } finally { await h.close(); }
});
test('job defaults to completion; the observation and external result are distinct', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd); const receipt = (await h.call('Monitor', { source: job.source, description: 'existing job' })).details;
    assert.equal(receipt.mode, 'completion'); assert.equal(receipt.kind, 'job'); assert.equal(receipt.job.jobId, job.manifest.jobId); assert.equal('pid' in receipt, false);
    assertJsonRoundTrip(receipt); fs.appendFileSync(job.stdout, 'FINAL OUTPUT\n'); job.status('failed', { exitCode: 7 });
    assert.equal(await until(() => terminal(h).length === 1), true);
    const snapshot = (await h.snapshots())[0]; assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.job.state, 'failed'); assert.equal(snapshot.job.exitCode, 7); assert.equal('exitCode' in snapshot, false);
    assert.match(terminal(h)[0].message.content, /exit code 7/); assert.match(fs.readFileSync(receipt.outputPath, 'utf8'), /FINAL OUTPUT/);
    await sleep(350); assert.equal(terminal(h).length, 1);
  } finally { await h.close(); }
});
for (const action of ['stop', 'reload', 'quit', 'loop']) test(action + ' ends only observation and leaves an independently started task alive', async () => {
  const h = createHarness({ loop: true }); let external;
  try {
    external = await startExternal(h.cwd, ticker); assert.equal(await until(() => fs.readFileSync(external.stdout, 'utf8').includes('tick')), true);
    const started = (await h.call('Monitor', { source: external.source, description: 'external ticker', persistent: true, loopPrompt: 'observe ticker' })).details;
    if (action === 'stop') assert.equal((await h.call('monitor_stop', { id: started.taskId })).details.stopped, true);
    else if (action === 'loop') await h.emitBus('loop:stopped', { observationGroups: [fixtureGroup('observe ticker')], reason: 'stopped' });
    else await h.emit('session_shutdown', { reason: action });
    const before = fs.statSync(external.stdout).size; await sleep(180);
    assert.equal(groupAlive(external.pid), true); assert.ok(fs.statSync(external.stdout).size > before);
    assert.equal(JSON.parse(fs.readFileSync(external.statusPath)).state, 'running');
  } finally { if (external) await external.stop(); await h.close(); }
});
test('observation timeout neither cancels nor reports a running job as failed', async () => {
  const h = createHarness(); let external; try {
    external = await startExternal(h.cwd, ticker);
    await h.call('Monitor', { source: external.source, description: 'bounded observation', timeout_ms: 1000 });
    assert.equal(await until(() => h.sent.some(s => s.message.details?.cause === 'timeout')), true);
    assert.equal(groupAlive(external.pid), true); const snapshot = (await h.snapshots())[0]; assert.equal(snapshot.status, 'timed_out'); assert.equal(snapshot.job.state, 'running');
    assert.match(h.sent.find(s => s.message.details?.cause === 'timeout').message.content, /not cancelled/);
  } finally { if (external) await external.stop(); await h.close(); }
});
test('mismatched and corrupt statuses remain unknown, then recover without resubmission', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd); await h.call('Monitor', { source: job.source, description: 'identity protected' });
    job.status('succeeded', { runId: 'foreign' }); assert.equal(await until(async () => (await h.snapshots())[0].job.state === 'unknown' && (await h.snapshots())[0].sourceError), true); assert.equal(terminal(h).length, 0);
    fs.writeFileSync(job.statusPath, '{'); await sleep(300); assert.equal(terminal(h).length, 0);
    job.status('succeeded'); assert.equal(await until(() => terminal(h).length === 1), true); assert.equal(terminal(h)[0].message.details.job.runId, job.manifest.runId);
  } finally { await h.close(); }
});
test('replacing a manifest never silently adopts another attempt', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd); const receipt = (await h.call('Monitor', { source: job.source, description: 'immutable source' })).details;
    fs.writeFileSync(job.manifestPath, JSON.stringify({ ...job.manifest, runId: 'replacement' })); job.status('succeeded', { runId: 'replacement' });
    assert.equal(await until(async () => Boolean((await h.snapshots())[0].job.error)), true); assert.equal(terminal(h).length, 0); assert.equal((await h.snapshots())[0].job.runId, receipt.job.runId);
  } finally { await h.close(); }
});
test('file EOF is not completion and rules update without changing the source', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd, { stdout: 'old\n' }); const receipt = (await h.call('Monitor', { source: { ...job.fileSource, from: 'now' }, description: 'log observation', watches: [{ id: 'error', text: 'ERROR', once: true }] })).details;
    await sleep(300); assert.equal(h.sent.length, 0);
    fs.appendFileSync(job.stdout, 'noise\nERROR first\nERROR second\n'); assert.equal(await until(() => h.sent.some(s => s.message.details?.cause === 'output')), true);
    assert.equal((await h.snapshots())[0].watches[0].fired, true); assert.equal((await h.snapshots())[0].status, 'running');
    await h.call('Monitor', { action: 'update', id: receipt.taskId, watches: [{ id: 'error', text: 'ERROR', once: true, notify: 'context' }] }); assert.equal((await h.snapshots())[0].watches[0].fired, true);
    await assert.rejects(h.call('Monitor', { source: job.fileSource, description: 'invalid result inference', mode: 'completion' }), /requires a job manifest/);
    assert.equal(fs.readFileSync(job.stdout, 'utf8'), 'old\nnoise\nERROR first\nERROR second\n');
  } finally { await h.close(); }
});
test('explicit reconnection to an already finished run does not start new work', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd, { state: 'succeeded', stdout: 'saved result\n' });
    await h.call('Monitor', { source: job.source, description: 'reconnect' }); assert.equal(await until(() => terminal(h).length === 1), true);
    const content = fs.readFileSync(job.manifestPath, 'utf8'); await h.call('Monitor', { source: job.source, description: 'reconnect again' }); assert.equal(await until(() => terminal(h).length === 2), true);
    assert.equal(fs.readFileSync(job.manifestPath, 'utf8'), content); assert.equal(terminal(h)[1].message.details.job.runId, job.manifest.runId);
  } finally { await h.close(); }
});

test('an older same-run terminal report cannot replace a newer valid running report', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd), stamp = job.manifest.createdAt;
    job.status('running', { updatedAt: stamp + 1000 }); await h.call('Monitor', { source: job.source, description: 'monotonic report' });
    assert.ok(await until(async () => (await h.snapshots())[0].job.state === 'running'));
    job.status('succeeded', { updatedAt: stamp + 500, endedAt: stamp + 500 });
    assert.ok(await until(async () => /stale/.test((await h.snapshots())[0].job.error ?? ''))); assert.equal(terminal(h).length, 0);
    job.status('succeeded', { updatedAt: stamp + 2000, endedAt: stamp + 2000 }); assert.ok(await until(() => terminal(h).length === 1));
  } finally { await h.close(); }
});
test('flapping source errors update diagnostics without flooding context warnings', async () => {
  const h = createHarness(); try {
    const job = createJob(h.cwd); await h.call('Monitor', { source: job.source, description: 'flapping source' });
    fs.writeFileSync(job.statusPath, '{'); assert.ok(await until(async () => /valid JSON/.test((await h.snapshots())[0].sourceError ?? '')));
    fs.writeFileSync(job.statusPath, '{}'); assert.ok(await until(async () => /schema/.test((await h.snapshots())[0].sourceError ?? '')));
    fs.writeFileSync(job.statusPath, '{'); assert.ok(await until(async () => /valid JSON/.test((await h.snapshots())[0].sourceError ?? '')));
    assert.equal(h.sent.filter(m => m.message.content.includes('Observation incomplete')).length, 1); assert.equal(terminal(h).length, 0);
  } finally { await h.close(); }
});
