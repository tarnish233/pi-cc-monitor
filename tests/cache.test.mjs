/**
 * Prompt-cache invariants. A provider caches the request by prefix (tools, then
 * system prompt, then messages), so an extension keeps the cache only if it
 * never changes anything before the end of the transcript. pi-cc-monitor only
 * appends: every event is a custom message added after what is already there.
 * These tests keep it that way: no prompt hooks, no tool changes after load.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

/** Hooks that change the system prompt, or rewrite the request or the history it carries. */
const PREFIX_HOOKS = ["before_agent_start", "context", "context_with_system", "before_provider_request"];

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-cache-"));
	process.chdir(workdir);
	const tools = new Map();
	const handlers = new Map();
	const bus = new Map();
	const sent = [];
	const calls = { lateTools: [], loadoutChanges: [], userMessages: 0 };
	let loaded = false;

	const pi = {
		registerCommand() {},
		registerTool(tool) {
			if (loaded) calls.lateTools.push(tool.name);
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry() {},
		sendUserMessage() {
			calls.userMessages += 1;
		},
		sendMessage(message, options) {
			sent.push({ message, options });
		},
		events: {
			emit() {},
			on(channel, handler) {
				bus.set(channel, handler);
				return () => bus.delete(channel);
			},
		},
		getAllTools() {
			return [...tools.keys(), "cron_delete"].map((name) => ({ name }));
		},
	};
	for (const method of ["setActiveTools", "setModel", "setThinkingLevel"]) {
		pi[method] = (...args) => calls.loadoutChanges.push({ method, args });
	}
	const ctx = {
		ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c, t) => t } },
		hasUI: true,
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};

	mod.default(pi);
	loaded = true;
	return { pi, ctx, tools, handlers, bus, sent, calls };
}

async function waitFor(predicate, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

test("monitors only append: no prompt hooks, no tool changes, events are messages", async () => {
	const h = makeHarness();
	const declared = () => [...h.tools.values()].map((tool) => JSON.stringify([tool.name, tool.description, tool.parameters]));
	const atLoad = declared();
	const exec = (name, params) => h.tools.get(name).execute("c", params, undefined, undefined, h.ctx);

	await h.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
	await exec("Monitor", { command: "printf 'one\\ntwo\\n'", description: "short" });
	assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details?.cause === "exit")), "the monitor ran to its end");
	const bound = await exec("Monitor", { command: "sleep 30", description: "bound", persistent: true, loopPrompt: "watch CI" });
	h.bus.get("loop:stopped")?.({ prompt: "watch CI", reason: "stopped" });
	const kept = await exec("Monitor", { command: "sleep 30", description: "kept", persistent: true });
	await exec("monitor_list", {});
	await exec("monitor_stop", { id: kept.details.taskId });
	await h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
	assert.ok(bound.details.taskId);

	for (const hook of PREFIX_HOOKS) {
		assert.ok(!h.handlers.has(hook), `no ${hook} handler: it would change what comes before the new messages`);
	}
	assert.deepEqual(h.calls.lateTools, [], "every tool is registered at load");
	assert.deepEqual(h.calls.loadoutChanges, [], "no active-tool, model or thinking changes");
	assert.deepEqual(declared(), atLoad, "tool declarations are static");
	assert.equal(h.calls.userMessages, 0, "events are custom messages, never user messages");
	assert.ok(h.sent.length > 0);
	for (const entry of h.sent) {
		assert.ok(["steer", "followUp"].includes(entry.options?.deliverAs), "appended through a queue lane");
	}
});
