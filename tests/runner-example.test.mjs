/** Validate the ordinary recorder and a private native tmux runner, never real training. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHarness, until, sleep } from './runtime-harness.mjs';
import { loadModule, extensionDir } from './helpers.mjs';
const { parseJobManifest, parseJobStatus } = await loadModule('job-protocol.ts');
const wrapper = path.join(extensionDir, 'examples/job-wrapper.py');
const hasPython3 = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0;
const hasTmux = hasPython3 && process.platform !== 'win32' && spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const q = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
function recorder(cwd, root, code) { return spawnSync('python3', [wrapper, '--runner', 'fixture', '--runner-id', 'foreground-test', root, '--', process.execPath, '-e', code], { cwd, encoding: 'utf8', timeout: 10000 }); }
function result(root) { const job = parseJobManifest(fs.readFileSync(path.join(root, 'job.json'), 'utf8'), path.join(root, 'job.json')); return { job, status: parseJobStatus(fs.readFileSync(job.status, 'utf8'), job) }; }

test('recorder writes valid atomic metadata/results, stable logs, and rejects duplicate run directories', { skip: !hasPython3 && 'python3 unavailable in this environment' }, async () => {
  const h = createHarness(); try {
    const root = path.join(h.cwd, 'recorded'); const r = recorder(h.cwd, root, "console.log('RECORDED');console.error('DETAIL');process.exit(7)"); assert.equal(r.status, 7, r.stderr || r.error?.message);
    const parsed = result(root); assert.equal(parsed.status.state, 'failed'); assert.equal(parsed.status.exitCode, 7); assert.match(fs.readFileSync(parsed.job.stdout, 'utf8'), /RECORDED/); assert.match(fs.readFileSync(parsed.job.stderr, 'utf8'), /DETAIL/);
    assert.equal('command' in JSON.parse(fs.readFileSync(path.join(root, 'job.json'))), false); assert.equal(fs.readdirSync(root).some(name => name.includes('.tmp-')), false);
    const before = fs.readFileSync(path.join(root, 'job.json'), 'utf8'); assert.equal(recorder(h.cwd, root, "console.log('SHOULD_NOT_RUN')").status, 2); assert.equal(fs.readFileSync(path.join(root, 'job.json'), 'utf8'), before); assert.doesNotMatch(fs.readFileSync(parsed.job.stdout, 'utf8'), /SHOULD_NOT_RUN/);
  } finally { await h.close(); }
});
test('native tmux task survives observation reload and can be reobserved without rerunning', { skip: !hasTmux }, async () => {
  const h = createHarness(), socket = 'pi-observe-' + randomUUID(), name = 'native-test', root = path.join(h.cwd, 'native-run'); let reconnect;
  const command = ['python3', wrapper, '--runner', 'tmux', '--runner-id', name, root, '--', process.execPath, '-e', "let n=0;const timer=setInterval(()=>{console.log('TMUX-TICK '+(++n));if(n===25){clearInterval(timer);console.log('TMUX-FINAL')}},50)"].map(q).join(' ');
  try {
    const start = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, '-c', h.cwd, 'exec ' + command], { encoding: 'utf8' }); assert.equal(start.status, 0, start.stderr);
    assert.ok(await until(() => fs.existsSync(path.join(root, 'job.json')) && fs.readFileSync(path.join(root, 'stdout.log'), 'utf8').includes('TMUX-TICK')));
    await h.call('Monitor', { source: { kind: 'job', manifest: path.join(root, 'job.json') }, description: 'native runner', persistent: true }); await h.emit('session_shutdown', { reason: 'reload' });
    const before = fs.statSync(path.join(root, 'stdout.log')).size; await sleep(150); assert.ok(fs.statSync(path.join(root, 'stdout.log')).size > before); assert.equal(spawnSync('tmux', ['-L', socket, 'has-session', '-t', name]).status, 0);
    assert.ok(await until(() => result(root).status.state === 'succeeded')); const manifest = fs.readFileSync(path.join(root, 'job.json'), 'utf8');
    reconnect = createHarness(); await reconnect.call('Monitor', { source: { kind: 'job', manifest: path.join(root, 'job.json') }, description: 'same finished run' }); assert.ok(await until(() => reconnect.sent.some(m => m.message.details.cause === 'job')));
    assert.equal(fs.readFileSync(path.join(root, 'job.json'), 'utf8'), manifest); assert.match(reconnect.sent.find(m => m.message.details.cause === 'job').message.details.stdoutTail, /TMUX-FINAL/);
  } finally { spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); if (reconnect) await reconnect.close(); await h.close(); }
});
test('only native cancellation reaches the recorder/command and can save a checkpoint', { skip: !hasTmux }, async () => {
  const h = createHarness(), socket = 'pi-cancel-' + randomUUID(), name = 'cancel-test', root = path.join(h.cwd, 'cancel-run'), checkpoint = path.join(h.cwd, 'checkpoint');
  const code = "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(" + JSON.stringify(checkpoint) + ",'saved');process.exit(0)});console.log('CANCEL-READY');let n=0;const t=setInterval(()=>{if(++n===40){clearInterval(t)}},50)";
  const command = ['python3', wrapper, '--runner', 'tmux', '--runner-id', name, '--cancel-grace', '1', root, '--', process.execPath, '-e', code].map(q).join(' ');
  try {
    assert.equal(spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', name, '-c', h.cwd, 'exec ' + command]).status, 0);
    assert.ok(await until(() => fs.existsSync(path.join(root, 'stdout.log')) && fs.readFileSync(path.join(root, 'stdout.log'), 'utf8').includes('CANCEL-READY')));
    const observed = (await h.call('Monitor', { source: { kind: 'job', manifest: path.join(root, 'job.json') }, description: 'cancel boundary', persistent: true })).details;
    await h.call('monitor_stop', { id: observed.taskId }); assert.equal(fs.existsSync(checkpoint), false); assert.equal(result(root).status.state, 'running');
    assert.equal(spawnSync('tmux', ['-L', socket, 'kill-session', '-t', name]).status, 0); assert.ok(await until(() => fs.existsSync(checkpoint) && result(root).status.state === 'cancelled'));
    assert.equal(fs.readFileSync(checkpoint, 'utf8'), 'saved'); assert.equal(result(root).status.exitCode, 0);
  } finally { spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }); await h.close(); }
});

test('status-recording failures never orphan the command or falsify its native exit', { skip: !hasPython3 && 'python3 unavailable in this environment' }, async () => {
  const h = createHarness(); try {
    for (const failedStates of [['running'], ['running', 'succeeded']]) {
      const root = path.join(h.cwd, 'advisory-' + failedStates.length), marker = path.join(h.cwd, 'finished-' + failedStates.length);
      const code = "setTimeout(()=>{require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'finished');console.log('ACTUAL-RESULT')},50)";
      const script = [
        'import runpy,sys,json',
        "ns=runpy.run_path(sys.argv[1]);main=ns['main'];real=main.__globals__['atomic_json']",
        'failed=json.loads(sys.argv[5])',
        'def injected(directory,name,value):',
        "    if name=='status.json' and value.get('state') in failed: raise OSError('ENOSPC injected')",
        '    return real(directory,name,value)',
        "main.__globals__['atomic_json']=injected",
        "sys.argv=['recorder','--runner','fixture','--runner-id','advisory',sys.argv[2],'--',sys.argv[3],'-e',sys.argv[4]]",
        'sys.exit(main())',
      ].join('\n');
      const r = spawnSync('python3', ['-c', script, wrapper, root, process.execPath, code, JSON.stringify(failedStates)], { cwd: h.cwd, encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, 0, r.stderr || r.error?.message); assert.equal(fs.readFileSync(marker, 'utf8'), 'finished'); assert.match(fs.readFileSync(path.join(root, 'stdout.log'), 'utf8'), /ACTUAL-RESULT/); assert.match(r.stderr, /status recording failed/);
      if (failedStates.length === 1) assert.equal(result(root).status.state, 'succeeded'); else assert.equal(fs.existsSync(path.join(root, 'status.json')), false);
    }
  } finally { await h.close(); }
});
