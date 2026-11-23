/**
 * pi-cc-monitor — background commands and Claude Code-style event monitors.
 *
 * `mode: "completion"` runs a shell command without blocking the agent: its
 * stdout/stderr go to log files and its terminal result arrives once at the
 * next response/tool-batch boundary, without interrupting active work.
 * `mode: "events"` delivers stdout lines or WebSocket text frames as events. Omitting
 * mode preserves the original events behaviour.
 *
 * The schema extends Claude Code's Monitor:
 *
 *   action      "start" | "update"?      default start; update is explicit
 *   id          string?                  update target; never starts work
 *   mode        "completion" | "events"? notification semantics (default events)
 *   command     string?                  shell command or script
 *   ws          object?                  { url, protocols? }; events only
 *   source      { monitorId }?            events-only live output subscription
 *   watches     WatchRule[]?              source observers; [] mutes, omitted
 *                                         means all stdout
 *   notify      object?                  output turn/context/none, terminal
 *                                         turn/context (defaults turn)
 *   description string                   start only; shown in notifications
 *   timeout_ms  number?                  min 1000; events default 300000, max
 *                                         3600000; completion default 1800000,
 *                                         max 7200000
 *   persistent  boolean?                 default false; run until session end
 *   loopPrompt  string?                  optionally bind a watch to /loop
 *
 * Exactly one of command, ws or source.monitorId is required for start;
 * update only accepts id, watches and notify and never restarts work.
 * Control characters are refused, ws urls must be ASCII ws:// or wss://
 * without userinfo or whitespace, and ws protocols must be unique RFC 6455
 * tokens. loopPrompt only takes effect when pi-cc-loop is loaded; without it
 * this package stands alone.
 *
 * Event watches retain Claude Code's 200ms batches, output caps and rate
 * limits. Completion commands deliberately bypass that event pipeline: logs
 * can be chatty without waking the agent, and exit/timeout/stop still ends the
 * record exactly once with at most one closing notice. That notice names the
 * outcome \u2014 completed, failed, or stopped at its background time limit \u2014 and
 * carries a bounded tail of both logs, so the model usually need not read
 * them again; the full logs stay on disk. Output is never streamed while a
 * completion runs.
 */

import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invalidateConfig, loadConfig } from "./config.ts";
import { CONFIG_CHANNEL, registerPiCcCommand } from "./settings.ts";
import { killTree, processGroupAlive, spawnMonitor, stopProcessGroup, KILL_CONFIRMATION_MS } from "./process.ts";
import { MONITOR_DESCRIPTION, MONITOR_LIST_SNIPPET, MONITOR_PROMPT_GUIDELINES, MONITOR_SNIPPET, MONITOR_STOP_SNIPPET, MONITOR_TIMEOUTS } from "./prompts.ts";
import { monitorEnv, monitorShell, prefixedCommand, type MonitorShell, type ShellSettings } from "./shell.ts";
import { capEventLines, LineBatcher, MAX_BATCH_CHARS, MAX_LINE_CHARS, RateLimiter } from "./stream.ts";
import { readLogTail, sanitizeDisplay, type LogTail } from "./log-tail.ts";
import { DEFAULT_NOTIFY, OutputBudget, outputLevel, strongerLevel, type NotifyPolicy, type OutputLevel, type TerminalLevel } from "./notification-budget.ts";
import { OutputLines, WatchRules, validateWatches, MAX_WATCHES, MAX_WATCH_TEXT, type WatchRule, type WatchState, type OutputStream } from "./watches.ts";
import { cleanOldLogDirectories, createLogDirectory } from "./log-store.ts";
import { registerTaskProvider, type TaskDetail, type TaskItem, type TaskStopResult } from "./tasks.ts";
import { formatDuration, releaseNotificationHover, setNotificationTui } from "./render.ts";
import { renderMonitorMessage } from "./message-render.ts";
import { displayLine, monitorBadges, monitorListText, monitorRole, observationLabel, startReceipt, stopReceipt, stopScope, updateReceipt } from "./monitor-view.ts";

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

/** This extension's slot in Pi's footer; pi-cc-loop uses "loop". */
const STATUS_KEY = "monitor";

/** Stable exports; the tool description and runtime share the same deadlines. */
export const DEFAULT_TIMEOUT_MS = MONITOR_TIMEOUTS.events.defaultMs;
export const MAX_TIMEOUT_MS = MONITOR_TIMEOUTS.events.maxMs;
export const DEFAULT_COMPLETION_TIMEOUT_MS = MONITOR_TIMEOUTS.completion.defaultMs;
export const MAX_COMPLETION_TIMEOUT_MS = MONITOR_TIMEOUTS.completion.maxMs;
export const MIN_TIMEOUT_MS = 1_000;
/** Terminal records retained after delivery and resource cleanup; active/pending records never count. */
export const ENDED_MONITOR_HISTORY_LIMIT = 50;

/** Claude Code batches stdout lines within 200ms into a single notification. */
export const BATCH_WINDOW_MS = 200;

/** A ws log's queued writes are capped; past this the log degrades, the watch continues. */
const WS_LOG_BACKLOG_LIMIT_BYTES = 4 * 1024 * 1024;

export type MonitorCause = "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded" | "stop_timeout";

/** Claude Code's notice when a monitor is stopped. */
export const STOPPED_NOTICE = "[Monitor stopped]";

export type MonitorStatus = "running" | "stopping" | "stop_timeout" | "stopped" | "exited" | "completed" | "timed_out" | "failed" | "flooded";
export type MonitorMode = "completion" | "events";

export interface MonitorRecord {
	id: string;
	kind: "command" | "ws" | "source";
	mode: MonitorMode;
	description: string;
	command?: string;
	wsUrl?: string;
	timeoutMs: number;
	persistent: boolean;
	createdAt: number;
	/** Events delivered to the agent. */
	eventCount: number;
	/** Events dropped by the per-source rate limit. */
	suppressedCount: number;
	globalSuppressedCount: number;
	notify: NotifyPolicy;
	pendingLevel?: OutputLevel;
	finalBatch?: { lines: string[]; count: number };
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
	/** Execution/notification state is not the resource-cleanup barrier. */
	resourceActive?: boolean;
	socketClosed?: boolean;
	sourceId?: string;
	matcher?: WatchRules;
	outputLines?: { stdout: OutputLines; stderr: OutputLines };
	finalized?: boolean;
	pendingStop?: Promise<boolean>;
	cleanupTimer?: ReturnType<typeof setTimeout>;
	/** Bounded stdout/stderr tails captured once for a completion's terminal notice. */
	tails?: { stdout: LogTail; stderr: LogTail };
	/** Closes a ws monitor's log; a command monitor's logs close with its process. */
	closeLog?: () => void;
	/** Set when a ws log stopped early (write error or backlog cap); the log is incomplete. */
	logError?: string;
	timeoutTimer?: ReturnType<typeof setTimeout>;
	batcher?: LineBatcher;
	limiter: RateLimiter;
}

/** A serializable view of a monitor, safe to put in tool result details (and in a codemode script). */
export type MonitorSnapshot = {
	id: string;
	kind: "command" | "ws" | "source";
	sourceId?: string;
	watches?: WatchState[];
	mode: MonitorMode;
	description: string;
	command?: string;
	wsUrl?: string;
	timeoutMs: number;
	persistent: boolean;
	createdAt: number;
	eventCount: number;
	suppressedCount: number;
	globalSuppressedCount: number;
	notify: NotifyPolicy;
	resourceActive?: boolean;
	status: MonitorStatus;
	endedAt?: number;
	exitCode?: number | null;
	loopPrompt?: string;
	/** Process id of a command monitor's shell. */
	pid?: number;
	outputPath: string;
	stderrPath: string;
	logError?: string;
};

// ------------------------------------------------------------------ helpers

/** Control characters would be invisible in an approval dialog. */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f]/;

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

const WS_URL_ERROR = "url must be a valid ASCII ws:// or wss:// URL with no userinfo and no tabs or newlines";

function isValidProtocols(protocols: string[] | undefined): boolean {
	if (!protocols) return true;
	if (new Set(protocols).size !== protocols.length) return false;
	return protocols.every((p) => RFC6455_TOKEN.test(p));
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

/**
 * A loop's prompt as pi-cc-loop keys it: a leading `/loop ` dropped (models
 * quote the request back either way, and schedule_wakeup stores the bare form).
 */
function chainPrompt(prompt: string): string {
	return prompt.trim().replace(/^\/loop\s+/i, "").trim();
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
	if (record.mode === "completion") {
		return [
			`[Monitor stopped \u2014 background time limit of ${after}: the command was killed before it finished, ` +
				`so its logs may be incomplete. Rerun it with a longer timeout only if it was still making progress. ` +
				`Output: ${record.outputPath}; stderr: ${record.stderrPath}]`,
			...completionTailLines(record),
		].join("\n");
	}
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
	if (record.mode === "completion") {
		const banner = record.status === "completed" ? "Monitor completed" : "Monitor failed";
		return [
			`[${banner} \u2014 ${how}. Output: ${record.outputPath}; stderr: ${record.stderrPath}]`,
			"Read and verify the outputs and result files before using this task's result. The log tail below is not verification. Continue any independent work; write the final report only when all required results have been obtained and verified. If the exit is nonzero or outputs are missing, report that honestly instead of a success.",
			...completionTailLines(record),
		].join("\n");
	}
	return `[Monitor ended \u2014 ${how}, ${eventsText(record.eventCount)} delivered${suppressed}]`;
}

/**
 * The bounded tail a completion's terminal notice carries: stdout always, and
 * stderr only when it has output \u2014 an empty stderr says nothing the banner's
 * path has not already named, so it gets no section (a read error is kept:
 * it says the tail is not merely empty). The full logs stay on disk \u2014 this is
 * only enough to usually avoid a second read.
 */
function completionTailLines(record: MonitorRecord): string[] {
	if (!record.tails) return [];
	return [...tailSection("stdout", record.tails.stdout), ...tailSection("stderr", record.tails.stderr)];
}

function tailSection(label: "stdout" | "stderr", tail: LogTail): string[] {
	// stdout is the thing that was asked for, so its empty case is marked; a
	// stderr with neither text nor a note stays silent \u2014 the banner already
	// carries its path, and "(no output)" is not information.
	if (!tail.text) {
		if (label === "stderr" && !tail.note) return [];
		return [`${label}: (${tail.note ?? "no output"})`];
	}
	const mark = tail.truncated ? ` (${tail.note ?? "truncated"})` : "";
	return [`${label} tail${mark}:`, tail.text];
}

/** Read both logs' bounded tails once, when the terminal notice is sent. */
function captureCompletionTails(record: MonitorRecord): void {
	try {
		record.tails = {
			stdout: readLogTail(record.outputPath),
			stderr: readLogTail(record.stderrPath),
		};
	} catch {
		// a tail is a convenience; the log paths in the notice remain the truth
	}
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
		mode: record.mode,
		description: record.description,
		...(record.command !== undefined ? { command: record.command } : {}),
		...(record.wsUrl !== undefined ? { wsUrl: record.wsUrl } : {}),
		...(record.sourceId ? { sourceId: record.sourceId } : {}),
		...(record.matcher ? { watches: record.matcher.snapshot() } : {}),
		timeoutMs: record.timeoutMs,
		persistent: record.persistent,
		createdAt: record.createdAt,
		eventCount: record.eventCount,
		suppressedCount: record.suppressedCount,
		globalSuppressedCount: record.globalSuppressedCount,
		notify: { ...record.notify },
		...(record.resourceActive ? { resourceActive: true } : {}),
		status: record.status,
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
		...(record.loopPrompt !== undefined ? { loopPrompt: record.loopPrompt } : {}),
		...(record.child?.pid !== undefined ? { pid: record.child.pid } : {}),
		outputPath: record.outputPath,
		stderrPath: record.stderrPath,
		...(record.logError !== undefined ? { logError: record.logError } : {}),
	};
}

// ------------------------------------------------------------------ extension

export default function piCcMonitorExtension(pi: ExtensionAPI): void {
	const monitors = new Map<string, MonitorRecord>();
	// Keep actual resources after logical stop/exit until their disappearance is confirmed.
	const liveResources = new Map<string, MonitorRecord>();
	const observers = new Map<string, Set<string>>();
	const pendingEndings = new Map<string, Ending>();
	// Terminal outcomes stay outside Esc-clearable queues until a safe boundary or idle.
	const pendingCompletions = new Map<string, { message: Parameters<ExtensionAPI["sendMessage"]>[0]; terminal: TerminalLevel }>();
	const outputBudget = new OutputBudget();
	const globallySuppressed = new Map<string, number>();
	let summaryTimer: ReturnType<typeof setTimeout> | undefined;
	let idleFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let logDirectory: ReturnType<typeof createLogDirectory> | undefined;
	let lastCtx: ExtensionContext | undefined;

	function outputDir(): string {
		return (logDirectory ??= createLogDirectory()).path;
	}
	/**
	 * True once the session is shutting down. Pi invalidates this extension's
	 * API right after `session_shutdown` (quit, reload, new, resume, fork); a
	 * child-process callback that touched it afterwards would throw an uncaught
	 * exception, and Pi exits on uncaught exceptions.
	 */
	let disposed = false;
	let pruneQueued = false;

	/**
	 * Bound model-list output, panel history and retained tails without dropping
	 * an outcome or a resource that still needs its record. Sources with live
	 * observers also stay available for identity and log sharing.
	 */
	function pruneEndedMonitors(): void {
		const eligible = [...monitors.values()].filter((record) =>
			record.finalized === true &&
			!isActive(record) &&
			!record.pendingStop &&
			!pendingCompletions.has(record.id) &&
			!pendingEndings.has(record.id) &&
			!(observers.get(record.id)?.size),
		);
		if (eligible.length <= ENDED_MONITOR_HISTORY_LIMIT) return;
		eligible.sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
		const removeCount = eligible.length - ENDED_MONITOR_HISTORY_LIMIT;
		for (const record of eligible.slice(0, removeCount)) monitors.delete(record.id);
		tasks.changed();
	}

	/** Never prune re-entrantly inside finalizeEnd -> deliver -> flushCompletions. */
	function scheduleMonitorPrune(): void {
		if (disposed || pruneQueued) return;
		pruneQueued = true;
		queueMicrotask(() => {
			pruneQueued = false;
			if (!disposed) pruneEndedMonitors();
		});
	}

	let lastStatusText: string | undefined;

	/**
	 * One chip in Pi's footer while monitors run: `2 monitors`, in the format of
	 * pi-cc-loop's chip (`2 loops \u00b7 next 3m`). Claude Code uses the same
	 * count-first pluralization and shows nothing when none is running. Called
	 * when a monitor starts or ends and when the shared settings change; the
	 * footer is UI only, the model never sees it.
	 */
	function refreshStatus(): void {
		if (disposed) return;
		tasks.changed();
		const ctx = lastCtx;
		if (!ctx || !ctx.hasUI) return;
		try {
			// Older Pi versions have no footer status API.
			if (typeof ctx.ui.setStatus !== "function") return;
			const running = [...monitors.values()].filter(isActive).length;
			const label = running === 1 ? "monitor" : "monitors";
			const text = loadConfig().footer && running > 0 ? `${running} ${label}` : undefined;
			// Every call repaints, even with the same text, so speak only on change.
			// lastStatusText !== undefined doubles as "a status is set".
			if (text === lastStatusText) return;
			lastStatusText = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// a stale context must never break the monitor
		}
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (disposed) return;
		try {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		} catch {
			// a stale context must never break the monitor
		}
	}

	/** Live output steers; terminal results append context at safe boundaries or wake from idle. */
	function publish(message: Parameters<ExtensionAPI["sendMessage"]>[0], mode: MonitorMode, triggerTurn = true): boolean {
		if (disposed) return false;
		try {
			pi.sendMessage(message, { deliverAs: mode === "completion" ? "followUp" : "steer", triggerTurn });
			return true;
		} catch {
			return false; // A stale session must never break a process callback.
		}
	}

	/** Returns whether a turn-level outcome was successfully handed off. */
	function flushCompletions(triggerTurn: boolean): boolean {
		let hasTurnResult = false;
		for (const [id, pending] of [...pendingCompletions]) {
			if (publish(pending.message, "completion", triggerTurn && pending.terminal !== "context")) {
				pendingCompletions.delete(id);
				hasTurnResult ||= pending.terminal === "turn";
			}
		}
		if (!pendingCompletions.size && idleFallbackTimer) {
			clearTimeout(idleFallbackTimer);
			idleFallbackTimer = undefined;
		}
		scheduleMonitorPrune();
		return hasTurnResult;
	}

	/**
	 * A cancelled or failed /tree navigation returns to idle without emitting
	 * session_tree or agent_settled, which would strand the outbox. One timer,
	 * armed only while results are pending, polls for that recovered idle and
	 * delivers context-only so an interrupted turn is never restarted; normal
	 * settlement still owns the wakeup and empties the outbox first.
	 */
	function scheduleIdleFallback(): void {
		if (disposed || idleFallbackTimer || !pendingCompletions.size) return;
		idleFallbackTimer = setTimeout(() => {
			idleFallbackTimer = undefined;
			if (disposed || !pendingCompletions.size) return;
			if (lastCtx?.isIdle()) flushCompletions(false);
			else scheduleIdleFallback();
		}, 200);
		idleFallbackTimer.unref?.();
	}

	function summaryLine(): string | undefined {
		if (!globallySuppressed.size) return undefined;
		const total = [...globallySuppressed.values()].reduce((sum, count) => sum + count, 0);
		const sources = globallySuppressed.size;
		globallySuppressed.clear();
		if (summaryTimer) clearTimeout(summaryTimer);
		summaryTimer = undefined;
		return `[Session output budget: ${total} events suppressed from ${sources} monitors; raw logs are unchanged. See monitor_list for sources.]`;
	}

	function scheduleSummary(): void {
		if (disposed || summaryTimer || !globallySuppressed.size) return;
		summaryTimer = setTimeout(() => {
			summaryTimer = undefined;
			if (disposed || !globallySuppressed.size) return;
			// The budget summary is an accounting notice, not event output: it does
			// not consume a slot, so sustained output cannot starve it.
			const line = summaryLine();
			if (!line) return;
			publish({ customType: EVENT_MESSAGE_TYPE, content: `monitor session · output budget\n${line}`, display: true,
				details: { mode: "events", description: "session output budget", cause: "output", lines: [line], notifyLevel: "context" } }, "events", false);
		}, outputBudget.remainingMs());
		summaryTimer.unref?.();
	}

	function forgetSuppression(id: string): void {
		globallySuppressed.delete(id);
		if (!globallySuppressed.size && summaryTimer) clearTimeout(summaryTimer);
		if (!globallySuppressed.size) summaryTimer = undefined;
	}

	function parseNotify(value: Partial<NotifyPolicy> | undefined, base: Readonly<NotifyPolicy> = DEFAULT_NOTIFY): NotifyPolicy {
		if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "output" && key !== "terminal"))) throw new Error("notify accepts only output and terminal");
		const policy = { ...base, ...value };
		if (!["turn", "context", "none"].includes(policy.output)) throw new Error("notify.output must be turn, context or none");
		if (!["turn", "context"].includes(policy.terminal)) throw new Error("notify.terminal must be turn or context; failures cannot be hidden");
		return policy;
	}

	function deliver(record: MonitorRecord, cause: MonitorCause, lines: string[], level: OutputLevel = record.notify.terminal, final = false): boolean {
		if (disposed) return false;
		const events = record.mode === "events";
		// The model-facing header is always one sanitized line; metadata keeps the original.
		const description = sanitizeDisplay(record.description).replace(/\s+/g, " ").trim();
		const rawHeader = `monitor ${record.id} \u00b7 ${description}`;
		const header = capEventLines([rawHeader], MAX_LINE_CHARS).join(" ");
		// The final budget includes the envelope and every post-batch notice.
		const body = events ? capEventLines(lines, MAX_BATCH_CHARS - header.length - 1) : lines;
		const message = {
			customType: EVENT_MESSAGE_TYPE,
			content: `${header}\n${body.join("\n")}`,
			display: true,
			details: {
				monitorId: record.id,
				kind: record.kind,
				mode: record.mode,
				description: record.description,
				createdAt: record.createdAt,
				endedAt: record.endedAt,
				resourceActive: record.resourceActive === true,
				timeoutMs: record.timeoutMs,
				persistent: record.persistent,
				notify: { ...record.notify },
				...(record.command !== undefined ? { command: record.command } : {}),
				...(record.wsUrl !== undefined ? { wsUrl: record.wsUrl } : {}),
				...(record.matcher ? { watchCount: record.matcher.snapshot().length } : {}),
				cause,
				lines: cause === "output" ? body : [],
				status: record.status,
				eventCount: record.eventCount,
				exitCode: record.exitCode,
				notifyLevel: level,
				suppressedCount: record.suppressedCount,
				globalSuppressedCount: record.globalSuppressedCount,
				...(record.sourceId ? { sourceId: record.sourceId, sourceDescription: monitors.get(record.sourceId)?.description } : {}),
				...(final ? { finalLines: body.slice(1) } : {}),
				outputPath: record.outputPath,
				stderrPath: record.stderrPath,
				...(record.tails ? {
					stdoutTail: record.tails.stdout.text,
					stdoutTailTruncated: record.tails.stdout.truncated,
					stdoutTailNote: record.tails.stdout.note,
					stderrTail: record.tails.stderr.text,
					stderrTailTruncated: record.tails.stderr.truncated,
					stderrTailNote: record.tails.stderr.note,
				} : {}),
				...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}),
			},
		};
		if (cause !== "output") {
			// Keep critical outcomes outside Esc-clearable queues, in both modes.
			const terminal = cause === "stopped" || cause === "stop_timeout" ? "context" : level === "turn" ? "turn" : "context";
			message.details.notifyLevel = terminal;
			pendingCompletions.set(record.id, { message, terminal });
			if (lastCtx?.isIdle()) flushCompletions(true);
			else scheduleIdleFallback();
			return true;
		}
		return publish(message, "events", level === "turn");
	}

	function deliverOutput(record: MonitorRecord, lines: string[], count: number, requested: OutputLevel): void {
		const level = outputLevel(record.notify.output, requested);
		if (disposed || level === "none") return;
		if (!outputBudget.take()) {
			record.globalSuppressedCount += count;
			globallySuppressed.set(record.id, (globallySuppressed.get(record.id) ?? 0) + count);
			scheduleSummary();
			tasks.changed();
			return;
		}
		const summary = summaryLine();
		record.eventCount += count;
		deliver(record, "output", summary ? [summary, ...lines] : lines, level);
	}

	pi.on("turn_end", (event, ctx) => {
		lastCtx = ctx;
		if (disposed || event.outcome !== "completed" || ctx.signal?.aborted) return;
		// Pi's triggerTurn:false lane appends after this response and all its
		// tool results, outside the Esc-clearable steering/follow-up queues.
		// Request at most one continuation; existing work satisfies it naturally.
		if (flushCompletions(false)) return { continue: true };
	});
	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		// Fallback for results arriving after a boundary, or an interrupted run.
		// Esc aborts the reply, not the outcome: store it without restarting.
		flushCompletions(!event.aborted);
	});
	pi.on("session_compact", (event, ctx) => {
		if (event.reason !== "manual") return;
		lastCtx = ctx;
		flushCompletions(false);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		if (event.reason !== "manual") return;
		lastCtx = ctx;
		flushCompletions(false);
	});
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.isIdle()) flushCompletions(true);
	});

	interface Ending {
		status: Exclude<MonitorStatus, "running" | "stopping" | "stop_timeout">;
		cause: MonitorCause;
		/** The one closing notice the agent gets; omitted for a silent stop. */
		notice?: () => string;
		/** Deliver the output that already arrived before the notice. */
		flush?: boolean;
		/** Kill the process tree and close the socket. */
		kill?: boolean;
	}

	function isActive(record: MonitorRecord): boolean {
		return record.status === "running" || record.status === "stopping" || record.status === "stop_timeout" || record.resourceActive === true;
	}

	function resourceAlive(record: MonitorRecord): boolean {
		if (record.child) return processGroupAlive(record.child);
		return !!record.socket && !record.socketClosed && record.socket.readyState !== 3;
	}

	function releaseResource(record: MonitorRecord): boolean {
		if (resourceAlive(record)) return false;
		liveResources.delete(record.id);
		record.resourceActive = false;
		if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
		record.cleanupTimer = undefined;
		if (!liveResources.size) removeExitHook();
		return true;
	}

	// Only watches an already-stopping owned resource; never reruns work or invokes the model.
	function awaitCleanup(record: MonitorRecord): void {
		// A disposed runtime must not keep polling an unkillable resource forever.
		if (disposed || record.cleanupTimer || !record.resourceActive) return;
		record.cleanupTimer = setTimeout(() => {
			record.cleanupTimer = undefined;
			if (releaseResource(record)) {
				const ending = pendingEndings.get(record.id);
				if (ending) finalizeEnd(record, ending);
				refreshStatus();
			} else awaitCleanup(record);
		}, 100);
		record.cleanupTimer.unref?.();
	}

	async function stopResource(record: MonitorRecord, force = false): Promise<boolean> {
		if (record.child) return stopProcessGroup(record.child, { force });
		if (!resourceAlive(record)) return true;
		try {
			if (force) (record.socket as WebSocket & { terminate?: () => void })?.terminate?.();
			record.socket?.close();
		} catch { /* confirmation, not the request, determines success */ }
		const deadline = Date.now() + KILL_CONFIRMATION_MS;
		while (resourceAlive(record) && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		return !resourceAlive(record);
	}

	/** Finalize once. Forced outcomes can have best-effort tails; natural close flushed both logs. */
	function finalizeEnd(record: MonitorRecord, ending: Ending): void {
		if (record.finalized || record.status === "stopping" && !ending.kill) return;
		if (record.kind === "command") closeObservers(record, ending.cause === "exit" && !ending.kill);
		if (record.kind === "source" && ending.flush && !ending.kill) finishObserver(record);
		const batch = record.finalBatch ?? (ending.flush && !ending.kill ? record.batcher?.drain() : undefined);
		let lastLines: string[] = [];
		if (batch && ending.notice && record.notify.output !== "none") {
			const verdict = record.limiter.take(batch.count);
			if (verdict.deliver) {
				record.eventCount += batch.count;
				lastLines = verdict.suppressed ? [suppressionNotice(verdict.suppressed), ...batch.lines] : batch.lines;
			} else record.suppressedCount += batch.count;
		}
		record.finalBatch = undefined;
		record.pendingLevel = undefined;
		record.finalized = true;
		pendingEndings.delete(record.id);
		record.batcher?.close();
		record.status = ending.status;
		record.endedAt = Date.now();
		if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
		record.timeoutTimer = undefined;
		record.closeLog?.();
		if (record.mode === "completion" && (ending.cause === "exit" || ending.cause === "timeout")) captureCompletionTails(record);
		if (ending.notice) {
			const global = globallySuppressed.get(record.id);
			const lines = [ending.notice(), ...(global ? [`[Session budget suppressed ${global} events from this monitor; raw logs are unchanged.]`] : []), ...lastLines];
			// Context is a hard ceiling; turn is already the strongest level.
			// Merging the last output cannot change the configured terminal policy.
			deliver(record, ending.cause, lines, record.notify.terminal, lastLines.length > 0);
			forgetSuppression(record.id);
		} else if (globallySuppressed.has(record.id)) {
			// A silent end (a source observer closed by its work) still owes the
			// session a context-only account of output the global budget dropped.
			scheduleSummary();
		} else {
			forgetSuppression(record.id);
		}
		if (record.sourceId) {
			const linked = observers.get(record.sourceId);
			linked?.delete(record.id);
			if (!linked?.size) observers.delete(record.sourceId);
		}
		releaseResource(record);
		refreshStatus();
		scheduleMonitorPrune();
	}

	function endMonitor(record: MonitorRecord, ending: Ending): Promise<boolean> {
		if (record.pendingStop) {
			// Loop/shutdown silence must also win over a stop already in flight.
			if (!ending.notice && ending.kill) {
				const pending = pendingEndings.get(record.id);
				if (pending) pending.notice = undefined;
				record.finalBatch = undefined;
			}
			return record.pendingStop;
		}
		if (!ending.kill) {
			if (!record.finalized) finalizeEnd(record, ending);
			return Promise.resolve(!resourceAlive(record));
		}
		if (!record.finalized) {
			if (record.kind === "command") closeObservers(record, ending.notice !== undefined);
			if (record.kind === "source" && ending.flush) finishObserver(record);
			if (ending.flush) record.finalBatch ??= record.batcher?.drain();
			else if (!ending.notice) record.finalBatch = undefined;
			pendingEndings.set(record.id, ending);
			record.status = "stopping";
			record.batcher?.close();
			if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
			record.timeoutTimer = undefined;
			refreshStatus();
		}
		const pending = stopResource(record).then((gone) => {
			if (gone) {
				releaseResource(record);
				finalizeEnd(record, pendingEndings.get(record.id) ?? ending);
			} else {
				if (!record.finalized) {
					record.status = "stop_timeout";
					const pending = pendingEndings.get(record.id);
					if (pending?.notice) {
						deliver(record, "stop_timeout", ["[Monitor stop unconfirmed — the owned resource is still alive; stop can be retried.]"]);
						// This logical stop already reported its unknown outcome; a later
						// disappearance updates status without a second notice. A loop stop
						// has already cleared the pending notice, so it stays silent.
						pending.notice = undefined;
					}
				}
				awaitCleanup(record);
				refreshStatus();
			}
			return gone;
		}).finally(() => { record.pendingStop = undefined; });
		record.pendingStop = pending;
		return pending;
	}

	/** Rate-limit a batch, then deliver it. */
	function onBatch(record: MonitorRecord, lines: string[], count: number): void {
		if (record.status !== "running") return;
		const requested = record.pendingLevel ?? record.notify.output;
		record.pendingLevel = undefined;
		if (record.notify.output === "none") return;
		const verdict = record.limiter.take(count);
		if (verdict.deliver) {
			deliverOutput(record, verdict.suppressed ? [suppressionNotice(verdict.suppressed), ...lines] : lines, count, requested);
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
		tasks.changed();
	}

	/**
	 * Kill every running command monitor at once. Installed as a process exit
	 * hook while monitors run: if Pi exits without a session_shutdown (for
	 * example after an uncaught exception), the detached process groups would
	 * otherwise keep running forever.
	 */
	function killAllNow(): void {
		for (const record of liveResources.values()) {
			killTree(record.child, "SIGKILL");
			try { record.socket?.close(); } catch { /* OS exit also closes sockets */ }
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
	pi.events.on(LOOP_STOPPED_CHANNEL, async (data) => {
		const payload = data as { prompt?: string; reason?: string } | undefined;
		if (!payload?.prompt) return;
		const ended = chainPrompt(payload.prompt);
		const stops: Promise<boolean>[] = [];
		for (const record of [...monitors.values()]) {
			if (record.loopPrompt === undefined || chainPrompt(record.loopPrompt) !== ended) continue;
			pendingCompletions.delete(record.id);
			forgetSuppression(record.id);
			if (!isActive(record)) continue;
			stops.push(endMonitor(record, { status: "stopped", cause: "stopped", kill: true }));
			const ctx = lastCtx;
			if (ctx) {
				notify(
					ctx,
					`Monitor ${record.id} stopped: its /loop chain ended (${payload.reason ?? "stopped"}).`,
					"info",
				);
			}
		}
		await Promise.all(stops);
	});

	// ------------------------------------------------------------- arming

	interface ArmInput {
		description: string;
		mode: MonitorMode;
		timeoutMs: number;
		persistent: boolean;
		loopPrompt?: string;
		notify?: Partial<NotifyPolicy>;
		watches?: WatchRule[];
	}

	/** The parts every monitor shares; only event watches need a batcher. */
	function createRecord(
		kind: MonitorRecord["kind"],
		input: ArmInput,
		target: { command?: string; wsUrl?: string; sourceId?: string },
		logSource?: MonitorRecord,
	): MonitorRecord {
		const id = generateId();
		const dir = outputDir();
		const record: MonitorRecord = {
			id,
			kind,
			mode: input.mode,
			description: input.description,
			...target,
			timeoutMs: input.persistent ? 0 : input.timeoutMs,
			persistent: input.persistent,
			createdAt: Date.now(),
			eventCount: 0,
			suppressedCount: 0,
			globalSuppressedCount: 0,
			notify: parseNotify(input.notify),
			status: "running",
			loopPrompt: input.loopPrompt,
			outputPath: logSource?.outputPath ?? path.join(dir, `${id}.out.log`),
			stderrPath: logSource?.stderrPath ?? path.join(dir, `${id}.err.log`),
			limiter: new RateLimiter(),
		};
		record.batcher = input.mode === "events" ? new LineBatcher({
			windowMs: BATCH_WINDOW_MS,
			onBatch: (lines, count) => onBatch(record, lines, count),
		}) : undefined;
		monitors.set(id, record);
		return record;
	}

	function acceptObservedLine(record: MonitorRecord, line: string, stream: OutputStream): void {
		if (record.status !== "running" || record.notify.output === "none") return;
		const match = record.matcher ? record.matcher.match(line, stream) : stream === "stdout" ? { ids: [], level: "turn" as const } : undefined;
		if (!match) return;
		const level = outputLevel(record.notify.output, match.level);
		record.pendingLevel = strongerLevel(record.pendingLevel ?? "none", level);
		record.batcher?.pushEvent(stream === "stderr" ? `[stderr] ${line.trimEnd()}` : line.trimEnd());
	}

	function forwardOutput(source: MonitorRecord, stream: OutputStream, chunk: Buffer): void {
		if (source.status !== "running") return;
		for (const id of observers.get(source.id) ?? []) {
			const observer = monitors.get(id);
			if (observer?.status === "running" && observer.notify.output !== "none" && (!observer.matcher || observer.matcher.hasRules())) observer.outputLines?.[stream].push(chunk);
		}
	}

	function finishObserver(record: MonitorRecord): void {
		record.outputLines?.stdout.finish();
		record.outputLines?.stderr.finish();
	}

	/**
	 * End a source's observers. A non-silent source ending flushes their buffered
	 * matches as context; the source terminal result is the sole wakeup.
	 */
	function closeObservers(source: MonitorRecord, flush: boolean): void {
		for (const id of [...(observers.get(source.id) ?? [])]) {
			const observer = monitors.get(id);
			if (!observer || observer.status !== "running") continue;
			if (flush) {
				finishObserver(observer);
				const batch = observer.batcher?.drain();
				if (batch && observer.notify.output !== "none") {
					const verdict = observer.limiter.take(batch.count);
					if (verdict.deliver) deliverOutput(observer, verdict.suppressed ? [suppressionNotice(verdict.suppressed), ...batch.lines] : batch.lines, batch.count, "context");
					else observer.suppressedCount += batch.count;
				}
			}
			observer.exitCode = source.exitCode;
			finalizeEnd(observer, { status: "exited", cause: "exit" });
		}
	}

	function armSource(input: ArmInput & { sourceId: string }): MonitorRecord {
		const parent = monitors.get(input.sourceId);
		if (!parent || parent.kind !== "command" || parent.status !== "running") throw new Error("source.monitorId must name a running command Monitor in this session");
		validateWatches(input.watches ?? []);
		const record = createRecord("source", input, { sourceId: parent.id }, parent);
		if (input.watches !== undefined) record.matcher = new WatchRules(input.watches);
		record.outputLines = { stdout: new OutputLines((line) => acceptObservedLine(record, line, "stdout")), stderr: new OutputLines((line) => acceptObservedLine(record, line, "stderr")) };
		const linked = observers.get(parent.id) ?? new Set<string>();
		linked.add(record.id);
		observers.set(parent.id, linked);
		startTimeout(record);
		return record;
	}

	function receipt(record: MonitorRecord) {
		return { taskId: record.id, mode: record.mode, timeoutMs: record.timeoutMs, persistent: record.persistent, kind: record.kind, outputPath: record.outputPath, stderrPath: record.stderrPath, notify: { ...record.notify }, ...(record.sourceId ? { sourceId: record.sourceId } : {}), ...(record.matcher ? { watches: record.matcher.snapshot() } : {}) };
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

	/**
	 * `shellPath` and `shellCommandPrefix` from the session's effective settings,
	 * the ones Pi's bash tool uses: global and project merged under Pi's trust
	 * rules, so an untrusted project cannot pick the shell.
	 */
	function shellSettings(): ShellSettings {
		try {
			const settings = typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
			return { shellPath: settings?.shellPath, shellCommandPrefix: settings?.shellCommandPrefix };
		} catch {
			return {};
		}
	}

	function armCommand(input: ArmInput & { command: string }, ctx: ExtensionContext): MonitorRecord {
		const record = createRecord("command", input, { command: input.command });
		try {
			const settings = shellSettings();
			// getShellConfig() throws when shellPath does not exist or no usable shell is found.
			record.child = spawnCommand(record, prefixedCommand(input.command, settings), monitorShell(settings), ctx);
		} catch (error) {
			// Nothing is running, so nothing may be listed as running.
			endMonitor(record, { status: "failed", cause: "error" });
			throw new Error(`Could not start the monitor: ${error instanceof Error ? error.message : String(error)}`);
		}
		record.resourceActive = true;
		liveResources.set(record.id, record);
		installExitHook();
		startTimeout(record);
		return record;
	}

	function spawnCommand(
		record: MonitorRecord,
		command: string,
		shell: MonitorShell,
		ctx: ExtensionContext,
	) {
		return spawnMonitor({
			command,
			cwd: ctx.cwd,
			env: monitorEnv(),
			shell: shell.shell,
			shellArgs: shell.args,
			commandTransport: shell.commandTransport,
			stdoutPath: record.outputPath,
			stderrPath: record.stderrPath,
			onStdout: (chunk) => {
				if (record.mode === "events" && record.status === "running") record.batcher?.push(chunk);
				forwardOutput(record, "stdout", chunk);
			},
			onStderr: (chunk) => {
				// The command itself stays stdout-only; attached watches may select stderr.
				forwardOutput(record, "stderr", chunk);
			},
			onExit: (code, signal) => {
				record.exitCode = code;
				// A confirmed Stop already released ownership; a late close must
				// not probe or signal a PID the OS may have handed to a new group.
				if (!record.resourceActive) return;
				const gone = releaseResource(record);
				const pending = pendingEndings.get(record.id);
				if (pending) {
					if (gone) finalizeEnd(record, pending);
					return;
				}
				// A monitor that was stopped, timed out or flooded has already
				// been reported (or silenced): the exit that follows the kill is
				// not news.
				// A completion reports its own outcome: exit code 0 is completed,
				// a nonzero exit or a terminating signal is failed. Event watches
				// keep the single "exited" status Claude Code reports.
				endMonitor(record, {
					status:
						record.mode === "completion" ? (code === 0 && signal === null ? "completed" : "failed") : "exited",
					cause: "exit",
					// Deliver what the batcher still holds before the exit notice.
					flush: true,
					notice: () => exitNotice(record, signal),
				});
				// A shell may close with same-group background children still alive.
				if (!gone) void stopResource(record).then(() => {
					if (!releaseResource(record)) awaitCleanup(record);
					refreshStatus();
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
	}

	/** The frames a ws monitor receives, copied to its output log like a command's stdout; closed when the monitor ends. */
	function wsLog(record: MonitorRecord): (line: string) => void {
		// The launch result names the file, and monitor_list reports it as the
		// place to read the events from: create it now, not at the first frame.
		const fd = fs.openSync(record.outputPath, "a", 0o600);
		let stream: ReturnType<typeof fs.createWriteStream>;
		try {
			stream = fs.createWriteStream(record.outputPath, { fd, flags: "a" });
		} catch (error) {
			try { fs.closeSync(fd); } catch { /* already closed */ }
			throw error;
		}
		// A log failure (a full disk, a deleted temp dir, a disk too slow for the
		// frame rate) degrades the log, never the watch: stop writing, mark the
		// log incomplete and warn once, context-only, even under output:none.
		// Nothing further is queued into a stuck stream, and the warning is an
		// infrastructure notice: no event-count or output-budget slot, no wakeup.
		// record.logError is the degrade-once marker: only degrade sets it, and
		// nothing ever clears it, so it replaces a private boolean.
		const degrade = (reason: string) => {
			if (record.logError !== undefined) return;
			record.logError = reason;
			record.closeLog = () => {};
			stream.destroy();
			if (disposed) return;
			tasks.changed();
			// A pending disk write can fail after the watch already ended; only a
			// running watch keeps observing, so the notice must not claim continuation.
			const outcome = record.status === "running"
				? `The watch continues; later frames are not written to ${record.outputPath}.`
				: `The watch is no longer observing; buffered writes may be missing from ${record.outputPath}.`;
			const line = `[Log incomplete \u2014 ${reason}. ${outcome}]`;
			publish({ customType: EVENT_MESSAGE_TYPE, content: `monitor ${record.id} \u00b7 log degraded\n${line}`, display: true,
				details: { monitorId: record.id, kind: record.kind, mode: record.mode, description: record.description, cause: "output", lines: [line], notifyLevel: "context", outputPath: record.outputPath } }, "events", false);
		};
		// A stream "error" without a listener is an uncaught exception; an error
		// after degradation (destroy flushes pending writes) must not warn twice.
		stream.on("error", (error) => degrade(`log write failed: ${error.message}`));
		record.closeLog = () => { if (record.logError === undefined) stream.end(); };
		return (line) => {
			if (record.logError !== undefined || stream.destroyed || stream.writableEnded) return;
			// write() === false is ordinary backpressure; only a backlog past the
			// cap means the disk cannot keep up and the log must stop.
			if (stream.writableLength + Buffer.byteLength(line) + 1 > WS_LOG_BACKLOG_LIMIT_BYTES) {
				degrade("disk writes fell behind (4 MiB log backlog cap)");
				return;
			}
			stream.write(`${line}\n`);
		};
	}

	function armWebSocket(input: ArmInput & { url: string; protocols?: string[] }): MonitorRecord {
		const record = createRecord("ws", input, { wsUrl: input.url });
		try {
			const log = wsLog(record);
			const socket = input.protocols?.length
				? new WebSocket(input.url, input.protocols)
				: new WebSocket(input.url);
			record.socket = socket;
			record.resourceActive = true;
			liveResources.set(record.id, record);
			installExitHook();

			socket.addEventListener("message", (event: MessageEvent) => {
				if (record.mode !== "events" || record.status !== "running") return;
				const data = event.data;
				const line =
					typeof data === "string" ? data : `[binary frame, ${byteLengthOf(data)} bytes]`;
				log(line);
				// Raw logs retain heartbeats, but blank text frames are not events,
				// matching blank stdout lines and avoiding notification-only floods.
				if (typeof data === "string" && !data.trim()) return;
				record.batcher?.pushEvent(line);
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
			socket.addEventListener("close", (event: { code: number }) => {
				record.socketClosed = true;
				releaseResource(record);
				const pending = pendingEndings.get(record.id);
				if (pending) { finalizeEnd(record, pending); return; }
				endMonitor(record, {
					status: "exited",
					cause: "closed",
					flush: true,
					notice: () => `[WebSocket closed: ${event.code}]`,
				});
			});
		} catch (error) {
			// A socket that never opened is a launch failure, like a command that
			// could not spawn: the tool call fails instead of reporting a monitor
			// that is already dead.
			const message = error instanceof Error ? error.message : String(error);
			endMonitor(record, { status: "failed", cause: "error" });
			throw new Error(`Could not start the monitor: ${message}`);
		}
		startTimeout(record);
		return record;
	}

	// ---------------------------------------------------------------- tools

	// Only asynchronous facts use the custom CC card; all tool rows use the host shell.
	pi.registerMessageRenderer(EVENT_MESSAGE_TYPE, (message, options, theme) =>
		renderMonitorMessage(message, options, theme, loadConfig().compactMessages));

	pi.registerTool({
		name: "Monitor",
		label: "Monitor",
		description: MONITOR_DESCRIPTION,
		promptSnippet: MONITOR_SNIPPET,
		promptGuidelines: MONITOR_PROMPT_GUIDELINES,
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("update")], { description: "Default start. Explicit update requires id and changes only watches/notify; never starts or restarts work." })),
			id: Type.Optional(Type.String({ description: "Existing Monitor id; only action=update uses this." })),
			source: Type.Optional(Type.Object({ monitorId: Type.String() }, { additionalProperties: false, description: "events-only: subscribe to an existing command Monitor, without spawning or rereading logs." })),
			watches: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
				text: Type.String({ minLength: 1, maxLength: MAX_WATCH_TEXT }),
				stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")])),
				once: Type.Optional(Type.Boolean({ description: "Once per match (still subject to notification budgets). Default false: repeat." })),
				notify: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context")])),
			}, { additionalProperties: false }), { maxItems: MAX_WATCHES, description: "Only attached source observers. Literal matching; [] mutes without stopping work. Unchanged IDs retain once state." })),
			mode: Type.Optional(
				Type.Union([Type.Literal("completion"), Type.Literal("events")], {
					description:
						"Notification mode. completion runs a command in the background, logs stdout/stderr and notifies once at exit or timeout. events notifies on each stdout line or WebSocket frame. Default events for backward compatibility; completion requires command.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description: "Shell command or script. completion logs its output and reports exit once; events emits each stdout line as a notification.",
				}),
			),
			ws: Type.Optional(
				Type.Object(
					{
						url: Type.String({
							description: "The socket to open: an ASCII ws:// or wss:// URL with no userinfo.",
						}),
						protocols: Type.Optional(
							Type.Array(Type.String({ description: "WebSocket subprotocol names." }), {
								description: "WebSocket subprotocols to request.",
							}),
						),
					},
					{
						description:
							"WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command; omit it entirely when using command.",
					},
				),
			),
			description: Type.Optional(Type.String({
				description: "Required for start; short description shown in notifications. Not accepted by update.",
			})),
			timeout_ms: Type.Optional(
				Type.Number({
					minimum: MIN_TIMEOUT_MS,
					// The schema carries the widest bound; the runtime check enforces the
					// mode's own limit once mode is known.
					maximum: MAX_COMPLETION_TIMEOUT_MS,
					description:
					`Kill the monitor after this deadline. Events: default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. ` +
					`Completion: default ${DEFAULT_COMPLETION_TIMEOUT_MS}ms, max ${MAX_COMPLETION_TIMEOUT_MS}ms. Ignored when persistent is true.`,
				}),
			),
			persistent: Type.Optional(
				Type.Boolean({
					description:
						"Run for the lifetime of the session (no timeout). Use for session-length commands or watches. Stop with monitor_stop.",
				}),
			),
			notify: Type.Optional(Type.Object({
				output: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context"), Type.Literal("none")])),
				terminal: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context")])),
			}, { additionalProperties: false, description: "Output level (turn/context/none) and terminal level (turn/context). Defaults turn. User stops never start a turn." })),
			loopPrompt: Type.Optional(
				Type.String({
					description:
						"The /loop prompt this monitor belongs to, verbatim. Only used when the pi-cc-loop extension is loaded: " +
						"when it ends that loop, this monitor is stopped with it. Ignored otherwise.",
				}),
			),
		}, { allOf: [{ if: { properties: { action: { const: "update" } }, required: ["action"] }, then: { required: ["id"] }, else: { required: ["description"] } }] }),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		// What a codemode script gets: the task id and paths as values (Pi sends the shape, not this).
		outputSchema: Type.Object({
			taskId: Type.String(),
			mode: Type.Union([Type.Literal("completion"), Type.Literal("events")]),
			timeoutMs: Type.Number(),
			persistent: Type.Boolean(),
			kind: Type.Union([Type.Literal("command"), Type.Literal("ws"), Type.Literal("source")]),
			outputPath: Type.String(),
			stderrPath: Type.String(),
			updated: Type.Optional(Type.Boolean()),
			notify: Type.Optional(Type.Object({ output: Type.String(), terminal: Type.String() })),
			sourceId: Type.Optional(Type.String()),
			watches: Type.Optional(Type.Array(Type.Object({ id: Type.String(), text: Type.String(), stream: Type.Optional(Type.String()), once: Type.Optional(Type.Boolean()), notify: Type.Optional(Type.String()), fired: Type.Boolean() }))),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (disposed) throw new Error("This Monitor runtime has ended");
			if (params.action === "update") {
				const allowed = new Set(["action", "id", "watches", "notify"]);
				if (Object.keys(params).some((key) => !allowed.has(key))) throw new Error("update accepts only action, id, watches and notify; execution/source/lifetime cannot change");
				if (!params.id?.trim()) throw new Error("update requires an existing Monitor id");
				const record = monitors.get(params.id);
				if (!record || record.status !== "running") throw new Error("update target does not exist or is not running; no work was started");
				if (params.watches !== undefined && record.kind !== "source") throw new Error("watches can only update an attached source observer");
				if (params.watches !== undefined) validateWatches(params.watches);
				const policy = parseNotify(params.notify, record.notify);
				const before = { watches: record.matcher?.snapshot(), notify: { ...record.notify } };
				const oldRules = JSON.stringify(before.watches);
				if (params.watches !== undefined) {
					record.matcher ??= new WatchRules([]);
					record.matcher.update(params.watches);
				}
				const rulesChanged = oldRules !== JSON.stringify(record.matcher?.snapshot());
				const outputChanged = policy.output !== record.notify.output;
				record.notify = policy;
				// A terminal-only policy change leaves the pending output valid.
				if (rulesChanged || outputChanged) {
					record.batcher?.discard();
					record.outputLines?.stdout.clear();
					record.outputLines?.stderr.clear();
					record.pendingLevel = undefined;
					forgetSuppression(record.id);
				}
				tasks.changed();
				const value = { ...receipt(record), updated: true };
				return { content: [{ type: "text" as const, text: updateReceipt(snapshotMonitor(record), before) }], details: value, structuredContent: value };
			}
			if (params.action !== undefined && params.action !== "start") throw new Error("action must be start or update");
			if (params.id !== undefined) throw new Error("id requires explicit action=update; no work was started");

			// A model that fills every schema property (the GPT family sends
			// `ws: { url: "", protocols: [] }` beside the command) leaves the
			// source it did not mean to use blank: a blank source is no source,
			// so only a non-blank one counts as given. Two real sources remain an
			// error, and a lone blank one still says which field needs a value.
			const command = typeof params.command === "string" ? params.command : undefined;
			const commandText = command ?? "";
			const ws = params.ws;
			const wsUrl = typeof ws?.url === "string" ? ws.url.trim() : "";
			const hasCommand = commandText.trim() !== "";
			const hasWs = wsUrl !== "";
			const sourceId = typeof params.source?.monitorId === "string" ? params.source.monitorId.trim() : "";
			const hasSource = sourceId !== "";
			if (Number(hasCommand) + Number(hasWs) + Number(hasSource) > 1) throw new Error("exactly one of command or ws or source.monitorId");
			if (!hasCommand && !hasWs && !hasSource) {
				if (command !== undefined) throw new Error("command must not be empty");
				if (ws !== undefined) throw new Error(WS_URL_ERROR);
				if (params.source !== undefined) throw new Error("source.monitorId must not be empty");
				throw new Error("exactly one of command or ws or source.monitorId");
			}
			if (!params.description?.trim()) {
				throw new Error("description is required");
			}

			const mode: MonitorMode = params.mode ?? "events";
			if ((hasWs || hasSource) && mode === "completion") throw new Error("mode=completion requires command; ws/source uses mode=events");
			if (params.watches !== undefined && !hasSource) throw new Error("watches requires an attached source.monitorId");
			const persistent = params.persistent ?? false;
			// A background command outlives an event watch: its deadline defaults to
			// 30 minutes and caps at 2 hours; events keep Claude Code's 5 minutes/1 hour.
			const { defaultMs: defaultTimeout, maxMs: maxTimeout } = MONITOR_TIMEOUTS[mode];
			const timeoutMs = params.timeout_ms ?? defaultTimeout;
			if (!persistent) {
				if (timeoutMs < MIN_TIMEOUT_MS) {
					throw new Error(`timeout_ms must be \u2265 ${MIN_TIMEOUT_MS}`);
				}
				if (timeoutMs > maxTimeout) {
					throw new Error(`timeout_ms must be \u2264 ${maxTimeout}`);
				}
			}
			const input: ArmInput = {
				description: params.description,
				mode,
				timeoutMs,
				persistent,
				loopPrompt: loopExtensionLoaded(pi) ? params.loopPrompt : undefined,
				notify: params.notify,
				watches: params.watches,
			};

			let record: MonitorRecord;
			if (hasCommand) {
				if (hasControlChars(commandText)) {
					throw new Error("command contains control characters that would be hidden in the approval dialog");
				}
				record = armCommand({ ...input, command: commandText }, ctx);
			} else if (hasSource) {
				record = armSource({ ...input, sourceId });
			} else {
				if (!isValidWsUrl(wsUrl)) {
					throw new Error(WS_URL_ERROR);
				}
				if (!isValidProtocols(ws?.protocols)) {
					throw new Error("protocols must be unique RFC 6455 tokens");
				}
				record = armWebSocket({ ...input, url: wsUrl, protocols: ws?.protocols });
			}
			refreshStatus();

			// The launch receipt distinguishes quiet background completion from an
			// event watch, and tells the model not to poll or mistake a notice for
			// a user's reply.
			const value = receipt(record);
			const launchText = startReceipt(snapshotMonitor(record));
			return {
				content: [{ type: "text", text: launchText }],
				details: value,
				structuredContent: value,
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop Monitor",
		description: "Stop a running monitor by id. For a command or WebSocket this requests bounded cleanup and reports success only after the owned resource is gone; for an output subscription it ends only the subscription. Unconfirmed cleanup stays listed and retryable.",
		promptSnippet: MONITOR_STOP_SNIPPET,
		parameters: Type.Object({
			id: Type.String({ description: "The monitor id returned by Monitor." }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		outputSchema: Type.Object({ stopped: Type.Boolean(), id: Type.String(), status: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const record = monitors.get(params.id);
			if (!record) {
				const value = { stopped: false, id: params.id };
				return {
					content: [{ type: "text" as const, text: `No monitor found with ID: ${params.id}` }],
					details: value,
					structuredContent: value,
				};
			}
			if (!isActive(record)) {
				const value = { stopped: false, id: params.id, status: record.status };
				return {
					content: [
						{ type: "text" as const, text: `Monitor ${params.id} is not running (${record.status}).` },
					],
					details: value,
					structuredContent: value,
				};
			}
			const stopped = await endMonitor(record, {
				status: "stopped",
				cause: "stopped",
				flush: true,
				kill: true,
				notice: () => STOPPED_NOTICE,
			});
			// Agent-issued stops append their context-only notice at a safe boundary;
			// the local overlay can deliver immediately when already idle.
			if (stopped && lastCtx?.isIdle()) flushCompletions(lastCtx?.isIdle() === true);
			// An already-finalized record (a natural exit with a living background
			// group) keeps its real status; only an un-finalized stop times out.
			const value = { stopped, id: params.id, ...(!stopped ? { status: snapshotMonitor(record).status } : {}) };
			return {
				content: [{ type: "text" as const, text: stopReceipt(snapshotMonitor(record), stopped) }],
				...(!stopped ? { isError: true } : {}),
				details: value,
				structuredContent: value,
			};
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description: "List this session's background commands and event watches with their ids, modes, state, event counts and exit codes.",
		promptSnippet: MONITOR_LIST_SNIPPET,
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		outputSchema: Type.Object({
			monitors: Type.Array(
				Type.Object({
					id: Type.String(),
					kind: Type.Union([Type.Literal("command"), Type.Literal("ws"), Type.Literal("source")]),
					sourceId: Type.Optional(Type.String()),
					watches: Type.Optional(Type.Array(Type.Object({ id: Type.String(), text: Type.String(), stream: Type.Optional(Type.String()), once: Type.Optional(Type.Boolean()), notify: Type.Optional(Type.String()), fired: Type.Boolean() }))),
					mode: Type.Union([Type.Literal("completion"), Type.Literal("events")]),
					description: Type.String(),
					command: Type.Optional(Type.String()),
					wsUrl: Type.Optional(Type.String()),
					timeoutMs: Type.Number(),
					persistent: Type.Boolean(),
					createdAt: Type.Number(),
					eventCount: Type.Number(),
					suppressedCount: Type.Number(),
					globalSuppressedCount: Type.Number(),
					notify: Type.Object({ output: Type.String(), terminal: Type.String() }),
					resourceActive: Type.Optional(Type.Boolean()),
					status: Type.String(),
					endedAt: Type.Optional(Type.Number()),
					exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
					loopPrompt: Type.Optional(Type.String()),
					pid: Type.Optional(Type.Number()),
					outputPath: Type.String(),
					stderrPath: Type.String(),
					logError: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const list = [...monitors.values()].map(snapshotMonitor);
			// monitorListText([]) is "No monitors." — the empty case needs no branch.
			const text = monitorListText(list);
			return {
				content: [{ type: "text" as const, text }],
				details: { monitors: list },
				structuredContent: { monitors: list },
			};
		},
	});

	// The shared task overlay. A TaskProvider is a read-only view plus the
	// one action that reuses this package's own lifecycle: endMonitor, which
	// kills the process tree or closes the socket and sends the usual notice.
	// The overlay never feeds the Monitor event stream: it reads the same
	// records monitor_list does and tails the log files with a byte/line cap.
	const tasks = registerTaskProvider(pi, {
		id: "monitor",
		label: "Monitor",
		list(): TaskItem[] {
			const now = Date.now();
			return [...monitors.values()].map((record) => {
				const end = record.endedAt ?? now;
				const view = snapshotMonitor(record);
				const badges = monitorBadges(view);
				badges.push(formatDuration(Math.max(0, end - record.createdAt)));
				if (record.kind !== "source" && record.exitCode !== undefined && record.exitCode !== null) badges.push(`exit ${record.exitCode}`);
				return {
					id: record.id,
					title: record.description,
					createdAt: record.createdAt,
					state: record.status,
					role: monitorRole(view),
					...(record.sourceId ? { parentId: record.sourceId } : {}),
					stopConfirmation: stopScope(view),
					active: isActive(record),
					meta: badges.join(" · "),
				};
			});
		},
		detail(item: TaskItem): TaskDetail {
			const record = monitors.get(item.id);
			if (!record) throw new Error("this monitor is no longer listed");
			const now = Date.now();
			const end = record.endedAt ?? now;
			const elapsed = Math.max(0, end - record.createdAt);
			const source = record.sourceId ? monitors.get(record.sourceId) : undefined;
			const target = record.kind === "ws" ? record.wsUrl : record.command;
			const remaining = record.persistent ? undefined : record.timeoutMs - elapsed;
			const configured = formatDuration(record.timeoutMs);
			const lifetime =
				record.persistent
					? record.status === "running"
						? "persistent \u2014 until stopped or the session ends"
						: "persistent \u2014 configured; monitor has ended"
					: record.status === "running"
						? `${configured} timeout \u00b7 ${remaining !== undefined && remaining > 0 ? `${formatDuration(remaining)} left` : "expired"}`
						: record.status === "timed_out"
							? `${configured} timeout \u00b7 expired`
							: `${configured} configured timeout \u00b7 ended early`;
			const view = snapshotMonitor(record);
			const rules = view.watches;
			const detail: TaskDetail = {
				rows: [],
				sections: [
					{ title: "State", rows: [
						{ label: "Status", value: record.status },
						{ label: "Kind", value: `${monitorRole(view)} · ${record.kind}` },
						...(record.sourceId ? [{ label: "Source", value: `${source ? `${displayLine(source.description)} ` : ""}#${record.sourceId} · ${source?.status ?? "unavailable"}` }] : []),
						{ label: "Resource", value: record.kind === "source" ? "subscription only; no process owned" : record.resourceActive ? record.finalized ? "owned; cleanup pending" : "owned; alive" : "released" },
						{ label: record.kind === "source" ? "Source exit" : "Exit", value: record.status === "running" ? "—" : record.exitCode !== undefined && record.exitCode !== null ? `code ${record.exitCode}` : record.kind === "ws" && record.socketClosed ? "socket close" : "not reported" },
						...(target !== undefined ? [{ label: record.kind === "ws" ? "Socket" : "Command", value: target }] : []),
					] },
					...(record.mode === "events" ? [{ title: "Observation", rows: [
						...(record.kind === "source" ? [{ label: "Rules", value: observationLabel(rules) }] : []),
						...(rules?.map((rule) => ({ label: `Watch ${rule.id}`, value: `${rule.stream} · ${rule.once ? "once" : "repeat"} · ${rule.notify} · ${rule.fired ? rule.once ? "matched (consumed)" : "matched (still active)" : "waiting"} · ${rule.text}` })) ?? []),
						{ label: "Events", value: `${record.eventCount} delivered${record.suppressedCount ? ` · ${record.suppressedCount} rate-suppressed` : ""}` },
						...(record.globalSuppressedCount ? [{ label: "Session budget", value: `${record.globalSuppressedCount} events suppressed; raw logs unchanged` }] : []),
					] }] : []),
					{ title: "Delivery", rows: [
						{ label: "Mode", value: record.mode === "completion" ? "completion · one terminal notification" : record.kind === "source" ? "events · selected future source output" : record.kind === "ws" ? "events · each WebSocket frame" : "events · each stdout line" },
						{ label: "Output", value: `${record.notify.output}${record.mode === "completion" ? " · runtime output is log-only" : ""}` },
						{ label: "Terminal", value: record.notify.terminal },
					] },
					{ title: "Lifetime", rows: [
						{ label: "Elapsed", value: `${formatDuration(elapsed)}${record.status === "running" ? " (running)" : ""}` },
						{ label: "Lifetime", value: lifetime },
						...(record.loopPrompt ? [{ label: "Loop", value: record.loopPrompt }] : []),
						...(record.child?.pid !== undefined ? [{ label: "PID", value: String(record.child.pid) }] : []),
					] },
					{ title: "Logs", rows: [
						...(record.sourceId ? [{ label: "Shared with", value: `source #${record.sourceId}; full source logs, not only matched events` }] : []),
						{ label: "stdout", value: record.outputPath },
						{ label: "stderr", value: record.stderrPath },
						...(record.logError ? [{ label: "Log status", value: `incomplete \u2014 ${record.logError}` }] : []),
					] },
				],
				logs: [
					{ label: record.kind === "source" ? "stdout (source log)" : "stdout (log)", path: record.outputPath },
					{ label: record.kind === "source" ? "stderr (source log)" : "stderr (log)", path: record.stderrPath },
				],
				note: isActive(record) ? `x: ${stopScope(view)}` : "This monitor has ended; its actions are disabled.",
			};
			// Older Loop-owned panels consume only rows; modern panels prefer sections.
			detail.rows = detail.sections?.flatMap((section) => section.rows) ?? [];
			return detail;
		},
		async stop(id: string): Promise<TaskStopResult> {
			const record = monitors.get(id);
			if (!record) return { stopped: false, message: `Monitor ${id} is no longer listed.` };
			if (!isActive(record)) return { stopped: false, message: `Monitor ${id} is not running (${record.status}).` };
			const stopped = await endMonitor(record, { status: "stopped", cause: "stopped", flush: true, kill: true, notice: () => STOPPED_NOTICE });
			if (stopped && lastCtx?.isIdle()) flushCompletions(true);
			return { stopped, message: stopReceipt(snapshotMonitor(record), stopped) };
		},
	});

	// The shared pi-cc settings and their /pi_cc command. The first pi-cc
	// package to load registers it; this one re-claims its own claim on /reload.
	registerPiCcCommand(pi, "pi-cc-monitor");

	// A pi-cc package changed the shared settings (loop, monitor or plugins
	// all carry the command): the footer follows.
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		// The footer may have been switched on or off.
		refreshStatus();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// The card says "click to show more" only where Pi actually delivers mouse
		// events: fullscreen. An empty widget is the native way to reach the TUI.
		if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("pi-cc-monitor:screen", (tui) => {
				setNotificationTui(tui);
				return { render: () => [], invalidate() {} };
			});
		}
		// Another process may have edited the shared settings file.
		invalidateConfig();
		cleanOldLogDirectories();
	});

	// --------------------------------------------------------------- lifecycle

	pi.on("session_shutdown", async () => {
		releaseNotificationHover();
		// Set first: the processes killed below exit after Pi has invalidated
		// this extension's API, and their callbacks must not touch it.
		disposed = true;
		// Close an open task overlay before the context and logs go away.
		tasks.close();
		// The idle fallback must not fire on the disposed runtime after an await.
		if (idleFallbackTimer) clearTimeout(idleFallbackTimer);
		idleFallbackTimer = undefined;
		// Kill synchronously before any await: explicit process.exit can bypass future timers.
		killAllNow();
		// Source subscriptions own no resource and never enter the loop below:
		// disarm their timers and batchers so nothing fires on the disposed
		// runtime after monitors.clear(). Outstanding cleanup polls die here too.
		for (const record of monitors.values()) {
			if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
			record.cleanupTimer = undefined;
			if (liveResources.has(record.id)) continue;
			if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
			record.timeoutTimer = undefined;
			record.batcher?.close();
		}
		await Promise.all([...liveResources.values()].map(async (record) => {
			const pending = pendingEndings.get(record.id);
			if (pending) pending.notice = undefined;
			await stopResource(record, true);
			if (!releaseResource(record)) awaitCleanup(record);
			finalizeEnd(record, { status: "stopped", cause: "stopped", kill: true });
		}));
		if (!liveResources.size) removeExitHook();
		pendingCompletions.clear();
		globallySuppressed.clear();
		if (summaryTimer) clearTimeout(summaryTimer);
		summaryTimer = undefined;
		logDirectory?.close();
		monitors.clear();
		// Pi clears extension statuses when it unloads, but a reload should not
		// leave a stale count behind until then.
		if (lastStatusText !== undefined) {
			lastStatusText = undefined;
			try {
				lastCtx?.ui?.setStatus?.(STATUS_KEY, undefined);
			} catch {
				// the context may already be invalid
			}
		}
	});
}

function byteLengthOf(data: unknown): number {
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
	return 0;
}
