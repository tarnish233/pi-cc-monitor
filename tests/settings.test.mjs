/**
 * Settings tests: pi-cc-monitor follows the shared config file written by
 * pi-cc-loop, so both extensions switch styles together.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const configFile = process.env.PI_CC_CONFIG_FILE;
const ccstyleConfig = process.env.PI_CC_EXTENSIONS_CONFIG_FILE;
assert.ok(configFile, "the test helper points PI_CC_CONFIG_FILE at a temp file");
assert.ok(ccstyleConfig, "the test helper points PI_CC_EXTENSIONS_CONFIG_FILE at a temp file");

const mod = await loadModule("index.ts");

function writeConfig(patch) {
	const current = fs.existsSync(configFile)
		? JSON.parse(fs.readFileSync(configFile, "utf8"))
		: { compactMessages: true, compactToolRows: true };
	fs.writeFileSync(configFile, JSON.stringify({ ...current, ...patch }), "utf8");
}

function makeTheme() {
	const bgCalls = { count: 0 };
	return {
		bgCalls,
		theme: {
			fg: (_color, text) => text,
			bg: (_color, text) => {
				bgCalls.count += 1;
				return text;
			},
			bold: (text) => text,
		},
	};
}

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-settings-"));
	process.chdir(workdir);

	const tools = new Map();
	const renderers = new Map();
	const toolRenderers = [];
	const handlers = new Map();

	const pi = {
		registerCommand() {},
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
		sendUserMessage() {},
		sendMessage() {},
		events: {
			emit() {},
			on(channel, handler) {
				handlers.set(`bus:${channel}`, handler);
				return () => handlers.delete(`bus:${channel}`);
			},
		},
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	const ctx = {
		ui: {
			notify: () => {},
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

	mod.default(pi);
	return { tools, renderers, toolRenderers, handlers, ctx };
}

function notifyConfig(h) {
	h.handlers.get("bus:pi-cc:config")?.({});
}

function resolveTool(h, name) {
	const next = () => undefined;
	const resolvers = h.toolRenderers;
	const resolve = (index) => (index < resolvers.length ? resolvers[index](name, () => resolve(index + 1)) : next());
	return resolve(0);
}

function renderEvent(h, expanded = false) {
	const renderer = h.renderers.get("pi-cc-monitor-event");
	const { theme, bgCalls } = makeTheme();
	const message = {
		role: "custom",
		customType: "pi-cc-monitor-event",
		display: true,
		content: "[monitor · errors in deploy.log]\nERROR: connection refused on :3000\nERROR: retry failed",
		details: {
			description: "errors in deploy.log",
			cause: "output",
			eventCount: 2,
			monitorId: "mon1",
		},
		timestamp: Date.now(),
	};
	const lines = renderer(message, { expanded, outputPad: 1 }, theme).render(100);
	return { text: lines.join("\n"), lines, bgCalls };
}

test("the defaults are compact messages and compact tool rows", () => {
	writeConfig({ compactMessages: true, compactToolRows: true });
	const h = makeHarness();
	notifyConfig(h);

	const event = renderEvent(h);
	assert.equal(event.lines.length, 3, event.text);
	assert.equal(event.bgCalls.count, 0);
	assert.ok(resolveTool(h, "Monitor")?.renderCall, "compact Monitor renderer is armed");
});

test("compactMessages off restores the legacy card", () => {
	writeConfig({ compactMessages: false });
	const h = makeHarness();
	notifyConfig(h);

	const event = renderEvent(h);
	assert.ok(event.lines.length > 3, event.text);
	assert.match(event.text, /Ctrl\+O/, event.text);
	assert.ok(event.bgCalls.count > 0);

	writeConfig({ compactMessages: true });
	notifyConfig(h);
	const compact = renderEvent(h);
	assert.equal(compact.lines.length, 3, compact.text);
	assert.equal(compact.bgCalls.count, 0);
});

test("compactToolRows off falls back to the default renderer and on restores it", () => {
	writeConfig({ compactToolRows: false });
	const h = makeHarness();
	notifyConfig(h);
	assert.equal(resolveTool(h, "Monitor"), undefined);

	writeConfig({ compactToolRows: true });
	notifyConfig(h);
	assert.ok(resolveTool(h, "Monitor")?.renderResult);
});

test("the compact Monitor row is one line and collapses the call row after completion", () => {
	writeConfig({ compactToolRows: true });
	const h = makeHarness();
	notifyConfig(h);
	const renderers = resolveTool(h, "Monitor");
	assert.ok(renderers, "compact renderers are armed");

	const { theme } = makeTheme();
	const call = renderers.renderCall(
		{ command: "tail -f deploy.log", description: "errors in deploy.log" },
		theme,
		{ isPartial: false, executionStarted: true },
	);
	assert.deepEqual(call.render(100), [], "the finished call row disappears");

	const result = {
		content: [{ type: "text", text: "Monitor bd9j9ugm armed" }],
		details: {
			taskId: "bd9j9ugm",
			timeoutMs: 3_600_000,
			persistent: false,
			kind: "command",
			outputPath: "/tmp/bd9j9ugm.out",
		},
	};
	const rendered = renderers
		.renderResult(result, { expanded: false, isPartial: false }, theme, {
			isError: false,
			args: { command: "tail -f deploy.log", description: "errors in deploy.log" },
		})
		.render(100)
		.join("\n");
	assert.match(rendered, /^✓ Armed bd9j9ugm · 1h timeout · errors in deploy\.log/);
	assert.equal(rendered.split("\n").length, 1);

	// A short timeout is shown in seconds, not rounded down to "0m".
	const short = renderers
		.renderResult(
			{ ...result, details: { ...result.details, timeoutMs: 5000 } },
			{ expanded: false, isPartial: false },
			theme,
			{ isError: false, args: { command: "sleep 300", description: "timeout test" } },
		)
		.render(100)
		.join("\n");
	assert.match(short, /^✓ Armed bd9j9ugm · 5s timeout · timeout test/);
});

test("session_start syncs the monitor tools into pi-cc-extensions excludeRenderers", async () => {
	writeConfig({ compactToolRows: true });
	const h = makeHarness();
	notifyConfig(h);
	await h.handlers.get("session_start")?.({}, h.ctx);

	let ccstyle = JSON.parse(fs.readFileSync(ccstyleConfig, "utf8"));
	assert.ok(ccstyle.excludeRenderers.includes("Monitor"));
	assert.ok(ccstyle.excludeRenderers.includes("monitor_stop"));
	assert.ok(ccstyle.excludeRenderers.includes("monitor_list"));

	writeConfig({ compactToolRows: false });
	notifyConfig(h);
	await h.handlers.get("session_start")?.({}, h.ctx);
	ccstyle = JSON.parse(fs.readFileSync(ccstyleConfig, "utf8"));
	assert.ok(!ccstyle.excludeRenderers.includes("Monitor"));
	assert.ok(!ccstyle.excludeRenderers.includes("monitor_stop"));
	assert.ok(!ccstyle.excludeRenderers.includes("monitor_list"));
});
