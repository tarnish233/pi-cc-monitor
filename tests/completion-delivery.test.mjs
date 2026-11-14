import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

const { default: factory } = await loadModule("index.ts");
const installed = findPiInstall();
const { Agent } = await import(pathToFileURL(path.join(installed.root, "@earendil-works", "pi-agent-core", "dist", "agent.js")).href);
const { AgentSession, SessionManager } = await import(pathToFileURL(installed.piCodingAgent).href);

/** Use the real Pi message/queue/storage methods, without a provider or credentials. */
function harness(t) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
	const session = Object.create(AgentSession.prototype);
	const starts = [];
	Object.assign(session, {
		agent: new Agent({ streamFn: async () => { throw new Error("No model/network calls are allowed in this test"); } }),
		sessionManager: SessionManager.inMemory(cwd),
		_isAgentRunActive: true,
		_isEmittingAgentSettled: false,
		_eventListeners: new Set(),
		_steeringMessages: [],
		_followUpMessages: [],
		_pendingNextTurnMessages: [],
		_pendingCustomMessages: [],
		_deferredSettledActions: [],
		_refreshFinalizedContext: () => {},
		_startRun: async ({ message }) => {
			starts.push(message);
			session._appendCustomMessage(message);
		},
	});
	const tools = new Map(), handlers = new Map(), bus = new Map();
	const sent = [], pending = [];
	let stale = false;
	const add = (map, key, fn) => {
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(fn);
		return () => map.set(key, map.get(key).filter(value => value !== fn));
	};
	const pi = {
		registerTool: tool => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		registerToolRenderer: () => {},
		getSettings: () => ({ shellPath: process.platform === "win32" ? undefined : "/bin/bash" }),
		getAllTools: () => [...tools.keys(), "cron_delete"].map(name => ({ name })),
		on: (key, fn) => add(handlers, key, fn),
		events: {
			on: (key, fn) => add(bus, key, fn),
			emit: (key, value) => { for (const fn of bus.get(key) ?? []) fn(value); },
		},
		sendMessage: (message, options) => {
			assert.equal(stale, false, "no stale API call after shutdown");
			sent.push({ message, options });
			pending.push(session.sendCustomMessage(message, options));
		},
	};
	const ctx = {
		cwd, hasUI: false, mode: "print", ui: {},
		sessionManager: session.sessionManager,
		isIdle: () => session.isIdle,
		// Pi's public helper counts user queues, not custom messages.
		hasPendingMessages: () => session.pendingMessageCount > 0,
	};
	factory(pi);
	const emit = async (key, value) => {
		if (key === "agent_settled") session._isEmittingAgentSettled = true;
		try {
			for (const fn of handlers.get(key) ?? []) await fn(value, ctx);
		} finally {
			if (key === "agent_settled") session._isEmittingAgentSettled = false;
		}
		// Real Pi defers triggerTurn sends until all settlement handlers finish.
		for (const action of session._deferredSettledActions.splice(0)) await action();
		await Promise.all(pending.splice(0));
	};
	t.after(async () => {
		await emit("session_shutdown", { reason: "quit" });
		stale = true;
	});
	return { session, tools, pi, ctx, starts, sent, emit, entries: () => session.sessionManager.getBranch().filter(entry => entry.type === "custom_message") };
}

async function finished(h, extra = {}) {
	const receipt = await h.tools.get("Monitor").execute("run", {
		command: "echo done", mode: "completion", description: "delivery regression", ...extra,
	}, undefined, undefined, h.ctx);
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		const list = await h.tools.get("monitor_list").execute("list", {}, undefined, undefined, h.ctx);
		const expected = extra.mode === "events" ? "exited" : "completed";
		if (list.details.monitors.find(item => item.id === receipt.details.taskId)?.status === expected) return receipt;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error("The command did not finish");
}

test("events terminal outbox survives real Pi clearQueue and aborted settlement", async t => {
	const h = harness(t);
	await finished(h, { mode: "events" });
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.session.clearQueue(), { steering: [], followUp: [] });
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: true });
	assert.equal(h.sent.length, 1);
	assert.equal(h.starts.length, 0);
	assert.equal(h.entries().length, 1);
	assert.equal(h.sent[0].message.details.mode, "events");
	assert.ok(h.sent[0].message.details.finalLines.includes("done"));
	assert.equal(h.sent[0].options.triggerTurn, false);
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1);
});

test("context terminal policy stores in the real session without starting a turn", async t => {
	const h = harness(t);
	await finished(h, { notify: { terminal: "context" } });
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1);
	assert.equal(h.starts.length, 0);
	assert.equal(h.entries().length, 1);
	assert.equal(h.sent[0].options.triggerTurn, false);
});

test("completion stays outside Pi's clearable queues while the agent is busy", async t => {
	const h = harness(t);
	await finished(h);
	assert.equal(h.sent.length, 0);
	assert.equal(h.session.agent.peekQueuedMessages().length, 0);
	assert.equal(h.entries().length, 0);
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1);
	assert.equal(h.starts.length, 1);
	assert.equal(h.entries().length, 1);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(h.sent[0].message.details.status, "completed");
	assert.ok(h.sent[0].message.details.stdoutTail.includes("done"));
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1, "a second settle never repeats the outcome");
});

for (const clear of [true, false]) {
	test(`${clear ? "Esc clearQueue" : "RPC abort without clearQueue"} preserves completion without restarting`, async t => {
		const h = harness(t);
		await finished(h);
		if (clear) assert.deepEqual(h.session.clearQueue(), { steering: [], followUp: [] });
		h.session._isAgentRunActive = false;
		await h.emit("agent_settled", { aborted: true });
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].options.triggerTurn, false);
		assert.equal(h.starts.length, 0, "the interrupted reply stays interrupted");
		assert.equal(h.entries().length, 1, "the terminal message is really in Pi's session tree");
		assert.equal(h.session.agent.peekQueuedMessages().length, 0);
		await h.emit("agent_settled", { aborted: false });
		assert.equal(h.sent.length, 1, "nothing is delivered a second time");
	});
}

test("an already-idle completion starts one follow-up immediately", async t => {
	const h = harness(t);
	h.session._isAgentRunActive = false;
	await finished(h);
	assert.equal(h.sent.length, 1);
	assert.equal(h.starts.length, 1);
	assert.equal(h.entries().length, 1);
});

test("manual compaction stores pending completion; automatic compaction waits for settling", async t => {
	const h = harness(t);
	await finished(h);
	await h.emit("session_compact", { reason: "threshold", willRetry: true });
	assert.equal(h.sent.length, 0);
	h.session._isAgentRunActive = false;
	h.session._compactionAbortController = new AbortController();
	await h.emit("session_compact", { reason: "manual", willRetry: false });
	assert.equal(h.entries().length, 1);
	assert.equal(h.starts.length, 0);
	assert.equal(h.sent[0].options.triggerTurn, false);
	h.session._compactionAbortController = undefined;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1);
});

test("failed manual compaction also preserves the pending result without a new turn", async t => {
	const h = harness(t);
	await finished(h);
	h.session._isAgentRunActive = false;
	await h.emit("session_compact_failed", { reason: "manual", aborted: true });
	assert.equal(h.entries().length, 1);
	assert.equal(h.starts.length, 0);
});

test("a stopped loop discards its unsent completion instead of resurrecting the loop", async t => {
	const h = harness(t);
	await finished(h, { loopPrompt: "check the deploy" });
	h.pi.events.emit("loop:stopped", { prompt: "check the deploy", reason: "stopped" });
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 0);
	assert.equal(h.starts.length, 0);
});

test("shutdown drops pending wakeups and later stale settlement is a no-op", async t => {
	const h = harness(t);
	await finished(h);
	await h.emit("session_shutdown", { reason: "reload" });
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 0);
	assert.equal(h.starts.length, 0);
});
