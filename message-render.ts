/** CC-style asynchronous cards. Tool rows remain entirely owned by Pi/ccstyle. */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	bodyLines,
	contentText,
	formatDuration,
	formatStamp,
	renderCard,
	renderNotificationCard,
	type KeyHintFn,
	type NotificationSection,
	type NotificationTone,
} from "./render.ts";
import { sanitizeDisplay } from "./log-tail.ts";
import { displayLine, monitorRole, sourceDescription } from "./monitor-view.ts";
import type { NotifyPolicy } from "./notification-budget.ts";
import type { JobSnapshot } from "./job-protocol.ts";
import type { ObservationSource } from "./observation-source.ts";

export interface MonitorMessageDetails {
	monitorId?: string;
	/** Old command/source details are display-only history, never resumable work. */
	kind?: "file" | "job" | "ws" | "command" | "source";
	source?: ObservationSource;
	job?: JobSnapshot;
	sourceGap?: boolean;
	sourceError?: string;
	mode?: "completion" | "events";
	description?: string;
	cause?: string;
	status?: string;
	sourceId?: string;
	sourceDescription?: string;
	command?: string;
	wsUrl?: string;
	eventCount?: number;
	suppressedCount?: number;
	globalSuppressedCount?: number;
	exitCode?: number | null;
	createdAt?: number;
	endedAt?: number;
	resourceActive?: boolean;
	timeoutMs?: number;
	persistent?: boolean;
	notify?: NotifyPolicy;
	notifyLevel?: string;
	watchCount?: number;
	notices?: string[];
	outputLines?: string[];
	outputPath?: string;
	stderrPath?: string;
	outputArchivePath?: string;
	stderrArchivePath?: string;
	logLimitBytes?: number;
	logTruncated?: boolean;
	logRemoved?: boolean;
	logError?: string;
	stdoutTail?: string;
	stderrTail?: string;
	stdoutTailNote?: string;
	stderrTailNote?: string;
	stdoutTailTruncated?: boolean;
	stderrTailTruncated?: boolean;
	loopPrompt?: string;
}

const LABELS: Record<string, string> = {
	output: "Monitor", source_gap: "Observation Gap", exit: "Monitor Ended", timeout: "Monitor Expired", error: "Monitor Failed",
	closed: "Monitor Closed", stopped: "Monitor Stopped", flooded: "Monitor Stopped", stop_timeout: "Monitor Stop Failed",
};

/** A lifecycle end, not a mid-observation diagnostic (a source gap is not an outcome). */
function isTerminalCause(cause: string | undefined): boolean {
	return cause !== undefined && cause !== "output" && cause !== "source_gap";
}

export function messageLabel(details: MonitorMessageDetails): string {
	// The card belongs to the observation, so its title says Monitor even when the
	// result it reports comes from the external job's status file. A finished
	// observation is `completed`, so a successful job reads the same way here and
	// in saved history.
	if (details.cause === "job" && details.job) return details.job.state === "succeeded" ? "Monitor Completed" : details.job.state === "failed" ? "Monitor Failed" : "Monitor Cancelled";
	if (details.mode === "completion" && details.cause === "exit" && details.status) {
		return details.status === "completed" ? "Monitor Completed" : "Monitor Failed";
	}
	if (details.mode === "completion" && details.cause === "timeout") return "Monitor Stopped";
	return LABELS[details.cause ?? "output"] ?? LABELS.output!;
}

export function messageTone(details: MonitorMessageDetails): ThemeColor {
	if (details.cause === "job" && details.job) return details.job.state === "succeeded" ? "success" : details.job.state === "failed" ? "error" : "warning";
	// A stop we could not confirm is a failed stop, not a warning: the label already
	// says "Stop Failed" and the resource is still alive.
	if (details.cause === "stop_timeout") return "error";
	if (details.cause === "timeout" || details.cause === "flooded" || details.cause === "source_gap") return "warning";
	if (details.cause === "error" || details.status === "failed") return "error";
	// The exit code is the command's own verdict, whichever mode reported it: a
	// successful watcher and a successful completion are the same fact.
	if (details.cause === "exit") {
		if (details.exitCode === 0) return "success";
		if (details.exitCode !== undefined && details.exitCode !== null) return "warning";
	}
	if (details.cause === "output" || details.cause === undefined) return "accent";
	if (details.cause === "stopped" || details.cause === "closed") return "accent";
	return "muted";
}

function cardTone(details: MonitorMessageDetails): NotificationTone {
	const tone = messageTone(details);
	return tone === "success" || tone === "error" || tone === "warning" ? tone : "accent";
}

/** What the card watched, including historical command/subscription entries in saved transcripts. */
function messageRoleOf(details: MonitorMessageDetails): string {
	if (!details.monitorId) return "notification summary";
	const kind = details.kind ?? (details.sourceId ? "source" : details.wsUrl ? "ws" : details.mode ? "command" : undefined);
	if (!kind) return "monitor";
	if (kind === "source") return "subscription";
	if (kind === "command") return details.mode === "completion" ? "task" : "watcher";
	return monitorRole({ kind, mode: details.mode ?? "events" });
}

export function messageIdentity(details: MonitorMessageDetails): string {
	const parts = [messageRoleOf(details) + (details.monitorId ? ` #${details.monitorId}` : "")];
	if (details.sourceId) parts[0] += ` → ${details.sourceDescription ? `${displayLine(details.sourceDescription)} ` : ""}#${details.sourceId}`;
	const terminal = isTerminalCause(details.cause);
	if (terminal && details.resourceActive) parts.unshift("cleanup pending at report");
	if (terminal && details.exitCode !== undefined && details.exitCode !== null) parts.push(`${details.sourceId ? "source exit" : "exit"} ${details.exitCode}`);
	if (terminal && details.createdAt !== undefined && details.endedAt !== undefined) {
		parts.push(`${details.kind === "file" || details.kind === "job" || details.kind === "ws" ? "observed " : ""}${formatDuration(Math.max(0, details.endedAt - details.createdAt))}`);
	}
	if (details.job) parts.push(`job ${details.job.jobId} · ${details.job.state}${terminal && details.job.exitCode !== undefined ? ` · job exit ${details.job.exitCode}` : ""}`);
	if (!terminal && (details.kind === "command" || details.kind === "file")) parts.push("stdout");
	if (!terminal && details.kind === "ws") parts.push("frames");
	if (details.notifyLevel === "context") parts.push("context only");
	return parts.join(" · ");
}

/** Paths are explicit expanded metadata, not part of the folded terminal banner. */
function withoutBannerPaths(lines: string[]): string[] {
	if (!lines.length || !/^\[(?:Monitor |WebSocket )/.test(lines[0]!)) return lines;
	const first = lines[0]!;
	const start = first.indexOf("Output:");
	if (start < 0) return lines;
	return [first.slice(0, start).replace(/[\s.;]+$/, "") + "]", ...lines.slice(1)];
}

/** Display-only selection of real captured output; never summarize or alter raw logs. */
export function messageBody(content: unknown, details: MonitorMessageDetails): string[] {
	const raw = contentText(content).replace(/^monitor \S+ ·[^\n]*\n?/, "");
	const lines = withoutBannerPaths(bodyLines(sanitizeDisplay(raw)));
	const hasTails = typeof details.stdoutTail === "string" || typeof details.stderrTail === "string";
	if (hasTails && (details.cause === "job" || details.mode === "completion" && (details.cause === "exit" || details.cause === "timeout"))) {
		const result: string[] = [];
		const exitCode = details.job ? details.job.exitCode : details.exitCode;
		// A deadline, signal, or missing code needs its actual reason, not just log output.
		if (details.cause === "timeout" || exitCode === null || exitCode === undefined) {
			if (lines[0]) result.push(lines[0]);
		}
		const streams = details.job?.state === "failed" || details.status === "failed" ? ["stderr", "stdout"] as const : ["stdout", "stderr"] as const;
		for (const stream of streams) {
			const text = stream === "stdout" ? details.stdoutTail : details.stderrTail;
			const note = stream === "stdout" ? details.stdoutTailNote : details.stderrTailNote;
			const truncated = stream === "stdout" ? details.stdoutTailTruncated : details.stderrTailTruncated;
			const output = bodyLines(sanitizeDisplay(text ?? ""));
			if (output.length) {
				result.push(`${stream}${truncated ? " (tail truncated)" : ""}: ${output[0]}`, ...output.slice(1));
			} else if (note || stream === "stdout" && !result.length) result.push(`${stream}: (${displayLine(note ?? "no output")})`);
		}
		return result;
	}
	// Old sessions may have a terminal tail only in content, without captured-tail metadata.
	if (details.mode === "completion" && details.cause === "exit" && /^\[Monitor (?:completed|failed) — exit code -?\d+/.test(lines[0] ?? "")) {
		return lines.slice(1);
	}
	if (details.sourceId) {
		if (details.cause === "stopped" && lines[0] === "[Monitor stopped]") {
			return ["Subscription ended; source command was not stopped by this operation.", ...lines.slice(1)];
		}
		if (details.cause === "timeout" || details.cause === "flooded") {
			const reason = details.cause === "timeout" ? "Observation time limit reached" : "Subscription stopped for excessive output";
			return [`${reason}; source command was not stopped by this operation.`, ...lines];
		}
	}
	return lines;
}

/** The one-line collapsed facts: an observable exit and how long the work took. */
function terminalStats(details: MonitorMessageDetails): string[] {
	const stats: string[] = [];
	if (details.job) stats.push(`job ${details.job.state}${details.job.exitCode !== undefined && details.job.exitCode !== null ? ` · exit ${details.job.exitCode}` : ""}`);
	else if (details.exitCode !== undefined && details.exitCode !== null) stats.push(`exit ${details.exitCode}`);
	if (details.createdAt !== undefined && details.endedAt !== undefined) {
		stats.push(`${details.kind === "file" || details.kind === "job" || details.kind === "ws" ? "observed " : ""}${formatDuration(Math.max(0, details.endedAt - details.createdAt))}`);
	}
	return stats;
}

function eventStats(details: MonitorMessageDetails): string[] {
	if (details.mode === "completion" || details.eventCount === undefined) return [];
	const stats = [`${details.eventCount} ${details.eventCount === 1 ? "event" : "events"}`];
	if (details.suppressedCount) stats.push(`${details.suppressedCount} rate-suppressed`);
	if (details.globalSuppressedCount) stats.push(`${details.globalSuppressedCount} session-suppressed`);
	return stats;
}

/**
 * Fallback notice detector for historical persisted messages without structured
 * `details.notices`. Matches only known Monitor protocol prefixes so bracketed
 * user output (e.g. `[1, 2, 3]` or `[PASS]`) is never misclassified as Status.
 */
const HISTORICAL_NOTICE =
	/^\[(?:Monitor |External job |external job |Observation |Rotated logs |Logs truncated |Log incomplete |Task artifacts |Session |WebSocket |\d+ events? suppressed|terminal|exit|timeout|error|closed|stopped|flooded|stop_timeout)/;

function isNotice(line: string): boolean {
	return HISTORICAL_NOTICE.test(line) || line.endsWith("was not stopped by this operation.");
}

/** Everything the folded card cannot show, split into the sections a reader looks for. */
function cardSections(details: MonitorMessageDetails, body: string[]): NotificationSection[] {
	const sections: NotificationSection[] = [];
	const structured = Array.isArray(details.notices);
	const notices = structured
		? details.notices!.flatMap((line) => bodyLines(sanitizeDisplay(line)))
		: body.filter(isNotice);
	const hasTails = typeof details.stdoutTail === "string" || typeof details.stderrTail === "string";
	const output = structured
		? hasTails || details.mode === "completion"
			? body
			: (details.outputLines ?? []).flatMap((line) => bodyLines(sanitizeDisplay(line)))
		: body.filter((line) => !isNotice(line));
	if (details.description) {
		sections.push({ heading: "Description", lines: [displayLine(details.description)], color: "text" });
	}
	sections.push({ heading: "Status", lines: [messageIdentity(details), ...notices], color: "muted" });
	if (details.sourceId) {
		const rules = details.watchCount !== undefined ? `${details.watchCount} rules` : "all stdout";
		sections.push({ heading: "Source", lines: [`#${details.sourceId} · ${rules}`], color: "dim" });
	}
	if (details.source) sections.push({ heading: "Source", lines: [sourceDescription(details.source)], color: "dim" });
	if (details.job) sections.push({ heading: "External job", lines: [displayLine(`${details.job.jobId} / ${details.job.runId} · ${details.job.runner.name} #${details.job.runner.id}`), ...(details.job.host ? [`host: ${displayLine(details.job.host)}`] : []), `reported state: ${details.job.state}`, ...(details.job.exitCode !== undefined ? [`job exit: ${details.job.exitCode}`] : []), `status: ${displayLine(details.job.statusPath)}`], color: "dim" });
	if (details.sourceError) sections.push({ heading: "Observation error", lines: [displayLine(details.sourceError), "External work was not cancelled."], color: "warning" });
	const events = eventStats(details);
	if (events.length) sections.push({ heading: "Events", lines: events, color: "dim" });
	if (output.length) sections.push({ heading: "Output", lines: output, color: "toolOutput" });
	if (details.command) {
		sections.push({ heading: "Command", lines: [sanitizeDisplay(details.command)], color: "toolOutput" });
	}
	if (details.wsUrl) {
		sections.push({ heading: "Socket", lines: [displayLine(details.wsUrl)], color: "toolOutput" });
	}
	const limits: string[] = [];
	if (details.notify) limits.push(`notify: output ${details.notify.output} · terminal ${details.notify.terminal}`);
	if (!details.notify && details.notifyLevel) limits.push(`notify: ${details.notifyLevel}`);
	if (details.persistent) limits.push("lifetime: until stopped or the session ends");
	else if (details.timeoutMs !== undefined) limits.push(`time limit: ${formatDuration(details.timeoutMs)}`);
	if (limits.length) sections.push({ heading: "Limits", lines: limits, color: "dim" });
	const logs: string[] = [];
	if (details.outputPath) logs.push(`stdout: ${sanitizeDisplay(details.outputPath)}`);
	if (details.stderrPath) logs.push(`stderr: ${sanitizeDisplay(details.stderrPath)}`);
	if (details.logLimitBytes !== undefined) logs.push(`disk limit: ${details.logLimitBytes / (1024 * 1024)} MiB (archives included)`);
	if (details.outputArchivePath) logs.push(`previous stdout (if rotated): ${sanitizeDisplay(details.outputArchivePath)}`);
	if (details.stderrArchivePath) logs.push(`previous stderr (if rotated): ${sanitizeDisplay(details.stderrArchivePath)}`);
	if (details.logRemoved) logs.push("artifacts reclaimed by retention/quota");
	else if (details.logTruncated) logs.push("logs truncated; only recent segments retained");
	if (details.sourceGap) logs.push("source gaps; this copy is not the entire external log");
	if (details.logError) logs.push(`log incomplete: ${sanitizeDisplay(details.logError)}`);
	if (logs.length) sections.push({ heading: "Logs", lines: logs, color: "dim" });
	if (details.loopPrompt) {
		sections.push({ heading: "Loop", lines: [displayLine(details.loopPrompt)], color: "dim" });
	}
	return sections;
}

export function renderMonitorMessage(
	message: { content: unknown; details?: unknown; timestamp?: number },
	options: { expanded: boolean; outputPad: number; keyHint?: KeyHintFn },
	theme: Theme,
	compact = true,
): Component {
	const details = (message.details ?? {}) as MonitorMessageDetails;
	const body = messageBody(message.content, details);
	if (!compact) {
		const header = [
			theme.fg(messageTone(details), theme.bold(messageLabel(details))),
			...(formatStamp(message.timestamp) ? [theme.fg("muted", formatStamp(message.timestamp))] : []),
			...(details.description ? [theme.fg("dim", displayLine(details.description))] : []),
		].join(theme.fg("dim", " · "));
		// The header already carries the description, so the section list starts at Status.
		return renderCard({
			header,
			body: cardSections(details, body)
				.filter((section) => section.heading !== "Description")
				.flatMap((section) => section.lines)
				.join("\n"),
			expanded: options.expanded,
			outputPad: options.outputPad,
			theme,
			keyHint: options.keyHint,
		});
	}
	// Process and outcome share one collapsed line; the difference is the icon
	// and what the expansion holds.
	const terminal = isTerminalCause(details.cause);
	return renderNotificationCard(message, options, theme, {
		title: messageLabel(details),
		id: details.monitorId,
		subtitle: details.description ? displayLine(details.description) : undefined,
		stamp: formatStamp(message.timestamp),
		stats: terminal ? terminalStats(details) : eventStats(details),
		tone: cardTone(details),
		terminal,
		sections: cardSections(details, body),
	});
}