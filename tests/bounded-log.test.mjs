import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { createBoundedLog } = await loadModule("bounded-log.ts");

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-log-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "stdout.log");
}
function retained(file) {
	return Buffer.concat([file + ".1", file].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p)));
}

test("small logs stay byte-complete and private", async (t) => {
	const file = fixture(t), input = Buffer.from("start\n你好\nfinish\n");
	let trimmed = 0;
	const log = createBoundedLog(file, { maxBytes: 256, onTruncate: () => trimmed++ });
	const done = finished(log);
	log.end(input);
	await done;
	assert.deepEqual(retained(file), input);
	assert.equal(trimmed, 0);
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("rotation keeps the newest bytes within the total cap and reports discarded output once", async (t) => {
	const file = fixture(t), input = Buffer.from(Array.from({ length: 1100 }, (_, i) => i % 251));
	let trimmed = 0;
	const log = createBoundedLog(file, { maxBytes: 256, onTruncate: () => trimmed++ });
	const done = finished(log);
	for (let i = 0; i < input.length; i += 77) log.write(input.subarray(i, i + 77));
	log.end();
	await done;
	const tail = retained(file);
	assert.ok(tail.length <= 256);
	assert.ok(tail.length >= 128);
	assert.deepEqual(tail, input.subarray(input.length - tail.length));
	assert.equal(trimmed, 1);
	assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["stdout.log", "stdout.log.1"]);
});

test("a huge single chunk is bounded too, with its final marker preserved", async (t) => {
	const file = fixture(t), input = Buffer.from("x".repeat(20000) + "\nFINAL_RESULT=ok\n");
	const log = createBoundedLog(file, { maxBytes: 1024 });
	const done = finished(log);
	log.end(input);
	await done;
	const tail = retained(file);
	assert.ok(tail.length <= 1024);
	assert.deepEqual(tail, input.subarray(input.length - tail.length));
	assert.ok(tail.toString().endsWith("FINAL_RESULT=ok\n"));
});

test("archive symlinks are rejected without writing to or deleting their target", async (t) => {
	const file = fixture(t), victim = path.join(path.dirname(file), "important.txt");
	fs.writeFileSync(victim, "keep me");
	fs.symlinkSync(victim, file + ".1");
	const log = createBoundedLog(file, { maxBytes: 64 });
	log.on("error", () => {});
	const done = finished(log);
	log.end(Buffer.alloc(200));
	await assert.rejects(done);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
	assert.ok(fs.lstatSync(file + ".1").isSymbolicLink());
});

test("missing log directories fail the log, not with an uncaught stream error", async (t) => {
	const file = path.join(fixture(t), "missing", "output.log");
	const log = createBoundedLog(file, { maxBytes: 64 });
	log.on("error", () => {});
	const done = finished(log);
	log.end("hello");
	await assert.rejects(done, (e) => e.code === "ENOENT" || e.code === "ENOTDIR");
});

test("destroy during rotation closes a file descriptor returned by a late open", { timeout: 2000 }, async (t) => {
	const file = fixture(t), originalOpen = fs.open, originalClose = fs.close;
	let calls = 0, release, lateFd, onOpened, onClosed;
	const opened = new Promise((resolve) => { onOpened = resolve; });
	const closed = new Promise((resolve) => { onClosed = resolve; });
	let log;
	t.after(() => {
		fs.open = originalOpen; fs.close = originalClose;
		release?.(); log?.destroy();
		try { if (lateFd !== undefined) fs.closeSync(lateFd); } catch {}
	});
	fs.open = (p, flags, mode, callback) => {
		if (p === file && ++calls === 2) return originalOpen(p, flags, mode, (error, fd) => {
			lateFd = fd;
			release = () => { release = undefined; callback(error, fd); };
			onOpened();
		});
		return originalOpen(p, flags, mode, callback);
	};
	fs.close = (fd, callback) => originalClose(fd, (error) => { if (fd === lateFd) onClosed(); callback(error); });
	log = createBoundedLog(file, { maxBytes: 256 });
	log.on("error", () => {});
	const done = finished(log).catch(() => {});
	log.write(Buffer.alloc(200)); // one rotation only; a live WebSocket log has not called end()
	await opened;
	log.destroy();
	await done; // destruction completes before the pending open callback arrives
	release();
	await closed;
	assert.throws(() => fs.fstatSync(lateFd), (e) => e.code === "EBADF");
});
