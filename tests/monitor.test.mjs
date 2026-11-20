import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { assertJsonRoundTrip, jsonSchemaProblems, loadModule, loadValidators, unsupportedTypeboxUsages } from "./helpers.mjs";

const mod = await loadModule("index.ts");
const stream = await loadModule("stream.ts");
const factory = mod.default;
// Use the installation's engine: TypeBox before 1.5.0, pi-schema since 1.5.0.
const { compile, validateToolArguments, engine } = await loadValidators();

const check = (schema, value) => compile(schema).check(value);

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

test("the schema extends Claude Code's Monitor with notification modes", async () => {
	const h = await start(makeHarness());
	const params = h.tools.get("Monitor").parameters;
	const props = params.properties ?? {};
	assert.deepEqual(Object.keys(props).sort(), [
		"action",
		"command",
		"description",
		"id",
		"loopPrompt",
		"mode",
		"notify",
		"persistent",
		"source",
		"timeout_ms",
		"watches",
		"ws",
	]);
	assert.equal(props.timeout_ms.minimum, 1000);
	// The schema carries the widest bound (completion's 2h); the runtime
	// check enforces each mode's own limit once mode is known.
	assert.equal(props.timeout_ms.maximum, 7200000);
	assert.ok(props.timeout_ms.description.includes("1800000"), "the completion default is documented");
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

test("a blank ws beside a command is not a second source", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	// The GPT family fills every schema property: `ws: { url: "", protocols: [] }`
	// arrives next to the command it actually meant, with the other optionals
	// spelled out too. That used to fail with "exactly one of command or ws"
	// and cost the monitor.
	for (const ws of [{ url: "", protocols: [] }, { url: "   " }]) {
		const armed = await tool.execute(
			"c",
			{
				command: "printf 'ok\\n'",
				ws,
				description: "blank ws",
				loopPrompt: "",
				timeout_ms: 3600000,
				persistent: true,
			},
			undefined,
			undefined,
			h.ctx,
		);
		assert.equal(armed.details.kind, "command");
		assert.equal(armed.details.persistent, true);
	}
});

test("a blank source alone names the field that needs a value", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { command: "  ", description: "x" }, undefined, undefined, h.ctx),
		/command must not be empty/,
	);
	await assert.rejects(
		() => tool.execute("c", { ws: { url: " " }, description: "x" }, undefined, undefined, h.ctx),
		/url must be a valid ASCII ws:\/\/ or wss:\/\/ URL/,
	);
});

test("control characters in the command are refused", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { command: "ls\u0007", description: "x" }, undefined, undefined, h.ctx),
		/control characters/,
	);
	// CR overwrites earlier dialog text just like the other control characters.
	for (const command of ["echo hi\r", "echo a\r\necho b"]) {
		await assert.rejects(
			() => tool.execute("c", { command, description: "x" }, undefined, undefined, h.ctx),
			/control characters/,
		);
	}
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

test("timeout_ms bounds follow the mode: events 1h, completion 2h", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	await assert.rejects(
		() => tool.execute("c", { command: "ls", description: "x", timeout_ms: 500 }, undefined, undefined, h.ctx),
		/timeout_ms must be ≥/,
	);
	await assert.rejects(
		() => tool.execute("c", { command: "ls", description: "x", timeout_ms: 3_700_000 }, undefined, undefined, h.ctx),
		/timeout_ms must be ≤ 3600000/,
		"an events watch is still capped at Claude Code's 1h",
	);
	const twoHours = await tool.execute(
		"c",
		{ command: "sleep 30", description: "x", mode: "completion", timeout_ms: 7_200_000 },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(twoHours.details.timeoutMs, 7_200_000, "a 2h completion deadline is accepted, and the receipt shows it");
	await h.tools.get("monitor_stop").execute("c", { id: twoHours.details.taskId }, undefined, undefined, h.ctx);
	await assert.rejects(
		() => tool.execute("c", { command: "ls", description: "x", mode: "completion", timeout_ms: 7_200_001 }, undefined, undefined, h.ctx),
		/timeout_ms must be ≤ 7200000/,
	);
});

test("each stdout line becomes one notification", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	const armed = await tool.execute(
		"c",
		{ command: "printf 'one\\ntwo\\nthree\\n'; sleep 0.4", description: "test monitor" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.ok(armed.details.taskId);
	assert.equal(armed.details.timeoutMs, 300000, "default timeout is 5 minutes");
	assert.equal(armed.details.mode, "events", "existing calls keep streaming events by default");

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

test("completion mode logs without output events and reports one terminal result", async () => {
	const h = await start(makeHarness());
	const release = path.join(h.ctx.cwd, "release-command");
	const armed = await h.tools.get("Monitor").execute(
		"c",
		{
			command: `printf 'begin\\n'; printf 'problem\\n' >&2; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; printf 'end\\n'; exit 7`,
			description: "background command",
			mode: "completion",
		},
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(armed.details.mode, "completion");
	assert.equal(check(h.tools.get("Monitor").outputSchema, armed.structuredContent), true);
	assert.match(armed.content[0].text, /^Started task #\w+ · background command\ncompletion · time limit 30m/);
	assert.ok(armed.content[0].text.includes(armed.details.outputPath));
	assert.ok(armed.content[0].text.includes(armed.details.stderrPath));
	assert.match(armed.content[0].text, /notified once/);
	assert.match(armed.content[0].text, /Do not poll, sleep or re-read the logs/);
	assert.match(armed.content[0].text, /End your turn now/);

	assert.ok(await waitFor(() =>
		fs.existsSync(armed.details.outputPath) && fs.readFileSync(armed.details.outputPath, "utf8").includes("begin") &&
		fs.existsSync(armed.details.stderrPath) && fs.readFileSync(armed.details.stderrPath, "utf8").includes("problem"),
	));
	assert.equal(h.sent.length, 0, "stdout and stderr stay in logs while the command runs");

	fs.writeFileSync(release, "go");
	assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit")));
	assert.equal(h.sent.length, 1, `one terminal notification only:\n${summarize(h.sent)}`);
	const finished = h.sent[0];
	assert.equal(finished.options.deliverAs, "followUp", "completion follows the active turn instead of steering it");
	assert.equal(finished.options.triggerTurn, true);
	assert.equal(finished.message.details.mode, "completion");
	assert.equal(finished.message.details.status, "failed", "a nonzero exit is a failed completion");
	assert.equal(finished.message.details.eventCount, 0);
	assert.equal(finished.message.details.exitCode, 7);
	assert.deepEqual(finished.message.details.lines, []);
	assert.match(finished.message.content, /\[Monitor failed \u2014 exit code 7\./);
	assert.ok(finished.message.content.includes(armed.details.outputPath));
	assert.ok(finished.message.content.includes(armed.details.stderrPath));
	// The bounded tails usually spare the model a second read.
	assert.ok(finished.message.details.stdoutTail.includes("begin"));
	assert.ok(finished.message.details.stdoutTail.includes("end"));
	assert.ok(finished.message.details.stderrTail.includes("problem"));
	assert.equal(finished.message.details.stdoutTailTruncated, false);
	assert.ok(finished.message.content.includes("stdout tail:"));
	assert.ok(finished.message.content.includes("stderr tail:"));
	assert.equal(fs.readFileSync(armed.details.outputPath, "utf8"), "begin\nend\n", "close drains the final output before notifying");
	assert.equal(fs.readFileSync(armed.details.stderrPath, "utf8"), "problem\n");

	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(listed.details.monitors[0].mode, "completion");
	assert.equal(listed.details.monitors[0].status, "failed");
	assert.equal(listed.details.monitors[0].eventCount, 0);
	assert.equal(listed.details.monitors[0].exitCode, 7);
	assert.equal(check(h.tools.get("monitor_list").outputSchema, listed.structuredContent), true);
});

test("a successful completion is completed, with its tails", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("Monitor").execute(
		"c",
		{ command: "printf 'built ok\n'", description: "build", mode: "completion" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(armed.details.timeoutMs, 1_800_000, "completion defaults to a 30m deadline");
	assert.match(armed.content[0].text.split("\n")[1], /^completion · time limit 30m$/);
	assert.match(armed.content[0].text, /notified once/);
	assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit")));
	assert.equal(h.sent.length, 1, summarize(h.sent));
	const finished = h.sent[0];
	assert.equal(finished.message.details.status, "completed", "exit code 0 is a completed completion");
	assert.equal(finished.message.details.exitCode, 0);
	assert.match(finished.message.content, /\[Monitor completed \u2014 exit code 0\./);
	assert.ok(finished.message.content.includes("built ok"), "the stdout tail rides along");
	assert.ok(finished.message.details.stdoutTail.includes("built ok"));
	assert.equal(finished.message.details.stdoutTailTruncated, false);
	assert.equal(finished.message.details.stderrTail, "");
	assert.ok(
		!finished.message.content.includes("stderr: ("),
		"an empty stderr has no tail section; the banner already names its path",
	);
	assert.ok(finished.message.content.includes("stdout tail:"), "a nonempty stdout tail still rides along");
	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(listed.details.monitors[0].status, "completed");
});

test("a completion notice carries a bounded tail while the full logs stay on disk", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("Monitor").execute(
		"c",
		{ command: "seq 1 5000; printf 'boom\n' >&2; exit 3", description: "verbose failure", mode: "completion" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit")));
	assert.equal(h.sent.length, 1, summarize(h.sent));
	const finished = h.sent[0];
	const tail = finished.message.details.stdoutTail;
	assert.ok(tail.split("\n").length <= 60, "about 60 lines, not the whole log");
	assert.match(tail, /5000$/);
	assert.ok(!tail.includes("4940"), "only the last lines");
	assert.equal(finished.message.details.stdoutTailTruncated, true, "truncation is flagged in the details");
	assert.match(finished.message.content, /stdout tail \(/, "and marked in the text");
	assert.ok(finished.message.details.stderrTail.includes("boom"), "a nonempty stderr tail rides along");
	assert.equal(finished.message.details.stderrTailTruncated, false);
	assert.equal(finished.message.details.status, "failed");
	assert.deepEqual(finished.message.details.lines, [], "the tail is not an event stream");
	// The full logs are untouched.
	assert.ok(fs.statSync(armed.details.outputPath).size > 8192);
	assert.equal(fs.readFileSync(armed.details.outputPath, "utf8").trim().split("\n").length, 5000);
	assert.equal(fs.readFileSync(armed.details.stderrPath, "utf8"), "boom\n");
});

test("a completion's terminal tail waits for log writes that lag behind the child's close", async () => {
	const h = await start(makeHarness());
	// Make both log copies slow, so the child closes while output is still
	// queued in its log streams. The old code called onExit synchronously on
	// `close` and read a mid-stream file as the final tail, losing the last
	// lines; the fix waits for both streams to finish before reporting.
	const savedCreate = fs.createWriteStream;
	fs.createWriteStream = (...args) => {
		const real = savedCreate.apply(fs, args);
		real.on("error", () => {});
		const slow = new Writable({
			write(chunk, _encoding, callback) {
				setTimeout(() => {
					real.write(chunk, () => {});
					callback();
				}, 5);
			},
			final(callback) {
				real.end(() => callback());
			},
		});
		slow.on("error", () => {});
		return slow;
	};
	try {
		const armed = await h.tools.get("Monitor").execute(
			"c",
			{ command: "seq 1 20000; echo the-real-final-line", description: "lagging logs", mode: "completion" },
			undefined,
			undefined,
			h.ctx,
		);
		assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit")));
		assert.equal(h.sent.length, 1, summarize(h.sent));
		const finished = h.sent[0];
		assert.equal(finished.message.details.status, "completed");
		assert.match(
			finished.message.details.stdoutTail,
			/the-real-final-line$/,
			"the tail has the actual final line, not a mid-stream snapshot",
		);
		assert.equal(
			fs.readFileSync(armed.details.outputPath, "utf8").trim().split("\n").pop(),
			"the-real-final-line",
			"the exit was reported only after the log was fully written",
		);
	} finally {
		fs.createWriteStream = savedCreate;
	}
});

test("completion mode times out in the background with one notice and no output events", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("Monitor").execute(
		"c",
		{ command: "printf 'tick\\n'; sleep 30", description: "deadline", mode: "completion", timeout_ms: 2000 },
		undefined,
		undefined,
		h.ctx,
	);
	assert.ok(await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "timeout"), 5000));
	assert.equal(h.sent.length, 1, summarize(h.sent));
	assert.equal(h.sent[0].message.details.mode, "completion");
	assert.equal(h.sent[0].message.details.status, "timed_out");
	assert.equal(h.sent[0].message.details.eventCount, 0);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	const notice = h.sent[0].message.content;
	assert.match(
		notice,
		/\[Monitor stopped \u2014 background time limit of 2s: the command was killed before it finished, so its logs may be incomplete\./,
	);
	assert.ok(!notice.includes("Re-arm"), "no blind restart encouragement at a deadline stop");
	assert.ok(notice.includes(armed.details.outputPath));
	assert.ok(notice.includes("stdout tail:"), "the tail flushed when the deadline hit rides along");
	assert.ok(h.sent[0].message.details.stdoutTail.includes("tick"));
	assert.equal(fs.readFileSync(armed.details.outputPath, "utf8"), "tick\n");
});

test("WebSocket sources require events mode", async () => {
	const h = await start(makeHarness());
	await assert.rejects(
		() => h.tools.get("Monitor").execute(
			"c",
			{ ws: { url: "wss://x.example" }, description: "feed", mode: "completion" },
			undefined,
			undefined,
			h.ctx,
		),
		/mode=completion requires command; ws\/source uses mode=events/,
	);
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

test("blank WebSocket text frames stay in the raw log but produce no events", async () => {
	const saved = globalThis.WebSocket;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	try {
		const h = await start(makeHarness());
		const armed = await h.tools.get("Monitor").execute("c", { ws: { url: "ws://x.example/feed" }, description: "feed" }, undefined, undefined, h.ctx);
		const socket = fake.sockets[0];
		socket.emit("message", { data: "" });
		socket.emit("message", { data: "  \t  " });
		await sleep(300);
		assert.equal(h.sent.length, 0, "blank heartbeats do not wake the agent or consume notification budget");

		socket.emit("message", { data: "real frame" });
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.sent[0].message.details.eventCount, 1);
		assert.deepEqual(h.sent[0].message.details.lines, ["real frame"]);
		assert.equal(fs.readFileSync(armed.details.outputPath, "utf8"), "\n  \t  \nreal frame\n", "the raw log still contains the blank frames");
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

test("a WebSocket log-open failure is failed, never a zombie running record", async (t) => {
	const saved = globalThis.WebSocket;
	const savedOpen = fs.openSync;
	const fake = fakeWebSocket();
	globalThis.WebSocket = fake.WebSocket;
	const h = await start(makeHarness());
	t.after(() => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx));
	fs.openSync = (file, ...args) => {
		if (String(file).endsWith(".out.log")) throw Object.assign(new Error("log denied"), { code: "EACCES" });
		return savedOpen.call(fs, file, ...args);
	};
	try {
		await assert.rejects(() => h.tools.get("Monitor").execute("c", {
			ws: { url: "ws://x.example/feed" }, description: "bad log",
		}, undefined, undefined, h.ctx), /log denied/);
		assert.equal(fake.sockets.length, 0, "no socket was constructed");
		const list = await h.tools.get("monitor_list").execute("list", {}, undefined, undefined, h.ctx);
		assert.equal(list.details.monitors.length, 1);
		assert.equal(list.details.monitors[0].status, "failed");
		assert.equal(h.sent.length, 0, "a failed launch does not claim it started");
	} finally {
		fs.openSync = savedOpen;
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

test("completion stop is a single follow-up notice and kills the process", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools.get("Monitor").execute(
		"c",
		{ command: "printf 'running\\n'; while true; do sleep 0.05; done", description: "stop completion", mode: "completion", persistent: true },
		undefined,
		undefined,
		h.ctx,
	);
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.readFileSync(armed.details.outputPath, "utf8").includes("running")));
	const listed = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	const pid = listed.details.monitors[0].pid;
	assert.ok(pid);
	const stopped = await h.tools.get("monitor_stop").execute("c", { id: armed.details.taskId }, undefined, undefined, h.ctx);
	assert.equal(stopped.details.stopped, true);
	assert.ok(await waitFor(() => {
		try { process.kill(pid, 0); return false; } catch { return true; }
	}));
	await sleep(100);
	assert.equal(h.sent.length, 1, summarize(h.sent));
	assert.equal(h.sent[0].message.details.cause, "stopped");
	assert.equal(h.sent[0].message.details.mode, "completion");
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.match(h.sent[0].message.content, /\[Monitor stopped\]/);
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
	assert.match(text, /^exited\s+watcher/);
	assert.match(text, /· \d+(?:ms|s|m(?: \d+s)?) · exit 0$/);
	const firstSnapshot = first.details.monitors[0];
	assert.equal(typeof firstSnapshot.endedAt, "number");

	await new Promise((resolve) => setTimeout(resolve, 1100));
	const second = await h.tools.get("monitor_list").execute("c", {}, undefined, undefined, h.ctx);
	assert.equal(second.content[0].text, text, "the rendered snapshot and duration stop growing after exit");
	assert.equal(second.details.monitors[0].endedAt, firstSnapshot.endedAt);

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
	assert.deepEqual(
		h.events.filter((event) => event.channel.startsWith("monitor:")),
		[],
		"no monitor:wake bus event any more",
	);
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

test("long lines and merged final batches obey our complete envelope budget", async () => {
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

	assert.ok(h.sent.length >= 1, summarize(h.sent));
	for (const entry of h.sent) {
		assert.ok(entry.message.content.length <= 3000, "the whole notification, not merely the body, is bounded");
		for (const line of entry.message.content.split("\n")) assert.ok(line.length <= 500, `line is ${line.length} chars`);
	}
	assert.ok(h.sent.some((entry) => entry.message.content.includes("...(truncated)")), "the long line is marked as truncated");
	const final = h.sent.find((entry) => entry.message.details.cause === "exit");
	assert.equal(final.message.details.eventCount, 1501, "every admitted line still counts, including the merged final batch");
	assert.ok(fs.readFileSync(final.message.details.outputPath, "utf8").endsWith("1500\n"), "clipping never cuts the raw log");
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
	assert.match(text, /^Started watcher #\w+ · short\nevents · time limit 30m/);
	assert.match(text, /The watch ends at its time limit unless the source ends first; re-arm/);
	assert.match(text, /Keep working \u2014 do not poll or sleep\./);
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
	assert.match(armed.content[0].text.split("\n")[1], /^events · time limit 1m$/);
	assert.equal(armed.details.timeoutMs, 60000);
});

test("a sub-minute timeout is not 'expires in 0 minutes'", async () => {
	const h = await start(makeHarness());
	const armed = await h.tools
		.get("Monitor")
		.execute("c", { command: "sleep 1", description: "quick", timeout_ms: 5_000 }, undefined, undefined, h.ctx);
	assert.match(armed.content[0].text.split("\n")[1], /^events · time limit 5s$/);
	assert.equal(armed.details.timeoutMs, 5000);
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

test("a parent exit reports after a bounded stdio grace when a descendant holds the pipes", { skip: process.platform === "win32" }, async () => {
	const { spawnMonitor, stopProcessGroup } = await loadModule("process.ts");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-exit-grace-"));
	const child = spawnMonitor({
		command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)' &`,
		cwd: dir,
		env: process.env,
		shell: "/bin/sh",
		shellArgs: ["-c"],
		commandTransport: "argv",
		stdoutPath: path.join(dir, "out.log"),
		stderrPath: path.join(dir, "err.log"),
		onStdout: () => {},
		onStderr: () => {},
		onError: (error) => { throw error; },
		onExit: (code) => { child.reportedExit = code; },
		exitGraceMs: 50,
	});
	try {
		assert.ok(await waitFor(() => child.reportedExit === 0, 2000), "exit is reported even though the descendant keeps stdout/stderr open");
		assert.equal(child.exitCode, 0, "the shell itself really exited");
	} finally {
		assert.equal(await stopProcessGroup(child, { force: true }), true, "the process group, including the descendant, is cleaned up");
		fs.rmSync(dir, { recursive: true, force: true });
	}
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

test("another runtime never cleans up old-looking logs of a live persistent monitor", async (t) => {
	const h = await start(makeHarness());
	t.after(() => h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx));
	const armed = await h.tools.get("Monitor").execute("c", {
		command: "echo early; sleep 30", description: "quiet live owner", mode: "completion", persistent: true,
	}, undefined, undefined, h.ctx);
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.readFileSync(armed.details.outputPath, "utf8").includes("early")));
	const dir = path.dirname(armed.details.outputPath);
	const old = new Date(Date.now() - 4 * 86_400_000);
	const ownerPath = path.join(dir, "owner.json");
	const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
	owner.createdAt = old.getTime();
	fs.writeFileSync(ownerPath, JSON.stringify(owner));
	for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), old, old);
	fs.utimesSync(dir, old, old);
	const other = await start(makeHarness());
	t.after(() => other.handlers.get("session_shutdown")({ reason: "quit" }, other.ctx));
	await other.handlers.get("session_start")({ reason: "startup" }, other.ctx);
	assert.equal(fs.existsSync(armed.details.outputPath), true, "quiet is not proof that the owner ended");
	assert.equal(fs.existsSync(armed.details.stderrPath), true);
	assert.equal(h.sent.length, 0, "completion logs do not generate events");
});

// ----------------------------------------------------------------- prompts

test("the tool description carries Claude Code's usage guidance", async () => {
	const h = await start(makeHarness());
	const tool = h.tools.get("Monitor");
	for (const phrase of [
		"Each stdout line is an event",
		"mode: \"completion\"",
		"instead of foreground bash",
		"stdout and stderr are only written",
		"cover the expected runtime",
		"observer owns no process",
		"--line-buffered",
		"stopping, expiring or flooding it never stops the work",
		"2>&1",
		"monitor_stop",
		"an event is not their reply",
		"output stays suppressed for 30 seconds is stopped",
		"action: \"update\"",
	]) {
		assert.ok(tool.description.includes(phrase), `description mentions ${phrase}`);
	}
	for (const name of ["Monitor", "monitor_stop", "monitor_list"]) {
		assert.ok(h.tools.get(name).promptSnippet, `${name} has a prompt snippet`);
	}
	assert.equal(tool.promptGuidelines.length, 5);
	assert.ok(tool.promptGuidelines[0].includes("instead of foreground bash"));
	assert.ok(tool.description.includes("cover the expected runtime"), "deadline guidance belongs to the tool contract");
	assert.ok(!tool.promptGuidelines.join(" ").includes("1800000"), "the deadline is not duplicated in selection guidelines");
	assert.ok(tool.promptGuidelines[1].includes("end your turn immediately"));
	assert.ok(tool.promptGuidelines[1].includes("Never write the task's results"));
	assert.ok(!h.handlers.has("before_agent_start"), "guidelines are static tool metadata, not a dynamic prompt hook");
});

test("a chained monitor's notifications name their loop", async () => {
	const h = await start(makeHarness());
	h.registeredToolNames.push("cron_delete");
	await h.tools
		.get("Monitor")
		.execute("c", { command: "printf 'x\\n'", description: "chained", loopPrompt: "check the deploy" }, undefined, undefined, h.ctx);
	await waitFor(() => h.sent.some((entry) => entry.message.details.cause === "exit"));
	assert.equal(h.sent.length, 1, "the final output and exit are one notification");
	assert.ok(h.sent[0].message.details.finalLines.includes("x"));
	for (const entry of h.sent) {
		assert.equal(entry.message.details.loopPrompt, "check the deploy", "pi-cc-loop knows whose turn an event starts");
	}
});

test("every tool gives codemode scripts structuredContent that matches its outputSchema", async () => {
	const h = await start(makeHarness());
	const mon = h.tools.get("Monitor");
	assert.ok(mon.outputSchema, "Monitor declares an outputSchema");
	const armed = await mon.execute("c", { command: "printf 'one\\n'", description: "test monitor" }, undefined, undefined, h.ctx);
	assert.ok(armed.structuredContent, "Monitor returns structuredContent");
	assert.equal(armed.structuredContent.mode, "events");
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
	assert.equal(armed.structuredContent.mode, "events");
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

// ---------------------------------------------------------------------------
// Pi's validator decides what reaches execute(): since 1.5.0 that is
// @earendil-works/pi-schema, not TypeBox. See tests/tool-schema.test.mjs in
// pi-cc-loop for the same checks on the cron tools.
// ---------------------------------------------------------------------------

/** The arguments a model sends for one tool, and what coercion should make of them. */
const ARGUMENT_CASES = {
	Monitor: [
		["a shell watch", { description: "errors in deploy.log", command: "tail -f deploy.log" }],
		["a background command", { description: "test suite", command: "npm test", mode: "completion" }],
		["a two-hour background command", { description: "slow build", command: "make", mode: "completion", timeout_ms: 7200000 }],
		["a WebSocket watch", { description: "deploy events", ws: { url: "wss://events.example.com/stream", protocols: ["v1"] } }],
		["one protocol for a list", { description: "deploy events", ws: { url: "wss://e.example.com", protocols: "v1" } }, { ws: { protocols: ["v1"] } }],
		[
			"a model's strings for numbers and booleans",
			{ description: "CI run", command: "gh run watch", timeout_ms: "60000", persistent: "true" },
			{ timeout_ms: 60000, persistent: true },
		],
	],
	monitor_stop: [["plain", { id: "mon_1" }]],
	monitor_list: [["no arguments", {}]],
};

/** Arguments that must not reach `execute()`, and the message the model sees. */
const REJECTED = [
	["Monitor", { command: "x" }, engine === "pi-schema" ? /- description: missing/ : /- description: must have required properties/],
	["Monitor", { description: "d", command: "x", mode: "sometimes" }, /mode/],
	["Monitor", { description: "d", command: "x", timeout_ms: 99999999 }, engine === "pi-schema" ? /- timeout_ms: expected <= 7200000/ : /- timeout_ms: must be <= 7200000/],
	["monitor_stop", {}, engine === "pi-schema" ? /- id: missing/ : /- id: must have required properties/],
];

const call = (tool, args) =>
	validateToolArguments(tool, { type: "toolCall", id: "t", name: tool.name, arguments: args });

/** `base` with the coerced leaves of `patch` applied, including nested objects. */
const merge = (base, patch) => {
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		out[key] =
			value && typeof value === "object" && !Array.isArray(value) ? merge(base?.[key] ?? {}, value) : value;
	}
	return out;
};

test("every tool's parameters take the arguments a model sends, with Pi's coercion", async () => {
	const h = await start(makeHarness());
	assert.deepEqual(
		[...h.tools.keys()].sort(),
		Object.keys(ARGUMENT_CASES).sort(),
		"each registered tool has argument cases",
	);
	for (const [name, cases] of Object.entries(ARGUMENT_CASES)) {
		const tool = h.tools.get(name);
		for (const [label, args, coerced] of cases) {
			const parsed = call(tool, args);
			if (coerced) {
				assert.deepEqual(parsed, merge(args, coerced), `${name} [${label}]`);
			} else {
				assert.deepEqual(parsed, args, `${name} [${label}] is passed through unchanged`);
			}
		}
	}
});

test("arguments Pi rejects never reach execute(), with Pi's error format", async () => {
	const h = await start(makeHarness());
	for (const [name, args, message] of REJECTED) {
		assert.throws(() => call(h.tools.get(name), args), message, `${name}: ${JSON.stringify(args)}`);
	}
});

test("tool schemas stay inside JSON Schema, which is all Pi validates", async () => {
	const h = await start(makeHarness());
	for (const [name, tool] of h.tools) {
		for (const key of ["parameters", "outputSchema"]) {
			const schema = tool[key];
			if (!schema) continue;
			assert.deepEqual(jsonSchemaProblems(schema), [], `${name}.${key}`);
			assertJsonRoundTrip(schema, `${name}.${key}`);
		}
	}
});

test("the sources use no TypeBox feature Pi's validator ignores", () => {
	assert.deepEqual(unsupportedTypeboxUsages(), [], "Type.Refine/BigInt/Undefined/Void/Codec, Format.Set");
});
