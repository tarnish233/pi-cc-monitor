/**
 * Rendering tests: an event is drawn like a scheduled fire — a timestamped
 * header, identity and body — while tool rows stay native/ccstyle.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

const mod = await loadModule("index.ts");
const { visibleWidth, stripTerminalSequences } = await import(pathToFileURL(findPiInstall().piTui).href);
const { messageBody } = await loadModule("message-render.ts");

/** A theme that keeps the text as-is, so assertions can read it. */
function makeTheme() {
	const bgCalls = { count: 0 };
	const fgCalls = [];
	return {
		bgCalls, fgCalls,
		theme: {
			fg: (color, text) => { fgCalls.push({ color, text }); return text; },
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
	let toolRendererCalls = 0;
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
		registerToolRenderer() { toolRendererCalls += 1; },
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
	return { renderers, tools, busHandlers, toolRendererCalls };
}

function eventMessage(content, details = {}) {
	return {
		role: "custom",
		customType: "Monitor",
		display: true,
		content,
		details: { description: "errors in deploy.log", cause: "output", eventCount: 2, monitorId: "mon1", ...details },
		// Today, so the header shows the clock alone rather than "Oct 22 10:22pm".
		timestamp: new Date().setHours(22, 22, 0, 0),
	};
}

function render(message, expanded = false, width = 120) {
	const { renderers } = makeHarness();
	const { theme, bgCalls, fgCalls } = makeTheme();
	const component = renderers.get("Monitor")(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(width);
	return { text: lines.join("\n"), lines, bgCalls, fgCalls };
}

test("an output event reads like a scheduled fire", () => {
	const { text } = render(
		eventMessage("monitor mon1 \u00b7 errors in deploy.log\nERROR: connection refused on :3000"),
	);
	assert.match(text, /\u273b monitor · 10:22pm · errors in deploy\.log/);
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
		assert.match(text, new RegExp(`\u273b ${label} · 10:22pm`), `${cause}: ${text}`);
	}
});

test("completion metadata does not claim that zero events were delivered", () => {
	const { text } = render(
		eventMessage("monitor mon1 · background test\n[Monitor completed \u2014 exit code 0]", {
			cause: "exit",
			mode: "completion",
			status: "completed",
			eventCount: 0,
			exitCode: 0,
		}),
		true,
	);
	assert.match(text, /\u273b monitor completed/);
	assert.match(text, /exit 0/);
	assert.doesNotMatch(text, /0 events/);
});

test("completion terminal headers distinguish completed, failed and deadline stop", () => {
	const cases = [
		[{ cause: "exit", status: "completed" }, "monitor completed"],
		[{ cause: "exit", status: "failed" }, "monitor failed"],
		[{ cause: "timeout", status: "timed_out" }, "monitor stopped"],
	];
	for (const [details, label] of cases) {
		const { text } = render(
			eventMessage("monitor mon1 · background test\n[terminal notice]", {
				mode: "completion",
				exitCode: 0,
				...details,
			}),
		);
		assert.match(text, new RegExp(`\u273b ${label} · 10:22pm`), `${JSON.stringify(details)}: ${text}`);
	}
	// The events wording is unchanged by a completion happening nearby.
	const { text } = render(
		eventMessage("monitor mon1 · background test\n[terminal notice]", { cause: "exit" }),
	);
	assert.match(text, /\u273b monitor ended · 10:22pm/);
});

test("the body is capped when collapsed and whole when expanded", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = eventMessage(`monitor mon1 \u00b7 errors in deploy.log\n${lines}`);

	const collapsed = render(message).text;
	assert.match(collapsed, /line 2/);
	assert.ok(!collapsed.includes("line 3"), "identity plus two body rows, not three output rows");
	assert.ok(!collapsed.includes("line 8"));
	assert.match(collapsed, /\+6 more lines/);

	const expanded = render(message, true).text;
	assert.match(expanded, /line 8/);
	assert.match(expanded, /id mon1/);
	assert.match(expanded, /2 events/);
});

test("completion paths are detail-view data, not collapsed noise", () => {
	const outputPath = "/tmp/monitor-output/very/long/path.out.log";
	const stderrPath = "/tmp/monitor-output/very/long/path.err.log";
	const message = eventMessage(
		`monitor mon1 · background test\n[Monitor completed — exit code 0. Output: ${outputPath}; stderr: ${stderrPath}]\nstdout tail:\nDONE`,
		{ mode: "completion", cause: "exit", status: "completed", outputPath, stderrPath },
	);
	const collapsed = render(message).text;
	assert.ok(!collapsed.includes(outputPath), "collapsed card omits the log path");
	assert.ok(!collapsed.includes(stderrPath), "collapsed card omits the stderr path");
	assert.match(collapsed, /DONE/);
	const expanded = render(message, true).text;
	assert.ok(expanded.includes(outputPath), "expanded card keeps the log path");
	assert.ok(expanded.includes(stderrPath), "expanded card keeps the stderr path");
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

test("all four roles have a visible identity and subscriptions name their actual source", () => {
  const cases = [
    [{ kind: "command", mode: "completion" }, /task #mon1/],
    [{ kind: "command", mode: "events" }, /watcher #mon1 · stdout/],
    [{ kind: "ws", mode: "events" }, /socket #mon1 · frames/],
    [{ kind: "source", mode: "events", sourceId: "work1234", sourceDescription: "build" }, /subscription #mon1 → build #work1234/],
  ];
  for (const [details, identity] of cases) {
    const { text, bgCalls } = render(eventMessage("monitor mon1 · errors in deploy.log\nERROR: detail", details));
    assert.match(text, identity);
    assert.equal(bgCalls.count, 0, "compact event cards have no success-background shell");
  }
});

test("semantic colors reserve success for actual completion, not observer stop or source exit", () => {
  const cases = [
    [{ kind: "command", mode: "completion", cause: "exit", status: "completed", exitCode: 0 }, "success"],
    [{ kind: "command", mode: "completion", cause: "exit", status: "failed", exitCode: 1 }, "error"],
    [{ kind: "source", sourceId: "work", mode: "events", cause: "stopped", status: "stopped" }, "accent"],
    [{ kind: "source", sourceId: "work", mode: "events", cause: "exit", status: "exited", exitCode: 0 }, "accent"],
    [{ kind: "command", mode: "completion", cause: "stopped", status: "stopped" }, "accent"],
    [{ kind: "ws", mode: "events", cause: "closed", status: "exited" }, "accent"],
    [{ kind: "command", mode: "events", cause: "exit", status: "exited", exitCode: 3 }, "warning"],
    [{ kind: "command", mode: "completion", cause: "timeout", status: "timed_out" }, "warning"],
    [{ kind: "command", mode: "events", cause: "stop_timeout", status: "stop_timeout" }, "warning"],
    [{ kind: "source", sourceId: "work", mode: "events", cause: "flooded", status: "flooded" }, "warning"],
  ];
  for (const [details, color] of cases) {
    const result = render(eventMessage("monitor mon1 · test\n[terminal]", details));
    assert.equal(result.fgCalls.find((call) => call.text.startsWith("✻ monitor")).color, color);
  }
});

test("folded failure cards prioritize real stderr, while expansion preserves both tails and metadata", () => {
  const message = eventMessage("monitor mon1 · test\n[Monitor failed — exit code 1]\nstdout tail:\ninfo 1\ninfo 2\nstderr tail:\nERROR: bad dependency", {
    kind: "command", mode: "completion", cause: "exit", status: "failed", exitCode: 1,
    stdoutTail: "info 1\ninfo 2", stderrTail: "ERROR: bad dependency",
    createdAt: 1000, endedAt: 121000, outputPath: "/tmp/full.out", stderrPath: "/tmp/full.err",
  });
  const before = JSON.stringify(message);
  const collapsed = render(message).text;
  assert.match(collapsed, /task #mon1 · exit 1 · 2m/);
  assert.match(collapsed, /stderr: ERROR: bad dependency/);
  assert.ok(collapsed.indexOf("ERROR") < collapsed.indexOf("info 1"));
  assert.doesNotMatch(collapsed, /\/tmp\/full/);
  const expanded = render(message, true).text;
  assert.match(expanded, /info 1[\s\S]*info 2/);
  assert.match(expanded, /stdout: \/tmp\/full.out/);
  assert.match(expanded, /stderr: \/tmp\/full.err/);
  assert.equal(JSON.stringify(message), before, "rendering cannot rewrite the model message");
});

test("subscription stops and deadlines expose their limited scope in the folded card", () => {
  for (const [cause, notice] of [["stopped", "[Monitor stopped]"], ["timeout", "[Monitor expired after 5m]"], ["flooded", "[Monitor stopped — too much output]"]]) {
    const message = eventMessage("monitor mon1 · test\n" + notice, { kind: "source", mode: "events", sourceId: "work", cause, status: cause === "timeout" ? "timed_out" : "stopped" });
    const { text } = render(message, false, 100);
    assert.match(text, /subscription #mon1 → #work/);
    assert.match(text, /source command was not stopped by this operation/);
  }
});

test("narrow and wide-character cards cap physical rows, strip hostile terminal data and fit width", () => {
  const message = eventMessage("monitor mon1 · test\n\x1b[31m" + "中文 🚀 ".repeat(150) + "\x1b[0m\nsecond\nthird", {
    kind: "command", mode: "events", description: "描述\n\x1b[31m红色\x1b[0m",
  });
  assert.ok(messageBody(message.content, message.details).every((line) => !line.includes("\x1b")), "incoming ANSI is removed before Pi wraps/styles the body");
  for (const width of [120, 40, 16, 5, 1]) {
    const result = render(message, false, width);
    assert.ok(result.lines.length <= 5, "one header, identity, two body rows and one hint");
    assert.ok(result.lines.every((line) => visibleWidth(line) <= width));
    assert.ok(!result.text.includes("\x1b[31m"), "incoming red style must not leak; Pi's own reset sequences are valid");
    assert.ok(!stripTerminalSequences(result.text).includes("\x1b"));
    assert.ok(!result.text.includes("\x00"));
    const expanded = render(message, true, width);
    assert.ok(expanded.lines.every((line) => visibleWidth(line) <= width));
  }
});

test("Monitor tools expose no custom shell or call/result renderer", () => {
  const { tools, toolRendererCalls } = makeHarness();
  assert.equal(toolRendererCalls, 0);
  for (const tool of tools.values()) {
    assert.equal(tool.renderShell, undefined);
    assert.equal(tool.renderCall, undefined);
    assert.equal(tool.renderResult, undefined);
  }
});
