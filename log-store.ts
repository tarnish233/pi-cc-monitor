/** Private runtime/task artifacts, with ownership-checked TTL and quota GC.
 * A runtime allocates its directory lazily. Each command/socket owns one task
 * directory; subscriptions share it. A task becomes collectible only after
 * resource cleanup and terminal handoff, plus a 10-minute read grace.
 * Other live runtimes, uncertain owners, legacy unmarked paths and symlinked
 * markers are never reclaimed. Size/TTL pressure only affects eligible data.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPidAlive, writeAtomic } from "./plugin-settings.ts";

const DIR_PREFIX = "pi-cc-monitor-";
const METADATA_NAME = "owner.json";
const OWNER_SCHEMA = "pi-cc-monitor.owner";
const TASK_SCHEMA = "pi-cc-monitor.task";
const TASK_MARKER = "task.json";
const TASK_ID = /^[a-z0-9_-]{1,64}$/;
export const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
export const LOG_BUDGET_BYTES = 200 * 1024 * 1024;
export const LOG_READ_GRACE_MS = 10 * 60 * 1000;
export const LOG_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

interface OwnerMetadata {
	schema: string;
	version: number;
	kind: string;
	pid: number;
	hostname: string;
	createdAt: number;
	closedAt: number | null;
	ownerToken?: string;
}
export interface LogDirectory {
	path: string;
	token: string;
	close(): void;
}
export interface TaskDirectory {
	id: string;
	path: string;
	root: LogDirectory;
	outputPath: string;
	stderrPath: string;
}
interface TaskMetadata {
	schema: typeof TASK_SCHEMA;
	version: 1;
	kind: "task";
	id: string;
	ownerToken: string;
	createdAt: number;
	endedAt: number | null;
	readyAt: number | null;
	resourcePid?: number | null;
}
export interface LogCleanupPolicy {
	retentionMs: number;
	budgetBytes: number;
}
export interface LogCleanupOptions {
	policy?: LogCleanupPolicy;
	current?: LogDirectory;
	protectedIds?: ReadonlySet<string>;
}
export interface LogCleanupResult {
	removedTasks: string[];
	removedDirectories: string[];
}
function chmodOrNull(target: string, mode: number): void {
	try { fs.chmodSync(target, mode); } catch { /* best effort on Windows */ }
}
function writeMetadata(dir: string, name: string, metadata: unknown): void {
	writeAtomic(path.join(dir, name), `${JSON.stringify(metadata, null, "\t")}\n`);
}
function readMetadata(file: string): Record<string, unknown> | undefined {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return;
	const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function readOwnerMetadata(dir: string): OwnerMetadata | undefined {
	try {
		const meta = readMetadata(path.join(dir, METADATA_NAME));
		if (!meta || meta.schema !== OWNER_SCHEMA || meta.kind !== "monitor" || meta.version !== 1) return;
		const pid = meta.pid;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
		if (typeof meta.hostname !== "string" || !meta.hostname) return;
		const closedAt = meta.closedAt ?? null;
		if (closedAt !== null && (typeof closedAt !== "number" || !Number.isFinite(closedAt))) return;
		if (meta.ownerToken !== undefined && (typeof meta.ownerToken !== "string" || !meta.ownerToken)) return;
		return {
			schema: OWNER_SCHEMA, kind: "monitor", version: 1, pid, hostname: meta.hostname,
			createdAt: typeof meta.createdAt === "number" && Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
			closedAt, ...(typeof meta.ownerToken === "string" ? { ownerToken: meta.ownerToken } : {}),
		};
	} catch { return; }
}
function ourUid(stat: fs.Stats): boolean {
	const uid = process.geteuid?.() ?? process.getuid?.();
	return uid === undefined || stat.uid === uid;
}
function owns(root: LogDirectory): boolean {
	try {
		const stat = fs.lstatSync(root.path);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !ourUid(stat)) return false;
		const metadata = readOwnerMetadata(root.path);
		return metadata?.pid === process.pid && metadata.hostname === os.hostname() && metadata.ownerToken === root.token && metadata.closedAt === null;
	} catch { return false; }
}
export function createLogDirectory(base: string = os.tmpdir()): LogDirectory {
	const root = typeof base === "string" && base.length > 0 ? base : os.tmpdir();
	const dir = fs.mkdtempSync(path.join(root, DIR_PREFIX));
	chmodOrNull(dir, 0o700);
	const token = randomUUID();
	const metadata: OwnerMetadata = { schema: OWNER_SCHEMA, version: 1, kind: "monitor", pid: process.pid, hostname: os.hostname(), createdAt: Date.now(), closedAt: null, ownerToken: token };
	try { writeMetadata(dir, METADATA_NAME, metadata); } catch (error) {
		// This mkdtemp result has not been handed to any caller or process.
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
			try { fs.writeFileSync(path.join(dir, METADATA_NAME), JSON.stringify({ ...metadata, closedAt: Date.now() }), { mode: 0o600 }); } catch { /* keep anything whose ownership cannot be recovered */ }
		}
		throw error;
	}
	let closed = false;
	return { path: dir, token, close() {
		if (closed) return;
		closed = true;
		try {
			if (!owns({ path: dir, token, close() {} })) return;
			const meta = readOwnerMetadata(dir);
			if (!meta || meta.ownerToken !== token || meta.closedAt !== null) return;
			writeMetadata(dir, METADATA_NAME, { ...meta, closedAt: Date.now() });
		} catch { /* shutdown must never throw, and close never deletes data */ }
	} };
}
export function createTaskDirectory(root: LogDirectory, id: string, now = Date.now()): TaskDirectory {
	if (!TASK_ID.test(id) || !owns(root)) throw new Error("invalid task id or artifact directory ownership");
	const dir = path.join(root.path, id);
	fs.mkdirSync(dir, { mode: 0o700 });
	const task: TaskDirectory = { id, path: dir, root, outputPath: path.join(dir, `${id}.out.log`), stderrPath: path.join(dir, `${id}.err.log`) };
	const meta: TaskMetadata = { schema: TASK_SCHEMA, version: 1, kind: "task", id, ownerToken: root.token, createdAt: now, endedAt: null, readyAt: null };
	try {
		writeMetadata(dir, TASK_MARKER, meta);
		return task;
	} catch (error) {
		// No observer/socket has started yet; never leave an uncollectible half-task.
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
			try { writeMetadata(dir, TASK_MARKER, { ...meta, endedAt: now, readyAt: now, resourcePid: null }); } catch { /* uncertain leftovers stay protected */ }
		}
		throw error;
	}
}
function readTaskMetadata(dir: string, root: LogDirectory): TaskMetadata | undefined {
	try {
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return;
		const meta = readMetadata(path.join(dir, TASK_MARKER));
		if (!meta || meta.schema !== TASK_SCHEMA || meta.version !== 1 || meta.kind !== "task" || meta.ownerToken !== root.token || meta.id !== path.basename(dir) || typeof meta.id !== "string" || !TASK_ID.test(meta.id)) return;
		for (const field of ["createdAt", "endedAt", "readyAt"] as const) {
			if (meta[field] !== null && (typeof meta[field] !== "number" || !Number.isFinite(meta[field]) || meta[field] < 0)) return;
		}
		if (meta.resourcePid !== undefined && meta.resourcePid !== null && (typeof meta.resourcePid !== "number" || !Number.isSafeInteger(meta.resourcePid) || meta.resourcePid <= 0)) return;
		return meta as unknown as TaskMetadata;
	} catch { return; }
}
/** Remember a process group so a dead runtime cannot GC an unconfirmed survivor. */
export function setTaskProcess(task: TaskDirectory, pid: number | null): void {
	try {
		const meta = readTaskMetadata(task.path, task.root);
		if (meta && meta.resourcePid !== pid && (pid === null || Number.isSafeInteger(pid) && pid > 0)) writeMetadata(task.path, TASK_MARKER, { ...meta, resourcePid: pid });
	} catch { /* metadata is advisory; never interfere with work */ }
}
/** Idempotent: subsequent sweeps must not continually renew the read grace. */
export function markTaskReady(task: TaskDirectory, endedAt: number, now = Date.now()): boolean {
	try {
		const meta = readTaskMetadata(task.path, task.root);
		if (!meta || !owns(task.root)) return false;
		if (meta.readyAt !== null) return true;
		writeMetadata(task.path, TASK_MARKER, { ...meta, endedAt, readyAt: now, resourcePid: null });
		return true;
	} catch { return false; /* uncertain/incomplete markers are never reclaimed in a live runtime */ }
}
interface TreeInfo { bytes: number; latest: number }
/** lstat only; a symbolic link contributes no external data or activity. */
function treeInfo(dir: string, omitTaskMarker = false): TreeInfo {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real artifact directory");
	// A task marker handoff changes the directory mtime, but retention is
	// based on the ended task and data writes, not on metadata rewrites.
	const info = { bytes: 0, latest: omitTaskMarker ? 0 : stat.mtimeMs };
	for (const name of fs.readdirSync(dir)) {
		const child = path.join(dir, name), st = fs.lstatSync(child);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			const nested = treeInfo(child);
			info.bytes += nested.bytes; info.latest = Math.max(info.latest, nested.latest);
		} else if (st.isFile()) {
			info.bytes += st.size;
			if (!(omitTaskMarker && name === TASK_MARKER)) info.latest = Math.max(info.latest, st.mtimeMs);
		}
	}
	return info;
}
interface Candidate {
	path: string;
	root: string;
	token?: string;
	task: boolean;
	ino: number;
	bytes: number;
	latest: number;
	expired: boolean;
}
function hasLiveTaskGroup(dir: string, token: string | undefined): boolean {
	if (!token) return false; // version-1 flat legacy directories have no per-task markers
	const root = { path: dir, token, close() {} };
	for (const name of fs.readdirSync(dir)) {
		const child = path.join(dir, name), stat = fs.lstatSync(child);
		if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		const meta = readTaskMetadata(child, root);
		if (meta?.resourcePid && isPidAlive(meta.resourcePid, true)) return true;
	}
	return false;
}
/** Sweep eligible current tasks and closed/dead local runtimes under one soft quota.
 * Active/pending/referenced data is deliberately outside the reclaimable pool.
 * Never throws and never claims a failed removal succeeded.
 */
export function cleanOldLogDirectories(now = Date.now(), base: string = os.tmpdir(), options: LogCleanupOptions = {}): LogCleanupResult {
	const result: LogCleanupResult = { removedTasks: [], removedDirectories: [] };
	const policy = options.policy ?? { retentionMs: LOG_RETENTION_MS, budgetBytes: LOG_BUDGET_BYTES };
	if (!Number.isFinite(policy.retentionMs) || policy.retentionMs < 0 || !Number.isFinite(policy.budgetBytes) || policy.budgetBytes < 0) return result;
	const candidates: Candidate[] = [];
	let names: string[];
	try {
		// base is the explicitly configured namespace (e.g. macOS /tmp alias),
		// not a discovered cleanup entry. Entries below it still use lstat only.
		const stat = fs.statSync(base);
		if (!stat.isDirectory()) return result;
		names = fs.readdirSync(base);
	} catch { return result; }
	for (const name of names) {
		if (!name.startsWith(DIR_PREFIX)) continue;
		const dir = path.join(base, name);
		try {
			const stat = fs.lstatSync(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink() || !ourUid(stat)) continue;
			const meta = readOwnerMetadata(dir);
			if (!meta || meta.hostname !== os.hostname()) continue;
			if (options.current?.path === dir && owns(options.current)) {
				for (const id of fs.readdirSync(dir)) {
					if (!TASK_ID.test(id) || options.protectedIds?.has(id)) continue;
					const taskPath = path.join(dir, id), taskStat = fs.lstatSync(taskPath);
					if (!taskStat.isDirectory() || taskStat.isSymbolicLink() || !ourUid(taskStat)) continue;
					const task = readTaskMetadata(taskPath, options.current);
					if (!task || task.endedAt === null || task.readyAt === null || task.resourcePid && isPidAlive(task.resourcePid, true)) continue;
					const info = treeInfo(taskPath, true);
					const latest = Math.max(info.latest, task.endedAt);
					if (now - Math.max(latest, task.readyAt) < LOG_READ_GRACE_MS) continue;
					candidates.push({ path: taskPath, root: dir, token: meta.ownerToken, task: true, ino: taskStat.ino, bytes: info.bytes, latest, expired: now - latest >= policy.retentionMs });
				}
			} else {
				if (meta.closedAt === null && isPidAlive(meta.pid) || hasLiveTaskGroup(dir, meta.ownerToken)) continue;
				const info = treeInfo(dir);
				const latest = Math.max(info.latest, meta.createdAt, meta.closedAt ?? 0);
				if (now - latest < LOG_READ_GRACE_MS) continue;
				candidates.push({ path: dir, root: dir, token: meta.ownerToken, task: false, ino: stat.ino, bytes: info.bytes, latest, expired: now - latest >= policy.retentionMs });
			}
		} catch { /* one malformed/unreadable directory never stops the sweep */ }
	}
	candidates.sort((a, b) => a.latest - b.latest);
	let bytes = candidates.reduce((total, item) => total + item.bytes, 0);
	for (const item of candidates) {
		if (!item.expired && bytes <= policy.budgetBytes) continue;
		try {
			const stat = fs.lstatSync(item.path);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== item.ino || !ourUid(stat)) continue;
			const meta = readOwnerMetadata(item.root);
			if (!meta || meta.ownerToken !== item.token || meta.hostname !== os.hostname()) continue;
			if (item.task) {
				if (!options.current || !owns(options.current) || options.protectedIds?.has(path.basename(item.path))) continue;
			} else if (meta.closedAt === null && isPidAlive(meta.pid) || hasLiveTaskGroup(item.path, meta.ownerToken)) continue;
			// Recheck activity in case another process wrote between discovery/removal.
			const info = treeInfo(item.path, item.task);
			if (info.latest > item.latest) continue;
			fs.rmSync(item.path, { recursive: true, force: true });
			bytes -= item.bytes;
			(item.task ? result.removedTasks : result.removedDirectories).push(item.path);
		} catch { /* EACCES/EIO/changed ownership: retain and continue */ }
	}
	return result;
}
