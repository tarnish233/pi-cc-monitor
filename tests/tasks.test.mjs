/**
 * /cc-tasks in pi-cc-monitor on its own.
 * The fake API omits getCommands(), exercising the conservative fallback;
 * real SDK command selection is covered by pi-cc-loop/tests/task-commands.test.mjs.
 *
 * The cross-package behaviour (both load orders, the real Loop provider, stop
 * cascades, durable ownership) lives in pi-cc-loop/tests/tasks.test.mjs. Here
 * the Monitor package must prove it works alone: one command, a native overlay
 * while the agent is busy, its own task records, stop via endMonitor, bounded
 * log tails, and clean session/runtime disposal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule, loadPi } from "./helpers.mjs";

const monitorMod = await loadModule("index.ts");
const tasksMod = await loadModule("tasks.ts");
const tuiPkg = await import(pathToFileURL(findPiInstall().piTui).href);
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences } = tuiPkg;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 4000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(20);
	}
	return false;
}

function makeRuntime() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-tasks-"));
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const sent = [];
	const busEvents = [];
	const notifications = [];
	const clients = [];
	const state = {
		idle: true,
		pending: false,
		waited: 0,
		aborts: 0,
		columns: 80,
		rows: 24,
		renders: 0,
		options: undefined,
		component: undefined,
		resolve: undefined,
	};

	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.up": "k",
		"tui.select.down": "j",
	});
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const tui = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return state.rows;
			},
		},
		requestRender: () => {
			state.renders += 1;
		},
	};

	function unique(name) {
		let candidate = name;
		let suffix = 1;
		while (commands.has(candidate)) candidate = `${name}:${suffix++}`;
		return candidate;
	}

	function createClient() {
		const subscriptions = new Set();
		const client = { disposed: false };
		const events = {
			emit(channel, data) {
				if (client.disposed) throw new Error("stale extension API");
				busEvents.push({ channel, data });
				bus.emit(channel, data);
			},
			on(channel, handler) {
				const wrapped = (data) => handler(data);
				bus.on(channel, wrapped);
				const entry = { channel, handler: wrapped };
				subscriptions.add(entry);
				return () => {
					if (!subscriptions.delete(entry)) return;
					bus.off(channel, wrapped);
				};
			},
		};
		client.pi = {
			events,
			registerCommand: (name, options) => commands.set(unique(name), options),
			registerTool: (tool) => tools.set(tool.name, tool),
			registerMessageRenderer() {},
			registerToolRenderer() {},
			on(event, handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {
					const index = list.indexOf(handler);
					if (index >= 0) list.splice(index, 1);
				};
			},
			appendEntry() {},
			sendUserMessage(content, options) {
				sent.push({ kind: "user", content, options });
			},
			sendMessage(message, options) {
				sent.push({ kind: "custom", message, options });
			},
			getAllTools: () => [...tools.keys()].map((name) => ({ name })),
			getSettings: () => ({}),
			setActiveTools() {
				throw new Error("/cc-tasks must not change the tool set");
			},
		};
		client.dispose = () => {
			client.disposed = true;
			for (const { channel, handler } of subscriptions) bus.off(channel, handler);
			subscriptions.clear();
		};
		clients.push(client);
		return client;
	}

	const ctx = {
		ui: {
			custom(factory, options) {
				state.options = options;
				const done = (result) => {
					const component = state.component;
					state.component = undefined;
					component?.dispose?.();
					const resolve = state.resolve;
					state.resolve = undefined;
					resolve?.(result);
				};
				state.component = factory(tui, theme, keybindings, done);
				return new Promise((resolve) => {
					state.resolve = resolve;
				});
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
			theme,
		},
		hasUI: true,
		mode: "tui",
		cwd: workdir,
		sessionManager: { getEntries: () => [], getBranch: () => [] },
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		waitForIdle: async () => {
			state.waited += 1;
		},
		abort: () => {
			state.aborts += 1;
		},
	};

	async function dispatch(event, payload = {}) {
		let last;
		for (const handler of [...(handlers.get(event) ?? [])]) last = await handler({ type: event, ...payload }, ctx);
		return last;
	}

	return {
		workdir,
		bus,
		state,
		ctx,
		commands,
		tools,
		handlers,
		sent,
		busEvents,
		notifications,
		load() {
			const client = createClient();
			monitorMod.default(client.pi);
			return client;
		},
		start: () => dispatch("session_start", { reason: "startup" }),
		async shutdown(reason = "quit") {
			await dispatch("session_shutdown", { reason });
			for (const client of clients) client.dispose();
		},
		render(width) {
			assert.ok(state.component, "overlay is open");
			const configured = state.options?.overlayOptions;
			const options = typeof configured === "function" ? configured() : configured;
			return state.component.render(width ?? options?.width ?? state.columns);
		},
		text(width) {
			return this.render(width).join("\n");
		},
		input(key) {
			assert.ok(state.component, "overlay is open");
			const keys = { up: "k", down: "j", enter: "\r", escape: "\x1b", tab: "\t", shiftTab: "\x1b[Z", pageDown: "\x1b[6~" };
			state.component.handleInput(keys[key] ?? key);
		},
	};
}

function openTasks(runtime) {
	const command = runtime.commands.get("cc-tasks");
	assert.ok(command, "/cc-tasks is registered");
	const promise = command.handler("", runtime.ctx);
	assert.ok(runtime.state.component, "factory ran synchronously");
	return promise;
}

async function arm(runtime, params) {
	return runtime.tools.get("Monitor").execute("m", params, undefined, undefined, runtime.ctx);
}

async function stop(runtime) {
	try {
		await runtime.shutdown();
	} finally {
		fs.rmSync(runtime.workdir, { recursive: true, force: true });
	}
}

test("standalone monitor: one native /cc-tasks, opened while busy, stops via endMonitor", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	runtime.load();
	await runtime.start();
	assert.deepEqual([...runtime.commands.keys()].filter((name) => name.startsWith("cc-tasks")), ["cc-tasks"]);
	assert.ok(runtime.commands.get("pi_cc"), "/pi_cc is unchanged");

	const armed = await arm(runtime, { command: "sleep 30", description: "standalone monitor", persistent: true });
	runtime.state.idle = false;
	runtime.state.pending = true;
	const overlay = openTasks(runtime);
	assert.equal(runtime.state.options.overlay, true);
	assert.equal(runtime.state.waited, 0);
	const all = runtime.text();
	assert.match(all, /standalone monitor/);
	assert.match(all, /Monitor 1/);
	assert.match(all, /Loop 0/);
	runtime.input("tab");
	assert.match(runtime.text(), /standalone monitor/);
	runtime.input("x");
	runtime.input("y");
	await sleep(30);
	const list = await runtime.tools.get("monitor_list").execute("l", {}, undefined, undefined, runtime.ctx);
	assert.equal(list.details.monitors[0].id, armed.details.taskId);
	assert.equal(list.details.monitors[0].status, "stopped");
	assert.ok(
		runtime.sent.some((entry) => entry.message?.customType === "Monitor" && entry.message.content.includes("[Monitor stopped]")),
		"monitor_stop's terminal notice",
	);
	assert.equal(runtime.state.aborts, 0);
	assert.equal(runtime.sent.filter((entry) => entry.kind === "user").length, 0, "opening/closing writes no conversation");
	runtime.input("escape");
	await overlay;
});

test("standalone monitor: details show exit data and bounded, sanitized logs", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	runtime.load();
	await runtime.start();
	const armed = await arm(runtime, {
		command: "printf '\\033[31mRED\\033[0m \\001CLEAR\\n'; printf 'ERR \\033[32mGREEN\\033[0m\\n' >&2; sleep 30",
		description: "log monitor",
		persistent: true,
	});
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.statSync(armed.details.outputPath).size > 0));
	assert.ok(await waitFor(() => fs.existsSync(armed.details.stderrPath) && fs.statSync(armed.details.stderrPath).size > 0));
	const overlay = openTasks(runtime);
	runtime.input("tab");
	runtime.input("enter");
	runtime.render();
	runtime.input("pageDown");
	const detail = runtime.text();
	assert.match(detail, /stdout|stderr/);
	assert.ok(detail.includes("RED") && detail.includes("GREEN"));
	assert.ok(!stripTerminalSequences(detail).includes("\x1b"));
	assert.ok(!stripTerminalSequences(detail).includes("\x01"));
	runtime.input("escape");
	runtime.input("escape");
	await overlay;

	const tail = tasksMod.readLogTail(armed.details.outputPath, 64, 2);
	assert.ok(tail.text.split("\n").length <= 2);
	assert.ok(!tail.text.includes("\x1b"));
});

test("detail state wording: a running WebSocket is not closed, and an early exit has no live countdown", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	runtime.load();
	await runtime.start();

	// A running WebSocket has no exit data yet.
	const savedWebSocket = globalThis.WebSocket;
	const sockets = [];
	globalThis.WebSocket = class {
		constructor(url) {
			this.url = url;
			this.listeners = new Map();
			sockets.push(this);
		}
		addEventListener(name, handler) {
			const list = this.listeners.get(name) ?? [];
			list.push(handler);
			this.listeners.set(name, list);
		}
		close() {
			for (const handler of this.listeners.get("close") ?? []) handler({ code: 1000 });
		}
	};
	try {
		await arm(runtime, { ws: { url: "ws://x.example/feed" }, description: "live socket", persistent: true });
		const overlay = openTasks(runtime);
		runtime.input("tab");
		runtime.input("enter");
		const detail = runtime.text();
		assert.match(detail, /Exit\s+—/, "a running socket has no exit yet");
		assert.doesNotMatch(detail, /Exit\s+socket close/, "running is not reported as closed");
		runtime.input("escape");
		runtime.input("escape");
		await overlay;
	} finally {
		globalThis.WebSocket = savedWebSocket;
	}

	// A command that exits before its timeout keeps the configured lifetime,
	// but must not show an active "left" countdown.
	await arm(runtime, {
		command: "printf 'done\\n'",
		description: "ends early",
		timeout_ms: 600_000,
	});
	assert.ok(
		await waitFor(() => runtime.sent.some((entry) => entry.message?.details?.cause === "exit")),
		"the command ended",
	);
	const ended = openTasks(runtime);
	runtime.input("down"); // the running socket is first; select the ended command
	runtime.input("enter");
	const endedDetail = runtime.text();
	assert.match(endedDetail, /Lifetime\s+10m configured timeout · ended early/);
	assert.match(endedDetail, /Exit\s+code 0/);
	assert.doesNotMatch(endedDetail, /Lifetime[^\n]*left/, "no remaining timer on an ended record");
	runtime.input("escape");
	runtime.input("escape");
	await ended;
});

test("standalone monitor: non-TUI summary, narrow widths and shutdown cleanup", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	const client = runtime.load();
	await runtime.start();
	await arm(runtime, { command: "sleep 30", description: "\u4e2d\u6587\ud83d\ude80 narrow", persistent: true });

	runtime.ctx.mode = "print";
	runtime.ctx.hasUI = false;
	await runtime.commands.get("cc-tasks").handler("", runtime.ctx);
	assert.equal(runtime.state.component, undefined);
	assert.equal(runtime.notifications.length, 0);
	runtime.ctx.mode = "rpc";
	runtime.ctx.hasUI = true;
	await runtime.commands.get("cc-tasks").handler("", runtime.ctx);
	assert.match(runtime.notifications.at(-1).message, /narrow/);

	runtime.ctx.mode = "tui";
	runtime.state.columns = 30;
	runtime.state.rows = 12;
	const overlay = openTasks(runtime);
	for (const line of runtime.render(25)) assert.ok(visibleWidth(line) <= 25);
	runtime.state.columns = 80;
	runtime.state.rows = 24;
	for (const line of runtime.render(68)) assert.ok(visibleWidth(line) <= 68);

	// Shutdown closes the open overlay without cancelling a monitor.
	await runtime.shutdown();
	await overlay;
	assert.equal(runtime.state.component, undefined);
	assert.equal(client.disposed, true);
	const renders = runtime.state.renders;
	await sleep(350);
	assert.equal(runtime.state.renders, renders, "timers stopped with the overlay");
});

test("the real Pi event bus joins a second provider across distinct facades without a second command", async () => {
	const { createEventBus } = await loadPi();
	const bus = createEventBus();
	const commands = new Map();
	function client() {
		const subs = new Set();
		const pi = {
			events: {
				emit: (channel, data) => bus.emit(channel, data),
				on(channel, handler) {
					const safe = async (data) => {
						try {
							await handler(data);
						} catch {
							// Pi's safe handler
						}
					};
					bus.on(channel, safe);
					const entry = { channel, safe };
					subs.add(entry);
					return () => {
						if (!subs.delete(entry)) return;
						bus.off(channel, safe);
					};
				},
			},
			registerCommand(name, options) {
				let candidate = name;
				let suffix = 1;
				while (commands.has(candidate)) candidate = `${name}:${suffix++}`;
				commands.set(candidate, options);
			},
			on: () => () => {},
		};
		return {
			pi,
			close: () => {
				for (const { channel, safe } of subs) bus.off(channel, safe);
				subs.clear();
			},
		};
	}
	const a = client();
	const b = client();
	assert.notEqual(a.pi.events, b.pi.events);
	const regA = tasksMod.registerTaskProvider(a.pi, { id: "monitor", label: "Monitor", list: () => [] });
	const regB = tasksMod.registerTaskProvider(b.pi, { id: "loop", label: "Loop", list: () => [] });
	assert.deepEqual([...commands.keys()], ["cc-tasks"]);
	regA.close();
	regB.close();
	a.close();
	b.close();
});

test("two runtimes keep separate Monitor task state and commands", async (t) => {
	const a = makeRuntime();
	const b = makeRuntime();
	t.after(() => stop(a));
	t.after(() => stop(b));
	a.load();
	b.load();
	await a.start();
	await b.start();
	assert.deepEqual([...a.commands.keys()].filter((name) => name.startsWith("cc-tasks")), ["cc-tasks"]);
	assert.deepEqual([...b.commands.keys()].filter((name) => name.startsWith("cc-tasks")), ["cc-tasks"]);
	await arm(a, { command: "sleep 30", description: "only A", persistent: true });
	const overlayA = openTasks(a);
	assert.match(a.text(), /only A/);
	const overlayB = openTasks(b);
	assert.doesNotMatch(b.text(), /only A/);
	assert.match(b.text(), /No tasks/);
	a.input("escape");
	b.input("escape");
	await overlayA;
	await overlayB;
});