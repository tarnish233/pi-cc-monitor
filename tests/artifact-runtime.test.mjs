import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";
import { createHarness, startReady, until } from "./runtime-harness.mjs";
const config = await loadModule("config.ts");
const { LOG_CLEANUP_INTERVAL_MS } = await loadModule("log-store.ts");
const DAY = 86400000;
async function settings(body, values = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-runtime-policy-")), old = process.env.PI_CC_CONFIG_FILE;
	try {
		process.env.PI_CC_CONFIG_FILE = path.join(dir, "settings.json");
		fs.writeFileSync(process.env.PI_CC_CONFIG_FILE, JSON.stringify(values)); config.invalidateConfig();
		await body();
	} finally {
		if (old === undefined) delete process.env.PI_CC_CONFIG_FILE; else process.env.PI_CC_CONFIG_FILE = old;
		config.invalidateConfig(); fs.rmSync(dir, { recursive: true, force: true });
	}
}
function nodeCommand(code) { return JSON.stringify(process.execPath) + " -e " + JSON.stringify(code); }

test("real command logs stay bounded, retain final markers and expose managed scratch without changing cwd", async () => {
	await settings(async () => {
		const h = createHarness();
		try {
			const code = "const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(p.join(process.env.PI_MONITOR_ARTIFACT_DIR,'verify.json'),JSON.stringify({cwd:process.cwd(),result:'ok'}));process.stdout.write('x'.repeat(1500000)+'\\nFINAL_STDOUT=ok\\n');process.stderr.write('y'.repeat(1500000)+'\\nFINAL_STDERR=ok\\n')";
			const r = (await h.call("Monitor", { command: nodeCommand(code), description: "large bounded output", mode: "completion" })).details;
			assert.equal(r.logLimitBytes, 1024 * 1024);
			assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === "exit")));
			const ending = h.sent.find((m) => m.message.details.cause === "exit");
			assert.equal(ending.message.details.status, "completed");
			assert.equal(ending.message.details.logTruncated, true);
			assert.match(ending.message.content, /Logs truncated/);
			assert.equal(h.sent.filter((m) => m.message.details.cause !== "output").length, 1);
			const logFiles = fs.readdirSync(path.dirname(r.outputPath)).filter((n) => n.includes(".log"));
			assert.ok(logFiles.length <= 4);
			const bytes = logFiles.reduce((total,n) => total + fs.statSync(path.join(path.dirname(r.outputPath),n)).size, 0);
			assert.ok(bytes <= r.logLimitBytes, String(bytes));
			assert.ok(fs.readFileSync(r.outputPath,"utf8").endsWith("FINAL_STDOUT=ok\n"));
			assert.ok(fs.readFileSync(r.stderrPath,"utf8").endsWith("FINAL_STDERR=ok\n"));
			assert.equal(JSON.parse(fs.readFileSync(path.join(r.artifactDir,"verify.json"),"utf8")).cwd, fs.realpathSync(h.cwd));
			assert.equal((await h.snapshots())[0].logTruncated, true);
		} finally { await h.close(); }
	}, { logMaxMiB: 1 });
});

test("a first rotation exposes the archive without falsely claiming output was discarded", async () => {
	await settings(async () => {
		const h = createHarness();
		try {
			const code = "process.stdout.write('z'.repeat(300000)+String.fromCharCode(10)+'DONE'+String.fromCharCode(10))";
			const r = (await h.call("Monitor", {command:nodeCommand(code),description:"first rotation",mode:"completion"})).details;
			assert.ok(await until(() => h.sent.some((m) => m.message.details.cause === "exit")));
			const ending = h.sent.find((m) => m.message.details.cause === "exit");
			assert.equal(ending.message.details.logTruncated,false);
			assert.match(ending.message.content,/Rotated logs/);
			assert.ok(ending.message.content.includes(r.outputArchivePath));
			const output = Buffer.concat([fs.readFileSync(r.outputArchivePath),fs.readFileSync(r.outputPath)]).toString();
			assert.equal(output,"z".repeat(300000)+"\nDONE\n");
		} finally { await h.close(); }
	},{logMaxMiB:1});
});

test("source observers share paths and artifact storage, rather than allocating another directory", async () => {
	await settings(async () => {
		const h = createHarness();
		try {
			const source = await startReady(h);
			const observer = (await h.call("Monitor", { source: { monitorId: source.taskId }, description: "shared observer", mode: "events", notify: {output:"none"} })).details;
			assert.equal(observer.outputPath, source.outputPath);
			assert.equal(observer.stderrPath, source.stderrPath);
			assert.equal(observer.artifactDir, source.artifactDir);
			const root = path.dirname(path.dirname(source.outputPath));
			assert.equal(fs.readdirSync(root).filter((n) => fs.lstatSync(path.join(root,n)).isDirectory()).length, 1);
		} finally { await h.close(); }
	});
});

test("GC protects an undelivered result, then honors the read grace and marks eventual reclamation", async () => {
	await settings(async () => {
		const h = createHarness({idle:false}), originalNow = Date.now;
		try {
			const r = (await h.call("Monitor", { command:"printf result", description:"pending result", mode:"completion" })).details;
			assert.ok(await until(async () => (await h.snapshots())[0].status === "completed"));
			assert.equal(h.sent.length, 0);
			const now = originalNow();
			Date.now = () => now + 5 * DAY;
			await h.emit("session_start");
			assert.ok(fs.existsSync(r.outputPath), "pending handoff is not reclaimable");
			Date.now = originalNow; h.setIdle(true); await h.emit("agent_settled", {aborted:false});
			assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(path.dirname(r.outputPath),"task.json"),"utf8")).readyAt !== null));
			Date.now = () => now + 60000; await h.emit("session_start");
			assert.ok(fs.existsSync(r.outputPath), "just-delivered results get a read grace");
			Date.now = () => now + 5 * DAY; await h.emit("session_start");
			assert.equal(fs.existsSync(r.outputPath), false);
			const listed = await h.call("monitor_list", {});
			assert.equal(listed.details.monitors[0].logRemoved, true);
			assert.match(listed.content[0].text, /artifacts reclaimed/);
		} finally { Date.now = originalNow; await h.close(); }
	});
});

test("maintenance starts only with session/tool use, is unref'd, and stops on shutdown", async () => {
	await settings(async () => {
		const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
		const timers = [], cleared = new Set(); let h;
		try {
			globalThis.setInterval = (fn, ms, ...args) => { const timer = originalSet(fn,ms,...args); if (ms === LOG_CLEANUP_INTERVAL_MS) timers.push(timer); return timer; };
			globalThis.clearInterval = (timer) => { cleared.add(timer); return originalClear(timer); };
			h = createHarness(); assert.equal(timers.length, 0);
			await h.emit("session_start"); await h.emit("session_start");
			assert.equal(timers.length, 1); assert.equal(timers[0].hasRef(), false);
			await h.close(); h = undefined;
			assert.ok(cleared.has(timers[0]));
		} finally { if (h) await h.close(); globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
	});
});
