/**
 * pi-cc-monitor — Claude Code's `Monitor` tool for the Pi coding agent.
 *
 * A monitor runs a background command (or opens a WebSocket) and turns its
 * output into notifications that wake the agent. Claude Code v2.1.306:
 *
 *   "Your script's stdout is the event stream. Each line becomes a
 *    notification. Exit ends the watch."
 *
 * The tool schema mirrors Claude Code's exactly:
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
 * it belongs to. pi-cc-loop subscribes to the `monitor:wake` event and uses
 * it to supersede the fallback heartbeat of that chain.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { invalidateConfig, loadConfig, syncPiCcExtensionsExcludes } from "./config.ts";
import { killTree, spawnMonitor } from "./process.ts";
import {
	bodyLines,
	contentText,
	firstLine,
	formatStamp,
	renderBlock,
	renderCard,
	stripProvenance,
} from "./render.ts";
import { monitorEnv, monitorShell } from "./shell.ts";
import { FloodGuard, LineBatcher } from "./stream.ts";

/** The event bus channel pi-cc-loop listens on. */
export const WAKE_CHANNEL = "monitor:wake";
/**
 * The event bus channel pi-cc-loop publishes when a chain ends. Monitors that
 * named that chain are stopped, the way Claude Code requires: "call
 * ScheduleWakeup with stop: true and TaskStop any Monitor you armed".
 */
export const LOOP_STOPPED_CHANNEL = "loop:stopped";
/** The custom message type used for notifications. */
export const EVENT_MESSAGE_TYPE = "pi-cc-monitor-event";
const CONFIG_CHANNEL = "pi-cc:config";
const MONITOR_TOOL_NAMES = ["Monitor", "monitor_stop", "monitor_list"];

/** Claude Code's defaults: 5 minutes, capped at 1 hour. */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MIN_TIMEOUT_MS = 1_000;

/** Claude Code batches stdout lines within 200ms into a single notification. */
export const BATCH_WINDOW_MS = 200;

/** Claude Code's flood thresholds for a monitor that will not stop talking. */
export const QUIET_GAP_MS = 2_000;
export const KILL_AFTER_MS = 600_000;

/** A hard backstop so a runaway script cannot flood the transcript. */
export const MAX_EVENTS = 2_000;

export type MonitorCause = "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded";

export interface MonitorWake {
	monitorId: string;
	description: string;
	kind: "command" | "ws";
	cause: MonitorCause;
	/** The lines that triggered this wake. */
	lines: string[];
	/** How many events this monitor has produced so far. */
	eventCount: number;
	/** The /loop chain this monitor belongs to, when one was named. */
	loopPrompt?: string;
}

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
	eventCount: number;
	status: MonitorStatus;
	/** The exit code of a command monitor, once it ended. */
	exitCode?: number | null;
	loopPrompt?: string;
	outputPath: string;
	stderrPath: string;
	child?: ChildProcess;
	socket?: WebSocket;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	batcher?: LineBatcher;
	flood?: FloodGuard;
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
	status: MonitorStatus;
	exitCode?: number | null;
	loopPrompt?: string;
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

function generateId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** A compact one-line call row for a tool. */
function toolCall(label: string, detail: string, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold(label));
	return new Text(detail ? `${title} ${theme.fg("muted", detail)}` : title, 0, 0);
}

/** A compact one-line result row for a tool. */
function toolResult(
	summary: string,
	detail: string | undefined,
	options: { expanded: boolean; isPartial: boolean; isError: boolean },
	theme: Theme,
): Text {
	if (options.isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
	const prefix = options.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
	const body = options.isError ? theme.fg("error", summary) : theme.fg("toolOutput", summary);
	const text = prefix + body;
	if (options.expanded && detail) return new Text(`${text}\n${theme.fg("dim", detail)}`, 0, 0);
	return new Text(text, 0, 0);
}

/** Hide the call row once the result has arrived, leaving one result line. */
function completedCall(): Container {
	return new Container();
}

/** The first text line of a tool result, used as a fallback summary. */
function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	for (const block of result.content ?? []) {
		if (block?.type === "text" && typeof block.text === "string") {
			return block.text.split("\n")[0] ?? "";
		}
	}
	return "";
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
		status: record.status,
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.loopPrompt !== undefined ? { loopPrompt: record.loopPrompt } : {}),
		outputPath: record.outputPath,
		stderrPath: record.stderrPath,
	};
}

function monitorSummary(record: MonitorSnapshot): string {
	const events = `${record.eventCount} event${record.eventCount === 1 ? "" : "s"}`;
	return `${record.id} ${record.status} (${events})`;
}

// ------------------------------------------------------------------ extension

export default function piCcMonitorExtension(pi: ExtensionAPI): void {
	const monitors = new Map<string, MonitorRecord>();
	let lastCtx: ExtensionContext | undefined;

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	/**
	 * Deliver an event to the agent.
	 *
	 * The bus event is emitted first so a listener (pi-cc-loop) can supersede
	 * a pending fallback heartbeat before the turn starts. `followUp` keeps the
	 * message in the low-priority lane: it waits for the current turn to end
	 * instead of cutting into it.
	 */
	function emitWake(record: MonitorRecord, lines: string[], cause: MonitorCause): void {
		const payload: MonitorWake = {
			monitorId: record.id,
			description: record.description,
			kind: record.kind,
			cause,
			lines,
			eventCount: record.eventCount,
			...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}),
		};
		try {
			pi.events.emit(WAKE_CHANNEL, payload);
		} catch {
			// a listener must never break the monitor
		}

		const header = `[monitor · ${record.description}]`;
		const body = lines.length ? lines.join("\n") : describeCause(record, cause);
		pi.sendMessage(
			{
				customType: EVENT_MESSAGE_TYPE,
				content: `${header}\n${body}`,
				display: true,
				details: {
					monitorId: record.id,
					description: record.description,
					cause,
					lines,
					eventCount: record.eventCount,
					exitCode: record.exitCode,
					outputPath: record.outputPath,
					stderrPath: record.stderrPath,
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	function describeCause(record: MonitorRecord, cause: MonitorCause): string {
		const events = `${record.eventCount} event${record.eventCount === 1 ? "" : "s"}`;
		switch (cause) {
			case "exit": {
				const code = record.exitCode;
				const codeText = code === null || code === undefined ? "no exit code" : `exit code ${code}`;
				return `the watch ended (${codeText}, ${events})`;
			}
			case "timeout":
				return `the watch timed out (${events})`;
			case "error":
				return `the watch failed (${events})`;
			case "closed":
				return `the socket closed (${events})`;
			case "stopped":
				return `the watch was stopped (${events})`;
			case "flooded":
				return `the watch produced too much output and was stopped (${events})`;
			default:
				return `the watch produced an event (${events})`;
		}
	}

	function finalize(record: MonitorRecord, status: MonitorStatus): void {
		if (record.status !== "running") return;
		record.status = status;
		if (record.timeoutTimer) {
			clearTimeout(record.timeoutTimer);
			record.timeoutTimer = undefined;
		}
	}

	function stopMonitor(record: MonitorRecord, cause: MonitorCause, notifyAgent: boolean): void {
		if (record.status !== "running") return;
		finalize(record, cause === "stopped" ? "stopped" : cause === "timeout" ? "timed_out" : cause === "flooded" ? "flooded" : "failed");
		killTree(record.child);
		try {
			record.socket?.close();
		} catch {
			// already closed
		}
		record.batcher?.flushRemainder();
		if (notifyAgent) emitWake(record, [], cause);
	}

	/**
	 * A /loop chain ended: stop the monitors that named it. Without this a
	 * monitor keeps firing, wakes the agent, and the agent reschedules the
	 * loop the user just stopped.
	 */
	pi.events.on(LOOP_STOPPED_CHANNEL, (data) => {
		const payload = data as { prompt?: string; reason?: string } | undefined;
		if (!payload?.prompt) return;
		for (const record of [...monitors.values()]) {
			if (record.loopPrompt !== payload.prompt) continue;
			if (record.status !== "running") continue;
			stopMonitor(record, "stopped", false);
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

	function armCommand(
		input: {
			command: string;
			description: string;
			timeoutMs: number;
			persistent: boolean;
			loopPrompt?: string;
		},
		ctx: ExtensionContext,
	): MonitorRecord {
		const id = generateId();
		const dir = outputDir();
		const record: MonitorRecord = {
			id,
			kind: "command",
			description: input.description,
			command: input.command,
			timeoutMs: input.persistent ? 0 : input.timeoutMs,
			persistent: input.persistent,
			createdAt: Date.now(),
			eventCount: 0,
			status: "running",
			loopPrompt: input.loopPrompt,
			outputPath: path.join(dir, `${id}.out.log`),
			stderrPath: path.join(dir, `${id}.err.log`),
		};
		monitors.set(id, record);

		record.batcher = new LineBatcher({
			windowMs: BATCH_WINDOW_MS,
			onBatch: (lines) => {
				record.eventCount += lines.length;
				emitWake(record, lines, "output");
				if (record.eventCount >= MAX_EVENTS && record.status === "running") {
					stopMonitor(record, "flooded", true);
				}
			},
			onLine: () => record.flood?.noteOutput(),
		});
		record.flood = new FloodGuard({
			quietGapMs: QUIET_GAP_MS,
			killAfterMs: KILL_AFTER_MS,
			onFlood: () => {
				if (record.status === "running") stopMonitor(record, "flooded", true);
			},
		});

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
				record.batcher?.push(chunk);
				record.flood?.isFlooding();
			},
			onStderr: () => {
				// stderr goes to the output file, it never triggers a notification
			},
			onExit: (code) => {
				record.exitCode = code;
				// Flush anything the batcher still holds before reporting the exit,
				// otherwise the events arrive after the "watch ended" notice.
				record.batcher?.flushRemainder();
				finalize(record, "exited");
				emitWake(record, [], "exit");
			},
			onError: (error) => {
				finalize(record, "failed");
				emitWake(record, [error.message], "error");
			},
		});

		if (!input.persistent) {
			record.timeoutTimer = setTimeout(() => {
				if (record.status === "running") stopMonitor(record, "timeout", true);
			}, record.timeoutMs);
			record.timeoutTimer.unref?.();
		}

		return record;
	}

	function armWebSocket(
		input: {
			url: string;
			protocols?: string[];
			description: string;
			timeoutMs: number;
			persistent: boolean;
			loopPrompt?: string;
		},
		ctx: ExtensionContext,
	): MonitorRecord {
		const id = generateId();
		const dir = outputDir();
		const record: MonitorRecord = {
			id,
			kind: "ws",
			description: input.description,
			wsUrl: input.url,
			timeoutMs: input.persistent ? 0 : input.timeoutMs,
			persistent: input.persistent,
			createdAt: Date.now(),
			eventCount: 0,
			status: "running",
			loopPrompt: input.loopPrompt,
			outputPath: path.join(dir, `${id}.out.log`),
			stderrPath: path.join(dir, `${id}.err.log`),
		};
		monitors.set(id, record);

		record.batcher = new LineBatcher({
			windowMs: BATCH_WINDOW_MS,
			onBatch: (lines) => {
				record.eventCount += lines.length;
				emitWake(record, lines, "output");
				if (record.eventCount >= MAX_EVENTS && record.status === "running") {
					stopMonitor(record, "flooded", true);
				}
			},
		});

		try {
			const socket = input.protocols?.length
				? new WebSocket(input.url, input.protocols)
				: new WebSocket(input.url);
			record.socket = socket;

			socket.addEventListener("message", (event: MessageEvent) => {
				const data = event.data;
				if (typeof data === "string") {
					// A multiline frame stays one event.
					record.batcher?.push(`${data}\n`);
					return;
				}
				const bytes = byteLengthOf(data);
				record.batcher?.push(`[binary frame, ${bytes} bytes]\n`);
			});
			socket.addEventListener("error", () => {
				// Errors are surfaced before the close.
				if (record.status === "running") {
					finalize(record, "failed");
					emitWake(record, ["[WebSocket error]"], "error");
				}
			});
			socket.addEventListener("close", (event: CloseEvent) => {
				record.batcher?.flushRemainder();
				if (record.status !== "running") return;
				finalize(record, "exited");
				emitWake(record, [`[WebSocket closed: ${event.code}]`], "closed");
			});
		} catch (error) {
			finalize(record, "failed");
			emitWake(record, [error instanceof Error ? error.message : String(error)], "error");
		}

		if (!input.persistent && record.status === "running") {
			record.timeoutTimer = setTimeout(() => {
				if (record.status === "running") stopMonitor(record, "timeout", true);
			}, record.timeoutMs);
			record.timeoutTimer.unref?.();
		}

		return record;
	}

	// ---------------------------------------------------------------- tools

	/** A short, human-readable label for a non-output cause. */
	function causeLabel(cause: MonitorCause, exitCode: number | null | undefined): string {
		switch (cause) {
			case "exit":
				return exitCode === null || exitCode === undefined ? "exited" : `exited (code ${exitCode})`;
			case "timeout":
				return "timed out";
			case "error":
				return "failed";
			case "closed":
				return "closed";
			case "stopped":
				return "stopped";
			case "flooded":
				return "stopped (too much output)";
			default:
				return "";
		}
	}

	function causeColor(cause: MonitorCause, exitCode: number | null | undefined): ThemeColor {
		switch (cause) {
			case "exit":
				return exitCode === 0 ? "success" : "error";
			case "timeout":
			case "flooded":
				return "warning";
			case "error":
				return "error";
			default:
				return "muted";
		}
	}

	/**
	 * Draw the event as a quiet block instead of Pi's default
	 * `[pi-cc-monitor-event]` title.
	 */
	pi.registerMessageRenderer(EVENT_MESSAGE_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as {
			description?: string;
			cause?: MonitorCause;
			eventCount?: number;
			monitorId?: string;
			exitCode?: number | null;
		};
		const cause = details.cause ?? "output";
		const text = contentText(message.content);
		const body = stripProvenance(text, /^\[monitor[^\]]*\]\n?/);
		if (!loadConfig().compactMessages) {
			const summary = firstLine(body);
			const header = `monitor · ${details.description ?? "watch"}`;
			const suffix = cause === "output" ? "" : ` (${cause})`;
			return renderCard({
				header: `${header}${suffix}${summary && cause === "output" ? ` · ${summary}` : ""}`,
				body,
				expanded: options.expanded,
				outputPad: options.outputPad,
				theme,
			});
		}

		const stamp = formatStamp(message.timestamp);
		const parts = [theme.fg("accent", theme.bold("monitor"))];
		if (stamp) parts.push(theme.fg("muted", stamp));
		if (details.description) parts.push(theme.fg("customMessageText", details.description));
		const causeText = causeLabel(cause, details.exitCode);
		if (causeText) parts.push(theme.fg(causeColor(cause, details.exitCode), causeText));
		const header = parts.join(theme.fg("dim", " · "));

		const meta: string[] = [];
		if (details.monitorId) meta.push(`id ${details.monitorId}`);
		if (details.eventCount !== undefined) {
			meta.push(`${details.eventCount} event${details.eventCount === 1 ? "" : "s"}`);
		}

		return renderBlock({
			header,
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
		description:
			"Start a background watch that turns output into notifications. Each stdout line (or each WebSocket " +
			"text frame) is one event that wakes the agent. Exit ends the watch. Use it to be told the moment " +
			"something happens instead of polling for it. Only stdout triggers notifications; stderr is written to " +
			"the output file and can be read with the read tool.",
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
						"The /loop chain this monitor belongs to. When set, the loop's fallback heartbeat is superseded by each event.",
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
					throw new Error(`timeout_ms must be ≥ ${MIN_TIMEOUT_MS}`);
				}
				if (timeoutMs > MAX_TIMEOUT_MS) {
					throw new Error(`timeout_ms must be ≤ ${MAX_TIMEOUT_MS}`);
				}
			}

			let record: MonitorRecord;
			if (hasCommand) {
				const command = params.command as string;
				if (!command.trim()) throw new Error("command must not be empty");
				if (hasControlChars(command)) {
					throw new Error("command contains control characters that would be hidden in the approval dialog");
				}
				record = armCommand(
					{
						command,
						description: params.description,
						timeoutMs,
						persistent,
						loopPrompt: params.loopPrompt,
					},
					ctx,
				);
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
				record = armWebSocket(
					{
						url: ws.url,
						protocols: ws.protocols,
						description: params.description,
						timeoutMs,
						persistent,
						loopPrompt: params.loopPrompt,
					},
					ctx,
				);
			}

			const lifetime = record.persistent
				? "for the lifetime of the session"
				: `for ${Math.round(record.timeoutMs / 60000)} minutes`;
			return {
				content: [
					{
						type: "text",
						text:
							`Monitor ${record.id} armed · ${record.description} · watching ${lifetime}. ` +
							`Stop it with monitor_stop { "id": "${record.id}" }.`,
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
		description: "Stop a running monitor by its id.",
		parameters: Type.Object({
			id: Type.String({ description: "The monitor id returned by Monitor." }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const record = monitors.get(params.id);
			if (!record) {
				return {
					content: [{ type: "text" as const, text: `No monitor with id ${params.id}.` }],
					details: { stopped: false, id: params.id },
				};
			}
			stopMonitor(record, "stopped", true);
			return {
				content: [{ type: "text" as const, text: `Stopped monitor ${params.id}.` }],
				details: { stopped: true, id: params.id },
			};
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description: "List the monitors of this session with their ids, state and event counts.",
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
					const age = Math.round((Date.now() - record.createdAt) / 1000);
					const target = record.kind === "ws" ? record.wsUrl : record.command;
					return `${record.id}  ${record.status}  ${record.kind}  ${record.eventCount} events  ${age}s  ${record.description}  ${target ?? ""}`;
				})
				.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { monitors: list },
			};
		},
	});

	// -------------------------------------------------------------- rendering

	/**
	 * Compact one-line tool rows.
	 *
	 * The resolver is consulted every time a tool row renders, so setting
	 * `compactToolRows` to false falls back to Pi's default rendering without
	 * re-registering the tool or reloading the extension.
	 */
	function registerToolRenderers(): void {
		if (typeof pi.registerToolRenderer !== "function") return;
		const renderers: Record<string, ToolRenderers> = {
			Monitor: {
				renderCall(args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					const description = truncate(args.description ?? "", 40);
					const target = args.ws?.url ? `ws ${truncate(args.ws.url, 40)}` : truncate(args.command ?? "", 40);
					return toolCall("Watch", [description, target].filter(Boolean).join(" · "), theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as {
						taskId?: string;
						timeoutMs?: number;
						persistent?: boolean;
						outputPath?: string;
						stderrPath?: string;
					};
					const lifetime = d.persistent
						? "session lifetime"
						: `${Math.round((d.timeoutMs ?? 0) / 60_000)}m timeout`;
					const description = context.args.description
						? ` · ${truncate(context.args.description, 40)}`
						: "";
					const summary = `Armed ${d.taskId ?? "?"} · ${lifetime}${description}`;
					const detail = options.expanded
						? [
								context.args.command ? `command: ${context.args.command}` : undefined,
								context.args.ws?.url ? `ws: ${context.args.ws.url}` : undefined,
								d.outputPath ? `output: ${d.outputPath}` : undefined,
								d.stderrPath ? `stderr: ${d.stderrPath}` : undefined,
							]
								.filter(Boolean)
								.join("\n")
						: undefined;
					return toolResult(
						summary,
						detail || undefined,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
			monitor_stop: {
				renderCall(args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					return toolCall("Stop", args.id ?? "", theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as { stopped?: boolean; id?: string };
					const summary = d.stopped ? `Stopped ${d.id ?? "?"}` : `No monitor ${d.id ?? "?"}`;
					return toolResult(
						summary,
						undefined,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
			monitor_list: {
				renderCall(_args: any, theme: Theme, context: any) {
					if (!context.isPartial && context.executionStarted) return completedCall();
					return toolCall("List monitors", "", theme);
				},
				renderResult(result: any, options: any, theme: Theme, context: any) {
					if (context.isError) {
						return toolResult(
							resultText(result) || "Failed",
							undefined,
							{ expanded: options.expanded, isPartial: options.isPartial, isError: true },
							theme,
						);
					}
					const d = (result.details ?? {}) as { monitors?: MonitorSnapshot[] };
					const list = d.monitors ?? [];
					let summary: string;
					if (!list.length) summary = "No monitors";
					else if (list.length === 1) summary = `1 monitor · ${monitorSummary(list[0])}`;
					else {
						const shown = list.slice(0, 2).map(monitorSummary).join(" · ");
						summary = `${list.length} monitors · ${shown}${list.length > 2 ? " …" : ""}`;
					}
					const detail = options.expanded
						? list.map((record) => `${monitorSummary(record)} · ${record.description}`).join("\n")
						: undefined;
					return toolResult(
						summary || resultText(result),
						detail,
						{ expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
						theme,
					);
				},
			},
		};

		pi.registerToolRenderer((toolName, next) => {
			if (!loadConfig().compactToolRows) return next();
			return renderers[toolName] ?? next();
		});
	}

	registerToolRenderers();

	/** pi-cc-loop owns the shared exclusion list when it is installed. */
	function loopToolAvailable(): boolean {
		try {
			return pi.getAllTools().some((tool) => tool.name === "cron_create");
		} catch {
			return false;
		}
	}

	// The loop extension writes the shared config file and announces the change.
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		if (!loopToolAvailable()) {
			syncPiCcExtensionsExcludes(MONITOR_TOOL_NAMES, loadConfig().compactToolRows);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (!loopToolAvailable() && syncPiCcExtensionsExcludes(MONITOR_TOOL_NAMES, loadConfig().compactToolRows)) {
			notify(ctx, "pi-cc-extensions excludeRenderers updated · /reload to apply", "info");
		}
	});

	// --------------------------------------------------------------- lifecycle

	pi.on("session_shutdown", async () => {
		for (const record of monitors.values()) {
			stopMonitor(record, "stopped", false);
		}
		monitors.clear();
	});
}

function byteLengthOf(data: unknown): number {
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
	return 0;
}
