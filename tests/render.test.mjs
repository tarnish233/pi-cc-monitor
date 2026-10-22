/**
 * Rendering tests: an event is drawn like a scheduled fire - a header that says
 * what happened and when, then the lines - not like a machine label.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
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
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-render-"));
	process.chdir(workdir);

	const renderers = new Map();
	const tools = new Map();
	/** pi.events handlers, so a test can tell the extension to reread the config. */
	const busHandlers = new Map();

	const pi = {
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerToolRenderer() {},
		on() {
			return () => {};
		},
		appendEntry() {},
		sendUserMessage() {},
		sendMessage() {},
		events: {
			emit() {},
			on(channel, handler) {
				busHandlers.set(channel, handler);
				return () => busHandlers.delete(channel);
			},
		},
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	mod.default(pi);
	return { renderers, tools, busHandlers };
}

function eventMessage(content, details = {}) {
	return {
		role: "custom",
		customType: "Monitor",
		display: true,
		content,
		details: { description: "errors in deploy.log", cause: "output", eventCount: 2, monitorId: "mon1", ...details },
		timestamp: new Date(2026, 9, 22, 22, 22).getTime(),
	};
}

function render(message, expanded = false) {
	const { renderers } = makeHarness();
	const { theme, bgCalls } = makeTheme();
	const component = renderers.get("Monitor")(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(120);
	return { text: lines.join("\n"), lines, bgCalls };
}

test("an output event reads like a scheduled fire", () => {
	const { text } = render(
		eventMessage("monitor mon1 \u00b7 errors in deploy.log\nERROR: connection refused on :3000"),
	);
	assert.match(text, /\u273b monitor \u00b7 10:22pm \u00b7 errors in deploy\.log/);
	assert.match(text, /ERROR: connection refused on :3000/);
	assert.ok(!text.includes("monitor mon1 \u00b7"), "the id line is for the model only");
	assert.ok(!text.includes("[Monitor]"), "no machine label");
});

test("every cause has its own wording", () => {
	const cases = [
		["exit", "monitor ended"],
		["timeout", "monitor expired"],
		["error", "monitor failed"],
		["closed", "monitor closed"],
		["stopped", "monitor stopped"],
		["flooded", "monitor stopped"],
	];
	for (const [cause, label] of cases) {
		const { text } = render(eventMessage(`monitor mon1 \u00b7 errors in deploy.log\n[${cause}]`, { cause }));
		assert.match(text, new RegExp(`\u273b ${label} \u00b7 10:22pm`), `${cause}: ${text}`);
	}
});

test("the body is capped when collapsed and whole when expanded", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = eventMessage(`monitor mon1 \u00b7 errors in deploy.log\n${lines}`);

	const collapsed = render(message).text;
	assert.match(collapsed, /line 3/);
	assert.ok(!collapsed.includes("line 8"), "collapsed stops after three lines");
	assert.match(collapsed, /\+5 more lines/);

	const expanded = render(message, true).text;
	assert.match(expanded, /line 8/);
	assert.match(expanded, /id mon1/);
	assert.match(expanded, /2 events/);
});

test("compactMessages off draws the padded card instead", () => {
	const { renderers, busHandlers } = makeHarness();
	fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: false }), "utf8");
	busHandlers.get("pi-cc:config")?.({}, {});
	const { theme, bgCalls } = makeTheme();
	const message = eventMessage("monitor mon1 \u00b7 errors in deploy.log\nERROR: boom");
	const text = renderers
		.get("Monitor")(message, { expanded: false, outputPad: 1 }, theme)
		.render(120)
		.join("\n");
	assert.ok(bgCalls.count > 0, "the card has a background");
	assert.match(text, /errors in deploy\.log/);
	assert.match(text, /Ctrl\+O/, "the expand hint");
	fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: true }), "utf8");
	busHandlers.get("pi-cc:config")?.({}, {});
});
