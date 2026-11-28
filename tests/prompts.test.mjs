import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadModule } from './helpers.mjs';
const { MONITOR_DESCRIPTION: description, MONITOR_PROMPT_GUIDELINES: guidelines, MONITOR_TIMEOUTS: deadlines, JOB_RECORDER: recorderPath } = await loadModule('prompts.ts');

test('metadata directs business execution to native runners and exposes observation sources only', () => {
  assert.equal(guidelines.length, 6); assert.ok(guidelines.every(rule => rule.includes('Monitor')));
  assert.match(description, /never starts, cancels, restarts/); assert.match(description, /external runner/); assert.match(description, /kind: "file"/); assert.match(description, /kind: "job"/); assert.match(description, /kind: "ws"/);
  assert.match(description, /Legacy command, top-level ws and source.monitorId inputs are rejected/);
  // A live run showed a model hand-writing a recorder per job (with its argv in
  // the manifest and a reused run directory). The description names the bundled
  // recorder instead, so the correct metadata is one command away.
  const recorder = /python3 (\S+\/examples\/job-wrapper\.py)/.exec(description)?.[1];
  assert.ok(recorder, 'the description names the bundled recorder');
  assert.equal(recorder, recorderPath);
  assert.ok(fs.existsSync(recorderPath), `${recorderPath} ships with the package`);
  assert.match(description, /creating the directory exclusively|creates the directory exclusively/); assert.match(description, /Do not install\/configure a runner automatically/);
});
test('supplied sources go straight to Monitor and WebSockets have no replay field', () => {
  assert.match(description.split('\n')[0], /supplied source; no Bash preflight/);
  assert.match(guidelines[0], /supplied source; no Bash preflight/);
  assert.match(description, /No from for WebSocket/);
  assert.match(description, /Use event lines as delivered; don't reread logs/);
});
test('waiting/result verification remains strong without unconditional final handoff', () => {
  const text = guidelines.join('\n'); assert.match(text, /observation receipt/); assert.match(text, /Continue independent work/); assert.match(text, /Do not poll, sleep/); assert.match(text, /Verify the external job/); assert.match(text, /every required job result/); assert.match(text, /not a user's reply/);
  assert.match(description, /safe response\/tool-batch boundary/); assert.match(description, /from idle/); assert.match(description, /not an independent OS audit/); assert.match(description, /Esc does not replay/);
});
test('observer deadlines keep existing values but cannot control job lifetime', () => {
  assert.deepEqual(deadlines, { events: { defaultMs: 300000, maxMs: 3600000 }, completion: { defaultMs: 1800000, maxMs: 7200000 } });
  assert.match(description, /timeout_ms ends only the observation/); assert.match(description, /persistent=true/); assert.match(description, /Reconnected|Reconnect to the same job\/run/); assert.match(description, /never submit a replacement implicitly/);
});
test('artifact and source-error guidance prevents accidental cleanup or false job results', () => {
  assert.match(description, /OBSERVATION COPIES/); assert.match(description, /read|Read/); assert.match(description, /\.1/); assert.match(description, /logTruncated and sourceGap/); assert.match(description, /Runner logs require their own/);
  assert.match(description, /Keep run scripts, manifests, status, checkpoints and formal outputs/); assert.match(description, /A log EOF, a stopped watcher, or an SSH error is never a business-job result/);
  assert.match(description, /never open both `events` and `completion` for the same job/);
  assert.match(guidelines[4], /never open a second completion Monitor for the same job/);
});
