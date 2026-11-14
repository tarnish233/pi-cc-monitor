import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { capEventLines, LineBatcher, MAX_LINE_CHARS, MAX_BATCH_CHARS, TRUNCATED } = await loadModule("stream.ts");

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
