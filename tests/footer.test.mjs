/**
 * The footer chip: `monitor N` while monitors run, in the format of
 * pi-cc-loop's chip (`loop 2 · next 3m`). Claude Code shows the same count in
 * its footer pill ("2 monitors") and nothing when none is running. It shares
 * one line with every other extension's status, so it is plain text and only
 * repainted when the count changes.
 *
 * Every test shuts the session down at the end: it kills the monitors' child
 * processes, which would otherwise outlive the test run.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-footer-"));
	const tools = new Map();
	const handlers = new Map();
	const bus = new Map();
	const statusCalls = [];
	const pi = {
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
		events: {
			emit() {},
			on(channel, handler) {
				bus.set(channel, handler);
				return () => bus.delete(channel);
			},
		},
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};
	const ctx = {
		ui: {
			notify() {},
			setWidget() {},
			setStatus: (key, text) => statusCalls.push([key, text]),
			theme: { fg: (_c, t) => t },
		},
		hasUI: true,
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	mod.default(pi);
	const monitorCalls = () => statusCalls.filter(([key]) => key === "monitor");
	return {
		bus,
		monitorCalls,
		exec: (name, params) => tools.get(name).execute("c", params, undefined, undefined, ctx),
		/** What the footer shows for this extension right now. */
		status: () => monitorCalls().at(-1)?.[1],
		start: () => handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx),
		shutdown: () => handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx),
	};
}

async function waitFor(predicate, timeoutMs = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

const forever = (description) => ({ command: "sleep 30", description, persistent: true });

test("the footer counts running monitors as `monitor N` and disappears at zero", async () => {
	const h = makeHarness();
	await h.start();
	try {
		assert.equal(h.monitorCalls().length, 0, "nothing running, nothing shown");
		const first = await h.exec("Monitor", forever("first"));
		assert.equal(h.status(), "monitor 1");
		const second = await h.exec("Monitor", forever("second"));
		assert.equal(h.status(), "monitor 2");
		await h.exec("monitor_stop", { id: first.details.taskId });
		assert.equal(h.status(), "monitor 1");
		await h.exec("monitor_stop", { id: second.details.taskId });
		assert.equal(h.status(), undefined, "cleared when the last one stops");

		await h.exec("Monitor", { command: "printf 'done\\n'", description: "short" });
		assert.equal(h.status(), "monitor 1");
		assert.ok(await waitFor(() => h.status() === undefined), "a monitor that exits on its own drops out");
	} finally {
		await h.shutdown();
	}
});

test("the chip repaints only when the count changes", async () => {
	const h = makeHarness();
	await h.start();
	try {
		await h.exec("Monitor", {
			command: "for i in 1 2 3; do echo line$i; sleep 0.1; done; sleep 30",
			description: "chatty",
			persistent: true,
		});
		const calls = h.monitorCalls().length;
		await new Promise((resolve) => setTimeout(resolve, 800));
		await h.exec("monitor_list", {});
		assert.equal(h.monitorCalls().length, calls, "events and listing leave the footer alone");
	} finally {
		await h.shutdown();
	}
});

test("the chip follows the shared footer setting", async () => {
	const h = makeHarness();
	await h.start();
	try {
		await h.exec("Monitor", forever("first"));
		assert.equal(h.status(), "monitor 1");
		// /loop settings footer off writes the shared file and announces it.
		process.env.PI_CC_FOOTER = "0";
		h.bus.get("pi-cc:config")();
		assert.equal(h.status(), undefined, "footer off hides it");
		await h.exec("Monitor", forever("second"));
		assert.equal(h.status(), undefined, "and keeps it hidden");
		process.env.PI_CC_FOOTER = "1";
		h.bus.get("pi-cc:config")();
		assert.equal(h.status(), "monitor 2", "back on, with the current count");
	} finally {
		delete process.env.PI_CC_FOOTER;
		await h.shutdown();
	}
});

test("shutdown clears the chip, so a reload leaves no stale count", async () => {
	const h = makeHarness();
	await h.start();
	await h.exec("Monitor", forever("first"));
	assert.equal(h.status(), "monitor 1");
	await h.shutdown();
	assert.equal(h.status(), undefined);
});
