import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");
const factory = mod.default;

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-t-"));
	process.chdir(workdir);

	const commands = new Map();
	const tools = new Map();
	const renderers = new Map();
	const toolRenderers = [];
	const handlers = new Map();
	const sent = [];
	const events = [];
	const notifications = [];

	const pi = {
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerToolRenderer(resolver) {
			toolRenderers.push(resolver);
		},
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry() {},
		sendUserMessage(content, options) {
			sent.push({ kind: "user", content, options });
		},
		sendMessage(message, options) {
			sent.push({ kind: "custom", message, options });
		},
		events: {
			emit(channel, data) {
				events.push({ channel, data });
			},
			on(channel, handler) {
				handlers.set(`bus:${channel}`, handler);
				return () => handlers.delete(`bus:${channel}`);
			},
		},
	};

	const ctx = {
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setWidget: () => {},
			theme: { fg: (_c, t) => t },
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};

	return { pi, ctx, commands, tools, renderers, toolRenderers, handlers, sent, events, notifications };
}

async function start(h) {
	factory(h.pi);
	return h;
}

/** Wait until the predicate holds or the timeout expires. */
async function waitFor(predicate, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
}

test("registers the Monitor, monitor_stop and monitor_list tools", async () => {
	const h = await start(makeHarness());
	for (const name of ["Monitor", "monitor_stop", "monitor_list"]) {
		assert.ok(h.tools.has(name), `${name} tool registered`);
	}
	assert.ok(h.handlers.has("session_shutdown"));
});

test("the schema mirrors Claude Code's Monitor", async () => {
	const h = await start(makeHarness());
	const params = h.tools.get("Monitor").parameters;
	const props = params.properties ?? {};
	assert.deepEqual(Object.keys(props).sort(), [
		"command",
		"description",
		"loopPrompt",
		"persistent",
		"timeout_ms",
		"ws",
	]);
	assert.equal(props.timeout_ms.minimum, 1000);
	assert.equal(props.timeout_ms.maximum, 3600000);
	assert.ok(props.description.description.includes("shown in notifications"));
});

test("exactly one of command or ws is required", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { description: "x" }, undefined, undefined, h.ctx),
		/exactly one of command or ws/,
	);
	await assert.rejects(
		() =>
			tool.execute(
				"c",
				{ command: "ls", ws: { url: "wss://x.example" }, description: "x" },
				undefined,
				undefined,
				h.ctx,
			),
		/exactly one of command or ws/,
	);
});

test("control characters in the command are refused", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { command: "ls\u0007", description: "x" }, undefined, undefined, h.ctx),
		/control characters/,
	);
});

test("a ws url must be a valid ASCII ws:// or wss:// url", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	// Claude Code's own check rejects a wrong scheme, userinfo, tabs/newlines
	// and non-ASCII, but it accepts a plain space in the path.
	for (const url of ["https://x.example", "ws://user:pw@x.example", "wss://x.example/a\tb", "wss://x.exämple"]) {
		await assert.rejects(
			() => tool.execute("c", { ws: { url }, description: "x" }, undefined, undefined, h.ctx),
			/url must be a valid ASCII/,
			`${url} must be refused`,
		);
	}
});

test("ws protocols must be unique RFC 6455 tokens", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() =>
			tool.execute(
				"c",
				{ ws: { url: "wss://x.example", protocols: ["v1", "v1"] }, description: "x" },
				undefined,
				undefined,
				h.ctx,
			),
		/protocols must be unique/,
	);
	await assert.rejects(
		() =>
			tool.execute(
				"c",
				{ ws: { url: "wss://x.example", protocols: ["bad protocol"] }, description: "x" },
				undefined,
				undefined,
				h.ctx,
			),
		/protocols must be unique/,
	);
});

test("timeout_ms must be within Claude Code's bounds", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { command: "ls", description: "x", timeout_ms: 500 }, undefined, undefined, h.ctx),
		/timeout_ms must be ≥/,
	);
	await assert.rejects(
		() =>
			tool.execute("c", { command: "ls", description: "x", timeout_ms: 7_200_000 }, undefined, undefined, h.ctx),
		/timeout_ms must be ≤/,
	);
});

test("each stdout line becomes one notification", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	const armed = await tool.execute(
		"c",
		{ command: "printf 'one\\ntwo\\nthree\\n'", description: "test monitor" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.ok(armed.details.taskId);
	assert.equal(armed.details.timeoutMs, 300000, "default timeout is 5 minutes");

	await waitFor(() => h.sent.length >= 1);
	// Lines written within the batch window are merged into one notification.
	await waitFor(() => h.sent.length >= 1 && h.sent[0].message.content.includes("three"));
	const content = h.sent[0].message.content;
	assert.ok(content.includes("[monitor · test monitor]"));
	assert.ok(content.includes("one"));
	assert.ok(content.includes("two"));
	assert.ok(content.includes("three"));
	assert.equal(h.sent[0].options.deliverAs, "followUp", "notifications use the low priority lane");
	assert.equal(h.sent[0].options.triggerTurn, true, "a notification wakes the agent");

	// The bus event carries the same payload.
	const wake = h.events.find((e) => e.channel === "monitor:wake");
	assert.ok(wake, "monitor:wake was emitted");
	assert.equal(wake.data.description, "test monitor");
	assert.equal(wake.data.kind, "command");
});

test("the exit ends the watch and is reported", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await tool.execute("c", { command: "printf 'hello\\n'", description: "exiting" }, undefined, undefined, h.ctx);

	await waitFor(() => h.sent.length >= 2, 8000);
	const last = h.sent[h.sent.length - 1].message.content;
	assert.ok(last.includes("[monitor · exiting]"));
	assert.ok(/ended|exit/i.test(last), `expected an exit report, got: ${last}`);
});

test("monitor_stop stops a running monitor", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	const armed = await tool.execute(
		"c",
		{ command: "while true; do sleep 0.05; done", description: "forever" },
		undefined,
		undefined,
		h.ctx,
	);
	const stopped = await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	assert.equal(stopped.details.stopped, true);
});

test("monitor_list reports the monitors", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 2", description: "listed" }, undefined, undefined, h.ctx);
	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.monitors.length, 1);
	assert.equal(list.details.monitors[0].description, "listed");
});

test("loopPrompt travels on the wake event", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "printf 'x\\n'", description: "chained", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);
	await waitFor(() => h.events.length >= 1);
	const wake = h.events.find((e) => e.channel === "monitor:wake");
	assert.equal(wake.data.loopPrompt, "check the deploy");
});

test("a persistent monitor has no timeout", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "p", persistent: true }, undefined, undefined, h.ctx);
	assert.equal(armed.details.timeoutMs, 0);
	assert.equal(armed.details.persistent, true);
});

test("a loop:stopped event stops the monitor that named the chain", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "while true; do sleep 0.05; done", description: "chained", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);

	await h.handlers.get("bus:loop:stopped")({ prompt: "check the deploy", reason: "stopped by the user" }, h.ctx);

	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.monitors[0].status, "stopped");
	assert.ok(
		h.notifications.some((n) => n.message.includes("its /loop chain ended")),
		"the user is told the monitor went down with the loop",
	);
	assert.ok(armed.details.taskId);
});

test("a loop:stopped event for another chain leaves the monitor alone", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 1", description: "chained", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);

	await h.handlers.get("bus:loop:stopped")({ prompt: "some other task" }, h.ctx);

	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.monitors[0].status, "running");
});

test("monitor_list details are JSON and structured-clone safe", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 5", description: "serialize test", timeout_ms: 60_000 },
			undefined,
			undefined,
			h.ctx,
		);
	const id = armed.details.taskId;
	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);

	assert.doesNotThrow(() => JSON.stringify(listed.details));
	assert.doesNotThrow(() => structuredClone(listed.details));
	const record = listed.details.monitors[0];
	assert.equal(record.id, id);
	assert.equal(record.child, undefined);
	assert.equal(record.timeoutTimer, undefined);
	assert.equal(record.batcher, undefined);
	assert.equal(record.flood, undefined);

	await h.tools.get("monitor_stop").execute("c", { id }, undefined, undefined, h.ctx);
});
