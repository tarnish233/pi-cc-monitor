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
import { createJob } from "./observation-fixtures.mjs";

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
		dispatch,
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

/** Traverse the real viewport to its bottom; sectioned details may need more than two pages. */
function detailText(runtime) {
	const pages = [];
	runtime.render();
	const limit = runtime.state.component.detailLineCount + 1;
	for (let i = 0; i < limit; i++) {
		pages.push(runtime.text());
		const before = runtime.state.component.detailScroll;
		runtime.input("pageDown");
		if (runtime.state.component.detailScroll === before) {
			assert.equal(before, Math.max(0, runtime.state.component.detailLineCount - runtime.state.component.detailViewport), "all detail rows are reachable");
			return pages.join("\n");
		}
	}
	assert.fail("detail paging did not reach the final viewport");
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
	assert.ok(runtime.commands.get("monitor_settings"), "/monitor_settings stays available");

	const armed = await arm(runtime, { source: createJob(runtime.workdir).fileSource, description: "standalone monitor", persistent: true });
	runtime.state.idle = false;
	runtime.state.pending = true;
	const overlay = openTasks(runtime);
	assert.equal(runtime.state.options.overlay, true);
	assert.equal(runtime.state.waited, 0);
	const all = runtime.text();
	assert.match(all, /standalone monitor/);
	assert.match(all, /Monitor 1/);
	assert.doesNotMatch(all, /Loop 0/, "a provider that is not loaded has no tab");
	runtime.input("tab");
	assert.match(runtime.text(), /standalone monitor/);
	runtime.input("x");
	runtime.input("y");
	// The overlay awaits real exit confirmation, not only a local status flip.
	const settled = Date.now() + 5000;
	let list;
	while (Date.now() < settled) {
		list = await runtime.tools.get("monitor_list").execute("l", {}, undefined, undefined, runtime.ctx);
		if (list.details.monitors[0].status === "stopped") break;
		await sleep(20);
	}
	assert.equal(list.details.monitors[0].id, armed.details.taskId);
	assert.equal(list.details.monitors[0].status, "stopped");
	assert.equal(runtime.sent.filter((entry) => entry.kind === "custom").length, 0, "a busy turn keeps its outcome out of the clearable queue");
	await runtime.dispatch("agent_settled", { aborted: false });
	assert.ok(
		runtime.sent.some((entry) => entry.message?.customType === "Monitor" && entry.message.content.includes("[Monitor stopped")),
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
		source: createJob(runtime.workdir, { stdout: "\x1b[31mRED\x1b[0m \x01CLEAR\n", stderr: "ERR \x1b[32mGREEN\x1b[0m\n" }).fileSource,
		description: "log monitor",
		persistent: true,
	});
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.statSync(armed.details.outputPath).size > 0));
	assert.ok(await waitFor(() => fs.existsSync(armed.details.stderrPath) && fs.statSync(armed.details.stderrPath).size > 0));
	// Wait for the bytes this assertion inspects; size > 0 can precede both writes under load.
	assert.ok(await waitFor(() => fs.readFileSync(armed.details.outputPath, "utf8").includes("RED") && fs.readFileSync(armed.details.stderrPath, "utf8").includes("GREEN")));
	const overlay = openTasks(runtime);
	runtime.input("tab");
	runtime.input("enter");
	const detail = detailText(runtime);
	assert.match(detail, /stdout|stderr/);
	// Both log tails may span pages at this width; the UI contract is that both are reachable.
	assert.ok(detail.includes("RED") && detail.includes("GREEN"), detail);
	assert.match(detail, /RED CLEAR/, "actual sanitized stdout, not just the Command field");
	assert.match(detail, /ERR GREEN/, "actual sanitized stderr is reachable too");
	assert.ok(!stripTerminalSequences(detail).includes("\x1b"));
	assert.ok(!stripTerminalSequences(detail).includes("\x01"));
	runtime.input("escape");
	runtime.input("escape");
	await overlay;

	const tail = tasksMod.readLogTail(armed.details.outputPath, 64, 2);
	assert.ok(tail.text.split("\n").length <= 2);
	assert.ok(!tail.text.includes("\x1b"));
});

test("standalone completion command: details show its mode and quiet log semantics", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	runtime.load();
	await runtime.start();
	const armed = await arm(runtime, {
		source: createJob(runtime.workdir, { stdout: "quiet\n" }).source,
		description: "background test suite",
		mode: "completion",
		persistent: true,
	});
	assert.ok(await waitFor(() => fs.existsSync(armed.details.outputPath) && fs.statSync(armed.details.outputPath).size > 0));
	assert.equal(runtime.sent.length, 0, "ordinary output does not wake the agent in completion mode");

	const overlay = openTasks(runtime);
	runtime.input("tab");
	assert.match(runtime.text(), /background test suite · task/);
	assert.doesNotMatch(runtime.text(), /completion/, "the list uses the role, technical mode is detail data");
	runtime.input("enter");
	const detail = detailText(runtime);
	assert.match(detail, /Mode\s+completion · external job terminal report/);
	assert.match(detail, /Output\s+turn/);
	assert.match(detail, /stdout \(observation copy\)/);
	assert.doesNotMatch(detail, /0 delivered/);
	assert.match(detail, /quiet/);
	runtime.input("escape");
	runtime.input("escape");
	await overlay;
});

test("standalone completion command: a finished command reports its terminal status", async (t) => {
	const runtime = makeRuntime();
	t.after(() => stop(runtime));
	runtime.load();
	await runtime.start();
	await arm(runtime, { source: createJob(runtime.workdir, { state: "succeeded", stdout: "done\n" }).source, description: "finishing build", mode: "completion" });
	assert.ok(
		await waitFor(() => runtime.sent.some((entry) => entry.message?.details?.status === "completed")),
		"exit code 0 is a completed completion, not exited",
	);
	const overlay = openTasks(runtime);
	assert.match(runtime.text(), /completed/);
	runtime.input("enter");
	const detail = detailText(runtime);
	assert.match(detail, /Status\s+completed/);
	assert.match(detail, /Job exit\s+0/);
	runtime.input("escape");
	runtime.input("escape");
	await overlay;
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
		await arm(runtime, { source: { kind: "ws", url: "ws://x.example/feed" }, description: "live socket", persistent: true });
		const overlay = openTasks(runtime);
		runtime.input("tab");
		runtime.input("enter");
		const detail = runtime.text();
		assert.match(detail, /Resource\s+observation only; active/, "the local connection is still active");
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
		source: createJob(runtime.workdir, { state: "succeeded", stdout: "done\n" }).source,
		description: "ends early",
		timeout_ms: 600_000,
	});
	assert.ok(
		await waitFor(() => runtime.sent.some((entry) => entry.message?.details?.cause === "job")),
		"the command ended",
	);
	const ended = openTasks(runtime);
	assert.equal(runtime.state.component.selected().title, "ends early", "the newest command is first");
	runtime.input("enter");
	const endedDetail = detailText(runtime);
	assert.match(endedDetail, /Lifetime\s+10m configured observation timeout/);
	assert.match(endedDetail, /Job exit\s+0/);
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
	await arm(runtime, { source: createJob(runtime.workdir).fileSource, description: "\u4e2d\u6587\ud83d\ude80 narrow", persistent: true });

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
	await arm(a, { source: createJob(a.workdir).fileSource, description: "only A", persistent: true });
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

test("independent source observations retain panel identity and stop only the selected watcher", async t => {
  const runtime = makeRuntime(); t.after(() => stop(runtime)); runtime.load(); await runtime.start();
  let creationTime = Date.now(); const clock = t.mock.method(Date, "now", () => ++creationTime);
  const job = createJob(runtime.workdir);
  const work = await arm(runtime, { source: job.source, description: "build", mode: "completion", persistent: true });
  const independent = await arm(runtime, { source: createJob(runtime.workdir).fileSource, description: "independent watcher", persistent: true });
  const observer = await arm(runtime, { source: job.fileSource, description: "build errors", persistent: true, watches: [{ id: "errors", text: "ERROR", stream: "both" }] });
  const muted = await arm(runtime, { source: job.fileSource, description: "build progress", persistent: true, watches: [] });
  clock.mock.restore(); const overlay = openTasks(runtime);
  assert.deepEqual(runtime.state.component.entries.map(item => item.id), [muted.details.taskId, observer.details.taskId, independent.details.taskId, work.details.taskId]);
  assert.match(runtime.text(), /build progress · watcher/); runtime.input("down"); assert.equal(runtime.state.component.selected().id, observer.details.taskId); runtime.input("enter");
  const detail = detailText(runtime); assert.match(detail, /Source\s+/); assert.match(detail, /Watch errors\s+both · repeat · turn · waiting · ERROR/); assert.ok(detail.includes("Observer") && detail.indexOf("Observer") < detail.indexOf("Observation")); assert.ok(detail.indexOf("Observation") < detail.indexOf("Delivery")); assert.doesNotMatch(detail, /Observation PID\s+\d+/);
  runtime.input("escape"); runtime.input("x"); const confirmation = stripTerminalSequences(runtime.text()).split("\n").map(line => line.replace(/^│\s*|\s*│$/g, "").trim()).join(" "); assert.match(confirmation, /Stop watcher/); assert.match(confirmation, /not cancelled or signalled/);
  runtime.input("escape"); assert.equal(runtime.sent.length, 0); runtime.input("x"); runtime.input("y"); assert.ok(await waitFor(() => runtime.sent.some(entry => entry.message?.details?.cause === "stopped")));
  const list = (await runtime.tools.get("monitor_list").execute("list", {}, undefined, undefined, runtime.ctx)).details.monitors;
  assert.equal(list.find(item => item.id === observer.details.taskId).status, "stopped"); for (const id of [work.details.taskId, independent.details.taskId, muted.details.taskId]) assert.equal(list.find(item => item.id === id).status, "running");
  assert.equal(fs.existsSync(job.manifestPath), true); assert.equal(runtime.state.aborts, 0); runtime.input("escape"); await overlay;
});

test("task panel makes ordinary endings prominent without recoloring success or abnormal endings", async (t) => {
  const runtime = makeRuntime();
  t.after(() => stop(runtime));
  const client = runtime.load();
  await runtime.start();
  const states = ["stopped", "exited", "closed", "completed", "failed", "timed_out", "stop_timeout", "flooded"];
  const registration = tasksMod.registerTaskProvider(client.pi, {
    id: "palette", label: "Palette",
    list: () => states.map((state) => ({ id: state, title: `color ${state}`, state, role: "task", active: false })),
  });
  const overlay = openTasks(runtime);
  const calls = [];
  runtime.state.component.options.theme.fg = (color, text) => { calls.push({ color, text }); return text; };
  runtime.render();
  const expected = { stopped: "accent", exited: "accent", closed: "accent", completed: "success", failed: "error", timed_out: "warning", stop_timeout: "warning", flooded: "warning" };
  for (const [state, color] of Object.entries(expected)) {
    assert.ok(calls.some((call) => call.text.trim() === state && call.color === color), `${state} uses ${color}`);
  }
  assert.equal(runtime.sent.length, 0, "palette rendering never starts a model turn");
  runtime.input("escape");
  await overlay;
  registration.close();
});

test("sectioned observation details preserve the existing flat-row fallback without duplicate rendering", async t => {
  const runtime = makeRuntime(); t.after(() => stop(runtime)); runtime.load(); await runtime.start(); const job = createJob(runtime.workdir);
  const work = await arm(runtime, { source: job.source, description: "work report", persistent: true });
  const observer = await arm(runtime, { source: job.fileSource, description: "error watch", persistent: true, watches: [{ id: "errors", text: "ERROR", stream: "stderr" }], notify: { output: "context" } });
  const overlay = openTasks(runtime), panel = runtime.state.component, provider = panel.options.registry.providers.get("monitor");
  for (const id of [work.details.taskId, observer.details.taskId]) {
    const detail = provider.detail(provider.list().find(item => item.id === id)); assert.ok(detail.rows.length); assert.deepEqual(detail.rows, detail.sections.flatMap(section => section.rows));
    const flat = detail.rows.map(row => row.label + ': ' + row.value).join('\n'); assert.match(flat, /Status: running/); assert.match(flat, /Mode: (completion|events)/); assert.match(flat, /Lifetime: until stopped/); assert.match(flat, /Resource: observation only; active/);
    const paths = id === work.details.taskId ? work.details : observer.details; assert.ok(flat.includes(paths.outputPath) && flat.includes(paths.stderrPath));
  }
  while (panel.selected().id !== observer.details.taskId) runtime.input("down"); runtime.input("enter"); const modern = panel.detailLines(90).map(line => stripTerminalSequences(line).trimEnd()); assert.equal(modern.filter(line => /^Status\s+/.test(line)).length, 1); assert.equal(modern.filter(line => /^Mode\s+/.test(line)).length, 1); assert.ok(modern.includes("Observer") && modern.includes("Observation") && modern.includes("Delivery"));
  runtime.input("escape"); runtime.input("escape"); await overlay;
});

test("task details retain each remote host even when file and manifest paths are identical", async t => {
  const runtime = makeRuntime(); t.after(() => stop(runtime)); runtime.load(); await runtime.start();
  const { SshSourceReader } = await loadModule("ssh-reader.ts");
  const { LocalSourceReader } = await loadModule("source-reader.ts");
  const read = SshSourceReader.prototype.read;
  SshSourceReader.prototype.read = request => new LocalSourceReader().read(request);
  try {
    const job = createJob(runtime.workdir), receipts = [];
    for (const host of ["gpu-a", "gpu-b"]) for (const source of [job.fileSource, job.source]) {
      receipts.push({ host, result: await arm(runtime, { source: { ...source, host }, description: "same remote path", persistent: true }) });
    }
    const overlay = openTasks(runtime), panel = runtime.state.component, provider = panel.options.registry.providers.get("monitor");
    for (const { host, result } of receipts) {
      const item = provider.list().find(item => item.id === result.details.taskId);
      const detail = provider.detail(item);
      const source = detail.rows.find(row => row.label === "Source").value;
      assert.ok(source.startsWith(host + " · "), source);
      assert.ok(source.includes(job.root), source);
    }
    runtime.input("escape"); await overlay;
  } finally {
    // Close every observer before removing the offline transport, including in-flight ticks.
    try { await stop(runtime); } finally { SshSourceReader.prototype.read = read; }
  }
});
