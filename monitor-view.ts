/** Display vocabulary and plain-text receipts. No execution or notification state changes. */
import { formatDuration } from "./render.ts";
import { sanitizeDisplay } from "./log-tail.ts";
import type { NotifyPolicy } from "./notification-budget.ts";
import type { WatchState } from "./watches.ts";

export type MonitorRole = "task" | "watcher" | "socket" | "subscription";

/** Structural view shared by live records and serialized snapshots. */
export interface MonitorView {
	id: string;
	kind: "command" | "ws" | "source";
	mode: "completion" | "events";
	description: string;
	sourceId?: string;
	persistent: boolean;
	timeoutMs: number;
	notify: NotifyPolicy;
	outputPath: string;
	stderrPath: string;
	status?: string;
	resourceActive?: boolean;
	createdAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	eventCount?: number;
	suppressedCount?: number;
	globalSuppressedCount?: number;
	logError?: string;
	watches?: WatchState[];
}

export function displayLine(value: unknown): string {
	return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

export function monitorRole(view: Pick<MonitorView, "kind" | "mode">): MonitorRole {
	if (view.kind === "source") return "subscription";
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
		// Policy is more important than counts when the right side is clipped.
		if (view.notify.output === "none" || view.kind === "source" && view.watches?.length === 0) badges.push("output muted");
		else if (view.kind === "source" && view.watches?.length && view.watches.every((rule) => rule.once && rule.fired)) badges.push("rules exhausted");
		else if (view.notify.output === "context") badges.push("output context");
		const count = view.eventCount ?? 0;
		badges.push(`${count} event${count === 1 ? "" : "s"}`);
		if (view.suppressedCount) badges.push(`${view.suppressedCount} suppressed`);
		if (view.globalSuppressedCount) badges.push(`${view.globalSuppressedCount} session-suppressed`);
	}
	if (view.notify.terminal === "context") badges.push("terminal context");
	if (view.logError) badges.push("log incomplete");
	if (view.resourceActive && view.status && !["running", "stopping", "stop_timeout"].includes(view.status)) badges.push("cleanup pending");
	return badges;
}

/** First two lines are the operation receipt; paths and model guidance remain available. */
export function startReceipt(view: MonitorView): string {
	const lifetime = view.persistent ? "session lifetime" : `time limit ${formatDuration(view.timeoutMs)}`;
	const setup = view.kind === "source"
		? `source #${view.sourceId} · ${observationLabel(view.watches)} · ${lifetime}`
		: `${view.mode} · ${lifetime}`;
	const lines = [`Started ${monitorIdentity(view)}`, setup];
	if (view.kind === "source") lines.push("Subscription only; stopping it does not stop the source command.");
	if (view.notify.output !== "turn" || view.notify.terminal !== "turn") {
		lines.push(`notify: output ${view.notify.output} · terminal ${view.notify.terminal}`);
	}
	lines.push(`stdout: ${view.outputPath}`, `stderr: ${view.stderrPath}`);
	if (view.persistent) lines.push("This instance runs until you stop it or the session ends.");
	if (view.mode === "completion") {
		lines.push("No result exists yet. Continue independent work; if only waiting for Monitor, end your turn with one short message: what is running and that you will report when it finishes. Do NOT report results, conclusions or estimates for this task while it is pending. Do not poll, sleep or re-read the logs just to wait. You will be notified once at the next response/tool-batch boundary or from idle. Read and verify the required outputs before using the result; a completed task does not by itself mean the overall report is ready. Notifications are not user replies.");
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
	if (before.notify.terminal !== view.notify.terminal) changes.push(`terminal: ${before.notify.terminal} → ${view.notify.terminal}`);
	return [
		`Updated ${monitorIdentity(view)}`,
		changes.length ? changes.join(" · ") : "No policy changes.",
		"Observation/notification policy only; work and lifetime unchanged.",
	].join("\n");
}

/** Local confirmation describes the affected resource, never the source's current outcome. */
export function stopScope(view: MonitorView): string {
	if (view.kind === "source") return `Ends this subscription only; source command #${view.sourceId} is not stopped by this operation.`;
	if (view.kind === "ws") return "Closes the local WebSocket connection; the remote service is not stopped.";
	return "Stops this command and cleans up its owned process group.";
}

export function stopReceipt(view: MonitorView, stopped: boolean): string {
	if (!stopped) return `Stop unconfirmed · ${monitorIdentity(view)}\nCleanup pending; owned resource still active. Stop can be retried.`;
	if (view.status && view.status !== "stopped") {
		return `Cleanup confirmed · ${monitorIdentity(view)}\nOwned resources released; the recorded outcome remains ${view.status}.`;
	}
	const scope = view.kind === "source"
		? `Subscription ended; source command #${view.sourceId} was not stopped by this operation.`
		: view.kind === "ws" ? "Local connection closed; remote service not stopped." : "Owned resources released.";
	return `Stopped ${monitorIdentity(view)}\n${scope}`;
}

/** A snapshot, not a live status stream. Complete fields stay in structuredContent. */
export function monitorListText(list: MonitorView[], now = Date.now()): string {
	if (!list.length) return "No monitors.";
	return list.map((view) => {
		const state = displayLine(view.status ?? "unknown").padEnd(12);
		const role = monitorRole(view).padEnd(12);
		const source = view.sourceId ? ` → #${view.sourceId}` : "";
		const meta = monitorBadges(view);
		if (view.createdAt !== undefined) meta.push(formatDuration(Math.max(0, (view.endedAt ?? now) - view.createdAt)));
		if (view.exitCode !== undefined && view.exitCode !== null) meta.push(`${view.kind === "source" ? "source exit" : "exit"} ${view.exitCode}`);
		return `${state} ${role} ${displayLine(view.description)} #${view.id}${source}${meta.length ? ` · ${meta.join(" · ")}` : ""}`;
	}).join("\n");
}
