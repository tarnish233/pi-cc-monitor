import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { capEventLines, LineBatcher, MAX_LINE_CHARS, MAX_BATCH_CHARS, MAX_PARTIAL_LINE_CHARS, TRUNCATED } = await loadModule("stream.ts");

test("composed-line clipping is pure and idempotent, preserving a leading notice", () => {
	const notice = "[42 events suppressed]";
	const lines = [notice, ...Array.from({ length: 12 }, () => "😀".repeat(250))];
	const before = [...lines];
	const capped = capEventLines(lines, 2800);
	assert.equal(capped[0], notice);
	assert.equal(capped.at(-1), TRUNCATED);
	assert.ok(capped.join("\n").length <= 2800);
	assert.deepEqual(lines, before);
	assert.deepEqual(capEventLines(capped, 2800), capped);
});

test("composed-line clipping leaves fitting and empty arrays alone", () => {
	const lines = ["one", "two"];
	assert.equal(capEventLines(lines, 7), lines);
	assert.deepEqual(capEventLines([], 0), []);
});

function batch(options = {}) {
	const results = [];
	const value = new LineBatcher({ windowMs: 200, onBatch: (lines, count) => results.push({ lines, count }), ...options });
	return { value, results };
}

test("the event line cap includes its truncation marker", () => {
	const { value, results } = batch();
	value.pushEvent("x".repeat(1000));
	value.flush();
	value.close();
	assert.ok(results[0].lines[0].endsWith(TRUNCATED));
	assert.ok(results[0].lines[0].length <= MAX_LINE_CHARS);
});

test("the notification cap includes separator and truncation marker", () => {
	const { value, results } = batch();
	for (let i = 0; i < 40; i++) value.pushEvent("x".repeat(400));
	value.flush();
	value.close();
	assert.ok(results[0].lines.join("\n").length <= MAX_BATCH_CHARS);
	assert.equal(results[0].count, 40, "clipping does not change the event count");
	assert.equal(results[0].lines.at(-1), TRUNCATED);
});

test("even small explicit event budgets include their marker", () => {
	for (const cap of [0, 1, 10, 14, 15, 32, 100]) {
		const { value, results } = batch({ maxBatchChars: cap });
		value.pushEvent("x".repeat(200));
		value.flush();
		value.close();
		assert.ok(results[0].lines.join("\n").length <= cap, `budget ${cap}`);
	}
});

test("line and batch clipping do not split a surrogate pair", () => {
	const line = batch();
	line.value.pushEvent("x".repeat(MAX_LINE_CHARS - TRUNCATED.length - 1) + "😀" + "y".repeat(100));
	line.value.flush();
	line.value.close();
	const prefix = line.results[0].lines[0].slice(0, -TRUNCATED.length);
	assert.ok(!/[\ud800-\udbff]$/.test(prefix));

	const small = batch({ maxBatchChars: 30 });
	small.value.pushEvent("x".repeat(14) + "😀" + "y".repeat(40));
	small.value.flush();
	small.value.close();
	assert.ok(!/[\ud800-\udbff]$/.test(small.results[0].lines[0]));
	assert.ok(small.results[0].lines.join("\n").length <= 30);
});

test("partial-line tail clipping never starts with an orphan low surrogate", () => {
	const rogue = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	// Legal UTF-8 whose tail slice at the default cap begins mid surrogate pair.
	const raw = Buffer.from("😀" + "x".repeat(MAX_PARTIAL_LINE_CHARS - 1));
	const lines = [];
	const split = new LineBatcher({ windowMs: 200, onBatch: () => {}, onLine: (line) => lines.push(line) });
	split.push(raw.subarray(0, 2)); // chunk boundary inside the emoji
	split.push(raw.subarray(2));
	split.push(Buffer.from("\n"));
	split.flush();
	split.close();
	assert.ok(!rogue.test(lines[0]), "clipped head must be a whole code point");
	assert.equal(lines[0], "x".repeat(MAX_PARTIAL_LINE_CHARS - 1));

	const drained = [];
	const rest = new LineBatcher({ windowMs: 200, onBatch: () => {}, onLine: (line) => drained.push(line) });
	rest.push(raw);
	const batch = rest.drain();
	rest.close();
	assert.equal(batch.count, 1);
	assert.ok(!rogue.test(drained[0]));
	assert.ok(!rogue.test(batch.lines.join("\n")));

	// ASCII tail clipping keeps exactly the last cap characters.
	const ascii = [];
	const plain = new LineBatcher({ windowMs: 200, onBatch: () => {}, onLine: (line) => ascii.push(line) });
	plain.push(Buffer.from("a".repeat(MAX_PARTIAL_LINE_CHARS + 10)));
	plain.push(Buffer.from("\n"));
	plain.close();
	assert.equal(ascii[0], "a".repeat(MAX_PARTIAL_LINE_CHARS));
});

test("a 100k-event burst keeps a bounded prefix, the exact count and the exact capped output", () => {
	const { value, results } = batch();
	const full = [];
	for (let i = 0; i < 100000; i++) {
		const frame = `FRAME_${i} ${"x".repeat(480)}`;
		full.push(frame);
		value.pushEvent(frame);
	}
	// Only the prefix capEventLines can read is retained; the rest is count-only.
	const retained = value.pending.reduce((sum, line) => sum + line.length, 0);
	assert.ok(retained <= MAX_BATCH_CHARS + MAX_LINE_CHARS + 1, `retained ${retained} chars`);
	value.flush();
	value.close();
	assert.equal(results[0].count, 100000, "count-only events still count");
	assert.deepEqual(results[0].lines, capEventLines(full, MAX_BATCH_CHARS), "output is byte-for-byte the old capped output");
});

test("count-only retention preserves custom caps, Unicode and blank-frame rules", () => {
	for (const cap of [0, 15, 100, 3000]) {
		const { value, results } = batch({ maxBatchChars: cap });
		const full = [];
		for (let i = 0; i < 2000; i++) {
			const frame = i % 3 === 0 ? "" : `帧${i}😀${"y".repeat(200)}`;
			full.push(frame);
			value.pushEvent(frame);
		}
		value.flush();
		value.close();
		assert.equal(results[0].count, 2000, `budget ${cap}`);
		assert.deepEqual(results[0].lines, capEventLines(full, cap), `budget ${cap} keeps the exact output`);
	}
});

test("flush, drain, discard and close all reset the count and retained size", () => {
	const { value, results } = batch();
	for (let i = 0; i < 5000; i++) value.pushEvent("z".repeat(400));
	value.flush();
	assert.equal(results[0].count, 5000);
	value.flush();
	assert.equal(results.length, 1, "a second flush has nothing to emit");
	value.pushEvent("after flush");
	value.flush();
	assert.equal(results[1].count, 1, "the count restarts after flush");

	for (let i = 0; i < 5000; i++) value.pushEvent("z".repeat(400));
	value.discard();
	value.pushEvent("after discard");
	value.flush();
	assert.equal(results[2].count, 1, "discard drops the count with the bodies");

	for (let i = 0; i < 5000; i++) value.pushEvent("z".repeat(400));
	const drained = value.drain();
	assert.equal(drained.count, 5000, "drain reports count-only events too");
	assert.deepEqual(drained.lines, capEventLines(Array.from({ length: 5000 }, () => "z".repeat(400)), MAX_BATCH_CHARS));
	assert.equal(value.drain(), undefined);

	for (let i = 0; i < 5000; i++) value.pushEvent("z".repeat(400));
	value.close();
	value.flush();
	assert.equal(results.length, 3, "close drops the count with the bodies");
});

test("a retained display line does not pin the giant frame it was sliced from", async () => {
	const helpers = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers.mjs")).href;
	const script = `
		import { loadModule } from ${JSON.stringify(helpers)};
		const { LineBatcher } = await loadModule("stream.ts");
		const settle = async () => { for (let i = 0; i < 5; i++) { global.gc(); await new Promise(r => setTimeout(r, 20)); } };
		const batcher = new LineBatcher({ windowMs: 100000, onBatch: () => {} });
		await settle();
		const baseline = process.memoryUsage().heapUsed;
		batcher.pushEvent("HEAD" + "x".repeat(32 * 1024 * 1024));
		for (let i = 0; i < 20; i++) batcher.pushEvent("y".repeat(400));
		await settle();
		const growthMiB = (process.memoryUsage().heapUsed - baseline) / 1048576;
		batcher.close();
		if (growthMiB >= 16) { console.error("giant frame retained: " + growthMiB + " MiB"); process.exit(1); }
	`;
	await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 30000 });
});
