/**
 * log-tail.ts on its own: bounded, sanitized log tails with truthful
 * clipping. All fixtures live in a unique temporary directory; the raw logs
 * are verified untouched after every read.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { readLogTail, sanitizeDisplay } = await loadModule("log-tail.ts");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-logtail-"));
test.after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

function write(name, content) {
	const file = path.join(work, name);
	fs.writeFileSync(file, content);
	return file;
}

test("keeps the ending marker of a >8KiB single newline-terminated line", () => {
	const marker = "PIPELINE-COMPLETE-42";
	const file = write("huge-line.log", "x".repeat(20 * 1024 - marker.length) + marker + "\n");
	const tail = readLogTail(file);
	assert.equal(tail.truncated, true);
	assert.ok(tail.text.length > 0, "the tail must retain a non-empty bounded fragment");
	assert.ok(tail.text.includes(marker), "the final marker must survive");
	assert.ok(tail.text.length <= 500);
	assert.match(tail.note ?? "", /tail/i);
	assert.ok(!tail.text.includes("\x1b"));
});

test("trailing blank/style-only lines never erase a huge final result", () => {
	const marker = "THE-REAL-FINAL-RESULT";
	for (const ending of ["\n\n", "\n\n\n", "\r\n\r\n", "\n\x1b[0m\n", "\n  \n"]) {
		const file = write("trailing-blanks.log", "q".repeat(9000) + marker + ending);
		const tail = readLogTail(file);
		assert.ok(tail.text.includes(marker), JSON.stringify(ending));
		assert.ok(tail.truncated);
		assert.ok(!tail.text.includes("\x1b"));
	}
});

test("a huge unterminated single line also keeps its ending", () => {
	const marker = "UNTERMINATED-END";
	const file = write("huge-no-nl.log", "w".repeat(30 * 1024 - marker.length) + marker);
	const tail = readLogTail(file);
	assert.equal(tail.truncated, true);
	assert.ok(tail.text.length > 0);
	assert.ok(tail.text.includes(marker));
});

test("a ~1000-char line is flagged truthfully and shortened with its ending kept", () => {
	const marker = "EXIT-STATUS-7";
	const file = write("long-line.log", "y".repeat(1000 - marker.length) + marker);
	const tail = readLogTail(file);
	assert.equal(tail.truncated, true, "per-line clipping must set truncated");
	assert.ok(tail.text.includes(marker), "the line ending must survive");
	assert.ok(tail.text.startsWith("yyy"), "the line head must survive");
	assert.ok(tail.text.length <= 500);
	assert.match(tail.note ?? "", /shorten/i);
});

test("a byte-sliced UTF-8 head decodes without replacement characters", () => {
	// 5000 two-byte characters: the 8192-byte tail starts mid-character.
	const file = write("unicode.log", "\u00fc".repeat(5000) + "END");
	const tail = readLogTail(file);
	assert.ok(!tail.text.includes("\uFFFD"), "no replacement characters at the sliced head");
	assert.ok(tail.text.startsWith("\u00fc"), "decoding starts on a character boundary");
	assert.ok(tail.text.endsWith("END"));
});

test("multiple bounded lines come through sanitized, tabs expanded", () => {
	const file = write("multi.log", "alpha\nbravo\tcharlie\ndelta\n");
	const tail = readLogTail(file);
	assert.equal(tail.truncated, false);
	assert.equal(tail.note, undefined);
	assert.deepEqual(tail.text.split("\n"), ["alpha", "bravo    charlie", "delta"]);
});

test("a trailing newline does not consume a last-lines slot", () => {
	const lines = Array.from({ length: 61 }, (_, index) => `L${index + 1}`);
	const file = write("many.log", `${lines.join("\n")}\n`);
	const tail = readLogTail(file);
	assert.equal(tail.truncated, true);
	const shown = tail.text.split("\n");
	assert.equal(shown.length, 60, "exactly maxLines lines are shown");
	assert.ok(shown.includes("L2"), "the trimmed terminal newline frees a slot");
	assert.ok(shown.includes("L61"));
	assert.ok(!shown.includes("L1"), "the oldest line is clipped");
});

test("a byte-bounded tail drops its partial first line", () => {
	const file = write("partial.log", `${"a".repeat(9000)}\nkeep-1\nkeep-2\n`);
	const tail = readLogTail(file);
	assert.deepEqual(tail.text.split("\n"), ["keep-1", "keep-2"]);
	assert.equal(tail.truncated, true);
	assert.match(tail.note ?? "", /tail/i);
});

test("missing, non-file and empty logs are notes, not errors", () => {
	assert.deepEqual(readLogTail(path.join(work, "absent.log")), {
		text: "",
		truncated: false,
		note: "log not created yet",
	});
	const dirPath = fs.mkdtempSync(path.join(work, "not-a-file-"));
	assert.deepEqual(readLogTail(dirPath), { text: "", truncated: false, note: "log is not a file" });
	assert.deepEqual(readLogTail(""), { text: "", truncated: false, note: "no log path" });
	const empty = write("empty.log", "");
	assert.deepEqual(readLogTail(empty), { text: "", truncated: false });
});

test("an unreadable log is a note on every platform, including root", () => {
	const file = write("unreadable.log", "data");
	const originalOpen = fs.openSync;
	fs.openSync = (name, ...args) => {
		if (name === file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		return originalOpen.call(fs, name, ...args);
	};
	try {
		assert.deepEqual(readLogTail(file), { text: "", truncated: false, note: "log unreadable" });
	} finally {
		fs.openSync = originalOpen;
	}
});

test("terminal escapes, controls and bidi overrides are stripped", () => {
	const file = write("dirty.log", "\x1b[31mred\x1b[0m plain\nbe\x1b]0;title\x07ep\u202ereversed\u202c\nnada\x00\x07\n");
	const tail = readLogTail(file);
	assert.ok(!tail.text.includes("\x1b"), "no ANSI reinjection");
	assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(tail.text), "no C0/C1 controls");
	assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(tail.text), "no bidi overrides");
	assert.deepEqual(tail.text.split("\n"), ["red plain", "beepreversed", "nada"]);
});

test("sanitizeDisplay handles non-strings and hostile text", () => {
	assert.equal(sanitizeDisplay("\x1b[31mhi\x1b[0m"), "hi");
	assert.equal(sanitizeDisplay("\x1b]0;title\x07ok"), "ok");
	assert.equal(sanitizeDisplay("a\u202eb"), "ab");
	assert.equal(sanitizeDisplay("a\u0007b"), "ab");
	assert.equal(sanitizeDisplay(null), "");
	assert.equal(sanitizeDisplay(undefined), "");
	assert.equal(sanitizeDisplay(42), "42");
	assert.equal(sanitizeDisplay("\u{1F600}"), "\u{1F600}", "valid surrogate pairs survive");
	assert.equal(sanitizeDisplay("\ud83dx"), "x", "dangling surrogates are removed");
});

test("reading never modifies the raw log", () => {
	const marker = "RAW-DONE";
	const file = write("raw.log", `\x1b[32mgo\x1b[0m\n${"z".repeat(20000)}${marker}\n`);
	const before = fs.readFileSync(file);
	readLogTail(file);
	readLogTail(file, 4096, 10, 80);
	assert.ok(before.equals(fs.readFileSync(file)), "the raw log must remain untouched");
});

test("explicit limits are honored", () => {
	const marker = "LIMIT-END";
	const file = write("limits.log", "k".repeat(300) + marker);
	const tail = readLogTail(file, 8192, 60, 120);
	assert.equal(tail.truncated, true);
	assert.ok(tail.text.length <= 120);
	assert.ok(tail.text.includes(marker), "the ending survives the smaller per-line cap");
	assert.ok(tail.text.startsWith("kkk"));
});
