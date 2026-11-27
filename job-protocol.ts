/** Runner-neutral, read-only observation contract. No process control or execution. */
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";

const JOB_SCHEMA = "pi-cc-job";
const STATUS_SCHEMA = "pi-cc-job.status";
const PROTOCOL_VERSION = 1;
export const MAX_METADATA_BYTES = 64 * 1024;
const MAX_SOURCE_PATH = 4096;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface JobManifest {
	schema: typeof JOB_SCHEMA;
	version: 1;
	jobId: string;
	/** A new immutable identity for every attempt; never reuse a previous runId. */
	runId: string;
	createdAt: number;
	runner: { name: string; id: string };
	stdout?: string;
	stderr?: string;
	status: string;
}
export interface ResolvedJob extends JobManifest { manifestPath: string; host?: string }
export interface JobStatus {
	schema: typeof STATUS_SCHEMA;
	version: 1;
	jobId: string;
	runId: string;
	state: JobState;
	updatedAt: number;
	startedAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string;
}
/** This is the external writer's report, not the observer's exit status or an OS audit. */
export type JobSnapshot = {
	jobId: string; runId: string; runner: { name: string; id: string };
	manifestPath: string; statusPath: string; host?: string;
	stdoutPath?: string; stderrPath?: string; createdAt: number;
	state: JobState | "unknown"; updatedAt?: number; startedAt?: number; endedAt?: number;
	exitCode?: number | null; signal?: string; error?: string;
};

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value as Record<string, unknown>;
}
function json(text: string, label: string): Record<string, unknown> {
	if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error(`${label} exceeds 64 KiB`);
	try { return object(JSON.parse(text), label); } catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
		throw error;
	}
}
function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a 1–128 character identifier`);
	return value;
}
function stamp(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be an integer Unix timestamp in milliseconds`);
	return value;
}
function label(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 500 || CONTROL.test(value)) throw new Error(`${name} must be a non-empty, single-line string (at most 500 characters)`);
	return value;
}
export function validateHost(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	// One SSH destination, not options, host:port, a URI or a shell fragment. Ports/jumps come from ssh_config.
	const destination = typeof value === "string" && value.length <= 255
		? /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?([A-Za-z0-9_.:%-]+)$/.exec(value)?.[1]
		: undefined;
	const ipv6 = destination?.replace(/%[A-Za-z0-9_.-]+$/, "");
	const valid = destination !== undefined && (
		/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(destination) ||
		(ipv6 !== undefined && isIP(ipv6) === 6)
	);
	if (!valid) throw new Error("host must be an SSH alias, hostname, address or user@host; no options, :port or shell syntax");
	return value as string;
}
export function sourcePath(value: unknown, cwd: string, host?: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_PATH || CONTROL.test(value)) throw new Error("source path must be a non-empty path without control characters (at most 4096 characters)");
	const raw = value.startsWith("@") ? value.slice(1) : value;
	if (!raw || !raw.trim()) throw new Error("source path must not be empty");
	if (host) {
		if (!path.posix.isAbsolute(raw)) throw new Error("remote source paths must be absolute POSIX paths; resolve the remote cwd before observing");
		return path.posix.normalize(raw);
	}
	const local = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.resolve(cwd, local);
}

export function parseJobManifest(text: string, manifestPath: string, host?: string): ResolvedJob {
	const raw = json(text, "job manifest");
	if (raw.schema !== JOB_SCHEMA || raw.version !== PROTOCOL_VERSION) throw new Error("unsupported job manifest schema/version");
	const runner = object(raw.runner, "runner");
	const paths = host ? path.posix : path;
	if (typeof manifestPath !== "string" || manifestPath.length > MAX_SOURCE_PATH || CONTROL.test(manifestPath) || !paths.isAbsolute(manifestPath)) throw new Error("manifestPath must already be an absolute, normalized source path");
	const file = paths.normalize(manifestPath);
	const base = host ? path.posix.dirname(file) : path.dirname(file);
	const resolve = (value: unknown) => {
		if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_PATH || CONTROL.test(value)) throw new Error("manifest paths must be non-empty paths without control characters");
		// Relative references are resolved against the manifest, never against Pi's cwd.
		const resolved = host ? path.posix.resolve(base, value) : sourcePath(value, base);
		const relative = host ? path.posix.relative(base, resolved) : path.relative(base, resolved);
		if (relative === ".." || relative.startsWith("../") || relative.startsWith(".." + path.sep) || (host ? path.posix.isAbsolute(relative) : path.isAbsolute(relative))) throw new Error("job source references must remain inside the manifest directory");
		return resolved;
	};
	const stdout = raw.stdout === undefined ? undefined : resolve(raw.stdout);
	const stderr = raw.stderr === undefined ? undefined : resolve(raw.stderr);
	const status = resolve(raw.status);
	const references = [file, status, stdout, stderr].filter((p): p is string => p !== undefined);
	if (new Set(references).size !== references.length) throw new Error("manifest, status and log paths must be distinct");
	return { schema: JOB_SCHEMA, version: 1, jobId: identifier(raw.jobId, "jobId"), runId: identifier(raw.runId, "runId"),
		createdAt: stamp(raw.createdAt, "createdAt"), runner: { name: label(runner.name, "runner.name"), id: label(runner.id, "runner.id") },
		...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}), status, manifestPath: file, ...(host ? { host } : {}) };
}
export function isTerminal(state: JobStatus["state"] | "unknown"): boolean {
	return state === "succeeded" || state === "failed" || state === "cancelled";
}
export function parseJobStatus(text: string, job: ResolvedJob): JobStatus {
	const raw = json(text, "job status");
	if (raw.schema !== STATUS_SCHEMA || raw.version !== PROTOCOL_VERSION) throw new Error("unsupported job status schema/version");
	if (raw.jobId !== job.jobId || raw.runId !== job.runId) throw new Error("job status identity does not match the observed job/run");
	const states: readonly unknown[] = ["queued", "running", "succeeded", "failed", "cancelled"];
	if (!states.includes(raw.state)) throw new Error("invalid job state");
	const state = raw.state as JobState;
	const updatedAt = stamp(raw.updatedAt, "updatedAt");
	const startedAt = raw.startedAt === undefined ? undefined : stamp(raw.startedAt, "startedAt");
	const endedAt = raw.endedAt === undefined ? undefined : stamp(raw.endedAt, "endedAt");
	if (updatedAt < job.createdAt || startedAt !== undefined && (startedAt < job.createdAt || startedAt > updatedAt) || endedAt !== undefined && (endedAt < (startedAt ?? job.createdAt) || endedAt > updatedAt)) throw new Error("job status timestamps are inconsistent");
	const code = raw.exitCode;
	if (code !== undefined && code !== null && (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0 || code > 0xffffffff)) throw new Error("exitCode must be a non-negative integer or null");
	const signal = raw.signal;
	if (signal !== undefined && (typeof signal !== "string" || !/^SIG[A-Z0-9]{1,24}$/.test(signal))) throw new Error("signal must be a signal name");
	if (isTerminal(state)) {
		if (endedAt === undefined || code === undefined) throw new Error("terminal job status requires endedAt and exitCode (null if unavailable)");
		if (state === "succeeded" && (code !== 0 || signal !== undefined)) throw new Error("succeeded requires exitCode 0 and no signal");
		if (state === "failed" && (code === 0 || code === null && signal === undefined)) throw new Error("failed requires a nonzero exit code or a terminating signal");
	} else if (endedAt !== undefined || code !== undefined || signal !== undefined) throw new Error("a nonterminal job must not have an exit result");
	return { schema: STATUS_SCHEMA, version: 1, jobId: job.jobId, runId: job.runId, state, updatedAt,
		...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}),
		...(code !== undefined ? { exitCode: code as number | null } : {}), ...(typeof signal === "string" ? { signal } : {}) };
}
export function jobSnapshot(job: ResolvedJob, status?: JobStatus, error?: string): JobSnapshot {
	return { jobId: job.jobId, runId: job.runId, runner: { ...job.runner }, manifestPath: job.manifestPath, statusPath: job.status,
		...(job.host ? { host: job.host } : {}), ...(job.stdout ? { stdoutPath: job.stdout } : {}), ...(job.stderr ? { stderrPath: job.stderr } : {}),
		createdAt: job.createdAt, state: status?.state ?? "unknown",
		...(status ? { updatedAt: status.updatedAt, ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
			...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}), ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
			...(status.signal ? { signal: status.signal } : {}) } : {}), ...(error ? { error: error.slice(0, 1024) } : {}) };
}
