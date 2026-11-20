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
const { ExtensionRunner } = await import(pathToFileURL(path.join(installed.root, "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "runner.js")).href);

/** Use the real Pi message/queue/storage methods, without a provider or credentials. */
function harness(t) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
	const session = Object.create(AgentSession.prototype);
	const starts = [];
	Object.assign(session, {
		agent: new Agent({ streamFn: async () => { throw new Error("No model/network calls are allowed in this test"); } }),
		sessionManager: SessionManager.inMemory(cwd),
		_cwd: cwd,
		_entryIdsByMessage: new WeakMap(),
		_boundaryDispatchedMessages: new WeakSet(),
		_turnIndex: 0,
		_isAgentRunActive: true,
		_isEmittingAgentSettled: false,
		_eventListeners: new Set(),
		_steeringMessages: [],
		_followUpMessages: [],
		_pendingNextTurnMessages: [],
		_pendingCustomMessages: [],
		_deferredSettledActions: [],
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
	const abortController = new AbortController();
	const ctx = {
		cwd, hasUI: false, mode: "print", ui: {}, signal: abortController.signal,
		sessionManager: session.sessionManager,
		isIdle: () => session.isIdle,
		// Pi's public helper counts user queues, not custom messages.
		hasPendingMessages: () => session.pendingMessageCount > 0,
	};
	factory(pi);
	const errors = [];
	// Exercise Pi's actual boundary composition, validation and persistence,
	// not a mock that ignores a handler's continuation result.
	session._extensionRunner = Object.assign(Object.create(ExtensionRunner.prototype), {
		extensions: [{ path: "pi-cc-monitor/index.ts", handlers }],
		createContext: () => ctx,
		emitError: error => errors.push(error),
	});
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
	const finishTurn = async ({ outcome = "completed", tools: withTools = true, afterBoundary } = {}) => {
		if (!session.sessionManager.getBranch().length) {
			session.sessionManager.appendMessage({ role: "user", content: "Continue independent work", timestamp: Date.now() });
		}
		const callId = `independent-${session._turnIndex}`;
		const toolResults = withTools && outcome === "completed" ? [{
			role: "toolResult", toolCallId: callId, toolName: "read", isError: false,
			content: [{ type: "text", text: "independent tool finished" }], timestamp: Date.now(),
		}] : [];
		const message = {
			role: "assistant", api: "test", provider: "test", model: "test", timestamp: Date.now(),
			content: toolResults.length
				? [{ type: "toolCall", id: callId, name: "read", arguments: { path: "notes.md" } }]
				: [{ type: "text", text: "Current response finished" }],
			stopReason: outcome === "completed" ? (toolResults.length ? "toolUse" : "stop") : outcome,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.sessionManager.appendMessage(message);
		for (const result of toolResults) session.sessionManager.appendMessage(result);
		session._refreshFinalizedContext();
		// These are the same two stages used by AgentSession.finishTurn and the
		// subsequent low-level turn_end event, with no model or credentials.
		session._boundaryDispatchedMessages.add(message);
		const continuation = await session._dispatchTurnEndBoundary(message, toolResults);
		await Promise.all(pending.splice(0));
		await afterBoundary?.(continuation);
		// The low-level turn_end event uses this prototype method to commit
		// context-only messages after all assistant/tool entries are persisted.
		session._flushPendingCustomMessages();
		session._turnIndex++;
		return continuation;
	};
	return { session, tools, pi, ctx, starts, sent, emit, finishTurn, abortController, errors,
		entries: () => session.sessionManager.getBranch().filter(entry => entry.type === "custom_message") };
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

test("busy completion reaches context at the next tool boundary without waiting for settlement", async t => {
	const h = harness(t);
	await finished(h);
	assert.equal(h.sent.length, 0, "completion does not interrupt the active response");
	assert.equal(await h.finishTurn(), true, "one continuation is requested at the boundary");
	assert.equal(h.errors.length, 0, "Pi accepts the boundary and its continuation");
	assert.equal(h.session.isIdle, false, "independent work has not settled");
	assert.equal(h.starts.length, 0, "no separate run is started in the middle of work");
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].options.triggerTurn, false, "context append, not a clearable steering send");
	assert.equal(h.entries().length, 1);
	const messages = h.session.agent.state.messages;
	assert.equal(messages.at(-2).role, "toolResult", "the entire tool batch precedes the completion");
	assert.equal(messages.at(-1).role, "custom", "the next provider request sees the result");
	assert.equal(messages.at(-1).details.status, "completed");
	assert.equal(await h.finishTurn(), false, "the next boundary does not request another continuation");
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.sent.length, 1, "no stale completion after the final report");
	assert.equal(h.starts.length, 0);
});

test("clearQueue before and during boundary handoff cannot discard the completion", async t => {
	const h = harness(t);
	await finished(h);
	h.session.clearQueue();
	await h.finishTurn({ afterBoundary: continuation => {
		assert.equal(continuation, true);
		assert.equal(h.session.agent.peekQueuedMessages().length, 0);
		assert.equal(h.session._pendingCustomMessages.length, 1, "Pi holds a non-clearable context append");
		h.session.clearQueue();
		assert.equal(h.session._pendingCustomMessages.length, 1);
	} });
	assert.equal(h.entries().length, 1);
	assert.equal(h.session._pendingCustomMessages.length, 0);
	h.session.clearQueue();
	assert.equal(h.entries().length, 1, "the persisted outcome survives later Esc too");
});

test("a completion after a text-only response requests one next response, not an idle follow-up", async t => {
	const h = harness(t);
	await finished(h);
	assert.equal(await h.finishTurn({ tools: false }), true);
	assert.equal(h.entries().length, 1);
	assert.equal(h.starts.length, 0);
	assert.equal(h.errors.length, 0);
});

test("context-only terminal at a boundary is visible but never requests continuation", async t => {
	const h = harness(t);
	await finished(h, { notify: { terminal: "context" } });
	assert.equal(await h.finishTurn({ tools: false }), false);
	assert.equal(h.entries().length, 1);
	assert.equal(h.sent[0].options.triggerTurn, false);
	assert.equal(h.starts.length, 0);
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: false });
	assert.equal(h.starts.length, 0);
	assert.equal(h.sent.length, 1);
});

test("multiple outcomes at one boundary coalesce continuation and retain each policy", async t => {
	const h = harness(t);
	await finished(h);
	await finished(h, { notify: { terminal: "context" } });
	assert.equal(await h.finishTurn(), true);
	assert.equal(h.entries().length, 2);
	assert.deepEqual(h.entries().map(entry => entry.details.notifyLevel), ["turn", "context"]);
	assert.equal(h.starts.length, 0);
	assert.equal(await h.finishTurn(), false);
	assert.equal(h.sent.length, 2);
});

for (const outcome of ["aborted", "error"]) {
	test(`${outcome} response does not force boundary continuation and retains the outbox`, async t => {
		const h = harness(t);
		await finished(h);
		assert.equal(await h.finishTurn({ outcome, tools: false }), false);
		assert.equal(h.sent.length, 0);
		assert.equal(h.entries().length, 0);
		h.session._isAgentRunActive = false;
		await h.emit("agent_settled", { aborted: outcome === "aborted" });
		assert.equal(h.entries().length, 1);
		assert.equal(h.starts.length, outcome === "aborted" ? 0 : 1, "the original settled fallback policy is preserved");
	});
}

test("an already-aborted signal wins over a completed boundary outcome", async t => {
	const h = harness(t);
	await finished(h);
	h.abortController.abort();
	assert.equal(await h.finishTurn(), false);
	assert.equal(h.sent.length, 0);
	h.session._isAgentRunActive = false;
	await h.emit("agent_settled", { aborted: true });
	assert.equal(h.entries().length, 1);
	assert.equal(h.starts.length, 0);
});

test("a failed boundary publish stays protected and never requests an empty continuation", async t => {
	const h = harness(t);
	await finished(h);
	const send = h.pi.sendMessage;
	h.pi.sendMessage = () => { throw new Error("publish temporarily unavailable"); };
	assert.equal(await h.finishTurn(), false);
	assert.equal(h.entries().length, 0);
	assert.equal(h.errors.length, 0);
	h.pi.sendMessage = send;
	assert.equal(await h.finishTurn(), true);
	assert.equal(h.entries().length, 1);
});

test("events terminal results use the same safe boundary, leaving live output routing unchanged", async t => {
	const h = harness(t);
	await finished(h, { mode: "events" });
	assert.equal(h.sent.length, 0);
	assert.equal(await h.finishTurn(), true);
	assert.equal(h.entries().length, 1);
	assert.equal(h.entries()[0].details.mode, "events");
	assert.ok(h.entries()[0].details.finalLines.includes("done"));
});

test("a stopped loop cannot be revived by the next boundary", async t => {
	const h = harness(t);
	await finished(h, { loopPrompt: "check the deploy" });
	h.pi.events.emit("loop:stopped", { prompt: "check the deploy", reason: "stopped" });
	assert.equal(await h.finishTurn(), false);
	assert.equal(h.sent.length, 0);
	assert.equal(h.entries().length, 0);
});

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

/** The real navigateTree control flow with a scripted session_before_tree outcome. */
function treeHarness(t, beforeTree) {
	const h = harness(t);
	h.session._isAgentRunActive = false;
	h.session._extensionRunner = {
		hasHandlers: type => type === "session_before_tree",
		emit: async event => {
			if (event.type === "session_before_tree") return beforeTree(event, h);
			await h.emit(event.type, event);
		},
	};
	// Tool loadout restoration is unrelated to delivery and needs the full runtime.
	h.session._restoreToolsFromTranscript = () => {};
	return h;
}

async function delivered(h, timeoutMs = 3000) {
	const until = Date.now() + timeoutMs;
	while (!h.sent.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
	return h.sent.length;
}

test("a cancelled tree navigation delivers the stranded completion context-only, once", async t => {
	let release;
	const gate = new Promise(resolve => release = resolve);
	const h = treeHarness(t, async () => { await gate; return { cancel: true }; });
	try {
		const target = h.session.sessionManager.appendCustomEntry("target", {});
		h.session.sessionManager.appendCustomEntry("leaf", {});
		const nav = h.session.navigateTree(target);
		assert.equal(h.session.isIdle, false, "navigation counts as busy");
		await finished(h);
		assert.equal(h.sent.length, 0, "the outcome waits while navigation is in flight");
		release();
		assert.deepEqual(await nav, { cancelled: true });
		assert.equal(h.session.isIdle, true, "cancel returns to idle without session_tree or agent_settled");
		assert.equal(await delivered(h), 1, "the idle fallback delivers without any unrelated input");
		assert.equal(h.sent[0].options.triggerTurn, false, "context-only: an interrupted turn is not restarted");
		assert.equal(h.starts.length, 0);
		assert.equal(h.entries().length, 1, "the outcome is really in the session tree");
		await h.emit("agent_settled", { aborted: false });
		assert.equal(h.sent.length, 1, "a later settlement never repeats the outcome");
	} finally {
		release();
	}
});

test("a throwing tree navigation also recovers through the idle fallback", async t => {
	let release;
	const gate = new Promise(resolve => release = resolve);
	const h = treeHarness(t, async () => { await gate; throw new Error("tree exploded"); });
	try {
		const target = h.session.sessionManager.appendCustomEntry("target", {});
		h.session.sessionManager.appendCustomEntry("leaf", {});
		const nav = h.session.navigateTree(target);
		await finished(h);
		assert.equal(h.sent.length, 0);
		release();
		await assert.rejects(nav, /tree exploded/);
		assert.equal(h.session.isIdle, true);
		assert.equal(await delivered(h), 1);
		assert.equal(h.sent[0].options.triggerTurn, false);
		assert.equal(h.starts.length, 0);
	} finally {
		release();
	}
});

test("an aborted branch summary delivers the stranded completion context-only", async t => {
	let release;
	const gate = new Promise(resolve => release = resolve);
	const h = treeHarness(t, async () => { await gate; h.session._branchSummaryAbortController.abort(); });
	try {
		// Real summarization plumbing, fake provider: the abort is terminal, never retried.
		Object.defineProperty(h.session, "model", { value: { contextWindow: 128000 } });
		h.session.settingsManager = { getBranchSummarySettings: () => ({}), getRetrySettings: () => ({ enabled: false }) };
		h.session._getSummarizationRequestAuth = async () => ({ model: h.session.model, apiKey: "test", headers: {}, env: {} });
		h.session._summarizationRetryCallbacks = () => ({});
		h.session.agent = { state: { messages: h.session.agent.state.messages }, streamFunction: async () => ({ result: async () => ({ role: "assistant", content: [], stopReason: "aborted", timestamp: Date.now() }) }) };
		const target = h.session.sessionManager.appendCustomEntry("target", {});
		h.session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "branch work" }], timestamp: Date.now() });
		const nav = h.session.navigateTree(target, { summarize: true });
		await finished(h);
		assert.equal(h.sent.length, 0);
		release();
		assert.deepEqual(await nav, { cancelled: true, aborted: true });
		assert.equal(h.session.isIdle, true);
		assert.equal(await delivered(h), 1);
		assert.equal(h.sent[0].options.triggerTurn, false);
		assert.equal(h.starts.length, 0);
	} finally {
		release();
	}
});

test("a completed navigation still flushes through session_tree with its normal wakeup", async t => {
	let release;
	const gate = new Promise(resolve => release = resolve);
	const h = treeHarness(t, async () => { await gate; });
	try {
		const target = h.session.sessionManager.appendCustomEntry("target", {});
		h.session.sessionManager.appendCustomEntry("leaf", {});
		const nav = h.session.navigateTree(target);
		await finished(h);
		assert.equal(h.sent.length, 0);
		release();
		await nav;
		assert.equal(h.sent.length, 1, "session_tree keeps owning the delivery");
		assert.equal(h.sent[0].options.triggerTurn, true, "the normal terminal wakeup is preserved");
		assert.equal(h.starts.length, 1);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.equal(h.sent.length, 1, "the idle fallback never duplicates a session_tree delivery");
	} finally {
		release();
	}
});

test("shutdown cancels the idle fallback before its first await", async t => {
	const h = harness(t);
	await finished(h);
	assert.equal(h.sent.length, 0);
	await h.emit("session_shutdown", { reason: "quit" });
	h.session._isAgentRunActive = false;
	await new Promise(resolve => setTimeout(resolve, 400));
	assert.equal(h.sent.length, 0, "the fallback timer must not fire on the disposed runtime");
	assert.equal(h.starts.length, 0);
});
