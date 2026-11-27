import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { monitorRole, monitorBadges, monitorListText, observationLabel, startReceipt, updateReceipt, stopReceipt, stopScope } = await loadModule("monitor-view.ts");
const record = (extra = {}) => ({
  id: "abcd1234", kind: "job", mode: "completion", description: "build", status: "running",
  timeoutMs: 600000, persistent: false, notify: { output: "turn", terminal: "turn" },
  outputPath: "/tmp/build.out", stderrPath: "/tmp/build.err", createdAt: 1000, eventCount: 0,
  ...extra,
});
const rule = (extra = {}) => ({ id: "errors", text: "ERROR", stream: "stderr", once: false, notify: "turn", fired: false, ...extra });

test("roles map live observation kinds and modes cleanly", () => {
  assert.equal(monitorRole(record()), "task");
  assert.equal(monitorRole(record({ kind: "file", mode: "events" })), "watcher");
  assert.equal(monitorRole(record({ kind: "job", mode: "completion" })), "task");
  assert.equal(monitorRole(record({ kind: "job", mode: "events" })), "watcher");
  assert.equal(monitorRole(record({ kind: "ws", mode: "events" })), "socket");
});

test("start receipts prioritize identity and setup while retaining logs, policy and waiting guidance", () => {
  const task = record();
  const text = startReceipt(task);
  assert.equal(text.split("\n")[0], "Started task #abcd1234 · build");
  assert.equal(text.split("\n")[1], "completion · time limit 10m");
  assert.ok(text.includes(task.outputPath) && text.includes(task.stderrPath));
  assert.match(text, /Do not poll, sleep or re-read the logs/);
  assert.match(text, /not user replies/);
  assert.match(text, /Continue independent work; if only waiting for Monitor, end your turn/);
  assert.match(text, /Do NOT report results, conclusions or estimates.*while it is pending/);
  assert.ok(text.includes("next response/tool-batch boundary"));
  assert.doesNotMatch(text, /End your turn now/);
  const observer = record({ kind: "file", mode: "events", watches: [], notify: { output: "none", terminal: "turn" } });
  const observation = startReceipt(observer);
  assert.match(observation, /^Started watcher/);
  assert.match(observation, /Observation only\. Stopping it/);
  assert.match(observation, /output none · terminal turn/);
  assert.match(observation, /an event is not their reply/);
  assert.match(startReceipt(record({ persistent: true, timeoutMs: 0 })), /session lifetime/);
});

test("updates state the actual delta, including same-count revisions and no-op updates", () => {
  const before = { watches: [rule(), rule({ id: "ready", text: "READY" })], notify: { output: "turn", terminal: "turn" } };
  const next = record({ kind: "file", mode: "events", watches: [rule()], notify: { output: "context", terminal: "turn" } });
  const text = updateReceipt(next, before);
  assert.match(text, /^Updated watcher/);
  assert.match(text, /rules: 2 → 1/);
  assert.match(text, /output: turn → context/);
  assert.match(text, /work and lifetime unchanged/);
  assert.match(updateReceipt({ ...next, watches: [rule({ text: "FAILED" })] }, { watches: next.watches, notify: next.notify }), /rules revised \(1\)/);
  assert.match(updateReceipt({ ...next, watches: [rule({ fired: true })] }, { watches: next.watches, notify: next.notify }), /No policy changes/);
  assert.match(updateReceipt({ ...next, watches: [] }, { watches: next.watches, notify: next.notify }), /1 → 0 \(muted\)/);
});

test("muting and once-rule consumption are badges, not lifecycle states", () => {
  assert.equal(observationLabel(undefined), "all stdout");
  assert.equal(observationLabel([]), "muted");
  assert.equal(observationLabel([rule({ once: true, fired: true })]), "rules exhausted");
  assert.equal(observationLabel([rule({ fired: true })]), "1 rule", "a repeat match is still active");
  const view = record({ kind: "file", mode: "events", watches: [], eventCount: 3 });
  const original = JSON.stringify(view);
  assert.ok(monitorBadges(view).includes("output muted"));
  assert.equal(view.status, "running");
  assert.equal(JSON.stringify(view), original);
  assert.ok(monitorBadges({ ...view, watches: [rule({ once: true, fired: true })] }).includes("rules exhausted"));
});

test("stop scopes and receipts never imply that stopping an observation cancels external work", () => {
  const observer = record({ kind: "file", mode: "events", status: "stopped" });
  assert.match(stopScope(observer), /observation only; the external runner\/job is not cancelled/);
  assert.match(stopReceipt(observer, true), /external work was not cancelled/);
  assert.match(stopScope(record({ kind: "ws", mode: "events" })), /remote service is not stopped/);
  assert.match(stopReceipt(record({ status: "stop_timeout", resourceActive: true }), false), /^Stop unconfirmed/);
  assert.match(stopReceipt(record({ status: "stop_timeout", resourceActive: true }), false), /Stop can be retried/);
  assert.match(stopReceipt(record({ status: "completed", resourceActive: false }), true), /^Cleanup confirmed/);
  assert.match(stopReceipt(record({ status: "completed", resourceActive: false }), true), /outcome remains completed/);
});

test("list text is a stable snapshot: roles, frozen age, counts and cleanup", () => {
  const job = { jobId: "run", runId: "attempt", runner: { name: "tmux", id: "run" }, manifestPath: "/runs/job.json", statusPath: "/runs/status.json", createdAt: 0, state: "succeeded", endedAt: 61000, exitCode: 0 };
  const task = record({ status: "completed", endedAt: 61000, job, resourceActive: true });
  const watcher = record({ id: "observer", kind: "file", mode: "events", status: "stopped", endedAt: 61000, eventCount: 2, suppressedCount: 3, globalSuppressedCount: 4 });
  const list = Object.freeze([Object.freeze(task), Object.freeze(watcher)]);
  const first = monitorListText(list, 90000);
  assert.equal(first, monitorListText(list, 180000), "ended ages must not keep advancing");
  assert.match(first, /completed\s+task\s+build #abcd1234/);
  assert.match(first, /watcher\s+build #observer/);
  assert.match(first, /cleanup pending/);
  assert.match(first, /2 events · 3 suppressed · 4 session-suppressed/);
  assert.match(first, /job exit 0/);
  assert.doesNotMatch(first.split("\n")[0], /0 events/);
  assert.equal(monitorListText([]), "No monitors.");
});

test("a degraded ws log is a visible badge, not a lifecycle state", () => {
  const healthy = record({ kind: "ws", mode: "events" });
  assert.ok(!monitorBadges(healthy).includes("log incomplete"));
  const degraded = record({ kind: "ws", mode: "events", logError: "disk writes fell behind (4 MiB log backlog cap)" });
  assert.ok(monitorBadges(degraded).includes("log incomplete"));
  assert.equal(degraded.status, "running", "the badge never changes the status vocabulary");
  assert.match(monitorListText([degraded], 2000), /log incomplete/);
  assert.doesNotMatch(monitorListText([healthy], 2000), /log incomplete/);
});

test("new file/job sources show muted and exhausted rules", () => {
  for (const kind of ["file", "job"]) {
    const muted = record({ kind, mode: "events", watches: [] });
    assert.equal(monitorRole(muted), "watcher"); assert.ok(monitorBadges(muted).includes("output muted"));
    assert.ok(monitorBadges({ ...muted, watches: [rule({ once: true, fired: true })] }).includes("rules exhausted"));
    assert.match(stopScope(muted), /observation only/); assert.match(stopScope(muted), /not cancelled or signalled/);
  }
});

test("an observation receipt never claims an already-finished external job has no result", () => {
  const job = { jobId: "run", runId: "attempt", runner: { name: "tmux", id: "run" }, manifestPath: "/runs/job.json", statusPath: "/runs/status.json", createdAt: 0, state: "failed", endedAt: 10, exitCode: 7 };
  const view = record({ kind: "job", job }); const receipt = startReceipt(view);
  assert.match(receipt, /external job may already be running or finished/); assert.match(receipt, /verifies no business result/); assert.doesNotMatch(receipt, /No result exists yet/);
  assert.match(monitorListText([view]), /job failed · job exit 7/);
});
