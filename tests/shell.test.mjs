/**
 * Monitor commands run the way Pi's bash tool runs commands: in the shell from
 * Pi's `shellPath` setting (a leading ~ is the home directory), with
 * `shellCommandPrefix` on its own line first, and with Pi's bin directory
 * (under PI_CODING_AGENT_DIR) at the front of PATH.
 *
 * The settings come from pi.getSettings(), the session's effective settings:
 * global and project merged under Pi's trust rules, so an untrusted project's
 * .pi/settings.json cannot pick the shell.
 *
 * Every test shuts the session down at the end to kill its child processes.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

function makeHarness(settings) {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-shell-"));
	const tools = new Map();
	const handlers = new Map();
	const events = [];
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
		sendMessage(message) {
			events.push(String(message.content));
		},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
		getSettings: () => structuredClone(settings),
	};
	const ctx = {
		ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c, t) => t } },
		hasUI: true,
		cwd: workdir,
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	mod.default(pi);
	return {
		events,
		exec: (name, params) => tools.get(name).execute("c", params, undefined, undefined, ctx),
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

const textOf = (result) => result.content.map((part) => part.text).join("\n");

/** A stand-in for a custom bash: marks the environment, then runs the real one. */
function fakeShell(dir) {
	const file = path.join(dir, "fake-bash");
	fs.writeFileSync(file, '#!/bin/bash\nexport PI_CC_SHELL=custom\nexec /bin/bash "$@"\n', { mode: 0o755 });
	return file;
}

test("a monitor command runs in Pi's shellPath, after shellCommandPrefix, like the bash tool", async () => {
	const shell = fakeShell(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-shell-")));
	const h = makeHarness({ shellPath: shell, shellCommandPrefix: "export PI_CC_PREFIX=on" });
	await h.start();
	try {
		const command = 'echo "shell=$PI_CC_SHELL prefix=$PI_CC_PREFIX"';
		await h.exec("Monitor", { command, description: "shell check" });
		assert.ok(
			await waitFor(() => h.events.some((event) => event.includes("shell=custom prefix=on"))),
			`events: ${JSON.stringify(h.events)}`,
		);
		const list = textOf(await h.exec("monitor_list", {}));
		assert.ok(list.includes(command), "the list shows the command as written");
		assert.doesNotMatch(list, /PI_CC_PREFIX=on/, "without the prefix");
	} finally {
		await h.shutdown();
	}
});

test("a leading ~ in shellPath is the home directory, as in Pi's settings", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-home-"));
	fakeShell(home);
	const previous = process.env.HOME;
	process.env.HOME = home;
	const h = makeHarness({ shellPath: "~/fake-bash" });
	try {
		await h.start();
		await h.exec("Monitor", { command: 'echo "shell=$PI_CC_SHELL"', description: "home shell" });
		assert.ok(
			await waitFor(() => h.events.some((event) => event.includes("shell=custom"))),
			`events: ${JSON.stringify(h.events)}`,
		);
	} finally {
		process.env.HOME = previous;
		await h.shutdown();
	}
});

test("a shellPath that does not exist fails the start, and nothing is left running", async () => {
	const h = makeHarness({ shellPath: "/nonexistent/pi-cc-bash" });
	await h.start();
	try {
		await assert.rejects(
			h.exec("Monitor", { command: "echo hi", description: "missing shell" }),
			/Could not start the monitor: Custom shell path not found: \/nonexistent\/pi-cc-bash/,
		);
		const list = textOf(await h.exec("monitor_list", {}));
		assert.match(list, / failed /);
		assert.doesNotMatch(list, / running /);
	} finally {
		await h.shutdown();
	}
});

test("PATH starts with Pi's bin directory under PI_CODING_AGENT_DIR", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const h = makeHarness({});
	try {
		await h.start();
		await h.exec("Monitor", { command: 'echo "first=${PATH%%:*}"', description: "path" });
		const expected = `first=${path.join(agentDir, "bin")}`;
		assert.ok(
			await waitFor(() => h.events.some((event) => event.includes(expected))),
			`events: ${JSON.stringify(h.events)}`,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await h.shutdown();
	}
});
