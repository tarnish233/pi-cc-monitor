/** Manual terminal acceptance fixture. Never loaded by the published package.
 * Requires an explicitly owned PI_OBSERVATION_FIXTURE directory. Automatic model
 * wakeups are disabled ONLY in this fixture; real SDK delivery is tested separately.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default async function observationTuiFixture(pi: ExtensionAPI) {
	const root = process.env.PI_OBSERVATION_FIXTURE;
	const worktree = process.env.PI_OBSERVATION_WORKTREE;
	if (!root || !worktree || !path.isAbsolute(root) || !path.isAbsolute(worktree)) throw new Error("observation fixture requires explicit private paths");
	const owner = JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8"));
	if (owner.schema !== "pi-cc-observation.validation" || owner.path !== root || !owner.token) throw new Error("invalid observation fixture ownership");
	const cfg = JSON.parse(fs.readFileSync(path.join(root, "control.json"), "utf8"));
	if (cfg.token !== owner.token || cfg.project !== path.join(root, "project") || (path.dirname(cfg.run) !== cfg.project || !/^run(?:-\d+)?$/.test(path.basename(cfg.run))) || !/^obs-tui-[a-z0-9-]+$/.test(cfg.socket) || cfg.session !== "fixture") throw new Error("invalid fixture control data");
	const tools = new Map<string, any>();
	let lastId: string | undefined;
	const notices: any[] = [];
	const api = new Proxy(pi, { get(target, key) {
		if (key === "registerTool") return (tool: any) => { tools.set(tool.name, tool); return target.registerTool(tool); };
		if (key === "sendMessage") return (message: any, options: any) => {
			notices.push({ cause: message.details?.cause, observation: message.details?.monitorId, job: message.details?.job?.state });
			if (notices.length > 20) notices.shift();
			return target.sendMessage(message, { ...options, triggerTurn: false });
		};
		if (key === "sendUserMessage") return () => { throw new Error("model requests are disabled in this terminal fixture"); };
		return Reflect.get(target, key);
	} });
	const loop = await import(pathToFileURL(path.join(worktree, "pi-cc-loop/index.ts")).href);
	const monitor = await import(pathToFileURL(path.join(worktree, "pi-cc-monitor/index.ts")).href);
	loop.default(api); monitor.default(api);

	function owned() {
		const current = JSON.parse(fs.readFileSync(path.join(root!, "owner.json"), "utf8"));
		if (current.token !== owner.token || current.path !== root) throw new Error("fixture ownership changed");
	}
	function save(name: string, value: unknown) { owned(); const file = path.join(root!, name + ".json"), temp = file + ".tmp"; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
	async function call(name: string, args: object, ctx: ExtensionContext) { return tools.get(name).execute("fixture", args, undefined, undefined, ctx); }
	async function evidence(ctx: ExtensionContext, event: string) {
		const list = (await call("monitor_list", {}, ctx)).details.monitors;
		const job = fs.existsSync(path.join(cfg.run, "job.json")) ? JSON.parse(fs.readFileSync(path.join(cfg.run, "job.json"), "utf8")) : undefined;
		const status = fs.existsSync(path.join(cfg.run, "status.json")) ? JSON.parse(fs.readFileSync(path.join(cfg.run, "status.json"), "utf8")) : undefined;
		const heartbeat = fs.existsSync(path.join(cfg.project, "heartbeat.json")) ? JSON.parse(fs.readFileSync(path.join(cfg.project, "heartbeat.json"), "utf8")) : undefined;
		const native = await pi.exec("tmux", ["-L", cfg.socket, "has-session", "-t", cfg.session], { timeout: 2000 });
		const value = { event, piPid: process.pid, job, status, heartbeat, nativeRunning: native.code === 0, observations: list, notices, checkpoint: fs.existsSync(path.join(cfg.project, "checkpoint")) };
		save("evidence", value); ctx.ui.notify(`Fixture ${event}: native=${value.nativeRunning}, job=${status?.state ?? "none"}, observers=${list.length}`, "info");
		return value;
	}
	function quoted(value: string): string { return "'" + value.replace(/'/g, "'\"'\"'") + "'"; }
	async function attach(ctx: ExtensionContext, loopPrompt?: string) {
		owned();
		const list = (await call("monitor_list", {}, ctx)).details.monitors;
		if (list.some((item: any) => item.status === "running" && item.source?.manifest === path.join(cfg.run, "job.json"))) throw new Error("fixture already has an active observation");
		const result = await call("Monitor", { source: { kind: "job", manifest: path.join(cfg.run, "job.json") }, mode: "completion", description: "independent runner fixture", persistent: true, notify: { output: "context" }, ...(loopPrompt ? { loopPrompt } : {}) }, ctx);
		lastId = result.details.taskId; await evidence(ctx, "attached");
	}
	pi.registerCommand("obs_start", { description: "Private fixture: start an owned native runner", handler: async (_args, ctx) => {
		owned(); if (fs.existsSync(cfg.run)) throw new Error("fixture run already exists; refusing a duplicate submission");
		const command = ["python3", path.join(worktree!, "pi-cc-monitor/examples/job-wrapper.py"), "--runner", "tmux", "--runner-id", cfg.session, "--job-id", "tui-smoke", "--cancel-grace", "2", cfg.run, "--", process.execPath, path.join(cfg.project, "worker.mjs")].map(quoted).join(" ");
		const start = await pi.exec("tmux", ["-L", cfg.socket, "new-session", "-d", "-s", cfg.session, "-c", cfg.project, "exec " + command], { timeout: 3000 });
		if (start.code !== 0) throw new Error("native fixture submission failed");
		// Setup confirmation is bounded and unrelated to waiting for the full job.
		const until = Date.now() + 5000; while (!fs.existsSync(path.join(cfg.run, "job.json")) && Date.now() < until) await new Promise(r => setTimeout(r, 25));
		await attach(ctx);
	} });
	pi.registerCommand("obs_attach", { description: "Private fixture: reconnect to the original run", handler: async (_args, ctx) => attach(ctx) });
	pi.registerCommand("obs_loop_attach", { description: "Private fixture: attach a loop-bound observation", handler: async (_args, ctx) => {
		const scheduler = loop.getScheduler(api);
		if (!scheduler) throw new Error("fixture: missing Loop scheduler");
		if (!scheduler.get("fixture-loop")) scheduler.add({
			id: "fixture-loop", kind: "wakeup", prompt: "fixture-loop", recurring: false, durable: false,
			createdAt: Date.now(), scheduledFor: Date.now() + 3600_000, source: "tui fixture",
		});
		await attach(ctx, "fixture-loop");
	} });
	pi.registerCommand("obs_loop_stop", { description: "Private fixture: retire only the observation loop", handler: async (_args, ctx) => {
		await call("cron_delete", { id: "fixture-loop" }, ctx); await evidence(ctx, "loop-stop-requested");
	} });
	pi.registerCommand("obs_stop", { description: "Private fixture: stop observation only", handler: async (_args, ctx) => {
		if (!lastId) throw new Error("no attached fixture observation"); await call("monitor_stop", { id: lastId }, ctx); await evidence(ctx, "observation-stopped");
	} });
	pi.registerCommand("obs_cancel", { description: "Private fixture: explicitly cancel only the owned native runner", handler: async (_args, ctx) => {
		owned(); const stop = await pi.exec("tmux", ["-L", cfg.socket, "kill-session", "-t", cfg.session], { timeout: 3000 }); if (stop.code !== 0) throw new Error("native fixture cancellation failed"); await evidence(ctx, "native-cancel-requested");
	} });
	pi.registerCommand("obs_status", { description: "Private fixture: capture authoritative acceptance evidence", handler: async (_args, ctx) => evidence(ctx, "status") });
	pi.on("session_start", (_event, ctx) => { save("boot", { piPid: process.pid, at: Date.now() }); ctx.ui.notify("Owned observation fixture ready; no automatic model requests", "info"); });
	pi.on("session_shutdown", event => { save("shutdown", { piPid: process.pid, reason: event.reason, at: Date.now() }); });
}
