import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";
const config = await loadModule("config.ts");
const { registerSettingsCommand } = await loadModule("settings.ts");
const ENVS = ["PI_CC_CONFIG_FILE", "PI_MONITOR_LOG_RETENTION_DAYS", "PI_MONITOR_LOG_MAX_MIB", "PI_MONITOR_LOG_BUDGET_MIB"];
async function isolated(body, initial = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-policy-")), file = path.join(dir, "settings.json");
	const before = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
	try {
		for (const k of ENVS) delete process.env[k];
		process.env.PI_CC_CONFIG_FILE = file; fs.writeFileSync(file, JSON.stringify(initial)); config.invalidateConfig();
		await body(file);
	} finally {
		for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
		config.invalidateConfig(); fs.rmSync(dir, { recursive: true, force: true });
	}
}
function host() {
	const commands = new Map(), changes = [], notices = [];
	registerSettingsCommand({ registerCommand: (id, c) => commands.set(id, c), events: { emit: (id, data) => changes.push({id,data}) } });
	return { command: commands.get("monitor_settings"), changes, notices, ctx: { mode: "rpc", hasUI: true, ui: { notify: (text, level) => notices.push({text,level}) } } };
}

test("Monitor alone owns validated numeric artifact settings", async () => {
	await isolated(async (file) => {
		const h = host();
		for (const input of ["retention 7", "logs 5", "budget 100"]) await h.command.handler(input, h.ctx);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { logRetentionDays: 7, logMaxMiB: 5, logBudgetMiB: 100 });
		assert.ok(h.changes.every((e) => e.id === "pi-cc-monitor:config"));
		assert.equal(config.loadConfig().footer, true);
		const before = fs.readFileSync(file, "utf8");
		for (const input of ["logs 0", "logs on", "logs -1", "logs 1.5", "budget Infinity", "retention 31", "logs 1025", "draft off"]) {
			await h.command.handler(input, h.ctx);
			assert.equal(fs.readFileSync(file, "utf8"), before, input);
		}
	});
});

test("numeric environment overrides are validated, displayed and never persisted", async () => {
	await isolated(async (file) => {
		process.env.PI_MONITOR_LOG_MAX_MIB = "5"; config.invalidateConfig();
		assert.equal(config.loadConfig().logMaxMiB, 5);
		assert.equal(config.envOverride("logMaxMiB"), "PI_MONITOR_LOG_MAX_MIB=5");
		const h = host(); await h.command.handler("logs 10", h.ctx);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).logMaxMiB, 10);
		assert.equal(config.loadConfig().logMaxMiB, 5);
		assert.equal(h.notices.at(-1).level, "warning");
		process.env.PI_MONITOR_LOG_MAX_MIB = "0"; config.invalidateConfig();
		assert.equal(config.envOverride("logMaxMiB"), undefined);
		assert.equal(config.loadConfig().logMaxMiB, 10);
	}, { logMaxMiB: 20, keep: "unchanged" });
});

test("invalid numeric file values fall back safely instead of disabling limits", async () => {
	for (const value of [0, -1, 1.5, "20", true, null, 999999]) {
		await isolated(() => {
			assert.equal(config.loadConfig().logMaxMiB, 20);
			assert.equal(config.loadConfig().logRetentionDays, 3);
		}, { logMaxMiB: value, logRetentionDays: value });
	}
});

test("the native single-page panel cycles numeric presets and locks overridden values", async () => {
	await isolated(async (file) => {
		const h = host(); let panel;
		h.ctx.mode = "tui";
		h.ctx.ui.custom = (factory) => new Promise((resolve) => { panel = factory({requestRender() {}}, {fg: (_r,t) => t, bold: (t) => t}, {}, resolve); });
		const done = h.command.handler("", h.ctx);
		assert.match(panel.render(100).join("\n"), /Artifact retention/);
		panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B"); panel.handleInput(" ");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).logRetentionDays, 7);
		panel.handleInput("\x1b"); await done;
		process.env.PI_MONITOR_LOG_MAX_MIB = "5"; config.invalidateConfig();
		const reopened = h.command.handler("", h.ctx);
		for (let i = 0; i < 3; i++) panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).logMaxMiB, undefined);
		panel.handleInput("\x1b"); await reopened;
	});
});
