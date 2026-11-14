/**
 * log-store.ts on its own: ownership markers, private modes and the
 * conservative cleanup policy. Every case runs in its own unique temporary
 * base directory with controlled owner markers. The only process signals
 * used are process.kill(pid, 0): on this process, on a spawned child that is
 * verified dead (ESRCH), and - only to exercise EPERM - on pid 1.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { createLogDirectory, cleanOldLogDirectories } = await loadModule("log-store.ts");

const DAY = 86400000;
const META = "owner.json";

function freshBase() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-monitor-store-"));
}

/** A controlled owner marker, byte-identical in shape to the real one. */
function writeMeta(dir, fields = {}) {
	const meta = {
		schema: "pi-cc-monitor.owner",
		version: 1,
		kind: "monitor",
		pid: process.pid,
		hostname: os.hostname(),
		createdAt: Date.now(),
		closedAt: null,
		...fields,
	};
	fs.writeFileSync(path.join(dir, META), `${JSON.stringify(meta, null, "\t")}\n`, { mode: 0o600 });
	return meta;
}

function makeOwnedDir(base, fields = {}) {
	const dir = fs.mkdtempSync(path.join(base, "pi-cc-monitor-"));
	writeMeta(dir, fields);
	return dir;
}

function backdateTree(dir, days, now) {
	// utimes takes seconds or Date objects, never milliseconds.
	const old = new Date(now - days * DAY);
	fs.utimesSync(dir, old, old);
	for (const name of fs.readdirSync(dir)) {
		const entry = path.join(dir, name);
		if (fs.statSync(entry).isFile()) fs.utimesSync(entry, old, old);
	}
}

/** A pid that is verified nonexistent via process.kill(pid, 0) -> ESRCH. */
function verifiedDeadPid() {
	for (let attempt = 0; attempt < 10; attempt++) {
		const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 10000 });
		if (!child.pid) continue;
		try {
			process.kill(child.pid, 0);
		} catch (error) {
			if (error && error.code === "ESRCH") return child.pid;
		}
	}
	throw new Error("could not obtain a verified-dead pid");
}

test("createLogDirectory creates a private owned directory", () => {
	const base = freshBase();
	const dir = createLogDirectory(base);
	assert.ok(fs.statSync(dir.path).isDirectory());
	assert.equal(path.dirname(dir.path), base);
	assert.ok(path.basename(dir.path).startsWith("pi-cc-monitor-"));
	assert.ok(fs.readdirSync(dir.path).includes(META));
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(dir.path).mode & 0o777, 0o700, "directory is 0700");
		assert.equal(fs.statSync(path.join(dir.path, META)).mode & 0o777, 0o600, "marker is 0600");
	}
	const meta = JSON.parse(fs.readFileSync(path.join(dir.path, META), "utf8"));
	assert.equal(meta.schema, "pi-cc-monitor.owner");
	assert.equal(meta.version, 1);
	assert.equal(meta.kind, "monitor");
	assert.equal(meta.pid, process.pid);
	assert.equal(meta.hostname, os.hostname());
	assert.equal(meta.closedAt, null);
	const other = createLogDirectory(base);
	assert.notEqual(other.path, dir.path, "each runtime gets its own directory");
	dir.close();
	other.close();
});

test("close() is idempotent, records closedAt, and deletes nothing", () => {
	const base = freshBase();
	const dir = createLogDirectory(base);
	fs.writeFileSync(path.join(dir.path, "monitor-1.log"), "output\n");
	dir.close();
	const metaFile = path.join(dir.path, META);
	const first = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	assert.equal(typeof first.closedAt, "number");
	dir.close();
	dir.close();
	const again = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	assert.equal(again.closedAt, first.closedAt, "repeated close does not rewrite the marker");
	assert.ok(fs.existsSync(dir.path), "close never deletes data");
	assert.ok(fs.existsSync(path.join(dir.path, "monitor-1.log")));
});

test("a quiet, old, live-owned log directory is never deleted", () => {
	const base = freshBase();
	const now = Date.now();
	const dir = makeOwnedDir(base, { createdAt: now - 6 * DAY });
	fs.writeFileSync(path.join(dir, "monitor-1.log"), "quiet\n");
	backdateTree(dir, 5, now);
	cleanOldLogDirectories(now, base);
	assert.ok(fs.existsSync(dir), "a live owner protects its quiet old logs");
	// ... even much later: aliveness, not age, is what protects it.
	cleanOldLogDirectories(now + 30 * DAY, base);
	assert.ok(fs.existsSync(dir));
});

test("a closed directory is removed after 3 days even while its pid is alive", () => {
	const base = freshBase();
	const now = Date.now();
	const dir = makeOwnedDir(base, { createdAt: now - 6 * DAY, closedAt: now - 5 * DAY, pid: process.pid });
	fs.writeFileSync(path.join(dir, "monitor-1.log"), "done\n");
	backdateTree(dir, 5, now);
	cleanOldLogDirectories(now, base);
	assert.ok(!fs.existsSync(dir), "closed beats a still-live pid");
});

test("a closed directory with recent activity is kept", () => {
	const base = freshBase();
	const now = Date.now();
	const dir = makeOwnedDir(base, { createdAt: now - 2 * DAY, closedAt: now - 1 * DAY });
	fs.writeFileSync(path.join(dir, "monitor-1.log"), "done\n");
	backdateTree(dir, 2, now);
	cleanOldLogDirectories(now, base);
	assert.ok(fs.existsSync(dir), "younger than the retention window");
});

test("an unclosed directory with a reliably dead pid is removed only after 3 days", () => {
	const base = freshBase();
	const now = Date.now();
	const dead = verifiedDeadPid();
	const old = makeOwnedDir(base, { createdAt: now - 6 * DAY, pid: dead });
	fs.writeFileSync(path.join(old, "monitor-1.log"), "gone\n");
	backdateTree(old, 5, now);
	const recent = makeOwnedDir(base, { createdAt: now - 2 * DAY, pid: dead });
	fs.writeFileSync(path.join(recent, "monitor-1.log"), "gone\n");
	backdateTree(recent, 2, now);
	cleanOldLogDirectories(now, base);
	assert.ok(!fs.existsSync(old), "reliably dead owner and old activity: removed");
	assert.ok(fs.existsSync(recent), "dead owner but recent activity: kept");
});

test("recent log writes protect a closed old directory", () => {
	const base = freshBase();
	const now = Date.now();
	const dir = makeOwnedDir(base, { createdAt: now - 6 * DAY, closedAt: now - 5 * DAY, pid: process.pid });
	const logFile = path.join(dir, "monitor-1.log");
	fs.writeFileSync(logFile, "still writing\n");
	backdateTree(dir, 5, now);
	// The monitor appended again an hour ago; only the file mtime moved.
	const recent = new Date(now - 3600000);
	fs.utimesSync(logFile, recent, recent);
	cleanOldLogDirectories(now, base);
	assert.ok(fs.existsSync(dir), "recent log activity protects the directory");
});

test("a recent close protects an otherwise old directory", () => {
	const base = freshBase();
	const now = Date.now();
	const dir = makeOwnedDir(base, { createdAt: now - 6 * DAY, closedAt: now - 3600000, pid: process.pid });
	fs.writeFileSync(path.join(dir, "monitor-1.log"), "done\n");
	backdateTree(dir, 5, now);
	cleanOldLogDirectories(now, base);
	assert.ok(fs.existsSync(dir), "closed age must protect recent logs");
});

test("malformed or unowned markers are never deleted", () => {
	const base = freshBase();
	const now = Date.now();
	const cases = [];
	const add = (writer) => {
		const dir = fs.mkdtempSync(path.join(base, "pi-cc-monitor-"));
		writer(dir);
		fs.writeFileSync(path.join(dir, "monitor-1.log"), "keep\n");
		backdateTree(dir, 5, now);
		cases.push(dir);
	};
	add(() => undefined); // no marker at all
	add((dir) => fs.writeFileSync(path.join(dir, META), "{ this is not json"));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "someone-elses.owner", version: 1, kind: "monitor",
			pid: process.pid, hostname: os.hostname(), closedAt: 1,
		})));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "pi-cc-monitor.owner", version: 99, kind: "monitor",
			pid: process.pid, hostname: os.hostname(), closedAt: 1,
		})));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "pi-cc-monitor.owner", version: 1, kind: "loop",
			pid: process.pid, hostname: os.hostname(), closedAt: 1,
		})));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "pi-cc-monitor.owner", version: 1, kind: "monitor",
			pid: "not a pid", hostname: os.hostname(), closedAt: 1,
		})));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "pi-cc-monitor.owner", version: 1, kind: "monitor",
			pid: -1, hostname: os.hostname(), closedAt: 1,
		})));
	add((dir) =>
		fs.writeFileSync(path.join(dir, META), JSON.stringify({
			schema: "pi-cc-monitor.owner", version: 1, kind: "monitor",
			pid: process.pid, hostname: "", closedAt: 1,
		})));
	cleanOldLogDirectories(now, base);
	for (const dir of cases) assert.ok(fs.existsSync(dir), `${dir} must be kept`);
});

test("foreign-host markers are uncertain and always kept", () => {
	const base = freshBase();
	const now = Date.now();
	const dead = verifiedDeadPid();
	const dir = makeOwnedDir(base, {
		createdAt: now - 6 * DAY,
		closedAt: now - 5 * DAY,
		pid: dead,
		hostname: "some-other-host",
	});
	backdateTree(dir, 5, now);
	cleanOldLogDirectories(now, base);
	assert.ok(fs.existsSync(dir));
});

test("symlinks are never followed or removed", () => {
	const base = freshBase();
	const now = Date.now();
	// A real closed/old directory proves the sweep actually ran.
	const real = makeOwnedDir(base, { createdAt: now - 6 * DAY, closedAt: now - 5 * DAY });
	fs.writeFileSync(path.join(real, "monitor-1.log"), "done\n");
	backdateTree(real, 5, now);
	// The symlink points outside the swept base; following it would delete
	// data the sweep does not own.
	const outside = freshBase();
	const victim = makeOwnedDir(outside, { createdAt: now - 6 * DAY, closedAt: now - 5 * DAY });
	backdateTree(victim, 5, now);
	const link = path.join(base, "pi-cc-monitor-sneaky");
	fs.symlinkSync(outside, link);
	cleanOldLogDirectories(now, base);
	assert.ok(!fs.existsSync(real), "the sweep ran and removed the real old directory");
	assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink entry itself is left alone");
	assert.ok(fs.existsSync(victim), "the symlink target is never followed");
});

test("legacy flat pi-cc-monitor logs are untouched", () => {
	const now = Date.now();
	const base = freshBase();
	const legacyFile = path.join(base, "pi-cc-monitor");
	fs.writeFileSync(legacyFile, "legacy flat log\n");
	const base2 = freshBase();
	const legacyDir = path.join(base2, "pi-cc-monitor");
	fs.mkdirSync(legacyDir);
	fs.writeFileSync(path.join(legacyDir, "old.log"), "legacy\n");
	const old = new Date(now - 5 * DAY);
	fs.utimesSync(legacyFile, old, old);
	fs.utimesSync(legacyDir, old, old);
	cleanOldLogDirectories(now, base);
	cleanOldLogDirectories(now, base2);
	assert.ok(fs.existsSync(legacyFile));
	assert.ok(fs.existsSync(legacyDir));
});

test("EPERM and unknown pid-probe failures conservatively count as alive", () => {
	const originalKill = process.kill;
	try {
		for (const errorCode of ["EPERM", "EINVAL", undefined]) {
			const base = freshBase();
			const now = Date.now();
			const dir = makeOwnedDir(base, { createdAt: now - 6 * DAY, pid: process.pid });
			backdateTree(dir, 5, now);
			process.kill = (pid, signal) => {
				if (pid === process.pid && signal === 0) throw Object.assign(new Error("probe denied"), { code: errorCode });
				return originalKill.call(process, pid, signal);
			};
			cleanOldLogDirectories(now, base);
			assert.ok(fs.existsSync(dir), "uncertain ownership is never deleted");
		}
	} finally {
		process.kill = originalKill;
	}
});

test("a missing base never throws", () => {
	assert.doesNotThrow(() => cleanOldLogDirectories(Date.now(), path.join(freshBase(), "no-such-dir")));
});
