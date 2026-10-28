import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");
const stream = await loadModule("stream.ts");
const factory = mod.default;
// TypeBox's own validator, from the Pi installation the extension runs on.
const install = findPiInstall();
const { Compile } = await import(pathToFileURL(path.join(install.root, "typebox", "build", "compile", "index.mjs")).href);

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
	/** Tools other extensions registered: pi-cc-loop's cron_delete marks it as loaded. */
	const registeredToolNames = [];
	// Pi invalidates an extension's API right after session_shutdown (reload,
	// new, resume, fork): every later call throws.
	const runtime = { stale: false };
	const assertActive = () => {
		if (runtime.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	};

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
			assertActive();
			sent.push({ kind: "custom", message, options });
		},
		getAllTools() {
			return [...tools.keys(), ...registeredToolNames].map((name) => ({ name }));
		},
		events: {
			emit(channel, data) {
				assertActive();
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

	return { pi, ctx, commands, tools, renderers, toolRenderers, handlers, sent, events, notifications, runtime, registeredToolNames };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One line per notification, for assertion messages. */
function summarize(sent) {
	return sent.map((entry) => `${entry.message.details.cause}: ${entry.message.content.split("\n").slice(1).join(" | ")}`).join("\n");
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
	assert.match(content, /^monitor \w+ · test monitor$/m);
	assert.ok(content.includes("one"));
	assert.ok(content.includes("two"));
	assert.ok(content.includes("three"));
	assert.equal(h.sent[0].options.deliverAs, "steer", "delivered mid-turn, like Claude Code's \"next\" priority");
	assert.equal(h.sent[0].options.triggerTurn, true, "a notification wakes the agent");
	assert.equal(h.sent[0].message.details.eventCount, 3);
});

/** A stand-in for WebSocket: records instances, sends frames, can fail to construct. */
function fakeWebSocket({ constructError } = {}) {
	const sockets = [];
	class FakeWebSocket {
		constructor(url, protocols) {
			if (constructError) throw constructError;
			this.url = url;
			this.protocols = protocols;
			this.listeners = new Map();
			sockets.push(this);
		}
		addEventListener(name, fn) {
			(this.listeners.get(name) ?? this.listeners.set(name, []).get(name)).push(fn);
		}
		emit(name, event) {
			for (const fn of this.listeners.get(name) ?? []) fn(event);
		}
		close() {
			this.emit("close", { code: 1000 });
		}
	}
	return { sockets, WebSocket: FakeWebSocket };
}

test("a ws monitor writes the frames it receives to its log file, and reports it", async () => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	try {
		const h = await start(makeHarness());
		const tool = h.tools.get("Monitor");
		const armed = await tool.execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx);
		assert.ok(fs.existsSync(armed.details.outputPath), "the output path exists");
		const socket = fake.sockets[0];
		socket.emit("message", { data: "frame one" });
		socket.emit("message", { data: "frame two" });
		await waitFor(() => h.sent.length > 0, 5000);
		assert.equal(fs.readFileSync(armed.details.outputPath, "utf8"), "frame one\nframe two\n", "the frames are in the log");
	} finally {
		globalThis.WebSocket = saved;
	}
});

test("one WebSocket text frame with newlines is one event", async () => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	try {
		const h = await start(makeHarness());
		const armed = await h.tools.get("Monitor").execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx);
		fake.sockets[0].emit("message", { data: "first line\nsecond line" });
		await waitFor(() => h.sent.length > 0);
		assert.equal(h.sent[0].message.details.eventCount, 1, "a frame counts once, even with newlines");
		assert.deepEqual(h.sent[0].message.details.lines, ["first line\nsecond line"]);
		await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	} finally {
		globalThis.WebSocket = saved;
	}
});

test("a ws monitor that cannot even open fails like a command monitor that cannot spawn", async () => {
	const saved = globalThis.WebSocket;
	globalThis.WebSocket = fakeWebSocket({ constructError: new Error("bad url") }).WebSocket;
	try {
		const h = await start(makeHarness());
		await assert.rejects(
			() => h.tools.get("Monitor").execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx),
			/bad url/,
			`the launch itself fails, no Monitor started result`,
		);
	} finally {
		globalThis.WebSocket = saved;
	}
});

test("a ws monitor's log is closed when the watch ends, or never starts", async () => {
	const saved = globalThis.WebSocket;
	const savedCreate = fs.createWriteStream;
	const streams = [];
	fs.createWriteStream = (...args) => {
		const stream = savedCreate.apply(fs, args);
		streams.push(stream);
		return stream;
	};
	try {
		const fake = fakeWebSocket();
		globalThis.WebSocket = fake.WebSocket;
		const h = await start(makeHarness());
		await h.tools.get("Monitor").execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx);
		assert.equal(streams.length, 1);
		assert.equal(streams[0].writableEnded, false, "open while the watch runs");
		fake.sockets[0].close();
		assert.equal(streams[0].writableEnded, true, "closed with the socket");

		globalThis.WebSocket = fakeWebSocket({ constructError: new Error("bad url") }).WebSocket;
		await assert.rejects(() => h.tools.get("Monitor").execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx));
		assert.equal(streams.length, 2);
		assert.equal(streams[1].writableEnded, true, "a socket that never opened leaves no log open");
	} finally {
		fs.createWriteStream = savedCreate;
		globalThis.WebSocket = saved;
	}
});

test("the exit ends the watch and is reported", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await tool.execute("c", { command: "printf 'hello\\n'", description: "exiting" }, undefined, undefined, h.ctx);

	await waitFor(() => h.sent.length >= 2, 8000);
	const last = h.sent[h.sent.length - 1].message.content;
	assert.match(last, /^monitor \w+ · exiting$/m);
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

test("monitor_list freezes the duration and includes the exit code", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute("c", { command: "echo one", description: "exited" }, undefined, undefined, h.ctx);
	await waitFor(() => h.sent.some((entry) => entry.message?.details?.cause === "exit"));

	const first = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	const text = first.content[0].text;
	assert.match(text, /exited/);
	assert.match(text, /exit 0/);
	const age = /events\s+(\d+)s/.exec(text)?.[1];
	assert.ok(age !== undefined, text);

	await new Promise((resolve) => setTimeout(resolve, 1100));
	const second = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	const frozenAge = /events\s+(\d+)s/.exec(second.content[0].text)?.[1];
	assert.equal(frozenAge, age, "the duration stops growing after exit");

	const snapshot = second.details.monitors[0];
	assert.equal(typeof snapshot.endedAt, "number");
	assert.equal(snapshot.exitCode, 0);
});

test("loopPrompt is kept when pi-cc-loop is loaded", async () => {
	const h = makeHarness();
	h.registeredToolNames.push("cron_create", "cron_delete", "schedule_wakeup");
	await start(h);
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 1", description: "chained", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);
	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.monitors[0].loopPrompt, "check the deploy");
	assert.equal(h.events.length, 0, "no monitor:wake bus event any more");
});

test("loopPrompt is ignored when pi-cc-loop is not loaded", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 1", description: "standalone", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);
	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(
		list.details.monitors[0].loopPrompt,
		undefined,
		"nothing may promise to stop this monitor with a loop that is not installed",
	);
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
	h.registeredToolNames.push("cron_delete");
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

test("a loop:stopped event matches a loopPrompt quoted with its /loop prefix", async () => {
	const h = await start(makeHarness());
	h.registeredToolNames.push("cron_delete");
	// pi-cc-loop keys a chain by its prompt without the prefix, the way
	// schedule_wakeup stores it; the model may pass the request back verbatim.
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 5", description: "chained", loopPrompt: "/loop check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);

	await h.handlers.get("bus:loop:stopped")({ prompt: "check the deploy", reason: "stopped by the user" }, h.ctx);

	const list = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(list.details.monitors[0].status, "stopped");
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

// ---------------------------------------------------------------- lifecycle

test("a monitor still running at /reload never touches the stale session", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute("c", { command: "tail -f /dev/null", description: "log tail", persistent: true }, undefined, undefined, h.ctx);
	await sleep(200);

	const errors = [];
	const capture = (error) => errors.push(error);
	process.on("uncaughtException", capture);
	try {
		await h.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, h.ctx);
		// Pi invalidates the old runtime as soon as session_shutdown returns.
		h.runtime.stale = true;
		await sleep(1000);
	} finally {
		process.off("uncaughtException", capture);
	}
	assert.deepEqual(
		errors.map((error) => error.message),
		[],
		"an exception escaping a child-process callback makes Pi exit",
	);
	assert.equal(h.sent.length, 0, `nothing is sent to the old session:\n${summarize(h.sent)}`);
});

test("monitor_stop sends exactly one notice", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 30", description: "stop me" }, undefined, undefined, h.ctx);
	await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	await sleep(600);

	assert.equal(h.sent.length, 1, `one notice, not one per teardown step:\n${summarize(h.sent)}`);
	assert.equal(h.sent[0].message.details.cause, "stopped");
	assert.ok(h.sent[0].message.content.includes("[Monitor stopped]"), h.sent[0].message.content);
});

test("a timeout sends exactly one notice that suggests re-arming", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 30", description: "short watch", timeout_ms: 1000 }, undefined, undefined, h.ctx);
	await sleep(1800);

	assert.equal(h.sent.length, 1, summarize(h.sent));
	assert.equal(h.sent[0].message.details.cause, "timeout");
	assert.match(h.sent[0].message.content, /expired after 1s with no events delivered\. Re-arm it/);
});

test("a monitor stopped together with its loop never wakes the agent", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "sleep 30", description: "chained", loopPrompt: "check the deploy" },
			undefined,
			undefined,
			h.ctx,
		);
	await h.handlers.get("bus:loop:stopped")({ prompt: "check the deploy", reason: "stopped by the user" }, h.ctx);
	await sleep(600);

	assert.equal(h.sent.length, 0, `the user just stopped the loop:\n${summarize(h.sent)}`);
});

test("output printed after a stop is dropped", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "trap 'echo bye-after-stop; exit 0' TERM; while true; do sleep 0.1; done", description: "trap" },
			undefined,
			undefined,
			h.ctx,
		);
	await sleep(300);
	await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	await sleep(800);

	assert.ok(!h.sent.some((entry) => entry.message.content.includes("bye-after-stop")), summarize(h.sent));
	assert.equal(h.sent.length, 1, summarize(h.sent));
});

// ------------------------------------------------------------------- output

test("long lines and large batches are capped like Claude Code", async () => {
	const h = await start(makeHarness());
	await h.tools
		.get("Monitor")
		.execute(
			"c",
			{ command: "head -c 5000 /dev/zero | tr '\\0' x; echo; seq 1 1500", description: "huge" },
			undefined,
			undefined,
			h.ctx,
		);
	await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit"), 8000);

	const outputs = h.sent.filter((entry) => entry.message.details.cause === "output");
	assert.ok(outputs.length >= 1, summarize(h.sent));
	for (const entry of outputs) {
		const body = entry.message.content.split("\n").slice(1).join("\n");
		assert.ok(body.length <= 3000 + "\n...(truncated)".length, `notification body is ${body.length} chars`);
		for (const line of body.split("\n")) {
			assert.ok(line.length <= 500 + "...(truncated)".length, `line is ${line.length} chars`);
		}
	}
	assert.ok(
		outputs.some((entry) => entry.message.content.includes("...(truncated)")),
		"the long line is marked as truncated",
	);
	assert.equal(outputs.at(-1).message.details.eventCount, 1501, "every line still counts as an event");
});

test("a UTF-8 character split across chunks stays intact", () => {
	const got = [];
	const batcher = new stream.LineBatcher({ windowMs: 5, onBatch: (lines) => got.push(...lines) });
	const bytes = Buffer.from("构建失败\n", "utf8");
	batcher.push(bytes.subarray(0, 4));
	batcher.push(bytes.subarray(4));
	batcher.flush();
	assert.deepEqual(got, ["构建失败"]);
});

test("blank lines are not events", () => {
	const got = [];
	const batcher = new stream.LineBatcher({ windowMs: 5, onBatch: (lines) => got.push(...lines) });
	batcher.push("a\n\n   \nb\r\n");
	batcher.flush();
	assert.deepEqual(got, ["a", "b"]);
});

test("the launch result is Claude Code's: expiry, keep working, an event is not a reply", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "short", timeout_ms: 1_800_000 }, undefined, undefined, h.ctx);
	const text = armed.content[0].text;
	assert.match(text, /^Monitor started \(task \w+, expires in 30 minutes unless the source ends first/);
	assert.match(text, /You will be notified on each event\. Keep working \u2014 do not poll or sleep\./);
	assert.match(text, /an event is not their reply/);
});

test("a persistent monitor says it runs until stopped", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "long", persistent: true }, undefined, undefined, h.ctx);
	assert.match(armed.content[0].text, /runs until you stop it or the session ends/);
});

test("a one minute timeout is not '1 minutes'", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "short", timeout_ms: 60_000 }, undefined, undefined, h.ctx);
	assert.match(armed.content[0].text, /expires in 1 minute unless/);
});

test("a sub-minute timeout is not 'expires in 0 minutes'", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "quick", timeout_ms: 5_000 }, undefined, undefined, h.ctx);
	assert.match(armed.content[0].text, /expires in 5 seconds unless/);
});

test("an unwritable output log does not crash Pi", async () => {
	const { spawnMonitor } = await loadModule("process.ts");
	const missing = path.join(os.tmpdir(), `pi-cc-monitor-missing-${process.pid}`, "nested");
	// A stream "error" without a listener is thrown as an uncaught exception,
	// and Pi exits on uncaught exceptions.
	const exit = await new Promise((resolve) => {
		spawnMonitor({
			command: "echo hi",
			cwd: os.tmpdir(),
			env: process.env,
			shell: "/bin/sh",
			shellArgs: ["-c"],
			commandTransport: "argv",
			stdoutPath: path.join(missing, "out.log"),
			stderrPath: path.join(missing, "err.log"),
			onStdout: () => {},
			onStderr: () => {},
			onExit: (code) => resolve(code),
			onError: () => resolve("error"),
		});
	});
	assert.equal(exit, 0, "the command still runs and reports its exit");
});

test("a monitor that fails to start is not listed as running", async () => {
	const h = await start(makeHarness());
	h.ctx.cwd = 42; // makes spawn throw synchronously
	await assert.rejects(
		h.tools.get("Monitor").execute("c", { command: "echo hi", description: "never" }, undefined, undefined, h.ctx),
		/Could not start the monitor/,
	);
	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.ok(!/\brunning\b/.test(listed.content[0].text), listed.content[0].text);
});

// -------------------------------------------------------------- rate limits

test("the rate limiter follows Claude Code: 10 at once, then one every 2s", () => {
	let now = 0;
	const limiter = new stream.RateLimiter({ now: () => now });
	for (let i = 0; i < 10; i++) assert.equal(limiter.take(1).deliver, true, `burst event ${i + 1}`);

	const eleventh = limiter.take(3);
	assert.equal(eleventh.deliver, false, "the 11th batch in the same instant is suppressed");
	assert.equal(eleventh.flood, false);

	now += 2000;
	const next = limiter.take(1);
	assert.equal(next.deliver, true, "a token comes back after 2s");
	assert.equal(next.suppressed, 3, "and reports how many events were suppressed meanwhile");
	assert.equal(limiter.take(1).deliver, false);
});

test("sustained suppression for more than 30s is a flood", () => {
	let now = 0;
	const limiter = new stream.RateLimiter({ now: () => now });
	for (let i = 0; i < 10; i++) limiter.take(1);
	let verdict;
	// A firehose: a batch every 100ms. Each refill lets one batch through, the
	// rest are suppressed, so suppression never stops.
	for (now = 100; now <= 31_000; now += 100) {
		verdict = limiter.take(1);
		if (verdict.flood) break;
	}
	assert.equal(verdict.flood, true, "stopped after 30s of continuous suppression");
	assert.ok(now > 30_000 && now <= 31_000, `flood at ${now}ms`);
});

test("a quiet gap resets the suppression window", () => {
	let now = 0;
	const limiter = new stream.RateLimiter({ now: () => now });
	for (let i = 0; i < 11; i++) limiter.take(1); // the 11th is suppressed at t=0
	now = 20_000; // quiet for 20s: the bucket is full again
	assert.equal(limiter.take(1).deliver, true);
	for (let i = 0; i < 10; i++) limiter.take(1);
	now = 45_000; // 25s after the new suppression started, 45s after the first one
	assert.equal(limiter.take(1).flood ?? false, false, "the old suppression does not count");
});

test("a chatty monitor is rate-limited and told how much was suppressed", async () => {
	const h = await start(makeHarness());
	await h.tools.get("Monitor").execute(
		"c",
		// 16 lines, one per batch window: more than the burst of 10.
		{ command: "for i in $(seq 1 16); do echo tick $i; sleep 0.25; done", description: "chatty" },
		undefined,
		undefined,
		h.ctx,
	);
	await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit"), 12000);

	const outputs = h.sent.filter((entry) => entry.message.details.cause === "output");
	assert.ok(outputs.length <= 13, `at most 10 + one per 2s get through, got ${outputs.length}`);
	const exit = h.sent.find((entry) => entry.message.details.cause === "exit").message.content;
	assert.match(exit, /suppressed/, `the exit notice reports suppressed events: ${exit}`);
});

// --------------------------------------------------------------- processes

test("monitor processes are killed if Pi exits without a shutdown", async () => {
	const h = await start(makeHarness());
	const before = new Set(process.listeners("exit"));
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 30", description: "orphan check", persistent: true }, undefined, undefined, h.ctx);
	const hooks = process.listeners("exit").filter((listener) => !before.has(listener));
	assert.equal(hooks.length, 1, "an exit hook is installed while monitors run");

	const pid = (await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx)).details.monitors[0].pid;
	assert.ok(pid, "the snapshot carries the process id");
	hooks[0](); // what Node runs on process.exit(), e.g. after an uncaught exception
	await sleep(300);
	assert.throws(() => process.kill(pid, 0), "the monitor process is gone");

	await h.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, h.ctx);
	assert.ok(!process.listeners("exit").includes(hooks[0]), "the hook is removed at shutdown");
	assert.ok(armed.details.taskId);
});

test("old monitor logs are cleaned up at session start", async () => {
	const dir = path.join(os.tmpdir(), "pi-cc-monitor");
	fs.mkdirSync(dir, { recursive: true });
	const old = path.join(dir, "zzoldlog.out.log");
	const fresh = path.join(dir, "zzfreshlog.out.log");
	fs.writeFileSync(old, "old");
	fs.writeFileSync(fresh, "fresh");
	const fourDaysAgo = (Date.now() - 4 * 86_400_000) / 1000;
	fs.utimesSync(old, fourDaysAgo, fourDaysAgo);

	const h = await start(makeHarness());
	await h.handlers.get("session_start")({ type: "session_start", reason: "startup" }, h.ctx);
	assert.equal(fs.existsSync(old), false, "logs older than 3 days are removed");
	assert.equal(fs.existsSync(fresh), true, "recent logs stay readable");
	fs.rmSync(fresh, { force: true });
});

// ----------------------------------------------------------------- prompts

test("the tool description carries Claude Code's usage guidance", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	for (const phrase of [
		"Each stdout line is an event",
		"--line-buffered",
		"silence is not success",
		"2>&1",
		"monitor_stop",
		"not replies from the user",
		"too many events are automatically stopped",
	]) {
		assert.ok(tool.description.includes(phrase), `description mentions ${phrase}`);
	}
	for (const name of ["Monitor", "monitor_stop", "monitor_list"]) {
		assert.ok(h.tools.get(name).promptSnippet, `${name} has a prompt snippet`);
	}
});

test("a chained monitor's notifications name their loop", async () => {
	const h = await start(makeHarness());
	h.registeredToolNames.push("cron_delete");
	await h.tools
		.get("Monitor")
		.execute("c", { command: "printf 'x\\n'", description: "chained", loopPrompt: "check the deploy" }, undefined, undefined, h.ctx);
	await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit"));
	assert.ok(h.sent.length >= 2);
	for (const entry of h.sent) {
		assert.equal(entry.message.details.loopPrompt, "check the deploy", "pi-cc-loop knows whose turn an event starts");
	}
});

test("every tool gives codemode scripts structuredContent that matches its outputSchema", async () => {
	const check = (schema, value) => Compile(schema).Check(value);
	const h = await start(makeHarness());
	const mon = h.tools.get("Monitor");
	assert.ok(mon.outputSchema, "Monitor declares an outputSchema");
	const armed = await mon.execute("c", { command: "printf 'one\\n'", description: "test monitor" }, undefined, undefined, h.ctx);
	assert.ok(armed.structuredContent, "Monitor returns structuredContent");
	assert.equal(check(mon.outputSchema, armed.structuredContent), true, JSON.stringify(armed.structuredContent));

	const list = h.tools.get("monitor_list");
	assert.ok(list.outputSchema, "monitor_list declares an outputSchema");
	const listed = await list.execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(check(list.outputSchema, listed.structuredContent), true, JSON.stringify(listed.structuredContent));

	const stop = h.tools.get("monitor_stop");
	assert.ok(stop.outputSchema, "monitor_stop declares an outputSchema");
	const missed = await stop.execute("c", { id: "nope" }, undefined, undefined, h.ctx);
	assert.equal(check(stop.outputSchema, missed.structuredContent), true);
	const stopped = await stop.execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	assert.equal(check(stop.outputSchema, stopped.structuredContent), true);
	await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
});

test("a script gets the task id and the log paths as values", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("Monitor").execute("c", { command: "printf 'one\\n'", description: "test monitor" }, undefined, undefined, h.ctx);
	assert.match(armed.structuredContent.taskId, /^\w+$/);
	assert.equal(armed.structuredContent.taskId, armed.details.taskId);
	assert.equal(armed.structuredContent.kind, "command");
	assert.equal(typeof armed.structuredContent.outputPath, "string");

	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.deepEqual(listed.structuredContent.monitors.map((monitor) => monitor.id), [armed.details.taskId]);
	assert.equal(listed.structuredContent.monitors[0].status, "running");

	const stopped = await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	assert.deepEqual(stopped.structuredContent, { stopped: true, id: armed.details.taskId });
	const again = await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	assert.equal(again.structuredContent.status, "stopped", "why it was not stopped");
	await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
});
