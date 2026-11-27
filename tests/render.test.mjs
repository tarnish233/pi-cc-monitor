/**
 * Rendering tests: an asynchronous fact draws one collapsed line, and an
 * expanded section tree with the tool-card background. Tool rows stay
 * native/ccstyle.
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
const { setNotificationTui, releaseNotificationHover } = await loadModule("render.ts");

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

/** Regular screen: no mouse, so the hint is the host's expand keybinding. */
function render(message, expanded = false, width = 120) {
	setNotificationTui({ mode: "regular" });
	const { renderers } = makeHarness();
	const { theme, bgCalls, fgCalls } = makeTheme();
	const component = renderers.get("Monitor")(message, { expanded, outputPad: 1 }, theme);
	const lines = component.render(width);
	return { text: lines.join("\n"), lines, bgCalls, fgCalls, component };
}

test("an output event reads like a scheduled fire", () => {
	const message = eventMessage("monitor mon1 \u00b7 errors in deploy.log\nERROR: connection refused on :3000");
	const { text, lines } = render(message);
	assert.equal(lines.length, 1, "one line, always");
	assert.match(text, /\u273b Monitor mon1 \u00b7 errors in deploy\.log \u00b7 10:22pm \u00b7 2 events/);
	assert.ok(!text.includes("ERROR: connection refused"), "the output is behind the expansion");
	assert.ok(!text.includes("monitor mon1 \u00b7"), "the id line is for the model only");
	assert.ok(!text.includes("[Monitor]"), "no machine label");
	assert.match(render(message, true).text, /ERROR: connection refused on :3000/);
});

test("every cause has its own wording", () => {
	// A warning cause is a warning icon, not the neutral event mark.
	const cases = [
		["exit", "\u25a0 Monitor Ended"],
		["timeout", "\u26a0 Monitor Expired"],
		["error", "\u2717 Monitor Failed"],
		["closed", "\u25a0 Monitor Closed"],
		["stopped", "\u25a0 Monitor Stopped"],
		["flooded", "\u26a0 Monitor Stopped"],
	];
	for (const [cause, label] of cases) {
		const { text } = render(eventMessage(`monitor mon1 \u00b7 errors in deploy.log\n[${cause}]`, { cause }));
		assert.match(text, new RegExp(`${label} mon1`), `${cause}: ${text}`);
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
	assert.match(text, /\u2713 Monitor Completed/);
	assert.match(text, /exit 0/);
	assert.doesNotMatch(text, /0 events/);
});

test("completion terminal headers distinguish completed, failed and deadline stop", () => {
	const cases = [
		[{ cause: "exit", status: "completed" }, "Monitor Completed"],
		[{ cause: "exit", status: "failed" }, "Monitor Failed"],
		[{ cause: "timeout", status: "timed_out" }, "Monitor Stopped"],
	];
	for (const [details, label] of cases) {
		const { text } = render(
			eventMessage("monitor mon1 · background test\n[terminal notice]", {
				mode: "completion",
				exitCode: 0,
				...details,
			}),
		);
		assert.match(text, new RegExp(`${label} mon1`), `${JSON.stringify(details)}: ${text}`);
	}
	// The events wording is unchanged by a completion happening nearby.
	const { text } = render(
		eventMessage("monitor mon1 · background test\n[terminal notice]", { cause: "exit" }),
	);
	assert.match(text, /\u25a0 Monitor Ended mon1/);
});

test("protocol notices are Status, not Output", () => {
	const source = render(eventMessage("monitor mon1 \u00b7 build errors\n[Monitor stopped]", {
		kind: "source", mode: "events", sourceId: "tx12345", sourceDescription: "build", cause: "stopped", status: "stopped",
	}), true);
	const status = source.text.slice(source.text.indexOf("Status"), source.text.indexOf("Source"));
	assert.match(status, /subscription #mon1 → build #tx12345/);
	assert.match(status, /source command was not stopped by this operation/);
	assert.ok(!source.text.includes("Output"), "a stop with no captured output has no Output section");

	// Real output still lives under Output, and a notice never shares that heading.
	const mixed = render(eventMessage("monitor mon1 \u00b7 test\n[Monitor stopped]\nreal line 1", {
		kind: "command", mode: "events", cause: "stopped", status: "stopped",
	}), true);
	const output = mixed.text.slice(mixed.text.indexOf("Output"));
	assert.match(output, /real line 1/);
	assert.ok(!output.includes("[Monitor stopped]"), output);
});

test("the legacy padded card lists the identity once", () => {
	const { renderers, busHandlers } = makeHarness();
	fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: false }), "utf8");
	busHandlers.get("pi-cc-monitor:config")?.({}, {});
	try {
		const { theme } = makeTheme();
		const message = eventMessage("monitor mon1 \u00b7 build\nstdout tail:\nok", {
			mode: "completion", cause: "exit", status: "completed", exitCode: 0, command: "npm run build",
		});
		const body = renderers.get("Monitor")(message, { expanded: true, outputPad: 1 }, theme).render(120).join("\n");
		assert.equal(body.split("task #mon1").length - 1, 1, body);
	} finally {
		fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: true }), "utf8");
		busHandlers.get("pi-cc-monitor:config")?.({}, {});
	}
});

test("every card collapses to a single line, and the expansion holds the output", () => {
	const body = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const cases = [
		["event batch", eventMessage(`monitor mon1 \u00b7 errors in deploy.log\n${body}`)],
		["completion", eventMessage(`monitor mon1 \u00b7 deploy\n${body}`, { mode: "completion", cause: "exit", status: "completed", exitCode: 0 })],
		["stop", eventMessage(`monitor mon1 \u00b7 run.sh\n${body}`, { cause: "stopped", status: "stopped" })],
	];
	for (const [label, message] of cases) {
		const collapsed = render(message);
		assert.equal(collapsed.lines.length, 1, `${label}: ${collapsed.text}`);
		assert.ok(!collapsed.text.includes("line 1"), `${label} shows no body while collapsed`);
		const expanded = render(message, true).text;
		assert.match(expanded, /line 8/, label);
		assert.match(expanded, /Output/, label);
	}
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
	const expanded = render(message, true).text;
	assert.ok(expanded.includes(outputPath), "expanded card keeps the log path");
	assert.ok(expanded.includes(stderrPath), "expanded card keeps the stderr path");
	assert.match(expanded, /DONE/);
});

test("compactMessages off draws the padded card instead", () => {
	const { renderers, busHandlers } = makeHarness();
	fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify({ compactMessages: false }), "utf8");
	busHandlers.get("pi-cc-monitor:config")?.({}, {});
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
	busHandlers.get("pi-cc-monitor:config")?.({}, {});
});

test("all four roles name what was watched, in the expanded Status section", () => {
	const cases = [
		[{ kind: "command", mode: "completion" }, /task #mon1/],
		[{ kind: "command", mode: "events" }, /watcher #mon1 · stdout/],
		[{ kind: "ws", mode: "events" }, /socket #mon1 · frames/],
		[{ kind: "source", mode: "events", sourceId: "work1234", sourceDescription: "build" }, /subscription #mon1 → build #work1234/],
	];
	for (const [details, identity] of cases) {
		const collapsed = render(eventMessage("monitor mon1 · errors in deploy.log\nERROR: detail", details));
		assert.match(collapsed.text, /\u273b Monitor mon1/);
		assert.equal(collapsed.bgCalls.count, 0, "a collapsed event card has no success-background shell");
		const expanded = render(eventMessage("monitor mon1 · errors in deploy.log\nERROR: detail", details), true);
		assert.match(expanded.text, identity);
	}
});

test("semantic colors reserve success for actual completion, not observer stop or source exit", () => {
	const cases = [
		[{ kind: "command", mode: "completion", cause: "exit", status: "completed", exitCode: 0 }, "\u2713", "success"],
		[{ kind: "command", mode: "completion", cause: "exit", status: "failed", exitCode: 1 }, "\u2717", "error"],
		// A neutral outcome is a quiet blue square, never success green.
		[{ kind: "source", sourceId: "work", mode: "events", cause: "stopped", status: "stopped" }, "\u25a0", "syntaxFunction"],
		[{ kind: "source", sourceId: "work", mode: "events", cause: "exit", status: "exited", exitCode: 0 }, "\u2713", "success"],
		[{ kind: "command", mode: "completion", cause: "stopped", status: "stopped" }, "\u25a0", "syntaxFunction"],
		[{ kind: "ws", mode: "events", cause: "closed", status: "exited" }, "\u25a0", "syntaxFunction"],
		[{ kind: "command", mode: "events", cause: "exit", status: "exited", exitCode: 3 }, "\u26a0", "warning"],
		[{ kind: "command", mode: "completion", cause: "timeout", status: "timed_out" }, "\u26a0", "warning"],
		[{ kind: "command", mode: "events", cause: "stop_timeout", status: "stop_timeout" }, "\u2717", "error"],
		[{ kind: "source", sourceId: "work", mode: "events", cause: "flooded", status: "flooded" }, "\u26a0", "warning"],
	];
	for (const [details, icon, color] of cases) {
		const result = render(eventMessage("monitor mon1 · test\n[terminal]", details), true);
		assert.equal(result.fgCalls.find((call) => call.text === icon)?.color, color, JSON.stringify(details));
		assert.ok(result.bgCalls.count > 0, "the expanded card carries the tool-card background");
	}
});

test("a failed completion leads with exit code, and stderr before stdout once expanded", () => {
	const message = eventMessage("monitor mon1 · test\n[Monitor failed — exit code 1]\nstdout tail:\ninfo 1\ninfo 2\nstderr tail:\nERROR: bad dependency", {
		kind: "command", mode: "completion", cause: "exit", status: "failed", exitCode: 1,
		stdoutTail: "info 1\ninfo 2", stderrTail: "ERROR: bad dependency",
		createdAt: 1000, endedAt: 121000, outputPath: "/tmp/full.out", stderrPath: "/tmp/full.err",
	});
	const before = JSON.stringify(message);
	const collapsed = render(message).text;
	assert.match(collapsed, /exit 1 · 2m/);
	assert.doesNotMatch(collapsed, /\/tmp\/full/);
	const expanded = render(message, true).text;
	assert.match(expanded, /task #mon1 · exit 1 · 2m/);
	assert.ok(expanded.indexOf("ERROR") < expanded.indexOf("info 1"), "stderr leads the expanded output");
	assert.match(expanded, /stdout: \/tmp\/full.out/);
	assert.match(expanded, /stderr: \/tmp\/full.err/);
	assert.equal(JSON.stringify(message), before, "rendering cannot rewrite the model message");
});

test("subscription stops and deadlines expose their limited scope", () => {
	for (const [cause, notice] of [["stopped", "[Monitor stopped]"], ["timeout", "[Monitor expired after 5m]"], ["flooded", "[Monitor stopped — too much output]"]]) {
		const message = eventMessage("monitor mon1 · test\n" + notice, { kind: "source", mode: "events", sourceId: "work", cause, status: cause === "timeout" ? "timed_out" : "stopped" });
		const expanded = render(message, true, 100).text;
		assert.match(expanded, /subscription #mon1 → #work/);
		assert.match(expanded, /source command was not stopped by this operation/);
	}
});

test("narrow and wide-character cards cap physical rows, strip hostile terminal data and fit width", () => {
	const message = eventMessage("monitor mon1 · test\n\x1b[31m" + "中文 🚀 ".repeat(150) + "\x1b[0m\nsecond\nthird", {
		kind: "command", mode: "events", description: "描述\n\x1b[31m红色\x1b[0m",
	});
	assert.ok(messageBody(message.content, message.details).every((line) => !line.includes("\x1b")), "incoming ANSI is removed before Pi wraps/styles the body");
	for (const width of [120, 40, 16, 5, 1]) {
		const result = render(message, false, width);
		assert.equal(result.lines.length, 1, "exactly one collapsed row");
		assert.ok(result.lines.every((line) => visibleWidth(line) <= width));
		assert.ok(!result.text.includes("\x1b[31m"), "incoming red style must not leak; Pi's own reset sequences are valid");
		assert.ok(!stripTerminalSequences(result.text).includes("\x1b"));
		assert.ok(!result.text.includes("\x00"));
		const expanded = render(message, true, width);
		assert.ok(expanded.lines.every((line) => visibleWidth(line) <= width));
	}
});

test("a live batch is a spark, a neutral outcome is a square", () => {
	const cases = [
		[{ cause: "output" }, "\u273b", "in-progress batch"],
		[{ cause: "stopped", status: "stopped" }, "\u25a0", "manual stop"],
		[{ cause: "exit", status: "completed", mode: "completion", exitCode: 0 }, "\u2713", "completed"],
		[{ cause: "exit", status: "failed", mode: "completion", exitCode: 1 }, "\u2717", "failed"],
		[{ cause: "flooded", status: "flooded" }, "\u26a0", "flooded"],
		[{ cause: "stop_timeout", status: "stop_timeout" }, "\u2717", "an unconfirmed stop is a failure"],
	];
	for (const [details, icon, label] of cases) {
		const { text } = render(eventMessage("monitor mon1 \u00b7 test\nline", details));
		assert.ok(text.includes(`${icon} `), `${label} starts with ${icon}: ${text}`);
	}
});

test("a long multi-byte description rides in the one collapsed row", () => {
	const description = "验证单一接口的动态标题、等待、历史恢复及两个 Pi 版本";
	const message = eventMessage("monitor mon1 \u00b7 x\nstdout tail:\nok", {
		kind: "command",
		mode: "completion",
		cause: "exit",
		status: "completed",
		exitCode: 0,
		description,
	});
	const wide = render(message, false, 140);
	assert.equal(wide.lines.length, 1, "one row");
	assert.ok(wide.text.includes(description), `the whole description fits a wide row: ${wide.text}`);
	for (const width of [120, 100, 80, 60]) {
		const { text, lines } = render(message, false, width);
		assert.equal(lines.length, 1, `${width}: one row`);
		assert.ok(text.includes(description.slice(0, 4)), `${width}: the description is shown (${text})`);
	}
});

test("an external job's result is titled as the Monitor observation, not as the job", () => {
	const job = state => ({
		jobId: "train-01", runId: "attempt-1", runner: { name: "tmux", id: "train-01" },
		manifestPath: "/runs/train-01/job.json", statusPath: "/runs/train-01/status.json", createdAt: 0, state,
		...(state === "succeeded" ? { endedAt: 200000, exitCode: 0 } : { endedAt: 200000, exitCode: state === "cancelled" ? 0 : 7 }),
	});
	const cases = [
		[{ state: "succeeded", icon: "\u2713", label: "Monitor Completed", stat: "job succeeded \u00b7 exit 0" }],
		[{ state: "failed", icon: "\u2717", label: "Monitor Failed", stat: "job failed \u00b7 exit 7" }],
		[{ state: "cancelled", icon: "\u26a0", label: "Monitor Cancelled", stat: "job cancelled \u00b7 exit 0" }],
	];
	for (const [{ state, icon, label, stat }] of cases) {
		const { text } = render(eventMessage("monitor mon1 \u00b7 training result\n[external job report]", {
			kind: "job", mode: "completion", cause: "job", status: "completed", job: job(state), createdAt: 0, endedAt: 200000,
		}));
		assert.match(text, new RegExp(`^ ${icon} ${label} mon1`), `${state}: ${text}`);
		assert.doesNotMatch(text, /Job (Succeeded|Failed|Cancelled)/, `${state}: no job-as-monitor title`);
		assert.ok(text.includes(stat), `${state}: the external job result stays data (${text})`);
		// The narrow one-row card clips the duration, so only its start must remain.
		assert.match(text, /observed 3m/);
	}
});

test("a source gap is a live diagnostic, never a finished card", () => {
	const { text } = render(eventMessage("monitor mon1 \u00b7 gap demo\n[Observation has source gaps]", {
		kind: "file", mode: "events", cause: "source_gap", status: "running", createdAt: 0, endedAt: 60000,
		notifyLevel: "context", sourceGap: true, outputPath: "/tmp/gap.log", stderrPath: "/tmp/gap.err",
	}), true);
	assert.match(text.trimStart(), /^\u26a0 Observation Gap mon1/);
	assert.doesNotMatch(text, /observed 1m/, "the observation is still running, so it has no elapsed total");
	assert.doesNotMatch(text, /cleanup pending at report/);
});

test("an exit code is the verdict, whichever mode reported it", () => {
	// The same exit 0 must not be a green check in one mode and a square in another.
	const exit = (mode, exitCode, extra = {}) =>
		render(eventMessage("monitor mon1 \u00b7 build\nline", {
			kind: "command", mode, cause: "exit", exitCode, ...extra,
		})).text;
	assert.match(exit("completion", 0, { status: "completed" }), /^ \u2713 Monitor Completed/);
	assert.match(exit("events", 0, { status: "exited" }), /^ \u2713 Monitor Ended/);
	assert.match(exit("events", 3, { status: "exited" }), /^ \u26a0 Monitor Ended/);
	assert.match(exit("completion", 1, { status: "failed" }), /^ \u2717 Monitor Failed/);
	// No exit code at all (a signal, or a stop): no verdict, so no check mark.
	assert.match(exit("events", null, { status: "exited" }), /^ \u25a0 Monitor Ended/);
	assert.match(render(eventMessage("monitor mon1 \u00b7 build\nline", { cause: "stopped", status: "stopped" })).text, /^ \u25a0 Monitor Stopped/);
	assert.match(render(eventMessage("monitor mon1 \u00b7 build\nline", { kind: "ws", mode: "events", cause: "closed" })).text, /^ \u25a0 Monitor Closed/);
});

test("an expanded card never outgrows the fullscreen viewport", () => {
	const { renderers } = makeHarness();
	const { theme } = makeTheme();
	const tui = { mode: "fullscreen", terminal: { rows: 20 }, handleViewportInput() {}, requestRender() {} };
	setNotificationTui(tui);
	const body = Array.from({ length: 140 }, (_, i) => `line ${i + 1}`).join("\n");
	const message = eventMessage("monitor mon1 \u00b7 big\n" + body, {
		mode: "completion", cause: "exit", status: "completed", exitCode: 0,
		stdoutTail: body, outputPath: "/tmp/big.log",
	});
	const lines = renderers.get("Monitor")(message, { expanded: true, outputPad: 1 }, theme).render(80);
	// 60% of 20 rows, plus the box's padding rows.
	assert.ok(lines.length <= 12 + 2, `${lines.length} rows`);
	const text = lines.join("\n");
	assert.match(text, /\+\d+ more rows/);
	assert.match(text, /see \/tasks/);
	releaseNotificationHover();
	setNotificationTui({ mode: "regular" });
});

test("the regular screen offers the expand keybinding, never a click", () => {
	const { text } = render(eventMessage("monitor mon1 \u00b7 deploy\nERROR: boom"));
	assert.match(text, /ctrl\+o to show more/);
	assert.ok(!text.includes("click to show more"), "the regular screen delivers no mouse events");
});

test("fullscreen says click to show more, and a click toggles the same card", () => {
	const { renderers } = makeHarness();
	const { theme } = makeTheme();
	setNotificationTui({ mode: "fullscreen" });
	const message = eventMessage("monitor mon1 \u00b7 deploy\nERROR: boom");
	const component = renderers.get("Monitor")(message, { expanded: false, outputPad: 1 }, theme);
	const collapsed = component.render(120);
	assert.match(collapsed.join("\n"), /click to show more/);

	// The host renders on a handled click, so the component must report one.
	// A move never lights the hint: nothing reports that the pointer left again.
	const at = (type) => ({ type, button: "left", x: 1, y: 0, screenX: 1, screenY: 0, width: 120, height: collapsed.length, shift: false, alt: false, ctrl: false });
	assert.equal(component.handleMouse(at("move")), undefined, "a move off the hint changes nothing");
	assert.equal(component.render(120).join("\n"), collapsed.join("\n"));

	const result = component.handleMouse(at("click"));
	assert.equal(result?.handled, true);
	assert.equal(result?.render, true);
	const expanded = component.render(120);
	assert.match(expanded.join("\n"), /\u251c Description/);
	assert.ok(expanded.length > collapsed.length);

	component.handleMouse(at("click"));
	assert.equal(component.render(120).length, collapsed.length, "a second click collapses it");
	setNotificationTui({ mode: "regular" });
});

test("a click survives the host rebuilding the card, and Ctrl+O still wins", () => {
	const { renderers } = makeHarness();
	const { theme } = makeTheme();
	setNotificationTui({ mode: "fullscreen" });
	const message = eventMessage("monitor mon1 \u00b7 deploy\nERROR: boom");
	const build = (expanded) => renderers.get("Monitor")(message, { expanded, outputPad: 1 }, theme);

	const first = build(false);
	first.handleMouse({ type: "click", button: "left", x: 1, y: 0, screenX: 1, screenY: 0, width: 120, height: 1, shift: false, alt: false, ctrl: false });

	// CustomMessageComponent.rebuild() re-runs the renderer at the same base.
	const rebuilt = build(false);
	assert.match(rebuilt.render(120).join("\n"), /\u251c Description/, "the click is remembered per message");
	// The host's own expand changes the base, so the local click no longer applies.
	assert.match(build(true).render(120).join("\n"), /\u251c Description/);
	setNotificationTui({ mode: "regular" });
});

test("a section is omitted when the payload has nothing for it", () => {
	const { text } = render(eventMessage("monitor mon1 \u00b7 deploy\nERROR: boom"), true);
	assert.match(text, /Description/);
	assert.match(text, /Status/);
	assert.ok(!text.includes("Logs"), "no log paths in this payload");
	assert.ok(!text.includes("Command"), "no command in this payload");
	assert.ok(!text.includes("Limits"), "no deadline in this payload");
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

for (const kind of ["file", "job"]) test(kind + " cards preserve different hosts for the same remote path", () => {
	const cards = ["gpu-a", "gpu-b"].map(host => {
		const source = kind === "file" ? { kind, host, stdout: "/work/run/stdout.log" } : { kind, host, manifest: "/work/run/job.json" };
		const job = { jobId: "run", runId: "attempt", host, runner: { name: "tmux", id: "run" }, manifestPath: "/work/run/job.json", statusPath: "/work/run/status.json", state: "succeeded", exitCode: 0, createdAt: 0 };
		const details = { kind, source, mode: kind === "job" ? "completion" : "events", cause: kind === "job" ? "job" : "output", ...(kind === "job" ? { job, stdoutTail: "RESULT", stderrTail: "" } : {}) };
		const card = render(eventMessage("monitor mon1 · remote result\n[terminal]\nStatus: " + host + ":/work/run/status.json", details), true);
		assert.ok(card.text.includes(host), card.text);
		assert.match(card.text, /Source/);
		assert.ok(card.text.includes(kind === "job" ? "/work/run/job.json" : "/work/run/stdout.log"), card.text);
		return card.text;
	});
	assert.notEqual(cards[0], cards[1]);
});

test("bracketed user output stays in Output and DCS/APC control payloads are stripped", () => {
	const structured = render(eventMessage("monitor mon1 · json feed\n[1, 2, 3]\n[PASS]\n\x1bPhidden-dcs\x1b\\[{\"ok\":true}]", {
		kind: "ws",
		mode: "events",
		cause: "output",
		notices: [],
		outputLines: ["[1, 2, 3]", "[PASS]", "\x1bPhidden-dcs\x1b\\[{\"ok\":true}]"],
	}), true);
	const status = structured.text.slice(structured.text.indexOf("Status"), structured.text.indexOf("Events"));
	const output = structured.text.slice(structured.text.indexOf("Output"));
	assert.doesNotMatch(status, /\[1, 2, 3\]|\[PASS\]/);
	assert.match(output, /\[1, 2, 3\]/);
	assert.match(output, /\[PASS\]/);
	assert.match(output, /\[\{"ok":true\}\]/);
	assert.doesNotMatch(structured.text, /hidden-dcs/);

	const legacy = render(eventMessage("monitor mon1 · legacy json\n[1, 2, 3]\n[PASS]", {
		kind: "file",
		mode: "events",
		cause: "output",
	}), true);
	assert.match(legacy.text.slice(legacy.text.indexOf("Output")), /\[1, 2, 3\]/);
});

test("job terminal notices in events mode stay in Status rather than Output", () => {
	const card = render(eventMessage("monitor mon1 · job watch\n[External job j1 / r1: succeeded, exit code 0.]\nThis is a validated status-file report, not an independent OS audit.\nStatus: /runs/j1/status.json", {
		kind: "job",
		mode: "events",
		cause: "job",
		status: "completed",
		notices: [
			"[External job j1 / r1: succeeded, exit code 0.]",
			"This is a validated status-file report, not an independent OS audit.",
			"Status: /runs/j1/status.json",
		],
		outputLines: [],
	}), true);
	assert.match(card.text, /validated status-file report/);
	assert.equal(card.text.includes("Output"), false, "status-file prose must not appear as job Output");
});