/**
 * Settings tests: pi-cc-monitor follows the shared config file written by
 * pi-cc-loop. Only the footer matters here now: monitor events use Pi's own
 * rendering, so there is no style of ours to switch.
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




