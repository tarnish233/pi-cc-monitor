/**
 * pi-cc-monitor — Claude Code's `Monitor` tool for the Pi coding agent.
 *
 * A monitor runs a background command (or opens a WebSocket) and turns its
 * output into notifications that wake the agent. Claude Code:
 *
 *   "Your script's stdout is the event stream. Each line becomes a
 *    notification. Exit ends the watch."
 *
 * The tool schema mirrors Claude Code's:
 *
 *   command     string?   shell command or script; each stdout line is an event
 *   ws          object?   { url, protocols? }; each text frame is an event
 *   description string    shown in every notification
 *   timeout_ms  number?   min 1000, default 300000, max 3600000
 *   persistent  boolean?  default false; run for the lifetime of the session
 *
 * with the same refinements: exactly one of command or ws, no control
 * characters in command or url, ws urls must be ASCII ws:// or wss:// without
 * userinfo or whitespace, and ws protocols must be unique RFC 6455 tokens.
 *
 * The one addition is `loopPrompt`, which lets a monitor name the /loop chain
 * it belongs to: when pi-cc-loop (and only it) ends that chain, the monitor is
 * stopped with it. Without that extension the field is ignored, so this package
 * stands alone.
 *
 * Runtime behaviour follows Claude Code too: lines within 200ms form one
 * notification, notifications are capped (500 characters a line, 3000 a
 * notification) and rate-limited (a burst of 10, then one every 2 seconds),
 * they are delivered mid-turn (between tool calls), and every monitor ends
 * exactly once with at most one closing notice.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invalidateConfig, loadConfig } from "./config.ts";
import { killTree, spawnMonitor } from "./process.ts";
import { MONITOR_DESCRIPTION, MONITOR_LIST_SNIPPET, MONITOR_SNIPPET, MONITOR_STOP_SNIPPET } from "./prompts.ts";
import { monitorEnv, monitorShell } from "./shell.ts";
import { LineBatcher, RateLimiter } from "./stream.ts";
import {
	bodyLines,
	contentText,
	formatDuration,
	formatStamp,
	renderBlock,
	renderCard,
	stripProvenance,
	truncate,
} from "./render.ts";

/**
 * The event bus channel pi-cc-loop publishes when a chain ends. Monitors that
 * named that chain are stopped, the way Claude Code requires: "call
 * ScheduleWakeup with stop: true and TaskStop any Monitor you armed".
 */
export const LOOP_STOPPED_CHANNEL = "loop:stopped";
/**
 * The custom message type for events. It is also the label Pi falls back to;
 * our renderer draws the header instead, in the shape of a scheduled fire.
 */
export const EVENT_MESSAGE_TYPE = "Monitor";

/**
 * The header a cause gets, in the shape of the loop's scheduled-task block:
 * `\u273b monitor stopped \u00b7 10:22pm`. Claude Code has no equivalent line (its
 * notifications are task messages), so the wording says what happened.
 */
const CAUSE_LABEL: Record<MonitorCause, string> = {
	output: "\u273b monitor",
	exit: "\u273b monitor ended",
	timeout: "\u273b monitor expired",
	error: "\u273b monitor failed",
	closed: "\u273b monitor closed",
	stopped: "\u273b monitor stopped",
	flooded: "\u273b monitor stopped",
};
const CONFIG_CHANNEL = "pi-cc:config";

/** Claude Code's defaults: 5 minutes, capped at 1 hour. */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MIN_TIMEOUT_MS = 1_000;

/** Claude Code batches stdout lines within 200ms into a single notification. */
export const BATCH_WINDOW_MS = 200;

/** Logs older than this are removed when a session starts. */
const LOG_RETENTION_MS = 3 * 86_400_000;

export type MonitorCause = "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded";

/** Claude Code's notice when a monitor is stopped. */
export const STOPPED_NOTICE = "[Monitor stopped]";

export type MonitorStatus = "running" | "stopped" | "exited" | "timed_out" | "failed" | "flooded";

export interface MonitorRecord {
	id: string;
	kind: "command" | "ws";
	description: string;
	command?: string;
	wsUrl?: string;
	timeoutMs: number;
	persistent: boolean;
	createdAt: number;
	/** Events delivered to the agent. */
	eventCount: number;
	/** Events dropped by the rate limit. */
	suppressedCount: number;
	status: MonitorStatus;
	/** Epoch ms when the monitor left the running state. */
	endedAt?: number;
	/** The exit code of a command monitor, once it ended. */
	exitCode?: number | null;
	loopPrompt?: string;
	outputPath: string;
	stderrPath: string;
	child?: ChildProcess;
	socket?: WebSocket;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	batcher?: LineBatcher;
	limiter: RateLimiter;
}

/** A serializable view of a monitor, safe to put in tool result details. */
export interface MonitorSnapshot {
	id: string;
	kind: "command" | "ws";
	description: string;
	command?: string;
	wsUrl?: string;
	timeoutMs: number;
	persistent: boolean;
	createdAt: number;
	eventCount: number;
	suppressedCount: number;
	status: MonitorStatus;
	endedAt?: number;
	exitCode?: number | null;
	loopPrompt?: string;
	/** Process id of a command monitor's shell. */
	pid?: number;
	outputPath: string;
	stderrPath: string;
}

// ------------------------------------------------------------------ helpers

/** Control characters would be invisible in an approval dialog. */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function hasControlChars(value: string): boolean {
	return CONTROL_CHARS.test(value);
}

function isValidWsUrl(value: string): boolean {
	if (!/^[\x00-\x7F]*$/.test(value)) return false;
	if (/[\t\n\r]/.test(value)) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
		if (url.username || url.password) return false;
		return true;
	} catch {
		return false;
	}
}

const RFC6455_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isValidProtocols(protocols: string[] | undefined): boolean {
	if (!protocols) return true;
	if (new Set(protocols).size !== protocols.length) return false;
	return protocols.every((p) => RFC6455_TOKEN.test(p));
}

function outputDir(): string {
	const dir = path.join(os.tmpdir(), "pi-cc-monitor");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Remove monitor logs that have not been written for a few days. */
function cleanOldLogs(now = Date.now()): void {
	try {
		const dir = outputDir();
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith(".log")) continue;
			const file = path.join(dir, name);
			try {
				if (now - fs.statSync(file).mtimeMs > LOG_RETENTION_MS) fs.rmSync(file, { force: true });
			} catch {
				// a file that vanished or cannot be read is not our problem
			}
		}
	} catch {
		// cleanup is best effort
	}
}

/**
 * True when the pi-cc-loop extension is loaded. `loopPrompt` is only a promise
 * while that extension is there to publish `loop:stopped`; on its own this
 * package must not store a binding nothing will ever honour.
 */
function loopExtensionLoaded(pi: ExtensionAPI): boolean {
	try {
		return (pi.getAllTools?.() ?? []).some((tool) => tool.name === "cron_delete");
	} catch {
		return false;
	}
}

function generateId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}

function eventsText(count: number): string {
	return count === 0 ? "no events" : `${count} event${count === 1 ? "" : "s"}`;
}

/** " (12 suppressed)" when the rate limit dropped events, otherwise "". */
function suppressedText(record: MonitorRecord): string {
	return record.suppressedCount ? ` (${record.suppressedCount} suppressed)` : "";
}

/** Claude Code's expiry notice. */
function expiryNotice(record: MonitorRecord): string {
	const after = formatDuration(record.timeoutMs);
	if (record.eventCount === 0) {
		return `[Monitor expired after ${after} with no events delivered${suppressedText(record)}. Re-arm it if you still need the watch \u2014 and widen the filter if silence was unexpected.]`;
	}
	return `[Monitor expired after ${after} with ${eventsText(record.eventCount)} delivered${suppressedText(record)}. Re-arm it if you still need the watch.]`;
}

function exitNotice(record: MonitorRecord, signal: NodeJS.Signals | null): string {
	const code = record.exitCode;
	const how =
		code !== null && code !== undefined ? `exit code ${code}` : signal ? `killed by ${signal}` : "no exit code";
	const suppressed = record.suppressedCount ? `, ${record.suppressedCount} suppressed` : "";
	return `[Monitor ended \u2014 ${how}, ${eventsText(record.eventCount)} delivered${suppressed}]`;
}

function floodNotice(record: MonitorRecord, suppressedForMs: number): string {
	return `[Monitor stopped \u2014 too much output (${eventsText(record.suppressedCount)} suppressed over ${formatDuration(suppressedForMs)}). Restart it with a more selective filter.]`;
}

/** Claude Code's notice for events the rate limit dropped. */
function suppressionNotice(count: number): string {
	return `[${eventsText(count)} suppressed \u2014 output rate too high. Consider using monitor_stop to restart this monitor with a more selective filter.]`;
}

function snapshotMonitor(record: MonitorRecord): MonitorSnapshot {
	return {
		id: record.id,
		kind: record.kind,
		description: record.description,
		...(record.command !== undefined ? { command: record.command } : {}),
		...(record.wsUrl !== undefined ? { wsUrl: record.wsUrl } : {}),
		timeoutMs: record.timeoutMs,
		persistent: record.persistent,
		createdAt: record.createdAt,
		eventCount: record.eventCount,
		suppressedCount: record.suppressedCount,
		status: record.status,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.loopPrompt !== undefined ? { loopPrompt: record.loopPrompt } : {}),
		...(record.child?.pid !== undefined ? { pid: record.child.pid } : {}),
		outputPath: record.outputPath,
		stderrPath: record.stderrPath,
	};
}

// ------------------------------------------------------------------ extension

export default function piCcMonitorExtension(pi: ExtensionAPI): void {
	const monitors = new Map<string, MonitorRecord>();
	let lastCtx: ExtensionContext | undefined;
	/**
	 * True once the session is shutting down. Pi invalidates this extension's
	 * API right after `session_shutdown` (quit, reload, new, resume, fork); a
	 * child-process callback that touched it afterwards would throw an uncaught
	 * exception, and Pi exits on uncaught exceptions.
	 */
	let disposed = false;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (disposed) return;
		try {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		} catch {
			// a stale context must never break the monitor
		}
	}

	/**
	 * Send one notification to the agent.
	 *
	 * `steer` is Claude Code's "next" priority: when the agent is busy the
	 * notification lands after the current tool call, before the next model
	 * request, instead of waiting for the whole turn to end. When the agent is
	 * idle it starts a turn.
	 */
	function deliver(record: MonitorRecord, cause: MonitorCause, lines: string[]): void {
		if (disposed) return;
		try {
			pi.sendMessage(
				{
					customType: EVENT_MESSAGE_TYPE,
					content: `monitor ${record.id} \u00b7 ${record.description}\n${lines.join("\n")}`,
					display: true,
					details: {
						monitorId: record.id,
						description: record.description,
						cause,
						lines: cause === "output" ? lines : [],
						eventCount: record.eventCount,
						exitCode: record.exitCode,
						outputPath: record.outputPath,
						stderrPath: record.stderrPath,
						// pi-cc-loop uses it to tell which loop a woken turn belongs to.
						...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}),
					},
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// the session is gone; there is nobody left to tell
		}
	}

	interface Ending {
		status: Exclude<MonitorStatus, "running">;
		cause: MonitorCause;
		/** The one closing notice the agent gets; omitted for a silent stop. */
		notice?: () => string;
		/** Deliver the output that already arrived before the notice. */
		flush?: boolean;
		/** Kill the process tree and close the socket. */
		kill?: boolean;
	}

	/**
	 * End a monitor. Only the first call has an effect, so every way a monitor
	 * can end produces at most one notice, and output arriving afterwards (for
	 * example from a script that prints on SIGTERM) is dropped.
	 */
	function endMonitor(record: MonitorRecord, ending: Ending): void {
		if (record.status !== "running") return;
		if (ending.flush) record.batcher?.flushRemainder();
		// Flushing can itself end the monitor (flood).
		if (record.status !== "running") return;
		record.batcher?.close();
		record.status = ending.status;
		record.endedAt = Date.now();
		if (record.timeoutTimer) {
			clearTimeout(record.timeoutTimer);
			record.timeoutTimer = undefined;
		}
		if (ending.kill) {
			killTree(record.child);
			try {
				record.socket?.close();
			} catch {
				// already closed
			}
		}
		if (ending.notice) deliver(record, ending.cause, [ending.notice()]);
		if (![...monitors.values()].some((other) => other.status === "running")) removeExitHook();
	}

	/** Rate-limit a batch, then deliver it. */
	function onBatch(record: MonitorRecord, lines: string[], count: number): void {
		if (record.status !== "running") return;
		const verdict = record.limiter.take(count);
		if (verdict.deliver) {
			record.eventCount += count;
			deliver(record, "output", verdict.suppressed ? [suppressionNotice(verdict.suppressed), ...lines] : lines);
			return;
		}
		record.suppressedCount += count;
		if (verdict.flood) {
			endMonitor(record, {
				status: "flooded",
				cause: "flooded",
				kill: true,
				notice: () => floodNotice(record, verdict.suppressedForMs),
			});
		}
	}

	/**
	 * Kill every running command monitor at once. Installed as a process exit
	 * hook while monitors run: if Pi exits without a session_shutdown (for
	 * example after an uncaught exception), the detached process groups would
	 * otherwise keep running forever.
	 */
	function killAllNow(): void {
		for (const record of monitors.values()) {
			if (record.status === "running") killTree(record.child, "SIGKILL");
		}
	}
	let exitHookInstalled = false;
	function installExitHook(): void {
		if (exitHookInstalled) return;
		process.on("exit", killAllNow);
		exitHookInstalled = true;
	}
	function removeExitHook(): void {
		if (!exitHookInstalled) return;
		process.off("exit", killAllNow);
		exitHookInstalled = false;
	}

	/**
	 * A /loop chain ended: stop the monitors that named it, silently. Without
	 * this a monitor keeps firing, wakes the agent, and the agent reschedules
	 * the loop the user just stopped.
	 */
	pi.events.on(LOOP_STOPPED_CHANNEL, (data) => {
		const payload = data as { prompt?: string; reason?: string } | undefined;
		if (!payload?.prompt) return;
		for (const record of [...monitors.values()]) {
			if (record.loopPrompt !== payload.prompt) continue;
			if (record.status !== "running") continue;
			endMonitor(record, { status: "stopped", cause: "stopped", kill: true });
			const ctx = lastCtx;
			if (ctx) {
				notify(
					ctx,
					`Monitor ${record.id} stopped: its /loop chain ended (${payload.reason ?? "stopped"}).`,
					"info",
				);
			}
		}
	});

	// ------------------------------------------------------------- arming

	interface ArmInput {
		description: string;
		timeoutMs: number;
		persistent: boolean;
		loopPrompt?: string;
	}

	/** The parts every monitor shares: record, batcher, rate limit. */
	function createRecord(
		kind: MonitorRecord["kind"],
		input: ArmInput,
		target: { command?: string; wsUrl?: string },
	): MonitorRecord {
		const id = generateId();
		const dir = outputDir();
		const record: MonitorRecord = {
			id,
			kind,
			description: input.description,
			...target,
			timeoutMs: input.persistent ? 0 : input.timeoutMs,
			persistent: input.persistent,
			createdAt: Date.now(),
			eventCount: 0,
			suppressedCount: 0,
			status: "running",
			loopPrompt: input.loopPrompt,
			outputPath: path.join(dir, `${id}.out.log`),
			stderrPath: path.join(dir, `${id}.err.log`),
			limiter: new RateLimiter(),
		};
		record.batcher = new LineBatcher({
			windowMs: BATCH_WINDOW_MS,
			onBatch: (lines, count) => onBatch(record, lines, count),
		});
		monitors.set(id, record);
		return record;
	}

	function startTimeout(record: MonitorRecord): void {
		if (record.persistent || record.status !== "running") return;
		record.timeoutTimer = setTimeout(() => {
			endMonitor(record, {
				status: "timed_out",
				cause: "timeout",
				flush: true,
				kill: true,
				notice: () => expiryNotice(record),
			});
		}, record.timeoutMs);
		record.timeoutTimer.unref?.();
	}

	function armCommand(input: ArmInput & { command: string }, ctx: ExtensionContext): MonitorRecord {
		const record = createRecord("command", input, { command: input.command });
		const shell = monitorShell();
		record.child = spawnMonitor({
			command: input.command,
			cwd: ctx.cwd,
			env: monitorEnv(),
			shell: shell.shell,
			shellArgs: shell.args,
			commandTransport: shell.commandTransport,
			stdoutPath: record.outputPath,
			stderrPath: record.stderrPath,
			onStdout: (chunk) => {
				if (record.status === "running") record.batcher?.push(chunk);
			},
			onStderr: () => {
				// stderr goes to the output file, it never triggers a notification
			},
			onExit: (code, signal) => {
				record.exitCode = code;
				// A monitor that was stopped, timed out or flooded has already
				// been reported (or silenced): the exit that follows the kill is
				// not news.
				endMonitor(record, {
					status: "exited",
					cause: "exit",
					// Deliver what the batcher still holds before the exit notice.
					flush: true,
					notice: () => exitNotice(record, signal),
				});
			},
			onError: (error) => {
				endMonitor(record, {
					status: "failed",
					cause: "error",
					kill: true,
					notice: () => `[Monitor failed \u2014 ${error.message}]`,
				});
			},
		});
		installExitHook();
		startTimeout(record);
		return record;
	}

	function armWebSocket(input: ArmInput & { url: string; protocols?: string[] }): MonitorRecord {
		const record = createRecord("ws", input, { wsUrl: input.url });
		try {
			const socket = input.protocols?.length
				? new WebSocket(input.url, input.protocols)
				: new WebSocket(input.url);
			record.socket = socket;

			socket.addEventListener("message", (event: MessageEvent) => {
				if (record.status !== "running") return;
				const data = event.data;
				if (typeof data === "string") {
					record.batcher?.push(`${data}\n`);
					return;
				}
				record.batcher?.push(`[binary frame, ${byteLengthOf(data)} bytes]\n`);
			});
			socket.addEventListener("error", () => {
				// Errors are surfaced before the close.
				endMonitor(record, {
					status: "failed",
					cause: "error",
					flush: true,
					kill: true,
					notice: () => "[WebSocket error]",
				});
			});
			socket.addEventListener("close", (event: CloseEvent) => {
				endMonitor(record, {
					status: "exited",
					cause: "closed",
					flush: true,
					notice: () => `[WebSocket closed: ${event.code}]`,
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			endMonitor(record, { status: "failed", cause: "error", notice: () => `[Monitor failed \u2014 ${message}]` });
		}
		startTimeout(record);
		return record;
	}

	// ---------------------------------------------------------------- tools

	/**
	 * Draw an event the way a scheduled fire is drawn: `\u273b monitor stopped \u00b7
	 * 10:22pm` over its lines. The "monitor <id> \u00b7 <description>" line the model
	 * receives is not repeated; the description moves into the header.
	 */
	pi.registerMessageRenderer(EVENT_MESSAGE_TYPE, (message, options, theme: Theme) => {
		const details = (message.details ?? {}) as {
			description?: string;
			cause?: MonitorCause;
			eventCount?: number;
			monitorId?: string;
			exitCode?: number | null;
		};
		const cause = details.cause ?? "output";
		const body = stripProvenance(contentText(message.content), /^monitor \S+ \u00b7[^\n]*\n?/);
		const label = CAUSE_LABEL[cause] ?? CAUSE_LABEL.output;

		if (!loadConfig().compactMessages) {
			const header = `${label.replace("\u273b ", "")}${details.description ? ` \u00b7 ${details.description}` : ""}`;
			return renderCard({ header, body, expanded: options.expanded, outputPad: options.outputPad, theme });
		}

		const stamp = formatStamp(message.timestamp);
		const parts = [theme.fg(cause === "output" ? "accent" : "warning", theme.bold(label))];
		if (stamp) parts.push(theme.fg("muted", stamp));
		if (details.description) parts.push(theme.fg("dim", details.description));

		const meta: string[] = [];
		if (details.monitorId) meta.push(`id ${details.monitorId}`);
		if (details.eventCount !== undefined) meta.push(eventsText(details.eventCount));
		if (details.exitCode !== undefined && details.exitCode !== null) meta.push(`exit code ${details.exitCode}`);

		return renderBlock({
			header: parts.join(theme.fg("dim", " \u00b7 ")),
			body: bodyLines(body),
			meta,
			expanded: options.expanded,
			outputPad: options.outputPad,
			theme,
			maxBodyLines: 3,
		});
	});

	pi.registerTool({
		name: "Monitor",
		label: "Monitor",
		description: MONITOR_DESCRIPTION,
		promptSnippet: MONITOR_SNIPPET,
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({
					description: "Shell command or script. Each stdout line is an event; exit ends the watch.",
				}),
			),
			ws: Type.Optional(
				Type.Object(
					{
						url: Type.String({
							description:
								"WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch.",
						}),
						protocols: Type.Optional(
							Type.Array(Type.String({ description: "WebSocket subprotocol names." }), {
								description: "WebSocket subprotocols to request.",
							}),
						),
					},
					{
						description:
							"WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
					},
				),
			),
			description: Type.String({
				description: "Short human-readable description of what you are monitoring (shown in notifications).",
			}),
			timeout_ms: Type.Optional(
				Type.Number({
					minimum: MIN_TIMEOUT_MS,
					maximum: MAX_TIMEOUT_MS,
					description: `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
				}),
			),
			persistent: Type.Optional(
				Type.Boolean({
					description:
						"Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with monitor_stop.",
				}),
			),
			loopPrompt: Type.Optional(
				Type.String({
					description:
						"The /loop prompt this monitor belongs to, verbatim. Only used when the pi-cc-loop extension is loaded: " +
						"when it ends that loop, this monitor is stopped with it. Ignored otherwise.",
				}),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;

			const hasCommand = params.command !== undefined;
			const hasWs = params.ws !== undefined;
			if (hasCommand === hasWs) {
				throw new Error("exactly one of command or ws");
			}
			if (!params.description?.trim()) {
				throw new Error("description is required");
			}

			const persistent = params.persistent ?? false;
			const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			if (!persistent) {
				if (timeoutMs < MIN_TIMEOUT_MS) {
					throw new Error(`timeout_ms must be \u2265 ${MIN_TIMEOUT_MS}`);
				}
				if (timeoutMs > MAX_TIMEOUT_MS) {
					throw new Error(`timeout_ms must be \u2264 ${MAX_TIMEOUT_MS}`);
				}
			}
			const input: ArmInput = {
				description: params.description,
				timeoutMs,
				persistent,
				loopPrompt: loopExtensionLoaded(pi) ? params.loopPrompt : undefined,
			};

			let record: MonitorRecord;
			if (hasCommand) {
				const command = params.command as string;
				if (!command.trim()) throw new Error("command must not be empty");
				if (hasControlChars(command)) {
					throw new Error("command contains control characters that would be hidden in the approval dialog");
				}
				record = armCommand({ ...input, command }, ctx);
			} else {
				const ws = params.ws as { url: string; protocols?: string[] };
				if (!isValidWsUrl(ws.url)) {
					throw new Error(
						"url must be a valid ASCII ws:// or wss:// URL with no userinfo and no tabs or newlines",
					);
				}
				if (!isValidProtocols(ws.protocols)) {
					throw new Error("protocols must be unique RFC 6455 tokens");
				}
				record = armWebSocket({ ...input, url: ws.url, protocols: ws.protocols });
			}

			// Claude Code's launch result: what was armed, when it expires, and the two
			// things a model gets wrong about monitors - polling, and reading an event
			// as the user's answer.
			const lifetime = record.persistent
				? "runs until you stop it or the session ends"
				: `expires in ${Math.round(record.timeoutMs / 60_000)} minute${Math.round(record.timeoutMs / 60_000) === 1 ? "" : "s"} unless the source ends first; ` +
					"you get one notice at expiry \u2014 re-arm if you still need the watch";
			return {
				content: [
					{
						type: "text",
						text:
							`Monitor started (task ${record.id}, ${lifetime}). You will be notified on each event. ` +
							"Keep working \u2014 do not poll or sleep. " +
							"Events may arrive while you are waiting for the user \u2014 an event is not their reply.",
					},
				],
				details: {
					taskId: record.id,
					timeoutMs: record.timeoutMs,
					persistent: record.persistent,
					kind: record.kind,
					outputPath: record.outputPath,
					stderrPath: record.stderrPath,
				},
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop Monitor",
		description: "Stop a running monitor by its id. The monitor's process tree is killed and you get one [Monitor stopped] notice.",
		promptSnippet: MONITOR_STOP_SNIPPET,
		parameters: Type.Object({
			id: Type.String({ description: "The monitor id returned by Monitor." }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const record = monitors.get(params.id);
			if (!record) {
				return {
					content: [{ type: "text" as const, text: `No monitor found with ID: ${params.id}` }],
					details: { stopped: false, id: params.id },
				};
			}
			if (record.status !== "running") {
				return {
					content: [
						{ type: "text" as const, text: `Monitor ${params.id} is not running (${record.status}).` },
					],
					details: { stopped: false, id: params.id, status: record.status },
				};
			}
			endMonitor(record, {
				status: "stopped",
				cause: "stopped",
				flush: true,
				kill: true,
				notice: () => STOPPED_NOTICE,
			});
			return {
				// Claude Code's TaskStop result, with the description in place of the command.
				content: [
					{ type: "text" as const, text: `Successfully stopped monitor: ${params.id} (${record.description})` },
				],
				details: { stopped: true, id: params.id },
			};
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description: "List the monitors of this session with their ids, state, event counts and exit codes.",
		promptSnippet: MONITOR_LIST_SNIPPET,
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const list = [...monitors.values()].map(snapshotMonitor);
			if (!list.length) {
				return {
					content: [{ type: "text" as const, text: "No monitors." }],
					details: { monitors: [] },
				};
			}
			const text = list
				.map((record) => {
					const age = Math.round(((record.endedAt ?? Date.now()) - record.createdAt) / 1000);
					const code =
						record.status !== "running" && record.exitCode !== undefined && record.exitCode !== null
							? `exit ${record.exitCode}  `
							: "";
					const suppressed = record.suppressedCount ? `  ${record.suppressedCount} suppressed` : "";
					const target = record.kind === "ws" ? record.wsUrl : record.command;
					return `${record.id}  ${record.status}  ${record.kind}  ${record.eventCount} events${suppressed}  ${age}s  ${code}${record.description}  ${target ?? ""}`;
				})
				.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { monitors: list },
			};
		},
	});

	// The loop extension writes the shared config file and announces the change.
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// Another process may have edited the shared settings file.
		invalidateConfig();
		cleanOldLogs();
	});

	// --------------------------------------------------------------- lifecycle

	pi.on("session_shutdown", async () => {
		// Set first: the processes killed below exit after Pi has invalidated
		// this extension's API, and their callbacks must not touch it.
		disposed = true;
		for (const record of monitors.values()) {
			endMonitor(record, { status: "stopped", cause: "stopped", kill: true });
		}
		removeExitHook();
		monitors.clear();
	});
}

function byteLengthOf(data: unknown): number {
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
	return 0;
}
