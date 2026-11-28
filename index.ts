/**
 * Observation only: typed files, external job status or WebSocket sources.
 * Business tasks are submitted through an external runner. Stop/reload/exit
 * closes observation handles, connections and copies, never the runner's job.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invalidateConfig, loadConfig } from "./config.ts";
import { generateId } from "./plugin-settings.ts";
import { CONFIG_CHANNEL, registerSettingsCommand } from "./settings.ts";
import { KILL_CONFIRMATION_MS } from "./process.ts";
import { MONITOR_DESCRIPTION, MONITOR_LIST_SNIPPET, MONITOR_PROMPT_GUIDELINES, MONITOR_SNIPPET, MONITOR_STOP_SNIPPET, MONITOR_TIMEOUTS } from "./prompts.ts";
import { capEventLines, LineBatcher, MAX_BATCH_CHARS, MAX_LINE_CHARS, RateLimiter } from "./stream.ts";
import { readLogTail, sanitizeDisplay, type LogTail } from "./log-tail.ts";
import { DEFAULT_NOTIFY, OutputBudget, outputLevel, strongerLevel, type NotifyPolicy, type OutputLevel } from "./notification-budget.ts";
import { OutputLines, WatchRules, validateWatches, type WatchRule, type WatchState, type OutputStream } from "./watches.ts";
import { cleanOldLogDirectories, createLogDirectory, createTaskDirectory, markTaskReady, setTaskProcess, LOG_CLEANUP_INTERVAL_MS, type TaskDirectory } from "./log-store.ts";
import { FileObservation, normalizeSource, cloneSource, type ObservationSource, type FileSource, type JobSource, type SocketSource } from "./observation-source.ts";
import { ObservationLog } from "./observation-log.ts";
import type { JobSnapshot } from "./job-protocol.ts";
import { MonitorParameters, MonitorReceiptSchema, MonitorSnapshotSchema } from "./tool-schema.ts";
export type { MonitorInput } from "./tool-schema.ts";
import { registerTaskProvider, type TaskStopResult } from "./tasks.ts";
import { formatDuration, releaseNotificationHover, setNotificationTui } from "./render.ts";
import { renderMonitorMessage } from "./message-render.ts";
import { monitorListText, startReceipt, stopReceipt, updateReceipt } from "./monitor-view.ts";
import { monitorTaskDetail, monitorTaskItem } from "./monitor-task-view.ts";

import { advertiseObservationMonitor, LOOP_OBSERVATION_ADOPT_CHANNEL, LOOP_OBSERVATION_BIND_CHANNEL, LOOP_STOPPED_CHANNEL, MONITOR_EVENT_TYPE as EVENT_MESSAGE_TYPE, OBSERVATION_LINK_VERSION, type ObservationBinding } from "./observation-link.ts";
import { TerminalOutbox } from "./terminal-outbox.ts";
export { LOOP_OBSERVATION_ADOPT_CHANNEL, LOOP_OBSERVATION_BIND_CHANNEL, LOOP_STOPPED_CHANNEL, EVENT_MESSAGE_TYPE };
const STATUS_KEY = "monitor";
export const MIN_TIMEOUT_MS = 1_000;
export const ENDED_MONITOR_HISTORY_LIMIT = 50;
export const BATCH_WINDOW_MS = 200;
export type MonitorCause = "output" | "job" | "timeout" | "error" | "closed" | "stopped" | "flooded" | "stop_timeout";
export const STOPPED_NOTICE = "[Monitor stopped — observation only; external work was not cancelled]";
export type MonitorStatus = "running" | "stopping" | "stop_timeout" | "stopped" | "exited" | "completed" | "timed_out" | "failed" | "flooded";
export type MonitorMode = "completion" | "events";
interface ManagedLogs { directory: TaskDirectory; maxBytes: number; truncated: boolean; removed: boolean; ready?: boolean; error?: string }
export interface MonitorRecord {
	id: string; kind: "file" | "job" | "ws"; mode: MonitorMode; description: string;
	source: ObservationSource; job?: JobSnapshot; wsUrl?: string;
	timeoutMs: number; persistent: boolean; createdAt: number;
	eventCount: number; suppressedCount: number; globalSuppressedCount: number;
	notify: NotifyPolicy; pendingLevel?: OutputLevel; finalBatch?: { lines: string[]; count: number };
	status: MonitorStatus; endedAt?: number; loopPrompt?: string;
	/** Stable Loop activity identity, exposed only in asynchronous message details. */
	loopObservationGroup?: string;
	logs: ManagedLogs;
	observer?: FileObservation; observationLog?: ObservationLog;
	socket?: WebSocket; socketClosed?: boolean;
	resourceActive?: boolean; sourceGap?: boolean; sourceError?: string; warningAt?: Partial<Record<"source" | "gap", number>>;
	startFailed?: boolean;
	matcher?: WatchRules; outputLines?: { stdout: OutputLines; stderr: OutputLines };
	finalized?: boolean; pendingStop?: Promise<boolean>; cleanupTimer?: ReturnType<typeof setTimeout>;
	tails?: { stdout: LogTail; stderr: LogTail }; logError?: string;
	timeoutTimer?: ReturnType<typeof setTimeout>; batcher?: LineBatcher; limiter: RateLimiter;
}
export type MonitorSnapshot = {
	id: string; kind: "file" | "job" | "ws"; mode: MonitorMode; description: string;
	source: ObservationSource; job?: JobSnapshot; watches?: WatchState[];
	timeoutMs: number; persistent: boolean; createdAt: number;
	eventCount: number; suppressedCount: number; globalSuppressedCount: number;
	notify: NotifyPolicy; resourceActive?: boolean; status: MonitorStatus; endedAt?: number;
	loopPrompt?: string; observationPid?: number; sourceGap?: boolean; sourceError?: string;
	outputPath: string; stderrPath: string; outputArchivePath?: string; stderrArchivePath?: string;
	logLimitBytes?: number; logTruncated?: boolean; logRemoved?: boolean; logError?: string;
};

function eventsText(count: number): string {
	return count === 0 ? "no events" : `${count} event${count === 1 ? "" : "s"}`;
}

/** " (12 suppressed)" when the rate limit dropped events, otherwise "". */
function suppressedText(record: MonitorRecord): string {
	return record.suppressedCount ? ` (${record.suppressedCount} suppressed)` : "";
}

/** Claude Code's expiry notice. */
function expiryNotice(record: MonitorRecord): string {
	return [
		"[Monitor expired after " + formatDuration(record.timeoutMs) + " with " + eventsText(record.eventCount) + " delivered" + suppressedText(record) + ". Observation stopped; external work was not cancelled. Reconnect to the same source if still needed.]",
		...(record.job ? ["External job " + record.job.jobId + ": last observed state " + record.job.state + ". Query the runner if needed; do not resubmit it."] : []),
		...(record.sourceError ? ["Observation incomplete: " + record.sourceError] : []),
	].join("\n");
}
function jobHeaderLines(record: MonitorRecord): string[] {
	const job = record.job!;
	const result = job.exitCode !== undefined && job.exitCode !== null ? "exit code " + job.exitCode : job.signal ?? "exit code unavailable";
	const observation = record.status === "stop_timeout" ? "Job terminal status validated; observation cleanup remains unconfirmed" : "Observation completed";
	return [
		"[External job " + job.jobId + " / " + job.runId + ": " + job.state + ", " + result + ". " + observation + "; the runner's job was not controlled by Monitor.]",
		"This is a validated status-file report, not an independent OS audit. Read and verify the required outputs and artifacts before using the result. Continue independent work; only report when all required results are verified.",
		"Status: " + (job.host ? job.host + ':' : '') + job.statusPath,
	];
}

/**
 * The bounded tail a completion's terminal notice carries: stdout always, and
 * stderr only when it has output \u2014 an empty stderr says nothing the banner's
 * path has not already named, so it gets no section (a read error is kept:
 * it says the tail is not merely empty). Bounded retained segments stay on disk \u2014 this is
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

/** Read both logs' bounded tails once (bridging rotated `.1` archives) when the terminal notice is sent. */
function captureCompletionTails(record: MonitorRecord): void {
	const { outputPath, stderrPath } = record.logs.directory;
	record.tails = {
		stdout: readLogTail(outputPath, undefined, undefined, undefined, `${outputPath}.1`),
		stderr: readLogTail(stderrPath, undefined, undefined, undefined, `${stderrPath}.1`),
	};
}

function floodNotice(record: MonitorRecord, suppressedForMs: number): string {
	return `[Monitor stopped \u2014 too much output (${eventsText(record.suppressedCount)} suppressed over ${formatDuration(suppressedForMs)}). Restart it with a more selective filter.]`;
}

/** Claude Code's notice for events the rate limit dropped. */
function suppressionNotice(count: number): string {
	return `[${eventsText(count)} suppressed \u2014 output rate too high. Consider using monitor_stop to restart this monitor with a more selective filter.]`;
}

function logDetails(record: MonitorRecord) {
	const logs = record.logs;
	return logs ? {
		outputArchivePath: logs.directory.outputPath + ".1",
		stderrArchivePath: logs.directory.stderrPath + ".1",
		logLimitBytes: logs.maxBytes,
		logTruncated: logs.truncated,
		logRemoved: logs.removed,
		...(record.logError ?? logs.error ? { logError: record.logError ?? logs.error } : {}),
	} : {};
}

function logNotice(record: MonitorRecord): string[] {
	if (record.logs.removed) return ["[Task artifacts reclaimed by retention/quota; the original log files are no longer available.]"];
	const notes: string[] = [];
	const archives = [record.logs.directory.outputPath + ".1", record.logs.directory.stderrPath + ".1"].filter((file) => fs.existsSync(file));
	if (archives.length) notes.push(`[Rotated logs — read these previous segments before the current paths: ${archives.join("; ")}. A current log path alone is not the whole retained output.]`);
	if (record.logs.truncated) notes.push(`[Logs truncated — old output was discarded by the ${record.logs.maxBytes / (1024 * 1024)} MiB task limit. Only recent segments remain; archives (if present): ${record.logs.directory.outputPath}.1; ${record.logs.directory.stderrPath}.1. Do not assume these logs are complete.]`);
	const error = record.logError ?? record.logs.error;
	if (error) notes.push(`[Log incomplete — ${error}]`);
	return notes;
}

function observationDetails(record: MonitorRecord) {
	return { kind: record.kind, mode: record.mode,
		source: cloneSource(record.source), ...(record.job ? { job: { ...record.job, runner: { ...record.job.runner } } } : {}),
		...(record.matcher ? { watches: record.matcher.snapshot() } : {}), timeoutMs: record.timeoutMs, persistent: record.persistent,
		...(record.sourceGap ? { sourceGap: true } : {}), ...(record.sourceError ? { sourceError: record.sourceError } : {}),
		outputPath: record.logs.directory.outputPath, stderrPath: record.logs.directory.stderrPath, ...logDetails(record), notify: { ...record.notify },
	};
}
function snapshotMonitor(record: MonitorRecord): MonitorSnapshot {
	return { id: record.id, ...observationDetails(record), description: record.description, createdAt: record.createdAt,
		eventCount: record.eventCount, suppressedCount: record.suppressedCount, globalSuppressedCount: record.globalSuppressedCount,
		...(record.resourceActive ? { resourceActive: true } : {}), status: record.status, ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}), ...(record.observer?.pid !== undefined ? { observationPid: record.observer.pid } : {}),
	};
}
// ------------------------------------------------------------------ extension

export default function piCcMonitorExtension(pi: ExtensionAPI): void {
	const monitors = new Map<string, MonitorRecord>();
	// Keep actual resources after logical stop/exit until their disappearance is confirmed.
	const liveResources = new Map<string, MonitorRecord>();
	const pendingEndings = new Map<string, Ending>();
	const unsubscribeCapability = advertiseObservationMonitor(pi);
	const completions = new TerminalOutbox<string>(pi, () => lastCtx?.isIdle() === true, scheduleMonitorPrune);
	const outputBudget = new OutputBudget();
	const globallySuppressed = new Map<string, number>();
	let summaryTimer: ReturnType<typeof setTimeout> | undefined;
	let logDirectory: ReturnType<typeof createLogDirectory> | undefined;
	let artifactInterval: ReturnType<typeof setInterval> | undefined;
	let artifactSweepTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCtx: ExtensionContext | undefined;

	function outputDir(): string {
		logDirectory ??= createLogDirectory();
		startArtifactMaintenance();
		return logDirectory.path;
	}
	function protectedArtifacts(): Set<string> {
		const ids = new Set<string>();
		for (const record of monitors.values()) {
			if (record.logs && (!record.finalized || isActive(record) || record.pendingStop || completions.has(record.id) || pendingEndings.has(record.id))) ids.add(record.logs.directory.id);
		}
		return ids;
	}
	function sweepArtifacts(): void {
		if (disposed) return;
		const config = loadConfig();
		const policy = { retentionMs: config.logRetentionDays * 86_400_000, budgetBytes: config.logBudgetMiB * 1024 * 1024 };
		const result = cleanOldLogDirectories(Date.now(), logDirectory ? path.dirname(logDirectory.path) : undefined, { policy, current: logDirectory, protectedIds: protectedArtifacts() });
		if (result.removedTasks.length) {
			const removed = new Set(result.removedTasks);
			for (const record of monitors.values()) if (record.logs && removed.has(record.logs.directory.path)) record.logs.removed = true;
			tasks.changed();
		}
	}
	function scheduleArtifactSweep(): void {
		if (disposed || artifactSweepTimer) return;
		artifactSweepTimer = setTimeout(() => { artifactSweepTimer = undefined; sweepArtifacts(); }, 100);
		artifactSweepTimer.unref?.();
	}
	function startArtifactMaintenance(): void {
		if (disposed || artifactInterval) return;
		artifactInterval = setInterval(sweepArtifacts, LOG_CLEANUP_INTERVAL_MS);
		artifactInterval.unref?.();
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
			!completions.has(record.id) &&
			!pendingEndings.has(record.id),
		);
		for (const record of eligible) {
			if (record.logs && !record.logs.ready && !record.logs.removed) record.logs.ready = markTaskReady(record.logs.directory, record.endedAt ?? Date.now());
		}
		scheduleArtifactSweep();
		if (eligible.length <= ENDED_MONITOR_HISTORY_LIMIT) return;
		eligible.sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
		const removeCount = eligible.length - ENDED_MONITOR_HISTORY_LIMIT;
		for (const record of eligible.slice(0, removeCount)) monitors.delete(record.id);
		tasks.changed();
	}

	/** Never prune re-entrantly inside finalizeEnd -> deliver -> outbox. */
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

	/** Live output is best-effort and stays out of the terminal outbox. */
	function publishOutput(message: Parameters<ExtensionAPI["sendMessage"]>[0], triggerTurn: boolean): boolean {
		if (disposed) return false;
		try {
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
			return true;
		} catch { return false; }
	}

	function summaryLine(): string | undefined {
		if (!globallySuppressed.size) return undefined;
		const total = [...globallySuppressed.values()].reduce((sum, count) => sum + count, 0);
		const sources = globallySuppressed.size;
		globallySuppressed.clear();
		if (summaryTimer) clearTimeout(summaryTimer);
		summaryTimer = undefined;
		return `[Session output budget: ${total} events suppressed from ${sources} monitors; event suppression does not alter disk logging. See monitor_list for sources.]`;
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
			publishOutput({ customType: EVENT_MESSAGE_TYPE, content: `monitor session · output budget\n${line}`, display: true,
				details: { mode: "events", description: "session output budget", cause: "output", lines: [line], notices: [line], outputLines: [], notifyLevel: "context" } }, false);
		}, outputBudget.remainingMs());
		summaryTimer.unref?.();
	}

	function forgetSuppression(id: string): void {
		globallySuppressed.delete(id);
		if (!globallySuppressed.size && summaryTimer) clearTimeout(summaryTimer);
		if (!globallySuppressed.size) summaryTimer = undefined;
	}

	function parseNotify(value: Partial<NotifyPolicy> | undefined, base: Readonly<NotifyPolicy> = DEFAULT_NOTIFY): NotifyPolicy {
		if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "output"))) throw new Error("notify accepts only output; end, failure and stop always wake the model");
		const policy = { output: value?.output ?? base.output, terminal: "turn" as const };
		if (!["turn", "context", "none"].includes(policy.output)) throw new Error("notify.output must be turn, context or none");
		return policy;
	}

	function deliver(
		record: MonitorRecord,
		cause: MonitorCause,
		lines: string[],
		level: OutputLevel = record.notify.terminal,
		final = false,
		structured?: { notices: string[]; outputLines: string[] },
	): boolean {
		if (disposed) return false;
		const events = record.mode === "events";
		const description = sanitizeDisplay(record.description).replace(/\s+/g, " ").trim();
		const exhausted = cause === "output" && record.kind !== "job" && Boolean(record.matcher?.snapshot().length) && !record.matcher!.hasRules();
		const rawHeader = `monitor ${record.id} \u00b7 ${description}${exhausted ? " (all once rules matched — call monitor_stop or update if done)" : ""}`;
		const header = capEventLines([rawHeader], MAX_LINE_CHARS).join(" ");
		const bodyBudget = MAX_BATCH_CHARS - header.length - 1;
		const body = events ? capEventLines(lines, bodyBudget) : lines;
		const cappedOutput = structured
			? events ? capEventLines(structured.outputLines, bodyBudget) : structured.outputLines
			: undefined;
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
				source: cloneSource(record.source),
				...(record.job ? { job: { ...record.job, runner: { ...record.job.runner } } } : {}),
				...(record.sourceGap ? { sourceGap: true } : {}),
				...(record.sourceError ? { sourceError: record.sourceError } : {}),
				...(record.wsUrl !== undefined ? { wsUrl: record.wsUrl } : {}),
				...(record.matcher ? { watchCount: record.matcher.snapshot().length } : {}),
				cause,
				lines: cause === "output" ? body : [],
				...(structured ? { notices: structured.notices, outputLines: cappedOutput! } : {}),
				status: record.status,
				eventCount: record.eventCount,
				notifyLevel: level,
				suppressedCount: record.suppressedCount,
				globalSuppressedCount: record.globalSuppressedCount,
				...(final && cappedOutput?.length ? { finalLines: cappedOutput } : final ? { finalLines: body.slice(1) } : {}),
				outputPath: record.logs.directory.outputPath,
				stderrPath: record.logs.directory.stderrPath,
				...logDetails(record),
				...(record.tails ? {
					stdoutTail: record.tails.stdout.text,
					stdoutTailTruncated: record.tails.stdout.truncated,
					stdoutTailNote: record.tails.stdout.note,
					stderrTail: record.tails.stderr.text,
					stderrTailTruncated: record.tails.stderr.truncated,
					stderrTailNote: record.tails.stderr.note,
				} : {}),
				...(record.loopPrompt ? { loopPrompt: record.loopPrompt } : {}),
				loopObservationGroup: record.loopObservationGroup ?? null,
			},
		};
		if (cause !== "output") {
			message.details.notifyLevel = "turn";
			completions.enqueue(record.id, message);
			return true;
		}
		return publishOutput(message, level === "turn");
	}

	function deliverOutput(record: MonitorRecord, lines: string[], count: number, requested: OutputLevel, suppressed = 0): void {
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
		const notices = [...(summary ? [summary] : []), ...(suppressed ? [suppressionNotice(suppressed)] : [])];
		record.eventCount += count;
		deliver(record, "output", [...notices, ...lines], level, false, { notices, outputLines: lines });
	}

	pi.on("agent_start", () => completions.cancelWakeRetry());
	pi.on("session_before_tree", () => completions.cancelWakeRetry());
	pi.on("session_before_compact", (event) => {
		if (event.reason === "manual") completions.cancelWakeRetry();
	});
	pi.on("turn_end", (event, ctx) => {
		lastCtx = ctx;
		if (disposed || event.outcome !== "completed" || ctx.signal?.aborted) return;
		// Pi's triggerTurn:false lane appends after this response and all its
		// tool results, outside the Esc-clearable steering/follow-up queues.
		// Request at most one continuation; existing work satisfies it naturally.
		if (completions.flush(false)) return { continue: true };
	});
	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		// Fallback for results arriving after a boundary, or an interrupted run.
		// Esc aborts the reply, not the outcome: store it without restarting.
		completions.flush(!event.aborted);
	});
	pi.on("session_compact", (event, ctx) => {
		if (event.reason !== "manual") return;
		lastCtx = ctx;
		completions.flush(false);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		if (event.reason !== "manual") return;
		lastCtx = ctx;
		completions.flush(false);
	});
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.isIdle()) completions.flush(true);
	});

	interface Ending {
		status: Exclude<MonitorStatus, "running" | "stopping" | "stop_timeout">;
		cause: MonitorCause; notice?: () => { notices: string[]; tailLines?: string[] }; flush?: boolean; silent?: boolean;
	}
	function isActive(record: MonitorRecord): boolean { return record.status === "running" || record.status === "stopping" || record.status === "stop_timeout" || record.resourceActive === true; }
	function resourceAlive(record: MonitorRecord): boolean {
		return record.observer?.active === true || record.observationLog?.active === true || !!record.socket && !record.socketClosed && record.socket.readyState !== 3;
	}
	function releaseResource(record: MonitorRecord): boolean {
		if (resourceAlive(record)) return false;
		liveResources.delete(record.id);
		record.resourceActive = false;
		setTaskProcess(record.logs.directory, null);
		if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
		record.cleanupTimer = undefined;
		if (record.finalized) discardFailedStart(record);
		if (!liveResources.size) {
			removeExitHook();
			if (disposed) logDirectory?.close();
		}
		scheduleMonitorPrune();
		return true;
	}
	/** Late I/O/close callbacks release ownership without touching a disposed Pi API. */
	function onResourceInactive(record: MonitorRecord): void {
		// An in-flight stop will confirm its own result; its finally retries this check.
		if (record.pendingStop || !record.resourceActive || !releaseResource(record)) return;
		const ending = pendingEndings.get(record.id);
		if (ending) finalizeEnd(record, ending);
		if (!disposed) refreshStatus();
	}
	function discardFailedStart(record: MonitorRecord): void {
		if (!record.startFailed || !record.finalized || resourceAlive(record)) return;
		completions.delete(record.id); pendingEndings.delete(record.id); forgetSuppression(record.id);
		if (!record.logs.ready && !record.logs.removed) record.logs.ready = markTaskReady(record.logs.directory, record.endedAt ?? Date.now());
		monitors.delete(record.id); if (!disposed) tasks.changed(); scheduleArtifactSweep();
	}
	function awaitCleanup(record: MonitorRecord): void {
		if (disposed || record.cleanupTimer || !record.resourceActive) return;
		record.cleanupTimer = setTimeout(() => { record.cleanupTimer = undefined;
			if (releaseResource(record)) { const ending = pendingEndings.get(record.id); if (ending) finalizeEnd(record, ending); refreshStatus(); }
			else awaitCleanup(record);
		}, 100); record.cleanupTimer.unref?.();
	}
	async function stopResource(record: MonitorRecord, force = false): Promise<boolean> {
		if (record.observer) await record.observer.stop(force);
		try { if (force) (record.socket as WebSocket & { terminate?: () => void })?.terminate?.(); record.socket?.close(); } catch { /* confirmation decides success */ }
		if (record.observationLog) await record.observationLog.close(force);
		const deadline = Date.now() + KILL_CONFIRMATION_MS;
		while (resourceAlive(record) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 25));
		return !resourceAlive(record);
	}
	function consumeFinalBatch(record: MonitorRecord, hasNotice: boolean): { notices: string[]; outputLines: string[] } {
		const batch = record.finalBatch;
		let notices: string[] = [];
		let outputLines: string[] = [];
		if (batch && hasNotice && record.notify.output !== "none") {
			const verdict = record.limiter.take(batch.count);
			if (verdict.deliver) {
				record.eventCount += batch.count;
				if (verdict.suppressed) notices = [suppressionNotice(verdict.suppressed)];
				outputLines = batch.lines;
			} else record.suppressedCount += batch.count;
		}
		record.finalBatch = undefined;
		record.pendingLevel = undefined;
		return { notices, outputLines };
	}
	function buildEndingPayload(record: MonitorRecord, rendered: { notices: string[]; tailLines?: string[] }, batch: { notices: string[]; outputLines: string[] }): { body: string[]; notices: string[]; outputLines: string[] } {
		const global = globallySuppressed.get(record.id);
		const notices = [
			...rendered.notices,
			...logNotice(record),
			...(record.sourceGap ? ["[Observation has source gaps; this copy is not the entire external log. Read the runner's original logs when needed.]"] : []),
			...(record.sourceError ? ["[Observation incomplete — " + record.sourceError + "]"] : []),
			...(global ? ["[Session budget suppressed " + global + " events; observation copying is independent.]"] : []),
			...batch.notices,
		];
		const body = [...rendered.notices, ...(rendered.tailLines ?? []), ...notices.slice(rendered.notices.length), ...(rendered.tailLines?.length ? [] : batch.outputLines)];
		return { body, notices, outputLines: batch.outputLines };
	}
	function finalizeEnd(record: MonitorRecord, ending: Ending): void {
		if (record.finalized) return;
		const batch = consumeFinalBatch(record, ending.notice !== undefined);
		record.finalized = true;
		pendingEndings.delete(record.id);
		record.batcher?.close();
		record.status = ending.status;
		record.endedAt = Date.now();
		if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
		record.timeoutTimer = undefined;
		void record.observationLog?.close();
		if (record.mode === "completion" || ending.cause === "job") captureCompletionTails(record);
		if (ending.notice) {
			const payload = buildEndingPayload(record, ending.notice(), batch);
			deliver(record, ending.cause, payload.body, record.notify.terminal, payload.outputLines.length > 0, { notices: payload.notices, outputLines: payload.outputLines });
			forgetSuppression(record.id);
		} else if (globallySuppressed.has(record.id)) scheduleSummary(); else forgetSuppression(record.id);
		releaseResource(record);
		refreshStatus();
		scheduleMonitorPrune();
	}
	function endMonitor(record: MonitorRecord, ending: Ending): Promise<boolean> {
		const current = pendingEndings.get(record.id);
		if (ending.silent) {
			if (current) current.notice = undefined;
			record.finalBatch = undefined;
		}
		if (record.pendingStop) return record.pendingStop;
		if (!record.finalized) {
			// A cleanup retry must not replace a validated job result with a manual-stop outcome.
			if (!current) {
				if (ending.flush) {
					record.outputLines?.stdout.finish();
					record.outputLines?.stderr.finish();
					record.finalBatch ??= record.batcher?.drain();
				}
				pendingEndings.set(record.id, ending);
			}
			record.status = "stopping";
			record.batcher?.close();
			if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
			record.timeoutTimer = undefined;
			refreshStatus();
		}
		const pending = stopResource(record).then(gone => {
			if (gone) {
				releaseResource(record);
				finalizeEnd(record, pendingEndings.get(record.id) ?? ending);
			} else {
				if (!record.finalized) {
					record.status = "stop_timeout";
					const current = pendingEndings.get(record.id);
					if (current?.notice) {
						const lead = "[Observation stop unconfirmed — local observation resources are still closing. The external job was not cancelled. Stop can be retried.]";
						if (current.cause === "job") {
							captureCompletionTails(record);
							const batch = consumeFinalBatch(record, true);
							const payload = buildEndingPayload(record, current.notice(), batch);
							forgetSuppression(record.id);
							deliver(record, "stop_timeout", [lead, ...payload.body], record.notify.terminal, payload.outputLines.length > 0, { notices: [lead, ...payload.notices], outputLines: payload.outputLines });
						} else {
							deliver(record, "stop_timeout", [lead], record.notify.terminal, false, { notices: [lead], outputLines: [] });
						}
						current.notice = undefined;
					}
				}
				awaitCleanup(record);
				refreshStatus();
			}
			return gone;
		}).finally(() => {
			record.pendingStop = undefined;
			onResourceInactive(record);
			scheduleMonitorPrune();
		});
		record.pendingStop = pending;
		return pending;
	}

	async function stopObservation(record: MonitorRecord, notifyModel = false): Promise<{ stopped: boolean; finalLines: string[] }> {
		if (notifyModel) {
			const stopped = await endMonitor(record, { status: "stopped", cause: "stopped", flush: true, notice: () => ({ notices: [STOPPED_NOTICE] }) });
			if (stopped && lastCtx?.isIdle() === true) completions.flush(true);
			return { stopped, finalLines: [] };
		}
		let finalLines: string[] = [];
		if (!record.finalized && !pendingEndings.has(record.id)) {
			record.outputLines?.stdout.finish();
			record.outputLines?.stderr.finish();
			record.finalBatch ??= record.batcher?.drain();
			finalLines = capEventLines(consumeFinalBatch(record, true).outputLines, MAX_BATCH_CHARS);
		}
		const stopped = await endMonitor(record, { status: "stopped", cause: "stopped" });
		return { stopped, finalLines };
	}

	/** Rate-limit a batch, then deliver it. */
	function onBatch(record: MonitorRecord, lines: string[], count: number): void {
		if (record.status !== "running") return;
		const requested = record.pendingLevel ?? record.notify.output;
		record.pendingLevel = undefined;
		if (record.notify.output === "none") return;
		const verdict = record.limiter.take(count);
		if (verdict.deliver) {
			deliverOutput(record, lines, count, requested, verdict.suppressed);
			return;
		}
		record.suppressedCount += count;
		if (verdict.flood) {
			endMonitor(record, {
				status: "flooded",
				cause: "flooded",
				notice: () => ({ notices: [floodNotice(record, verdict.suppressedForMs)] }),
			});
		}
		tasks.changed();
	}

	/** Exit backstop closes only observation connections, readers and copies. */
	function killAllNow(): void {
		for (const record of liveResources.values()) { record.observer?.closeNow(); record.observationLog?.closeNow(); try { record.socket?.close(); } catch { /* OS exit closes sockets too */ } }
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
	 * A /loop activity ended: silently stop its owned observations. Without
	 * this a monitor keeps firing, wakes the agent, and the agent reschedules
	 * the loop the user just stopped.
	 */
	const unsubscribeLoopStopped = pi.events.on(LOOP_STOPPED_CHANNEL, async (data) => {
		if (disposed) return;
		const payload = data as { observationGroups?: string[]; reason?: string } | undefined;
		const groups = new Set(Array.isArray(payload?.observationGroups) ? payload.observationGroups.filter(id => typeof id === "string") : []);
		if (!groups.size) return;
		const stops: Promise<boolean>[] = [];
		for (const record of monitors.values()) {
			if (record.loopObservationGroup === undefined || !groups.has(record.loopObservationGroup)) continue;
			completions.delete(record.id);
			forgetSuppression(record.id);
			if (!isActive(record)) continue;
			stops.push(endMonitor(record, { status: "stopped", cause: "stopped", silent: true }));
			const ctx = lastCtx;
			if (ctx) notify(ctx, `Monitor ${record.id} stopped: its /loop attempt ended (${payload?.reason ?? "stopped"}).`, "info");
		}
		await Promise.all(stops);
	});
	const unsubscribeObservationAdoption = pi.events.on(LOOP_OBSERVATION_ADOPT_CHANNEL, (data) => {
		if (disposed) return;
		const payload = data as { observationGroups?: string[]; prompt?: string; detached?: boolean } | undefined;
		if (!Array.isArray(payload?.observationGroups) || typeof payload.prompt !== "string") return;
		const groups = new Set(payload.observationGroups);
		for (const record of monitors.values()) {
			if (!record.loopObservationGroup || !groups.has(record.loopObservationGroup)) continue;
			record.loopPrompt = payload.prompt;
			if (payload.detached) record.loopObservationGroup = undefined;
		}
		tasks.changed();
	});

	// ------------------------------------------------------------- observing
	interface ArmInput { description: string; mode: MonitorMode; timeoutMs: number; persistent: boolean; loopPrompt?: string; loopObservationGroup?: string; notify?: Partial<NotifyPolicy>; watches?: WatchRule[] }
	function resolveLoopBinding(prompt: string | undefined): Pick<ArmInput, "loopPrompt" | "loopObservationGroup"> {
		if (prompt !== undefined && typeof prompt !== "string") throw new Error("loopPrompt must be a string");
		if (!prompt?.trim()) return {};
		const request: ObservationBinding = { prompt, version: OBSERVATION_LINK_VERSION };
		pi.events.emit(LOOP_OBSERVATION_BIND_CHANNEL, request);
		if (request.acceptedVersion !== undefined && request.acceptedVersion !== OBSERVATION_LINK_VERSION) return {};
		if (request.error) throw new Error(request.error);
		// A version-less binding responder may still return a real activity id.
		// No reply (including a similarly named tool) never implies ownership.
		if (typeof request.observationGroup !== "string" || !request.observationGroup) return {};
		return { loopPrompt: request.canonicalPrompt ?? prompt, loopObservationGroup: request.observationGroup };
	}
	function createRecord(input: ArmInput, source: ObservationSource): MonitorRecord {
		const id = generateId(); outputDir();
		const logs: ManagedLogs = { directory: createTaskDirectory(logDirectory!, id), maxBytes: loadConfig().logMaxMiB * 1024 * 1024, truncated: false, removed: false };
		const record: MonitorRecord = { id, kind: source.kind, source, ...(source.kind === "ws" ? { wsUrl: source.url } : {}), mode: input.mode, description: input.description,
			timeoutMs: input.persistent ? 0 : input.timeoutMs, persistent: input.persistent, createdAt: Date.now(), eventCount: 0, suppressedCount: 0, globalSuppressedCount: 0,
			notify: parseNotify(input.notify), status: "running", loopPrompt: input.loopPrompt, loopObservationGroup: input.loopObservationGroup, logs, limiter: new RateLimiter() };
		if (input.watches !== undefined) record.matcher = new WatchRules(input.watches);
		record.batcher = input.mode === "events" ? new LineBatcher({ windowMs: BATCH_WINDOW_MS, onBatch: (lines, count) => onBatch(record, lines, count) }) : undefined;
		if (input.mode === "events") record.outputLines = { stdout: new OutputLines(line => acceptObservedLine(record, line, "stdout")), stderr: new OutputLines(line => acceptObservedLine(record, line, "stderr")) };
		monitors.set(id, record); return record;
	}
	function acceptObservedLine(record: MonitorRecord, line: string, stream: OutputStream): void {
		if (disposed || record.status !== "running" || record.notify.output === "none") return;
		const match = record.matcher ? record.matcher.match(line, stream) : stream === "stdout" ? { ids: [], level: "turn" as const } : undefined; if (!match) return;
		record.pendingLevel = strongerLevel(record.pendingLevel ?? "none", outputLevel(record.notify.output, match.level)); record.batcher?.pushEvent(stream === "stderr" ? "[stderr] " + line.trimEnd() : line.trimEnd());
	}
	function observedPaths(record: MonitorRecord): string[] {
		if (record.source.kind === "ws") return [];
		return [
			...(record.source.kind === "job" ? [record.source.manifest] : [record.source.stdout, record.source.stderr]),
			record.job?.stdoutPath,
			record.job?.stderrPath,
		].filter((p): p is string => Boolean(p));
	}
	function findOverlappingMonitor(record: MonitorRecord): MonitorRecord | undefined {
		const paths = new Set(observedPaths(record));
		const host = record.source.kind === "ws" ? undefined : record.source.host;
		for (const other of monitors.values()) {
			if (other.id === record.id || !isActive(other)) continue;
			if (record.source.kind === "ws" || other.source.kind === "ws") {
				if (record.source.kind === "ws" && other.source.kind === "ws" && record.source.url === other.source.url) return other;
				continue;
			}
			if (other.source.host === host && observedPaths(other).some(p => paths.has(p))) return other;
		}
		return undefined;
	}
	function receipt(record: MonitorRecord) { return { taskId: record.id, ...observationDetails(record) }; }
	function startTimeout(record: MonitorRecord): void {
		if (record.persistent || record.status !== "running") return;
		record.timeoutTimer = setTimeout(() => { void endMonitor(record, { status: "timed_out", cause: "timeout", flush: true, notice: () => ({ notices: expiryNotice(record).split("\n") }) }); }, record.timeoutMs); record.timeoutTimer.unref?.();
	}
	function observationWarning(record: MonitorRecord, line: string, category?: "source" | "gap"): void {
		if (disposed) return; tasks.changed();
		if (category) {
			const now = Date.now(), last = record.warningAt?.[category];
			if (last !== undefined && now - last < 30_000) return;
			record.warningAt ??= {}; record.warningAt[category] = now;
		}
		publishOutput({ customType: EVENT_MESSAGE_TYPE, content: "monitor " + record.id + " · observation warning\n" + line, display: true,
			details: { monitorId: record.id, description: record.description, cause: category === "gap" ? "source_gap" : "output", lines: [line], notices: [line], outputLines: [], notifyLevel: "context", ...observationDetails(record) } }, false);
	}
	function onLogError(record: MonitorRecord, reason: string): void {
		if (record.logError !== undefined) return;
		record.logError = reason;
		record.logs.error = reason;
		if (disposed) return;
		const outcome = record.status === "running"
			? `The watch continues; later output is not written to ${record.logs.directory.outputPath}; external work is not cancelled.`
			: `The watch is no longer observing; buffered writes may be missing from ${record.logs.directory.outputPath}.`;
		observationWarning(record, `[Log incomplete \u2014 ${reason}. ${outcome}]`);
	}
	function createObservationLog(record: MonitorRecord, paths: Partial<Record<OutputStream, string>>): ObservationLog {
		return new ObservationLog(
			paths,
			record.logs.maxBytes,
			reason => onLogError(record, reason),
			() => { record.logs.truncated = true; if (!disposed) tasks.changed(); },
			log => { record.observationLog = log; },
			() => onResourceInactive(record),
		);
	}
	async function failedStart(record: MonitorRecord, error: unknown): Promise<never> {
		record.startFailed = true;
		const closed = await endMonitor(record, { status: "failed", cause: "error" }); discardFailedStart(record);
		throw new Error("Could not start observation: " + (error instanceof Error ? error.message : String(error)) + (closed ? "" : "; cleanup unconfirmed for observation " + record.id + ", inspect monitor_list and retry monitor_stop"));
	}
	async function armObservation(input: ArmInput, source: FileSource | JobSource): Promise<MonitorRecord> {
		const record = createRecord(input, source);
		try {
			record.resourceActive = true; liveResources.set(record.id, record); installExitHook();
			const logPaths = source.kind === "file"
				? {
					...(source.stdout ? { stdout: record.logs.directory.outputPath } : {}),
					...(source.stderr ? { stderr: record.logs.directory.stderrPath } : {}),
				}
				: { stdout: record.logs.directory.outputPath, stderr: record.logs.directory.stderrPath };
			createObservationLog(record, logPaths);
			record.observer = new FileObservation(source, {
				onData(stream, data) { if (disposed || record.status !== "running") return; record.observationLog?.write(stream, data); if (record.mode === "events") record.outputLines?.[stream].push(data); },
				onGap(stream, reason) { record.sourceGap = true; record.outputLines?.[stream].clear(); observationWarning(record, "[Observation has source gaps — " + stream + ": " + reason + ". This copy is incomplete; consult the runner's original logs. External work was not cancelled.]", "gap"); },
				onIssue(error) { record.sourceError = error; if (error) observationWarning(record, "[Observation incomplete — " + error + "; external work was not stopped]", "source"); else if (!disposed) tasks.changed(); },
				onJob(job) { record.job = job; if (!disposed) tasks.changed(); },
				onComplete(job) {
					if (disposed || record.status !== "running") return;
					record.job = job;
					void endMonitor(record, { status: "completed", cause: "job", flush: true, notice: () => ({ notices: jobHeaderLines(record), tailLines: completionTailLines(record) }) });
				},
				onInactive() { onResourceInactive(record); },
			}, pid => { setTaskProcess(record.logs.directory, pid); });
			await record.observer.prepare();
			if (disposed || record.status !== "running") throw new Error("observation ended during setup"); startTimeout(record); record.observer.start(); return record;
		} catch (error) { return failedStart(record, error); }
	}

	async function armWebSocket(input: ArmInput, source: SocketSource): Promise<MonitorRecord> {
		const record = createRecord(input, source);
		record.resourceActive = true; liveResources.set(record.id, record); installExitHook();
		try {
			const log = createObservationLog(record, { stdout: record.logs.directory.outputPath });
			const socket = source.protocols?.length ? new WebSocket(source.url, source.protocols) : new WebSocket(source.url);
			record.socket = socket;
			socket.addEventListener("message", (event: MessageEvent) => {
				if (disposed || record.status !== "running") return;
				const data = event.data, line = typeof data === "string" ? data : "[binary frame, " + byteLengthOf(data) + " bytes]";
				log.write("stdout", Buffer.from(line + "\n", "utf8"));
				if (typeof data === "string" && !data.trim()) return;
				acceptObservedLine(record, line, "stdout");
			});
			socket.addEventListener("error", () => { void endMonitor(record, { status: "failed", cause: "error", flush: true, notice: () => ({ notices: ["[WebSocket observation error; the remote service was not stopped]"] }) }); });
			socket.addEventListener("close", (event: { code: number }) => {
				record.socketClosed = true;
				if (disposed) { onResourceInactive(record); return; }
				const ending = pendingEndings.get(record.id);
				if (ending) { if (releaseResource(record)) finalizeEnd(record, ending); return; }
				void endMonitor(record, { status: "exited", cause: "closed", flush: true, notice: () => ({ notices: ["[WebSocket closed: " + event.code + "; remote service not stopped]"] }) });
			});
		} catch (error) { return failedStart(record, error); }
		startTimeout(record); return record;
	}

	// ---------------------------------------------------------------- tools

	// Only asynchronous facts use the custom CC card; all tool rows use the host shell.
	pi.registerMessageRenderer(EVENT_MESSAGE_TYPE, (message, options, theme) =>
		renderMonitorMessage(message, options, theme, loadConfig().compactMessages));

	pi.registerTool({
		name: "Monitor", label: "Monitor", description: MONITOR_DESCRIPTION, promptSnippet: MONITOR_SNIPPET, promptGuidelines: MONITOR_PROMPT_GUIDELINES,
		parameters: MonitorParameters, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }, outputSchema: MonitorReceiptSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx; if (disposed) throw new Error("This Monitor runtime has ended");
			const allowed = new Set(["action", "id", "source", "mode", "description", "watches", "timeout_ms", "persistent", "notify", "loopPrompt"]);
			if (Object.keys(params).some(key => !allowed.has(key))) throw new Error("Monitor is observation-only: command and legacy execution fields are no longer supported. Submit business work through an external runner, then provide a source.");
			if (params.action === "update") {
				if (Object.keys(params).some(key => !["action", "id", "watches", "notify"].includes(key))) throw new Error("update accepts only action, id, watches and notify; source/lifetime cannot change");
				if (!params.id?.trim()) throw new Error("update requires an existing Monitor id");
				const record = monitors.get(params.id); if (!record || record.status !== "running") throw new Error("update target is not a running observation; no work was started");
				if (params.watches !== undefined && record.mode !== "events") throw new Error("watches require mode=events");
				if (params.watches !== undefined) validateWatches(params.watches);
				const policy = parseNotify(params.notify, record.notify), before = { watches: record.matcher?.snapshot(), notify: { ...record.notify } };
				const oldRules = JSON.stringify(before.watches);
				if (params.watches !== undefined) { record.matcher ??= new WatchRules([]); record.matcher.update(params.watches); }
				const rulesChanged = oldRules !== JSON.stringify(record.matcher?.snapshot()), outputChanged = policy.output !== record.notify.output; record.notify = policy;
				if (rulesChanged || outputChanged) { record.batcher?.discard(); record.outputLines?.stdout.clear(); record.outputLines?.stderr.clear(); record.pendingLevel = undefined; forgetSuppression(record.id); }
				tasks.changed(); const value = { ...receipt(record), updated: true };
				return { content: [{ type: "text" as const, text: updateReceipt(snapshotMonitor(record), before) }], details: value, structuredContent: value };
			}
			if (params.action !== undefined && params.action !== "start") throw new Error("action must be start or update");
			if (params.id !== undefined) throw new Error("id requires explicit action=update"); if (!params.description?.trim()) throw new Error("description is required");
			const source = normalizeSource(params.source, ctx.cwd), mode: MonitorMode = params.mode ?? (source.kind === "job" ? "completion" : "events");
			if (mode !== "events" && mode !== "completion") throw new Error("mode must be events or completion");
			if (mode === "completion" && source.kind !== "job") throw new Error("completion requires a job manifest with a verifiable terminal status; a log or connection closing is not a business result");
			if (params.watches !== undefined && mode !== "events") throw new Error("watches require mode=events"); if (params.watches !== undefined) validateWatches(params.watches); parseNotify(params.notify);
			const persistent = params.persistent ?? false; if (typeof persistent !== "boolean") throw new Error("persistent must be boolean");
			const { defaultMs, maxMs } = MONITOR_TIMEOUTS[source.kind === "job" ? "completion" : "events"], timeoutMs = params.timeout_ms ?? defaultMs;
			if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > maxMs) throw new Error("timeout_ms is outside this observation mode's supported range");
			const input: ArmInput = { description: params.description, mode, timeoutMs, persistent, notify: params.notify, watches: params.watches, ...resolveLoopBinding(params.loopPrompt) };
			const record = source.kind === "ws" ? await armWebSocket(input, source) : await armObservation(input, source); refreshStatus(); const value = receipt(record);
			const overlap = findOverlappingMonitor(record);
			const overlapNote = overlap
				? `\nNote: active monitor #${overlap.id} (${overlap.mode}) already observes this target; prefer one job mode=events monitor (and action=update) or monitor_stop redundant observers.`
				: "";
			const bindingNote = params.loopPrompt?.trim() && !record.loopObservationGroup
				? "\nNo Loop activity bound; this observation remains independent."
				: "";
			return { content: [{ type: "text" as const, text: startReceipt(snapshotMonitor(record)) + overlapNote + bindingNote }], details: value, structuredContent: value };
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop Monitor",
		description: "Stop an observation by id. Closes only its reader, connection and disposable copies; never cancels or signals the external job. Unconfirmed local cleanup stays listed and retryable.",
		promptSnippet: MONITOR_STOP_SNIPPET,
		parameters: Type.Object({
			id: Type.String({ description: "The monitor id returned by Monitor." }),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		outputSchema: Type.Object({ stopped: Type.Boolean(), id: Type.String(), status: Type.Optional(Type.String()), finalLines: Type.Optional(Type.Array(Type.String())) }),
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
			const { stopped, finalLines } = await stopObservation(record);
			// An already-finalized record (a natural exit with a living background
			// group) keeps its real status; only an un-finalized stop times out.
			const value = {
				stopped,
				id: params.id,
				...(!stopped ? { status: snapshotMonitor(record).status } : {}),
				...(finalLines.length ? { finalLines } : {}),
			};
			return {
				content: [{ type: "text" as const, text: stopReceipt(snapshotMonitor(record), stopped, finalLines) }],
				...(!stopped ? { isError: true } : {}),
				details: value,
				structuredContent: value,
			};
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "List Monitors",
		description: "List this session's observations. Observation status and external job reports are separate; no job is started, cancelled or restarted.",
		promptSnippet: MONITOR_LIST_SNIPPET,
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		outputSchema: Type.Object({ monitors: Type.Array(MonitorSnapshotSchema) }),
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

	// The panel sees snapshots; this runtime retains resource ownership.
	const tasks = registerTaskProvider(pi, {
		id: "monitor", label: "Monitor",
		list() {
			const now = Date.now();
			return [...monitors.values()].map(record => monitorTaskItem(snapshotMonitor(record), now, isActive(record)));
		},
		detail(item) {
			const record = monitors.get(item.id);
			if (!record) throw new Error("this observation is no longer listed");
			const view = snapshotMonitor(record);
			return monitorTaskDetail(view, Date.now(), {
				canStop: isActive(record), finalized: record.finalized === true,
				stdoutArchive: !view.logRemoved && !!view.outputArchivePath && fs.existsSync(view.outputArchivePath),
				stderrArchive: !view.logRemoved && !!view.stderrArchivePath && fs.existsSync(view.stderrArchivePath),
			});
		},
		async stop(id: string): Promise<TaskStopResult> {
			const record = monitors.get(id);
			if (!record || !isActive(record)) return { stopped: false, message: "Observation " + id + " is not running." };
			const { stopped } = await stopObservation(record, true);
			return { stopped, message: stopReceipt(snapshotMonitor(record), stopped) };
		},
	});

	registerSettingsCommand(pi);

	// A Monitor setting changed: the footer follows.
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		// Footer and retention/budget changes take effect without restarting work.
		refreshStatus();
		scheduleArtifactSweep();
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
		// Another process may have edited the Monitor settings file.
		invalidateConfig();
		startArtifactMaintenance();
		sweepArtifacts();
	});

	// --------------------------------------------------------------- lifecycle

	pi.on("session_shutdown", async () => {
		releaseNotificationHover();
		// Set first: the processes killed below exit after Pi has invalidated
		// this extension's API, and their callbacks must not touch it.
		disposed = true;
		unsubscribeLoopStopped?.();
		unsubscribeObservationAdoption?.();
		unsubscribeCapability?.();
		completions.dispose();
		if (artifactInterval) clearInterval(artifactInterval);
		if (artifactSweepTimer) clearTimeout(artifactSweepTimer);
		artifactInterval = undefined;
		artifactSweepTimer = undefined;
		// Close an open task overlay before the context and logs go away.
		tasks.close();
		// Kill synchronously before any await: explicit process.exit can bypass future timers.
		killAllNow();
		// Disarm already-released records and outstanding cleanup polls. Late
		// reader/log close events release retained ownership without rearming
		// timers or using this disposed runtime's Pi API.
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
			finalizeEnd(record, { status: "stopped", cause: "stopped", silent: true });
		}));
		if (!liveResources.size) removeExitHook();
		globallySuppressed.clear();
		if (summaryTimer) clearTimeout(summaryTimer);
		summaryTimer = undefined;
		// An unconfirmed resource keeps its open owner marker: never reclaim a
		// directory merely because this runtime tried, but failed, to stop work.
		if (!liveResources.size) logDirectory?.close();
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
