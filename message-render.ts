/** CC-style asynchronous cards. Tool rows remain entirely owned by Pi/ccstyle. */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { bodyLines, contentText, formatDuration, formatStamp, renderCard } from "./render.ts";
import { sanitizeDisplay } from "./log-tail.ts";
import { displayLine, monitorRole } from "./monitor-view.ts";
import type { NotifyPolicy } from "./notification-budget.ts";

export interface MonitorMessageDetails {
	monitorId?: string;
	kind?: "command" | "ws" | "source";
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
	outputPath?: string;
	stderrPath?: string;
	stdoutTail?: string;
	stderrTail?: string;
	stdoutTailNote?: string;
	stderrTailNote?: string;
	stdoutTailTruncated?: boolean;
	stderrTailTruncated?: boolean;
	loopPrompt?: string;
}

const LABELS: Record<string, string> = {
	output: "monitor", exit: "monitor ended", timeout: "monitor expired", error: "monitor failed",
	closed: "monitor closed", stopped: "monitor stopped", flooded: "monitor stopped", stop_timeout: "monitor stop failed",
};

export function messageLabel(details: MonitorMessageDetails): string {
	if (details.mode === "completion" && details.cause === "exit" && details.status) {
		return details.status === "completed" ? "monitor completed" : "monitor failed";
	}
	if (details.mode === "completion" && details.cause === "timeout") return "monitor stopped";
	return LABELS[details.cause ?? "output"] ?? LABELS.output!;
}

export function messageTone(details: MonitorMessageDetails): ThemeColor {
	if (details.cause === "stop_timeout" || details.cause === "timeout" || details.cause === "flooded") return "warning";
	if (details.cause === "error" || details.status === "failed") return "error";
	if (details.mode === "completion" && details.status === "completed") return "success";
	if (details.cause === "output" || details.cause === undefined) return "accent";
	if (details.exitCode !== undefined && details.exitCode !== null && details.exitCode !== 0) return "warning";
	if (details.cause === "stopped" || details.cause === "exit" || details.cause === "closed") return "accent";
	return "muted";
}

function messageRole(details: MonitorMessageDetails): string {
	if (!details.monitorId) return "notification summary";
	const kind = details.kind ?? (details.sourceId ? "source" : details.wsUrl ? "ws" : details.mode ? "command" : undefined);
	return kind ? monitorRole({ kind, mode: details.mode ?? "events" }) : "monitor";
}

export function messageIdentity(details: MonitorMessageDetails): string {
	const parts = [messageRole(details) + (details.monitorId ? ` #${details.monitorId}` : "")];
	if (details.sourceId) parts[0] += ` → ${details.sourceDescription ? `${displayLine(details.sourceDescription)} ` : ""}#${details.sourceId}`;
	const terminal = details.cause !== undefined && details.cause !== "output";
	if (terminal && details.resourceActive) parts.unshift("cleanup pending at report");
	if (terminal && details.exitCode !== undefined && details.exitCode !== null) parts.push(`${details.sourceId ? "source exit" : "exit"} ${details.exitCode}`);
	if (terminal && details.createdAt !== undefined && details.endedAt !== undefined) {
		parts.push(formatDuration(Math.max(0, details.endedAt - details.createdAt)));
	}
	if (!terminal && details.kind === "command") parts.push("stdout");
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
	if (details.mode === "completion" && hasTails && (details.cause === "exit" || details.cause === "timeout")) {
		const result: string[] = [];
		// A deadline, signal, or missing code needs its actual reason, not just log output.
		if (details.cause === "timeout" || details.exitCode === null || details.exitCode === undefined) {
			if (lines[0]) result.push(lines[0]);
		}
		const streams = details.status === "failed" ? ["stderr", "stdout"] as const : ["stdout", "stderr"] as const;
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

function expandedMeta(details: MonitorMessageDetails): string[] {
	const lines: string[] = [];
	if (details.monitorId) lines.push(`id ${details.monitorId}${details.kind ? ` · ${details.kind}/${details.mode ?? "events"}` : ""}`);
	if (details.eventCount !== undefined && details.mode !== "completion") lines.push(`${details.eventCount} events delivered${details.suppressedCount ? ` · ${details.suppressedCount} rate-suppressed` : ""}${details.globalSuppressedCount ? ` · ${details.globalSuppressedCount} session-suppressed` : ""}`);
	if (details.sourceId) lines.push(`source #${details.sourceId}${details.watchCount !== undefined ? ` · ${details.watchCount} rules` : " · all stdout"}`);
	if (details.notify) lines.push(`notify: output ${details.notify.output} · terminal ${details.notify.terminal}`);
	if (details.persistent) lines.push("lifetime: until stopped or the session ends");
	else if (details.timeoutMs !== undefined) lines.push(`time limit: ${formatDuration(details.timeoutMs)}`);
	if (details.command) lines.push(`command: ${sanitizeDisplay(details.command)}`);
	if (details.wsUrl) lines.push(`socket: ${displayLine(details.wsUrl)}`);
	if (details.outputPath) lines.push(`stdout: ${sanitizeDisplay(details.outputPath)}`);
	if (details.stderrPath) lines.push(`stderr: ${sanitizeDisplay(details.stderrPath)}`);
	if (details.loopPrompt) lines.push(`loop: ${displayLine(details.loopPrompt)}`);
	return lines;
}

/** One title, one identity line, two physical body rows, then an honest expansion hint. */
export function renderMonitorMessage(
	message: { content: unknown; details?: unknown; timestamp?: number },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
	compact = true,
): Component {
	const details = (message.details ?? {}) as MonitorMessageDetails;
	const label = `✻ ${messageLabel(details)}`;
	const stamp = formatStamp(message.timestamp);
	const body = messageBody(message.content, details);
	const identity = messageIdentity(details);
	const meta = expandedMeta(details);
	const header = () => [
		theme.fg(messageTone(details), theme.bold(label)),
		...(stamp ? [theme.fg("muted", stamp)] : []),
		...(details.description ? [theme.fg("dim", displayLine(details.description))] : []),
	].join(theme.fg("dim", " · "));
	if (!compact) {
		return renderCard({ header: header(), body: [identity, ...body, ...meta].join("\n"), expanded: options.expanded, outputPad: options.outputPad, theme });
	}
	return {
		invalidate() {}, // No width- or theme-colored cache is retained.
		render(width: number): string[] {
			const columns = Math.max(1, Math.floor(Number(width) || 0));
			const pad = Math.max(0, Math.min(columns - 1, Math.floor(Number(options.outputPad) || 0)));
			const indent = Math.min(columns - 1, pad + 2);
			const available = Math.max(1, columns - indent);
			const fitted = (text: string, padding: number) => " ".repeat(padding) + truncateToWidth(text, columns - padding, "…");
			const lines = [fitted(header(), pad), fitted(theme.fg("dim", identity), indent)];
			const wrapped = body.flatMap((line) => wrapTextWithAnsi(line, available));
			const shown = options.expanded ? wrapped : wrapped.slice(0, 2);
			for (const line of shown) lines.push(fitted(theme.fg("customMessageText", line), indent));
			if (!options.expanded && wrapped.length > shown.length) {
				lines.push(fitted(theme.fg("dim", `+${wrapped.length - shown.length} more lines`), indent));
			}
			if (options.expanded && meta.length) {
				lines.push("");
				for (const line of meta) {
					for (const part of wrapTextWithAnsi(line, available)) lines.push(fitted(theme.fg("dim", part), indent));
				}
			}
			return lines;
		},
	};
}
