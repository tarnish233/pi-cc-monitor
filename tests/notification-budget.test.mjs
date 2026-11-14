import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { default: factory } = await loadModule("index.ts");
const { MAX_BATCH_CHARS, MAX_LINE_CHARS, RateLimiter, TRUNCATED } = await loadModule("stream.ts");

function harness(t) {
	const tools = new Map(), handlers = new Map(), bus = new Map();
	const sent = [];
	const add = (map, key, fn) => {
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(fn);
		return () => map.set(key, map.get(key).filter(value => value !== fn));
	};
	const pi = {
		registerTool: value => tools.set(value.name, value),
		registerCommand: () => {}, registerMessageRenderer: () => {}, registerToolRenderer: () => {},
		getSettings: () => ({ shellPath: process.platform === "win32" ? undefined : "/bin/bash" }),
		getAllTools: () => [...tools.keys()].map(name => ({ name })),
		on: (key, fn) => add(handlers, key, fn),
		events: { on: (key, fn) => add(bus, key, fn), emit: (key, value) => { for (const fn of bus.get(key) ?? []) fn(value); } },
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "notification-budget-")),
		hasUI: false, mode: "print", ui: {}, isIdle: () => true,
		sessionManager: { getEntries: () => [] },
	};
	factory(pi);
	t.after(async () => { for (const fn of handlers.get("session_shutdown") ?? []) await fn({ reason: "quit" }, ctx); });
	return { tools, sent, ctx };
}

const raw = Array.from({ length: 8 }, (_, i) => `LINE_${i} ` + "X".repeat(800) + (i === 7 ? "RAW_FINAL_MARKER" : "")).join("\n") + "\n";
// Hold this fixture past the batch window: these assertions exercise streaming envelopes.
// A separate output-policy test exercises the merged terminal envelope.
const command = "node -e 'process.stdout.write(" + JSON.stringify(raw) + ")'; sleep 0.3";

async function run(h, params) {
	const receipt = await h.tools.get("Monitor").execute("run", { command, description: "budget", ...params }, undefined, undefined, h.ctx);
	const end = Date.now() + 5000;
	while (Date.now() < end) {
		if (h.sent.some(value => value.message.details.cause === "exit")) return receipt;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error("the fixture did not complete");
}

function fakeSuppression(t, count) {
	const original = RateLimiter.prototype.take;
	RateLimiter.prototype.take = () => ({ deliver: true, suppressed: count });
	t.after(() => { RateLimiter.prototype.take = original; });
}

function assertEnvelope(message) {
	const [header, ...body] = message.content.split("\n");
	assert.ok(message.content.length <= MAX_BATCH_CHARS, `whole content ${message.content.length} > ${MAX_BATCH_CHARS}`);
	assert.ok(header.length <= MAX_LINE_CHARS);
	if (message.details.cause === "output") assert.deepEqual(message.details.lines, body, "structured metadata and visible body are identical");
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(message.content), "clipping must not split Unicode pairs");
}

for (const suppressed of [0, 1, 42, 1234567]) {
	test(`the final events budget includes header and ${suppressed} suppressed events`, async t => {
		const h = harness(t);
		fakeSuppression(t, suppressed);
		const receipt = await run(h, { mode: "events" });
		const output = h.sent.filter(value => value.message.details.cause === "output");
		assert.equal(output.length, 1);
		for (const { message } of h.sent) assertEnvelope(message);
		const message = output[0].message;
		assert.equal(message.details.eventCount, 8, "display clipping does not change event accounting");
		assert.equal(message.details.lines.at(-1), TRUNCATED);
		assert.equal(message.details.lines.filter(line => line === TRUNCATED).length, 1, "one final clipping marker");
		if (suppressed) assert.match(message.details.lines[0], /suppressed/, "the suppression notice is not discarded");
		assert.equal(fs.readFileSync(receipt.details.outputPath, "utf8"), raw, "the full raw log is untouched");
	});
}

test("a huge Unicode/control-bearing description cannot exhaust the events envelope", async t => {
	const h = harness(t);
	fakeSuppression(t, 42);
	const description = "😀".repeat(5000) + "\n\x1b[31mEND";
	const receipt = await run(h, { mode: "events", description });
	for (const { message } of h.sent) {
		assertEnvelope(message);
		assert.equal(message.details.description, description, "original description metadata is preserved");
		assert.ok(!message.content.includes("\x1b"));
	}
	assert.equal(fs.readFileSync(receipt.details.outputPath, "utf8"), raw);
});

test("completion keeps its separate log-tail budget and quiet delivery", async t => {
	const h = harness(t);
	const description = "quiet\n\x1b[31mred";
	const receipt = await run(h, { mode: "completion", description });
	assert.equal(h.sent.length, 1);
	const message = h.sent[0].message;
	assert.equal(message.details.status, "completed");
	assert.equal(message.details.description, description, "metadata keeps the raw description");
	assert.equal(message.content.split("\n")[0], `monitor ${message.details.monitorId} · quiet red`);
	assert.ok(!message.content.includes("\x1b"));
	assert.equal(message.details.eventCount, 0);
	assert.deepEqual(message.details.lines, []);
	assert.ok(message.content.length > MAX_BATCH_CHARS, "events' 3000-char cap must not truncate completion tails");
	assert.ok(message.details.stdoutTail.includes("RAW_FINAL_MARKER"));
	assert.equal(fs.readFileSync(receipt.details.outputPath, "utf8"), raw);
});
