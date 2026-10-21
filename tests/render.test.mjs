/**
 * Rendering tests: the custom message renderer must replace Pi's machine-name
 * title (`[pi-cc-monitor-event]`) with a readable, collapsible card.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule, loadPi } from "./helpers.mjs";

// The expand hint needs Pi's theme; the real TUI always has one.
try {
	const { initTheme } = await loadPi();
	initTheme();
} catch {
	// the renderer falls back to a plain hint
}

const mod = await loadModule("index.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
const fakeTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

function makeHarness() {
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-render-"));
	process.chdir(workdir);

	const renderers = new Map();
	const tools = new Map();

	const pi = {
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		on() {
			return () => {};
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
		events: { emit() {}, on() { return () => {}; } },
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	mod.default(pi);
	return { renderers, tools };
}

function render(renderer, message, expanded) {
	const component = renderer(message, { expanded, outputPad: 1 }, fakeTheme);
	return component.render(100).join("\n");
}

test("the event is drawn as a readable card, not [pi-cc-monitor-event]", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-monitor-event");
	assert.ok(renderer, "a renderer is registered for the event message type");

	const message = {
		role: "custom",
		customType: "pi-cc-monitor-event",
		display: true,
		content: "[monitor · errors in deploy.log]\nERROR: connection refused on :3000",
		details: { description: "errors in deploy.log", cause: "output", eventCount: 1 },
	};

	const collapsed = render(renderer, message, false);
	assert.ok(collapsed.includes("monitor · errors in deploy.log"), collapsed);
	assert.ok(collapsed.includes("ERROR: connection refused on :3000"), collapsed);
	assert.ok(!collapsed.includes("[pi-cc-monitor-event]"), "the machine name is gone");
});

test("a non-output cause is shown in the header", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-monitor-event");
	const message = {
		role: "custom",
		customType: "pi-cc-monitor-event",
		display: true,
		content: "[monitor · errors in deploy.log]\nthe watch ended (exit code 0, 3 events)",
		details: { description: "errors in deploy.log", cause: "exit", eventCount: 3 },
	};
	const collapsed = render(renderer, message, false);
	assert.ok(collapsed.includes("(exit)"), collapsed);
});
