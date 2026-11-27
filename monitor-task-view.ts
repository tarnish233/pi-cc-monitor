/** Task panel projection from an observation snapshot, never from runner handles. */
import type { MonitorSnapshot } from "./index.ts";
import { monitorBadges, monitorRole, observationLabel, sourceDescription, stopScope } from "./monitor-view.ts";
import { formatDuration } from "./render.ts";
import type { TaskDetail, TaskItem, TaskLogRef } from "./tasks.ts";

export function monitorTaskItem(view: MonitorSnapshot, now: number, canStop: boolean): TaskItem {
	const badges = monitorBadges(view);
	badges.push(formatDuration(Math.max(0, (view.endedAt ?? now) - view.createdAt)));
	return { id: view.id, title: view.description, createdAt: view.createdAt, state: view.status,
		role: monitorRole(view), stopConfirmation: stopScope(view), active: canStop, meta: badges.join(" · ") };
}

export function monitorTaskDetail(
	view: MonitorSnapshot,
	now: number,
	state: { canStop: boolean; finalized: boolean; stdoutArchive: boolean; stderrArchive: boolean },
): TaskDetail {
	const elapsed = Math.max(0, (view.endedAt ?? now) - view.createdAt);
	const remaining = view.timeoutMs - elapsed;
	const lifetime = view.persistent
		? "until stopped or this Pi session ends"
		: formatDuration(view.timeoutMs) + (view.status === "running"
			? " observation timeout · " + (remaining > 0 ? formatDuration(remaining) + " left" : "expired")
			: " configured observation timeout");
	const logs: TaskLogRef[] = [
		{ label: "stdout (observation copy)", path: view.outputPath },
		{ label: "stderr (observation copy)", path: view.stderrPath },
	];
	if (!view.logRemoved && state.stdoutArchive && view.outputArchivePath) logs.push({ label: "stdout (previous segment)", path: view.outputArchivePath });
	if (!view.logRemoved && state.stderrArchive && view.stderrArchivePath) logs.push({ label: "stderr (previous segment)", path: view.stderrArchivePath });
	const job = view.job;
	const sections: NonNullable<TaskDetail["sections"]> = [
		{ title: "Observer", rows: [
			{ label: "Status", value: view.status },
			{ label: "Kind", value: monitorRole(view) + " · " + view.kind },
			{ label: "Resource", value: view.resourceActive ? state.finalized ? "observation cleanup pending" : "observation only; active" : "observation released" },
			{ label: "Source", value: sourceDescription(view.source) },
			...(view.sourceError ? [{ label: "Source error", value: view.sourceError }] : []),
		] },
		...(job ? [{ title: "External job", rows: [
			{ label: "Run", value: job.jobId + " / " + job.runId },
			{ label: "Reported", value: job.state },
			{ label: "Runner", value: job.runner.name + " · " + job.runner.id },
			{ label: "Job exit", value: job.exitCode != null ? String(job.exitCode) : "not reported" },
		] }] : []),
		...(view.mode === "events" ? [{ title: "Observation", rows: [
			{ label: "Rules", value: observationLabel(view.watches) },
			...(view.watches?.map(rule => ({ label: "Watch " + rule.id, value: rule.stream + " · " + (rule.once ? "once" : "repeat") + " · " + rule.notify + " · " + (rule.fired ? "matched" : "waiting") + " · " + rule.text })) ?? []),
			{ label: "Events", value: view.eventCount + " delivered" + (view.suppressedCount ? " · " + view.suppressedCount + " rate-suppressed" : "") },
			...(view.globalSuppressedCount ? [{ label: "Session budget", value: view.globalSuppressedCount + " events suppressed; copying is independent" }] : []),
		] }] : []),
		{ title: "Delivery", rows: [
			{ label: "Mode", value: view.mode === "completion" ? "completion · external job terminal report" : "events · observed source output" },
			{ label: "Output", value: view.notify.output }, { label: "Terminal", value: view.notify.terminal },
		] },
		{ title: "Lifetime", rows: [
			{ label: "Elapsed", value: formatDuration(elapsed) }, { label: "Lifetime", value: lifetime },
			...(view.loopPrompt ? [{ label: "Loop", value: view.loopPrompt }] : []),
			...(view.observationPid !== undefined ? [{ label: "Observation PID", value: String(view.observationPid) }] : []),
		] },
		{ title: "Logs", rows: [
			{ label: "stdout copy", value: view.outputPath }, { label: "stderr copy", value: view.stderrPath },
			...(view.logLimitBytes !== undefined ? [{ label: "Disk limit", value: view.logLimitBytes / (1024 * 1024) + " MiB (copies and archives only)" }] : []),
			...(view.logRemoved ? [{ label: "Log status", value: "observation artifacts reclaimed" }] : view.logTruncated ? [{ label: "Log status", value: "copy truncated; recent segments only" }] : []),
			...(view.sourceGap ? [{ label: "Source gaps", value: "copy does not contain all external output" }] : []),
			...(view.logError ? [{ label: "Log error", value: view.logError }] : []),
		] },
	];
	return { rows: sections.flatMap(section => section.rows), sections, logs,
		note: state.canStop ? "x: " + stopScope(view) : "This observation has ended; its actions are disabled." };
}
