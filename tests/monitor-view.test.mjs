import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { monitorRole, monitorBadges, monitorListText, observationLabel, startReceipt, updateReceipt, stopReceipt, stopScope } = await loadModule("monitor-view.ts");
const record = (extra = {}) => ({
  id: "abcd1234", kind: "command", mode: "completion", description: "build", status: "running",
  timeoutMs: 600000, persistent: false, notify: { output: "turn", terminal: "turn" },
  outputPath: "/tmp/build.out", stderrPath: "/tmp/build.err", createdAt: 1000, eventCount: 0,
  ...extra,
});
const rule = (extra = {}) => ({ id: "errors", text: "ERROR", stream: "stderr", once: false, notify: "turn", fired: false, ...extra });

test("roles describe four supported combinations, never confuse subscriptions with processes", () => {
  assert.equal(monitorRole(record()), "task");
  assert.equal(monitorRole(record({ mode: "events" })), "watcher");
  assert.equal(monitorRole(record({ kind: "ws", mode: "events" })), "socket");
  assert.equal(monitorRole(record({ kind: "source", mode: "events" })), "subscription");
});

test("start receipts prioritize identity and setup but retain logs, policy and waiting guidance", () => {
  const task = record();
  const text = startReceipt(task);
  assert.equal(text.split("\n")[0], "Started task #abcd1234 · build");
  assert.equal(text.split("\n")[1], "completion · time limit 10m");
  assert.ok(text.includes(task.outputPath) && text.includes(task.stderrPath));
  assert.match(text, /do not poll or sleep/);
  assert.match(text, /not user replies/);
  assert.match(text, /End your turn if you are only waiting/);
  const observer = record({ kind: "source", mode: "events", sourceId: "source12", watches: [], notify: { output: "none", terminal: "context" } });
  const observation = startReceipt(observer);
  assert.match(observation, /^Started subscription/);
  assert.match(observation.split("\n")[1], /source #source12 · muted/);
  assert.match(observation, /stopping it does not stop the source/);
  assert.match(observation, /output none · terminal context/);
  assert.match(observation, /an event is not their reply/);
  assert.match(startReceipt(record({ persistent: true, timeoutMs: 0 })), /session lifetime/);
});

test("updates state the actual delta, including same-count revisions and no-op updates", () => {
  const before = { watches: [rule(), rule({ id: "ready", text: "READY" })], notify: { output: "turn", terminal: "turn" } };
  const next = record({ kind: "source", mode: "events", sourceId: "source12", watches: [rule()], notify: { output: "context", terminal: "turn" } });
  const text = updateReceipt(next, before);
  assert.match(text, /^Updated subscription/);
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
  const view = record({ kind: "source", mode: "events", watches: [], eventCount: 3 });
  const original = JSON.stringify(view);
  assert.ok(monitorBadges(view).includes("output muted"));
  assert.equal(view.status, "running");
  assert.equal(JSON.stringify(view), original);
  assert.ok(monitorBadges({ ...view, watches: [rule({ once: true, fired: true })] }).includes("rules exhausted"));
});

test("stop scopes and receipts never imply that stopping a subscription kills its source", () => {
  const observer = record({ kind: "source", mode: "events", sourceId: "source12", status: "stopped" });
  assert.match(stopScope(observer), /subscription only; source command #source12 is not stopped/);
  assert.match(stopReceipt(observer, true), /source command #source12 was not stopped/);
  assert.match(stopScope(record({ kind: "ws", mode: "events" })), /remote service is not stopped/);
  assert.match(stopReceipt(record({ status: "stop_timeout", resourceActive: true }), false), /^Stop unconfirmed/);
  assert.match(stopReceipt(record({ status: "stop_timeout", resourceActive: true }), false), /Stop can be retried/);
  assert.match(stopReceipt(record({ status: "completed", resourceActive: false }), true), /^Cleanup confirmed/);
  assert.match(stopReceipt(record({ status: "completed", resourceActive: false }), true), /outcome remains completed/);
});

test("list text is a stable snapshot: roles, source relation, frozen age, counts and cleanup", () => {
  const task = record({ status: "completed", endedAt: 61000, exitCode: 0, resourceActive: true });
  const source = record({ id: "observer", kind: "source", mode: "events", sourceId: task.id, status: "exited", endedAt: 61000, exitCode: 0, eventCount: 2, suppressedCount: 3, globalSuppressedCount: 4 });
  const list = Object.freeze([Object.freeze(task), Object.freeze(source)]);
  const first = monitorListText(list, 90000);
  assert.equal(first, monitorListText(list, 180000), "ended ages must not keep advancing");
  assert.match(first, /completed\s+task\s+build #abcd1234/);
  assert.match(first, /subscription\s+build #observer → #abcd1234/);
  assert.match(first, /cleanup pending/);
  assert.match(first, /2 events · 3 suppressed · 4 session-suppressed/);
  assert.match(first, /source exit 0/);
  assert.doesNotMatch(first.split("\n")[0], /0 events/);
  assert.equal(monitorListText([]), "No monitors.");
});
