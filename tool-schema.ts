/** JSON-visible observation-only tool contracts. No compatibility command fields. */
import { Type, type Static } from "typebox";
import { ObservationSourceSchema } from "./observation-source.ts";
import { MAX_WATCHES, MAX_WATCH_TEXT } from "./watches.ts";
import { MONITOR_TIMEOUTS } from "./prompts.ts";

export const WatchSchema = Type.Object({
	id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), text: Type.String({ minLength: 1, maxLength: MAX_WATCH_TEXT }),
	stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")])),
	once: Type.Optional(Type.Boolean()), notify: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context")], { description: "Watch string, not an object. Omit to inherit notify.output." })),
}, { additionalProperties: false });
export const WatchStateSchema = Type.Object({ ...WatchSchema.properties, fired: Type.Boolean() });
export const JobSnapshotSchema = Type.Object({
	jobId: Type.String(), runId: Type.String(), runner: Type.Object({ name: Type.String(), id: Type.String() }),
	manifestPath: Type.String(), statusPath: Type.String(), host: Type.Optional(Type.String()),
	stdoutPath: Type.Optional(Type.String()), stderrPath: Type.Optional(Type.String()), createdAt: Type.Number(),
	state: Type.Union([Type.Literal("unknown"), Type.Literal("queued"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]),
	updatedAt: Type.Optional(Type.Number()), startedAt: Type.Optional(Type.Number()), endedAt: Type.Optional(Type.Number()),
	exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])), signal: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
});
const eventsMode = { anyOf: [
	{ properties: { mode: { const: "events" } }, required: ["mode"] },
	{ not: { required: ["mode"] }, properties: { source: { properties: { kind: { enum: ["file", "ws"] } }, required: ["kind"] } }, required: ["source"] },
] };
export const MonitorParameters = Type.Object({
	action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("update")])),
	id: Type.Optional(Type.String({ description: "Existing observation id; only action=update uses this." })),
	source: Type.Optional(ObservationSourceSchema),
	mode: Type.Optional(Type.Union([Type.Literal("events"), Type.Literal("completion")], { description: "events follows source output; completion waits for an external job's valid terminal status. Default: completion for job sources, events otherwise. No command is executed." })),
	description: Type.Optional(Type.String({ minLength: 1, description: "Required for start; short description of what is observed." })),
	watches: Type.Optional(Type.Array(WatchSchema, { maxItems: MAX_WATCHES, description: "events only: literal source-output matching. [] mutes; omitted means all stdout. Matching never controls the external job." })),
	timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: MONITOR_TIMEOUTS.completion.maxMs, description: "Observation deadline only, never a business-job timeout. Ignored when persistent is true." })),
	persistent: Type.Optional(Type.Boolean({ description: "Keep this observation for the Pi session (no observation timeout). It does not determine how long the external job runs." })),
	notify: Type.Optional(Type.Object({ output: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context"), Type.Literal("none")])) }, { additionalProperties: false, description: 'Live output object, e.g. {"output":"turn"}.' })),
	loopPrompt: Type.Optional(Type.String({ description: "Optional /loop binding. Ending that loop stops only this observation, not the runner's job." })),
}, { additionalProperties: false, allOf: [{
	if: { properties: { action: { const: "update" } }, required: ["action"] },
	then: { required: ["id"], properties: { source: false, mode: false, description: false, timeout_ms: false, persistent: false, loopPrompt: false } },
	else: { required: ["description", "source"], properties: { id: false }, allOf: [
		{ if: eventsMode, then: { properties: { timeout_ms: { maximum: MONITOR_TIMEOUTS.events.maxMs } } } },
		{ if: { properties: { mode: { const: "completion" } }, required: ["mode"] }, then: { properties: { source: { properties: { kind: { const: "job" } }, required: ["kind"] } } } },
		{ if: { required: ["watches"] }, then: eventsMode },
	] },
}] });
export type MonitorInput = Static<typeof MonitorParameters>;
const artifacts = {
	outputPath: Type.String(), stderrPath: Type.String(), outputArchivePath: Type.Optional(Type.String()), stderrArchivePath: Type.Optional(Type.String()),
	logLimitBytes: Type.Optional(Type.Number()), logTruncated: Type.Optional(Type.Boolean()),
	logRemoved: Type.Optional(Type.Boolean()), logError: Type.Optional(Type.String()),
};
export const MonitorReceiptSchema = Type.Object({
	taskId: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("job"), Type.Literal("ws")]),
	mode: Type.Union([Type.Literal("events"), Type.Literal("completion")]), source: ObservationSourceSchema,
	job: Type.Optional(JobSnapshotSchema), timeoutMs: Type.Number(), persistent: Type.Boolean(),
	...artifacts, sourceGap: Type.Optional(Type.Boolean()), sourceError: Type.Optional(Type.String()), updated: Type.Optional(Type.Boolean()),
	notify: Type.Object({ output: Type.String(), terminal: Type.String() }), watches: Type.Optional(Type.Array(WatchStateSchema)),
});
export const MonitorSnapshotSchema = Type.Object({
	id: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("job"), Type.Literal("ws")]),
	mode: Type.Union([Type.Literal("events"), Type.Literal("completion")]), description: Type.String(), source: ObservationSourceSchema,
	job: Type.Optional(JobSnapshotSchema), timeoutMs: Type.Number(), persistent: Type.Boolean(), createdAt: Type.Number(),
	eventCount: Type.Number(), suppressedCount: Type.Number(), globalSuppressedCount: Type.Number(),
	notify: Type.Object({ output: Type.String(), terminal: Type.String() }), resourceActive: Type.Optional(Type.Boolean()), status: Type.String(),
	endedAt: Type.Optional(Type.Number()), loopPrompt: Type.Optional(Type.String()), observationPid: Type.Optional(Type.Number()),
	...artifacts, sourceGap: Type.Optional(Type.Boolean()), sourceError: Type.Optional(Type.String()), watches: Type.Optional(Type.Array(WatchStateSchema)),
});
