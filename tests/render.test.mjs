/**
 * Rendering tests: the custom message renderer must replace Pi's machine-name
 * title (`[pi-cc-monitor-event]`) with a quiet, readable block.
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
		events: { emit() {}, on() { return () => {}; } },
		getAllTools() {
			return [...tools.keys()].map((name) => ({ name }));
		},
	};

	mod.default(pi);
	return { renderers, tools };
}

function render(renderer, message, expanded) {
	const { theme, bgCalls } = makeTheme();
	const component = renderer(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(100);
	return { text: lines.join("\n"), lines, bgCalls };
}

function eventMessage(content, details = {}) {
	return {
		role: "custom",
		customType: "pi-cc-monitor-event",
		display: true,
		content,
		details: {
			description: "errors in deploy.log",
			cause: "output",
			eventCount: 1,
			monitorId: "mon1",
			...details,
		},
		timestamp: Date.now(),
	};
}

test("the event is a quiet block, not [pi-cc-monitor-event]", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-monitor-event");
	assert.ok(renderer, "a renderer is registered for the event message type");

	const message = eventMessage(
		"[monitor · errors in deploy.log]\nERROR: connection refused on :3000",
	);

	const { text, lines, bgCalls } = render(renderer, message, false);
	assert.equal(lines.length, 2, text);
	assert.ok(lines[0].includes("monitor"), text);
	assert.ok(lines[0].includes("errors in deploy.log"), text);
	assert.match(lines[0], /\d{1,2}:\d{2}/, "the header carries a timestamp");
	assert.equal(lines[1].trim(), "ERROR: connection refused on :3000");
	assert.ok(!text.includes("[pi-cc-monitor-event]"), "the machine name is gone");
	assert.ok(!text.includes("⟳"), "no arrow glyph");
	assert.equal(bgCalls.count, 0, "no background is painted");
});

test("a non-output cause is shown in the header", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-monitor-event");
	const message = eventMessage(
		"[monitor · errors in deploy.log]\n[Monitor ended — exit code 0, 3 events delivered]",
		{ cause: "exit", exitCode: 0, eventCount: 3 },
	);

	const { text } = render(renderer, message, false);
	assert.ok(text.includes("exited (code 0)"), text);
	assert.ok(text.includes("Monitor ended"), text);
});

test("long batches are capped when collapsed and complete when expanded", () => {
	const h = makeHarness();
	const renderer = h.renderers.get("pi-cc-monitor-event");
	const lines = ["one", "two", "three", "four", "five"];
	const message = eventMessage(`[monitor · batch]\n${lines.join("\n")}`, {
		description: "batch",
		eventCount: 5,
	});

	const collapsed = render(renderer, message, false);
	assert.ok(collapsed.text.includes("one"), collapsed.text);
	assert.ok(collapsed.text.includes("three"), collapsed.text);
	assert.ok(collapsed.text.includes("+2 more lines"), collapsed.text);
	assert.ok(!collapsed.text.includes("four"), collapsed.text);

	const expanded = render(renderer, message, true);
	assert.ok(expanded.text.includes("four"), expanded.text);
	assert.ok(expanded.text.includes("five"), expanded.text);
	assert.ok(expanded.text.includes("id mon1"), expanded.text);
	assert.ok(expanded.text.includes("5 events"), expanded.text);
	assert.ok(!expanded.text.includes("more lines"), expanded.text);
});
