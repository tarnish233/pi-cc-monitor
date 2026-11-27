/** Fixtures belong to the test runner, not the Monitor extension. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function createJob(cwd, options = {}) {
  const jobId = options.jobId ?? 'job-' + randomUUID();
  const root = path.join(cwd, jobId); fs.mkdirSync(root, { mode: 0o700 });
  const createdAt = Date.now(), runId = randomUUID();
  const manifest = { schema: 'pi-cc-job', version: 1, jobId, runId, createdAt, runner: { name: 'fixture', id: jobId }, stdout: 'stdout.log', stderr: 'stderr.log', status: 'status.json', ...options.manifest };
  const stdout = path.join(root, manifest.stdout), stderr = path.join(root, manifest.stderr), statusPath = path.join(root, manifest.status), manifestPath = path.join(root, 'job.json');
  fs.writeFileSync(stdout, options.stdout ?? ''); fs.writeFileSync(stderr, options.stderr ?? '');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const status = (state, extra = {}) => {
    const stamp = Math.max(Date.now(), createdAt);
    const value = { schema: 'pi-cc-job.status', version: 1, jobId: manifest.jobId, runId: manifest.runId, state, updatedAt: stamp, ...(state === 'queued' || state === 'running' ? {} : { endedAt: stamp, exitCode: state === 'succeeded' ? 0 : 1 }), ...extra };
    const tmp = statusPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, statusPath); return value;
  };
  status(options.state ?? 'running');
  return { root, manifest, manifestPath, stdout, stderr, statusPath, status, source: { kind: 'job', manifest: manifestPath }, fileSource: { kind: 'file', stdout, stderr } };
}
export async function startExternal(cwd, code, options = {}) {
  const job = createJob(cwd, options);
  const out = fs.openSync(job.stdout, 'a'), err = fs.openSync(job.stderr, 'a');
  let child;
  try { child = spawn(process.execPath, ['-e', code], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const completion = new Promise(resolve => child.once('exit', (exitCode, signal) => {
    job.status(exitCode === 0 && !signal ? 'succeeded' : 'failed', { exitCode, ...(signal ? { signal } : {}) }); resolve({ exitCode, signal });
  }));
  return { ...job, child, pid: child.pid, completion, async stop() {
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} }
    await completion;
  } };
}
