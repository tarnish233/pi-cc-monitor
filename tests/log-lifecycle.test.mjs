import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const { createLogDirectory, createTaskDirectory, markTaskReady, setTaskProcess, cleanOldLogDirectories, LOG_READ_GRACE_MS } = await loadModule("log-store.ts");
const DAY = 86400000;
function fixture(t) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-lifecycle-store-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return { base, root: createLogDirectory(base) };
}
function backdate(dir, at) {
	const date = new Date(at);
	for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, item.name);
		if (item.isSymbolicLink()) continue;
		if (item.isDirectory()) backdate(p, at);
		else fs.utimesSync(p, date, date);
	}
	fs.utimesSync(dir, date, date);
}
const policy = { retentionMs: 3 * DAY, budgetBytes: 200 * 1024 * 1024 };
function finish(root, id, now, age = 5 * DAY) {
	const task = createTaskDirectory(root, id, now - age - DAY);
	fs.writeFileSync(task.outputPath, "retained output");
	fs.writeFileSync(task.stderrPath, "retained stderr");
	markTaskReady(task, now - age, now - age);
	backdate(task.path, now - age);
	return task;
}

test("task directories own log copies without changing the project cwd", (t) => {
	const { root } = fixture(t), task = createTaskDirectory(root, "abc12345");
	assert.equal(path.dirname(task.path), root.path);
	assert.ok(task.outputPath.endsWith("abc12345.out.log"));
	if (process.platform !== "win32") assert.equal(fs.statSync(task.path).mode & 0o777, 0o700);
	assert.throws(() => createTaskDirectory(root, "../escape"));
});

test("completed tasks expire inside a live runtime, including their disposable scripts", (t) => {
	const { base, root } = fixture(t), now = Date.now();
	const old = finish(root, "old12345", now);
	const active = createTaskDirectory(root, "live1234", now - 10 * DAY);
	fs.writeFileSync(active.outputPath, "still in use"); backdate(active.path, now - 10 * DAY);
	cleanOldLogDirectories(now, base, { policy, current: root });
	assert.equal(fs.existsSync(old.path), false);
	assert.ok(fs.existsSync(active.path));
	assert.ok(fs.existsSync(root.path), "the live runtime itself is never removed");
});

test("unpublished, protected and recently handed-off results survive expiry and quota pressure", (t) => {
	const { base, root } = fixture(t), now = Date.now();
	const pending = createTaskDirectory(root, "pending1", now - 10 * DAY);
	fs.writeFileSync(pending.outputPath, "awaiting delivery"); backdate(pending.path, now - 8 * DAY);
	const referenced = finish(root, "referenc", now);
	const justDelivered = createTaskDirectory(root, "delivere", now - 6 * DAY);
	fs.writeFileSync(justDelivered.outputPath, "finally delivered");
	backdate(justDelivered.path, now - 5 * DAY);
	markTaskReady(justDelivered, now - 5 * DAY, now);
	cleanOldLogDirectories(now, base, { policy: { ...policy, budgetBytes: 1 }, current: root, protectedIds: new Set([referenced.id]) });
	for (const task of [pending, referenced, justDelivered]) assert.ok(fs.existsSync(task.path));
	assert.equal(LOG_READ_GRACE_MS, 10 * 60 * 1000);
});

test("a small eligible-data budget removes the oldest task first even before TTL", (t) => {
	const { base, root } = fixture(t), now = Date.now();
	const older = finish(root, "older123", now, DAY);
	const newer = finish(root, "newer123", now, DAY / 2);
	fs.writeFileSync(older.outputPath, "x".repeat(1000));
	fs.writeFileSync(newer.outputPath, "y".repeat(1000));
	backdate(older.path, now - DAY); backdate(newer.path, now - DAY / 2);
	cleanOldLogDirectories(now, base, { policy: { ...policy, budgetBytes: 2000 }, current: root });
	assert.equal(fs.existsSync(older.path), false);
	assert.ok(fs.existsSync(newer.path));
});

test("a live sibling runtime is never reclaimed by another runtime's quota", (t) => {
	const { base, root } = fixture(t), now = Date.now(), sibling = createLogDirectory(base);
	const theirs = finish(sibling, "theirs12", now);
	cleanOldLogDirectories(now, base, { policy: { ...policy, budgetBytes: 1 }, current: root });
	assert.ok(fs.existsSync(theirs.path));
});

test("recent nested writes protect old closed runtimes", (t) => {
	const { base, root } = fixture(t), now = Date.now();
	const task = finish(root, "nested12", now);
	root.close();
	const metaFile = path.join(root.path, "owner.json"), meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	meta.createdAt = now - 6 * DAY; meta.closedAt = now - 5 * DAY;
	fs.writeFileSync(metaFile, JSON.stringify(meta)); backdate(root.path, now - 5 * DAY);
	fs.writeFileSync(path.join(task.path, "recent.log"), "recent result");
	cleanOldLogDirectories(now, base, { policy });
	assert.ok(fs.existsSync(root.path));
});

test("symlink targets and directories with invalid task ownership remain untouched", (t) => {
	const { base, root } = fixture(t), now = Date.now();
	const old = finish(root, "safe1234", now), invalid = finish(root, "invalid1", now);
	fs.writeFileSync(path.join(invalid.path, "task.json"), "{broken"); backdate(invalid.path, now - 5 * DAY);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-gc-victim-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, "keep"), "important");
	fs.symlinkSync(outside, path.join(old.path, "link"));
	backdate(old.path, now - 5 * DAY);
	cleanOldLogDirectories(now, base, { policy, current: root });
	assert.equal(fs.existsSync(old.path), false);
	assert.ok(fs.existsSync(invalid.path));
	assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "important");
});

test("a closed runtime with an unconfirmed live task group is protected even under quota pressure", (t) => {
	const {base,root}=fixture(t), now=Date.now(), task=createTaskDirectory(root,"survivor",now-6*DAY);
	const pid=424242; setTaskProcess(task,pid); root.close();
	const ownerFile=path.join(root.path,"owner.json"), owner=JSON.parse(fs.readFileSync(ownerFile,"utf8"));
	owner.createdAt=now-6*DAY; owner.closedAt=now-5*DAY; fs.writeFileSync(ownerFile,JSON.stringify(owner)); backdate(root.path,now-5*DAY);
	const original=process.kill;
	try {
		process.kill=(candidate,signal)=>{if(Math.abs(candidate)===pid&&signal===0)return true;return original(candidate,signal);};
		cleanOldLogDirectories(now,base,{policy:{...policy,budgetBytes:1}});
		assert.ok(fs.existsSync(task.path));
		process.kill=(candidate,signal)=>{if(Math.abs(candidate)===pid&&signal===0)throw Object.assign(new Error("gone"),{code:"ESRCH"});return original(candidate,signal);};
		cleanOldLogDirectories(now,base,{policy:{...policy,budgetBytes:1}});
		assert.equal(fs.existsSync(root.path),false);
	} finally {process.kill=original;}
});

test("failed cleanup never throws or claims it removed a directory", (t) => {
	const { base, root } = fixture(t), now = Date.now(), old = finish(root, "fail1234", now);
	const original = fs.rmSync;
	let result;
	try {
		fs.rmSync = (p, opts) => { if (p === old.path) throw new Error("busy filesystem"); return original(p, opts); };
		assert.doesNotThrow(() => { result = cleanOldLogDirectories(now, base, { policy, current: root }); });
	} finally { fs.rmSync = original; }
	assert.ok(fs.existsSync(old.path));
	assert.ok(!result.removedTasks.includes(old.path));
});
