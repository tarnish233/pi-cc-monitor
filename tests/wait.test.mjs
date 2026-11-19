import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHarness, until } from "./runtime-harness.mjs";
import { assertJsonRoundTrip, loadModule, loadValidators } from "./helpers.mjs";

const { MAX_WAIT_TASKS, WAIT_TAIL_BYTES } = await loadModule("index.ts");
const { compile } = await loadValidators();
const nodeCommand = source => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;

function harness(t, idle = false) {
  const h = createHarness({ idle });
  const entries = [];
  let serial = 0;
  h.ctx.sessionManager.getBranch = () => entries;
  h.ctx.sessionManager.getEntries = () => entries;
  h.wait = (ids, extra = {}, signal, onUpdate) => {
    const callId = `wait-${++serial}`;
    return { callId, promise: h.tools.get("Monitor").execute(callId, { action: "wait", ids, wait_timeout_ms: 10000, ...extra }, signal, onUpdate, h.ctx) };
  };
  h.persist = async (callId, result, overrides = {}) => {
    const message = { role: "toolResult", toolName: "Monitor", toolCallId: callId,
      content: result.content, details: result.details, isError: false, timestamp: Date.now(), ...overrides };
    entries.push({ type: "message", id: `entry-${entries.length}`, message });
    await h.emit("turn_end", { toolResults: [message], outcome: "completed" });
    return message;
  };
  t.after(() => h.close());
  return h;
}

async function ended(h, id, status = "completed") {
  assert.ok(await until(async () => (await h.snapshots()).find(r => r.id === id)?.status === status), `task ${id} reaches ${status}`);
}

async function start(h, command = "echo done", extra = {}) {
  return (await h.call("Monitor", { command, description: "wait dependency", mode: "completion", timeout_ms: 60000, ...extra })).details;
}

/** An external gate, not a timer in the implementation under test. */
async function gated(h, name, extra = {}) {
  const gate = path.join(h.cwd, `${name}.gate`);
  const material = path.join(h.cwd, `${name}.txt`);
  const source = `const fs = require('node:fs'); const gate = ${JSON.stringify(gate)};` +
    `const finish = () => { if (!fs.existsSync(gate)) return; watch.close(); fs.writeFileSync(${JSON.stringify(material)}, ${JSON.stringify(`material:${name}`)}); process.stdout.write(${JSON.stringify(`DONE:${name}\n`)}, () => process.exit(0)); };` +
    `const watch = fs.watch(${JSON.stringify(h.cwd)}, finish); process.stdout.write('READY\\n'); finish();`;
  const task = await start(h, nodeCommand(source), { description: name, ...extra });
  assert.ok(await until(() => fs.existsSync(task.outputPath) && fs.readFileSync(task.outputPath, "utf8").includes("READY")));
  return { ...task, material, release: () => fs.writeFileSync(gate, "go") };
}

async function settle(h, aborted = false) {
  h.setIdle(true);
  await h.emit("agent_settled", { aborted });
}

test("start stays asynchronous; closeout waits only explicit dependencies, not unrelated work", async t => {
  const h = harness(t);
  const a = await gated(h, "A");
  const b = await gated(h, "B");
  const unrelated = await gated(h, "service", { persistent: true });
  // Main-agent independent work can happen while all three background tasks run.
  fs.writeFileSync(path.join(h.cwd, "independent-research.txt"), "independent evidence");
  assert.equal((await h.snapshots()).filter(r => r.status === "running").length, 3);
  const progress = [];
  const wait = h.wait([a.taskId, b.taskId], {}, undefined, value => progress.push(value));
  let returned = false;
  const promise = wait.promise.then(result => { returned = true; return result; });
  a.release();
  await ended(h, a.taskId);
  assert.equal(returned, false, "one finished dependency is not the batch barrier");
  assert.equal(progress[0].details.completed, false);
  assert.equal(h.sent.length, 0, "wait does not require settled notification delivery");
  b.release();
  const result = await promise;
  assert.equal(result.details.completed, true);
  assert.equal(result.details.allSucceeded, true);
  assert.deepEqual(result.details.pendingIds, []);
  assert.deepEqual(result.details.ids, [a.taskId, b.taskId]);
  assert.ok(result.details.monitors[0].stdout.text.includes("DONE:A"));
  assert.ok(result.details.monitors[1].stdout.text.includes("DONE:B"));
  assert.equal(fs.readFileSync(a.material, "utf8"), "material:A");
  assert.equal(fs.readFileSync(b.material, "utf8"), "material:B");
  assert.equal((await h.snapshots()).find(r => r.id === unrelated.taskId).status, "running");
  assert.equal(h.sent.length, 0);
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(h.sent.length, 0, "collected results must not restart a post-report follow-up");
  assert.equal((await h.snapshots()).find(r => r.id === unrelated.taskId).status, "running");
});

test("already-ended results return without waiting for notifications; repeat waits do not repeat notices", async t => {
  const h = harness(t);
  const task = await start(h);
  await ended(h, task.taskId);
  for (let i = 0; i < 2; i++) {
    const wait = h.wait([task.taskId]);
    const result = await wait.promise;
    assert.equal(result.details.completed, true);
    assert.equal(result.details.monitors[0].exitCode, 0);
    assert.equal(result.details.monitors[0].resourceActive, false);
    await h.persist(wait.callId, result);
  }
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("signal termination stays diagnostic after wait consumes the original notice", { skip: process.platform === "win32" }, async t => {
  const h = harness(t);
  const task = await start(h, "kill -TERM $$");
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  assert.equal(result.details.monitors[0].signal, "SIGTERM");
  assert.equal(result.details.monitors[0].cause, "exit");
  assert.equal(result.details.monitors[0].exitCode, null);
  assert.match(result.content[0].text, /signal SIGTERM/);
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.snapshots())[0].signal, "SIGTERM");
  const again = await h.wait([task.taskId]).promise;
  assert.equal(again.details.monitors[0].signal, "SIGTERM");
});

test("asynchronous spawn failure keeps its infrastructure error even with empty logs", async t => {
  const h = harness(t);
  h.ctx.cwd = path.join(h.cwd, "missing-cwd");
  const task = await start(h, "echo cannot-run");
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  assert.equal(result.details.allSucceeded, false);
  assert.equal(result.details.monitors[0].cause, "error");
  assert.match(result.details.monitors[0].error, /ENOENT/);
  assert.match(result.content[0].text, /error:.*ENOENT/);
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(h.sent.length, 0);
  assert.match((await h.snapshots())[0].error, /ENOENT/);
});

test("metadata markers and a changed result are not immutable delivery proof", { skip: process.platform === "win32" }, async t => {
  for (const modified of [false, true]) {
    const h = harness(t);
    const task = await start(h, "kill -TERM $$");
    const wait = h.wait([task.taskId]);
    const result = await wait.promise;
    if (modified) result.structuredContent.monitors[0].signal = "SIGKILL";
    const text = modified ? JSON.stringify(result.structuredContent) : "done";
    await h.persist(wait.callId, result, { content: [{ type: "text", text }] });
    await settle(h, true);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].message.content, /SIGTERM/);
  }
});

test("ordinary notifications and a delivered wait do not scan conversation history", async t => {
  const h = harness(t, true);
  let reads = 0;
  const forbidden = () => { reads++; throw new Error("history must not be read"); };
  h.ctx.sessionManager.getBranch = forbidden;
  h.ctx.sessionManager.getEntries = forbidden;
  const task = await start(h);
  await ended(h, task.taskId);
  assert.equal(h.sent.length, 1);
  assert.equal(reads, 0);
  h.setIdle(false);
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  assert.equal(reads, 0, "wait no longer snapshots all historical entry ids");
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(reads, 0);
});

test("failed command results are collected as failures, not as a successful report", async t => {
  const h = harness(t);
  const good = await start(h);
  const bad = await start(h, nodeCommand("process.stderr.write('actual failure\\n'); process.exitCode = 7"));
  const wait = h.wait([good.taskId, bad.taskId]);
  const result = await wait.promise;
  assert.equal(result.details.completed, true);
  assert.equal(result.details.allSucceeded, false);
  assert.equal(result.details.monitors[1].status, "failed");
  assert.equal(result.details.monitors[1].exitCode, 7);
  assert.match(result.details.monitors[1].stderr.text, /actual failure/);
  assert.match(result.content[0].text, /Not all tasks succeeded/);
  assert.match(result.content[0].text, /not proof that downloaded\/generated files were read/);
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("wait budget returns pending ids without stopping them or changing their deadline", async t => {
  const h = harness(t);
  const done = await start(h);
  await ended(h, done.taskId);
  const pending = await gated(h, "pending");
  const before = (await h.snapshots()).find(r => r.id === pending.taskId);
  const wait = h.wait([done.taskId, pending.taskId], { wait_timeout_ms: 1000 });
  const result = await wait.promise;
  assert.equal(result.details.completed, false);
  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.allSucceeded, false);
  assert.deepEqual(result.details.pendingIds, [pending.taskId]);
  assert.equal(result.details.monitors[1].stdout, undefined, "do not pretend an open log is a final output");
  const after = (await h.snapshots()).find(r => r.id === pending.taskId);
  assert.equal(after.status, "running");
  assert.equal(after.timeoutMs, before.timeoutMs);
  assert.deepEqual(after.notify, before.notify);
  await h.persist(wait.callId, result);
  await settle(h);
  assert.equal(h.sent.length, 0, "only the already-returned subset was collected");
  pending.release();
  await ended(h, pending.taskId);
  assert.deepEqual(h.sent.map(entry => entry.message.details.monitorId), [pending.taskId], "the uncollected task still gets its notification");
});

test("abort releases the wait only; completed results survive and interrupted replies are not restarted", async t => {
  const h = harness(t);
  const done = await start(h);
  await ended(h, done.taskId);
  const pending = await gated(h, "abort-pending");
  const controller = new AbortController();
  const wait = h.wait([done.taskId, pending.taskId], {}, controller.signal);
  controller.abort();
  await assert.rejects(wait.promise, /wait cancelled.*not stopped/);
  assert.equal((await h.snapshots()).find(r => r.id === pending.taskId).status, "running");
  await settle(h, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.monitorId, done.taskId);
  assert.equal(h.sent[0].options.triggerTurn, false);
});

test("context cancellation and a failed progress callback release wait reservations", async t => {
  for (const contextAbort of [true, false]) {
    const h = harness(t);
    const task = await gated(h, contextAbort ? "context-abort" : "progress-error");
    const controller = new AbortController();
    if (contextAbort) h.ctx.signal = controller.signal;
    const wait = h.wait([task.taskId], {}, undefined, contextAbort ? undefined : () => { throw new Error("progress callback failed"); });
    if (contextAbort) controller.abort();
    await assert.rejects(wait.promise, contextAbort ? /wait cancelled/ : /progress callback failed/);
    h.setIdle(true);
    task.release();
    await ended(h, task.taskId);
    assert.equal(h.sent.length, 1, "the aborted/failed wait must not swallow the task's later result");
  }
});

test("abort after wait execution but before its tool result is persisted preserves the outcome", async t => {
  const h = harness(t);
  const task = await start(h);
  const wait = h.wait([task.taskId]);
  await wait.promise;
  await settle(h, true); // No persisted successful wait receipt.
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, false);
  await settle(h);
  assert.equal(h.sent.length, 1);
});

test("nested codemode delivery is acknowledged only when the full result is forwarded", async t => {
  const h = harness(t);
  const task = await start(h);
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  await h.persist("codemode-parent", { content: [{ type: "text", text: "Script completed\n==> text 1/1 <==\n" + JSON.stringify({ result: result.structuredContent }, null, 2) }], details: {} }, {
    toolName: "codemode", nestedCalls: { complete: true, calls: [{ id: wait.callId, name: "Monitor", status: "ok" }] },
  });
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("successful nested metadata alone cannot swallow a failed task outcome", async t => {
  const h = harness(t);
  const task = await start(h, "exit 7");
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  assert.equal(result.details.allSucceeded, false);
  await h.persist("codemode-parent", { content: [{ type: "text", text: "done" }], details: {} }, {
    toolName: "codemode", nestedCalls: { complete: true, calls: [{ id: wait.callId, name: "Monitor", status: "ok" }] },
  });
  await settle(h);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.exitCode, 7);
});

test("full model-visible JSON proves transfer even when nested metadata was omitted", async t => {
  const h = harness(t);
  const task = await start(h);
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  await h.persist("codemode-parent", { content: [{ type: "text", text: JSON.stringify(result.structuredContent) }], details: {} }, { toolName: "codemode" });
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("a failed nested parent or lost nested metadata does not discard the unique result", async t => {
  for (const parent of [
    { isError: true, nestedCalls: { calls: [{ name: "Monitor", status: "ok" }] } },
    { isError: false, nestedCalls: { calls: [], complete: false } },
  ]) {
    const h = harness(t);
    const task = await start(h);
    const wait = h.wait([task.taskId]);
    await wait.promise;
    if (parent.nestedCalls.calls.length) parent.nestedCalls.calls[0].id = wait.callId;
    await h.persist("codemode-parent", { content: [], details: {} }, { toolName: "codemode", ...parent });
    await settle(h, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].options.triggerTurn, false);
  }
});

test("historical nested-call metadata cannot acknowledge a later wait with a reused call id", async t => {
  const h = harness(t);
  await h.persist("old-parent", { content: [], details: {} }, { toolName: "codemode",
    nestedCalls: { complete: true, calls: [{ id: "wait-1", name: "Monitor", status: "ok" }] } });
  const task = await start(h);
  const wait = h.wait([task.taskId]);
  assert.equal(wait.callId, "wait-1");
  await wait.promise;
  await settle(h, true); // The new wait receipt was never persisted.
  assert.equal(h.sent.length, 1, "an old parent cannot consume a new undelivered result");
  assert.equal(h.sent[0].options.triggerTurn, false);
});

test("overlapping batch waits resolve independently and release notification reservations once", async t => {
  const h = harness(t);
  const task = await gated(h, "shared");
  const first = h.wait([task.taskId]);
  const second = h.wait([task.taskId]);
  task.release();
  const results = await Promise.all([first.promise, second.promise]);
  await h.persist(first.callId, results[0]);
  await h.persist(second.callId, results[1]);
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("explicit stop and task timeout remain distinct non-success outcomes", async t => {
  const h = harness(t);
  const stopped = await gated(h, "stopped");
  const stopWait = h.wait([stopped.taskId]);
  assert.equal((await h.call("monitor_stop", { id: stopped.taskId })).details.stopped, true);
  const stopResult = await stopWait.promise;
  assert.equal(stopResult.details.monitors[0].status, "stopped");
  assert.equal(stopResult.details.allSucceeded, false);
  await h.persist(stopWait.callId, stopResult);
  const timeout = await start(h, nodeCommand("setInterval(() => {}, 1000)"), { timeout_ms: 1000 });
  const timeoutWait = h.wait([timeout.taskId], { wait_timeout_ms: 6000 });
  const timeoutResult = await timeoutWait.promise;
  assert.equal(timeoutResult.details.completed, true);
  assert.equal(timeoutResult.details.timedOut, false, "the command deadline, not the wait budget, expired");
  assert.equal(timeoutResult.details.monitors[0].status, "timed_out");
  assert.equal(timeoutResult.details.allSucceeded, false);
  await h.persist(timeoutWait.callId, timeoutResult);
  await settle(h);
  assert.equal(h.sent.length, 0);
});

test("invalid targets and mixed-action arguments fail atomically without starting or changing work", async t => {
  const h = harness(t);
  const task = await gated(h, "valid");
  for (const ids of [[], [""], [task.taskId, task.taskId], [task.taskId, ` ${task.taskId} `], [task.taskId, "missing"], Array(MAX_WAIT_TASKS + 1).fill(task.taskId)]) {
    await assert.rejects(h.wait(ids).promise);
  }
  for (const extra of [{ id: task.taskId }, { command: "echo must-not-start" }, { description: "not start" }, { mode: "completion" }, { timeout_ms: 1000 }, { notify: { terminal: "context" } }, { wait_timeout_ms: 999 }, { wait_timeout_ms: 7200001 }, { wait_timeout_ms: NaN }]) {
    await assert.rejects(h.wait([task.taskId], extra).promise);
  }
  await assert.rejects(h.call("Monitor", { ids: [task.taskId], command: "echo must-not-start", description: "wrong action" }), /explicit action=wait/);
  assert.equal((await h.snapshots()).length, 1);
  h.setIdle(true);
  task.release();
  await ended(h, task.taskId);
  assert.equal(h.sent.length, 1, "failed validation leaked no notification reservation");
});

test("event commands, subscriptions and running persistent commands are not completion waits", async t => {
  const h = harness(t);
  const persistent = await gated(h, "persistent", { persistent: true });
  const observer = (await h.call("Monitor", { mode: "events", source: { monitorId: persistent.taskId }, description: "subscription" })).details;
  const events = await start(h, "echo events", { mode: "events" });
  for (const id of [persistent.taskId, observer.taskId, events.taskId]) await assert.rejects(h.wait([id]).promise, /persistent|command\/completion/);
  assert.equal((await h.snapshots()).find(r => r.id === persistent.taskId).status, "running");
});

test("shutdown cancels wait promises and timers before resource teardown", async t => {
  const h = harness(t);
  const task = await gated(h, "shutdown");
  const wait = h.wait([task.taskId]);
  const rejected = assert.rejects(wait.promise, /runtime has ended/);
  await h.emit("session_shutdown", { reason: "reload" });
  await rejected;
  assert.equal(h.sent.length, 0);
});

test("ended tasks referenced by an active batch wait are not evicted by the history cap", async t => {
  const h = harness(t, true);
  const old = await start(h);
  await ended(h, old.taskId);
  const pending = await gated(h, "history-pending");
  const wait = h.wait([old.taskId, pending.taskId]);
  for (let chunk = 0; chunk < 6; chunk++) {
    const tasks = await Promise.all(Array.from({ length: 10 }, () => start(h, "echo other")));
    await Promise.all(tasks.map(task => ended(h, task.taskId)));
  }
  assert.ok((await h.snapshots()).some(task => task.id === old.taskId), "wait-referenced records survive normal pruning");
  pending.release();
  const result = await wait.promise;
  assert.deepEqual(result.details.monitors.map(task => task.id), [old.taskId, pending.taskId]);
  await h.persist(wait.callId, result);
});

test("batch tails are UTF-8 byte bounded, marked truncated, and leave complete logs unchanged", async t => {
  const h = harness(t);
  const tasks = await Promise.all(Array.from({ length: 4 }, (_, i) => start(h, nodeCommand(
    `const fs = require('node:fs'); fs.writeSync(1, ${JSON.stringify("😀\tstdout\n")}.repeat(2000) + ${JSON.stringify(`OUT-FINAL-${i}\n`)}); fs.writeSync(2, ${JSON.stringify("😀\tstderr\n")}.repeat(2000) + ${JSON.stringify(`ERR-FINAL-${i}\n`)});`
  ))));
  const wait = h.wait(tasks.map(task => task.taskId));
  const result = await wait.promise;
  let bytes = 0;
  for (const [i, task] of result.details.monitors.entries()) {
    for (const stream of ["stdout", "stderr"]) {
      const tail = task[stream];
      bytes += Buffer.byteLength(tail.text);
      assert.equal(tail.truncated, true);
      assert.ok(!tail.text.includes("\ufffd") && !tail.text.includes("\x1b"));
      assert.ok(tail.text.endsWith(`${stream === "stdout" ? "OUT" : "ERR"}-FINAL-${i}`));
    }
    assert.ok(fs.statSync(task.outputPath).size > Buffer.byteLength(task.stdout.text));
  }
  assert.ok(bytes <= WAIT_TAIL_BYTES);
  await h.persist(wait.callId, result);
});

test("large batch receipts respect model output limits and save a complete private receipt", async t => {
  const h = harness(t);
  const tasks = await Promise.all(Array.from({ length: MAX_WAIT_TASKS }, () => start(h, nodeCommand(
    "const fs = require('node:fs'); fs.writeSync(1, 'stdout\\n'.repeat(100)); fs.writeSync(2, 'stderr\\n'.repeat(100))"
  ))));
  const wait = h.wait(tasks.map(task => task.taskId));
  const result = await wait.promise;
  assert.ok(result.details.resultPath);
  const text = result.content[0].text;
  assert.ok(Buffer.byteLength(text) <= 50 * 1024);
  assert.ok(text.split("\n").length <= 2000);
  assert.match(text, /Wait receipt truncated/);
  const complete = fs.readFileSync(result.details.resultPath, "utf8");
  for (const task of tasks) assert.ok(complete.includes(task.taskId));
  if (process.platform !== "win32") assert.equal(fs.statSync(result.details.resultPath).mode & 0o777, 0o600);
  await h.persist(wait.callId, result);
});

test("native schemas distinguish wait results from launch receipts without breaking start/update", async t => {
  const h = harness(t);
  const tool = h.tools.get("Monitor");
  const input = compile(tool.parameters);
  assert.equal(input.check({ action: "wait", ids: ["abc"] }), true);
  assert.equal(input.check({ action: "wait" }), false);
  assert.equal(input.check({ action: "wait", ids: [] }), false);
  assert.equal(input.check({ action: "wait", ids: ["abc", "abc"] }), false);
  assert.equal(input.check({ command: "echo x", description: "start" }), true);
  assert.equal(input.check({ action: "update", id: "abc", notify: { terminal: "context" } }), true);
  assert.equal(input.check({ action: "update" }), false);
  const task = await start(h);
  const wait = h.wait([task.taskId]);
  const result = await wait.promise;
  assert.deepEqual(result.details, result.structuredContent);
  assert.equal(compile(tool.outputSchema).check(result.structuredContent), true);
  assertJsonRoundTrip(result.structuredContent);
  assert.deepEqual([...h.tools.keys()], ["Monitor", "monitor_stop", "monitor_list"]);
  assert.equal(h.handlers.has("context") || h.handlers.has("before_agent_start"), false);
  await h.persist(wait.callId, result);
});
