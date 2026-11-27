/** Display vocabulary and plain-text receipts for live Monitor observations. */
import { formatDuration } from "./render.ts";
import { sanitizeDisplay } from "./log-tail.ts";
import type { NotifyPolicy } from "./notification-budget.ts";
import type { WatchState } from "./watches.ts";
import type { ObservationSource } from "./observation-source.ts";
import type { JobSnapshot } from "./job-protocol.ts";

export type MonitorRole = "task" | "watcher" | "socket";

/** Structural view shared by live records and serialized snapshots. */
export interface MonitorView {
	id: string;
	kind: "file" | "job" | "ws";
	source?: ObservationSource;
	job?: JobSnapshot;
	sourceGap?: boolean;
	sourceError?: string;
	mode: "completion" | "events";
	description: string;
	persistent: boolean;
	timeoutMs: number;
	notify: NotifyPolicy;
	outputPath: string;
	stderrPath: string;
	status?: string;
	resourceActive?: boolean;
	createdAt?: number;
	endedAt?: number;
	eventCount?: number;
	suppressedCount?: number;
	globalSuppressedCount?: number;
	logError?: string;
	logTruncated?: boolean;
	logRemoved?: boolean;
	logLimitBytes?: number;
	outputArchivePath?: string;
	stderrArchivePath?: string;
	watches?: WatchState[];
}

export function displayLine(value: unknown): string {
	return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

/** Keep host and paths together in receipts, list text, cards and the task panel. */
export function sourceDescription(source: ObservationSource): string {
	const target = source.kind === "ws" ? source.url : source.kind === "job" ? source.manifest : [source.stdout, source.stderr].filter(Boolean).join("; ");
	return displayLine(source.kind !== "ws" && source.host ? `${source.host} · ${target}` : target);
}

export function monitorRole(view: Pick<MonitorView, "kind" | "mode">): MonitorRole {
	if (view.kind === "ws") return "socket";
	return view.mode === "completion" ? "task" : "watcher";
}

export function monitorIdentity(view: MonitorView): string {
	return `${monitorRole(view)} #${view.id} · ${displayLine(view.description)}`;
}

export function observationLabel(watches: WatchState[] | undefined): string {
	if (watches === undefined) return "all stdout";
	if (!watches.length) return "muted";
	if (watches.every((rule) => rule.once && rule.fired)) return "rules exhausted";
	return `${watches.length} rule${watches.length === 1 ? "" : "s"}`;
}

export function monitorBadges(view: MonitorView): string[] {
	const badges: string[] = [];
	if (view.mode === "events") {
		if (view.notify.output === "none" || view.watches?.length === 0) badges.push("output muted");
		else if (view.watches?.length && view.watches.every((rule) => rule.once && rule.fired)) badges.push("rules exhausted");
		else if (view.notify.output === "context") badges.push("output context");
		const count = view.eventCount ?? 0;
		badges.push(`${count} event${count === 1 ? "" : "s"}`);
		if (view.suppressedCount) badges.push(`${view.suppressedCount} suppressed`);
		if (view.globalSuppressedCount) badges.push(`${view.globalSuppressedCount} session-suppressed`);
	}
	if (view.job) {
		badges.push(`job ${view.job.state}`);
		if (view.job.exitCode !== undefined && view.job.exitCode !== null) badges.push(`job exit ${view.job.exitCode}`);
	}
	if (view.sourceGap) badges.push("source gaps");
	if (view.sourceError) badges.push("source incomplete");
	if (view.logRemoved) badges.push("artifacts reclaimed");
	else if (view.logTruncated) badges.push("logs truncated");
	if (view.logError) badges.push("log incomplete");
	if (view.resourceActive && view.status && !["running", "stopping", "stop_timeout"].includes(view.status)) badges.push("cleanup pending");
	return badges;
}

/** First two lines are the operation receipt; paths and model guidance remain available. */
export function startReceipt(view: MonitorView): string {
	const lifetime = view.persistent ? "session lifetime" : `time limit ${formatDuration(view.timeoutMs)}`;
	const lines = [`Started ${monitorIdentity(view)}`, `${view.mode} · ${lifetime}`];
	if (view.source) lines.push(`source: ${sourceDescription(view.source)}`);
	if (view.kind === "file" || view.kind === "job") {
		lines.push("Observation only. Stopping it, exiting/reloading Pi or ending a bound loop does not cancel the external job.");
	}
	if (view.job) lines.push(`external job: ${view.job.jobId} / ${view.job.runId} · ${view.job.runner.name} #${view.job.runner.id} · reported ${view.job.state}`);
	if (view.notify.output !== "turn") lines.push(`notify: output ${view.notify.output} · terminal ${view.notify.terminal}`);
	lines.push(`stdout: ${view.outputPath}`, `stderr: ${view.stderrPath}`);
	if (view.outputArchivePath) lines.push(`previous stdout (if rotated): ${view.outputArchivePath}`);
	if (view.stderrArchivePath) lines.push(`previous stderr (if rotated): ${view.stderrArchivePath}`);
	if (view.logLimitBytes !== undefined) {
		lines.push(`Logs: at most ${view.logLimitBytes / (1024 * 1024)} MiB per task, archives included. Previous segments use .1; logTruncated marks discarded output. Ended copies expire or yield to the quota after terminal handoff and a 10-minute read grace.`);
	}
	if (view.persistent) lines.push("This instance runs until you stop it or the session ends.");
	if (view.mode === "completion") {
		lines.push("Observation receipt only; the external job may already be running or finished. This receipt verifies no business result. Continue independent work; if only waiting for Monitor, end your turn with one short message: what is observed and that you will report after verifying its result. Do NOT report results, conclusions or estimates for this task while it is pending. Do not poll, sleep or re-read the logs just to wait. You will be notified once at the next response/tool-batch boundary or from idle. Read and verify the required outputs before using the result; a completed task does not by itself mean the overall report is ready. Notifications are not user replies.");
	} else {
		lines.push("Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.");
		if (!view.persistent) lines.push("The watch ends at its time limit unless the source ends first; re-arm if you still need it.");
	}
	return lines.join("\n");
}

export interface ObservationPolicy {
	watches?: WatchState[];
	notify: NotifyPolicy;
}

function conditions(watches: WatchState[] | undefined): string {
	return JSON.stringify(watches?.map(({ fired: _fired, ...rule }) => rule)) ?? "all stdout";
}

export function updateReceipt(view: MonitorView, before: ObservationPolicy): string {
	const changes: string[] = [];
	if (conditions(before.watches) !== conditions(view.watches)) {
		const old = before.watches === undefined ? "all stdout" : String(before.watches.length);
		const next = view.watches === undefined ? "all stdout" : String(view.watches.length);
		changes.push(old === next ? `rules revised (${next})` : `rules: ${old} → ${next}${view.watches?.length === 0 ? " (muted)" : ""}`);
	}
	if (before.notify.output !== view.notify.output) changes.push(`output: ${before.notify.output} → ${view.notify.output}`);
	return [
		`Updated ${monitorIdentity(view)}`,
		changes.length ? changes.join(" · ") : "No policy changes.",
		"Observation/notification policy only; work and lifetime unchanged.",
	].join("\n");
}

/** Local confirmation describes the affected resource, never the source's current outcome. */
export function stopScope(view: MonitorView): string {
	if (view.kind === "ws") return "Closes the local WebSocket connection; the remote service is not stopped.";
	return "Stops this observation only; the external runner/job is not cancelled or signalled.";
}

export function stopReceipt(view: MonitorView, stopped: boolean): string {
	if (!stopped) return `Stop unconfirmed · ${monitorIdentity(view)}\nCleanup pending; owned resource still active. Stop can be retried.`;
	if (view.status && view.status !== "stopped") {
		return `Cleanup confirmed · ${monitorIdentity(view)}\nObservation resources released; the recorded observation outcome remains ${view.status}.`;
	}
	const scope = view.kind === "ws"
		? "Local connection closed; remote service not stopped."
		: "Observation resources released; external work was not cancelled.";
	return `Stopped ${monitorIdentity(view)}\n${scope}`;
}

/** A snapshot, not a live status stream. Complete fields stay in structuredContent. */
export function monitorListText(list: MonitorView[], now = Date.now()): string {
	if (!list.length) return "No monitors.";
	return list.map((view) => {
		const state = displayLine(view.status ?? "unknown").padEnd(12);
		const role = monitorRole(view).padEnd(12);
		const meta = monitorBadges(view);
		if (view.createdAt !== undefined) meta.push(formatDuration(Math.max(0, (view.endedAt ?? now) - view.createdAt)));
		if (view.job) meta.push(`job ${view.job.jobId} / ${view.job.runId}`);
		if (view.source) meta.push(`source ${sourceDescription(view.source)}`);
		return `${state} ${role} ${displayLine(view.description)} #${view.id}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
	}).join("\n");
}
