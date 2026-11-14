/**
 * Ownership of pi-cc-monitor's per-runtime log directory.
 *
 * Node builtins only; no Pi, TUI, timers, locks, supervisors or history
 * store. A Pi runtime allocates the directory lazily, when its first Monitor
 * starts (not at extension factory startup), and closes it when the runtime
 * shuts down. Every runtime owns one private `mkdtemp` directory
 * (0700) under `base` (default os.tmpdir()) with an `owner.json` marker
 * (0600) recording schema, version, kind, pid, hostname, createdAt and,
 * after close(), closedAt.
 *
 * Failure policy:
 * - `createLogDirectory` throws only for an unusable base directory; it
 *   never deletes anything.
 * - `close()` is idempotent and best-effort: it records `closedAt` with a
 *   safe write (temp file + rename) and never deletes data. A runtime is
 *   marked closed independently of whether its pid is still alive.
 * - `cleanOldLogDirectories` never throws and deletes a directory only when
 *   ALL of the following hold:
 *     1. its name carries our mkdtemp prefix (`pi-cc-monitor-`), so legacy
 *        flat `os.tmpdir()/pi-cc-monitor` logs are never touched;
 *     2. its `owner.json` validates as OUR schema/kind/version with a sane
 *        pid and hostname (malformed, unowned or symlinked markers are kept);
 *     3. its latest meaningful activity - createdAt, closedAt, or the mtime
 *        of the directory or any log file in it - is older than 3 days, so
 *        recent writes and recent closes always protect the logs;
 *     4. its owner is closed, or its pid is reliably not alive on this host.
 *        EPERM and unknown kill(pid, 0) results count as alive, a foreign
 *        hostname is uncertain and always skipped, and a live pid never
 *        overrides a closed record - so pid reuse errs toward retaining.
 *   Cleanup uses lstat everywhere and never follows symlinks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** mkdtemp prefix: only directories with this prefix are ever cleaned. */
const DIR_PREFIX = "pi-cc-monitor-";
/** The ownership marker file inside a runtime's log directory. */
const METADATA_NAME = "owner.json";
const OWNER_SCHEMA = "pi-cc-monitor.owner";
const OWNER_VERSION = 1;
const OWNER_KIND = "monitor";
/** Directories with activity older than this are eligible for cleanup. */
export const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

interface OwnerMetadata {
	schema: string;
	version: number;
	kind: string;
	pid: number;
	hostname: string;
	createdAt: number;
	closedAt: number | null;
}

export interface LogDirectory {
	/** The private directory this runtime writes monitor logs into. */
	path: string;
	/** Record that this runtime is done. Idempotent; never deletes data. */
	close(): void;
}

function chmodOrNull(target: string, mode: number): void {
	try {
		fs.chmodSync(target, mode);
	} catch {
		// best effort; Windows ignores POSIX modes
	}
}

/** Safe write: a temp file in the same directory, then rename over. */
function writeOwnerMetadata(dir: string, metadata: OwnerMetadata): void {
	const temp = path.join(dir, `${METADATA_NAME}.tmp-${process.pid}`);
	fs.writeFileSync(temp, `${JSON.stringify(metadata, null, "\t")}\n`);
	chmodOrNull(temp, 0o600);
	fs.renameSync(temp, path.join(dir, METADATA_NAME));
}

/**
 * Read and validate the ownership marker. Only a marker that is a regular
 * file (lstat, never a symlink), small, well-formed JSON, and exactly our
 * schema/kind/version with a positive integer pid and non-empty hostname
 * counts as owned; everything else returns undefined and is never deleted.
 */
function readOwnerMetadata(dir: string): OwnerMetadata | undefined {
	const file = path.join(dir, METADATA_NAME);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const meta = parsed as Record<string, unknown>;
	if (meta.schema !== OWNER_SCHEMA || meta.kind !== OWNER_KIND || meta.version !== OWNER_VERSION) return undefined;
	const pid = meta.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (typeof meta.hostname !== "string" || meta.hostname.length === 0) return undefined;
	const closedAt = meta.closedAt ?? null;
	if (closedAt !== null && !Number.isFinite(closedAt)) return undefined;
	return {
		schema: OWNER_SCHEMA,
		version: OWNER_VERSION,
		kind: OWNER_KIND,
		pid,
		hostname: meta.hostname,
		createdAt: Number.isFinite(meta.createdAt) ? (meta.createdAt as number) : 0,
		closedAt: closedAt as number | null,
	};
}

/**
 * Create this runtime's private log directory. The directory is 0700 and the
 * ownership marker 0600 on POSIX; other users can neither read monitor logs
 * nor forge or read the marker.
 */
export function createLogDirectory(base: string = os.tmpdir()): LogDirectory {
	const root = typeof base === "string" && base.length > 0 ? base : os.tmpdir();
	const dir = fs.mkdtempSync(path.join(root, DIR_PREFIX));
	chmodOrNull(dir, 0o700);
	writeOwnerMetadata(dir, {
		schema: OWNER_SCHEMA,
		version: OWNER_VERSION,
		kind: OWNER_KIND,
		pid: process.pid,
		hostname: os.hostname(),
		createdAt: Date.now(),
		closedAt: null,
	});
	let closed = false;
	return {
		path: dir,
		close() {
			if (closed) return;
			closed = true;
			try {
				// Only a marker that still validates as ours is extended, and a
				// closed marker is never rewritten: close() is idempotent.
				const metadata = readOwnerMetadata(dir);
				if (!metadata || metadata.closedAt !== null) return;
				writeOwnerMetadata(dir, { ...metadata, closedAt: Date.now() });
			} catch {
				// close() runs on shutdown paths and must never throw.
			}
		},
	};
}

/** Whether a pid is known to be running. EPERM and unknown mean alive. */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH: reliably gone. EPERM (exists, not ours) and anything else
		// mean "assume alive" so cleanup errs toward retaining.
		return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
	}
}

/**
 * Remove our own log directories that are old and whose owners are finished.
 * Never throws, never follows symlinks, never deletes anything it cannot
 * positively identify as this package's abandoned data.
 */
export function cleanOldLogDirectories(now: number = Date.now(), base: string = os.tmpdir()): void {
	const root = typeof base === "string" && base.length > 0 ? base : os.tmpdir();
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		// The prefix check also leaves legacy flat "pi-cc-monitor" logs alone.
		if (!name.startsWith(DIR_PREFIX)) continue;
		const dir = path.join(root, name);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(dir);
		} catch {
			continue;
		}
		// lstat: a symlink entry is never a directory here, so links to
		// elsewhere are skipped, not followed.
		if (!stat.isDirectory()) continue;
		try {
			maybeRemove(dir, stat, now);
		} catch {
			// one bad directory must not stop the sweep
		}
	}
}

function maybeRemove(dir: string, stat: fs.Stats, now: number): void {
	const metadata = readOwnerMetadata(dir);
	if (!metadata) return; // malformed or unowned: keep
	if (metadata.hostname !== os.hostname()) return; // foreign host: uncertain, keep
	if (metadata.closedAt === null && isPidAlive(metadata.pid)) return; // open and alive: keep
	if (now - latestActivity(dir, stat, metadata) < LOG_RETENTION_MS) return; // too recent: keep
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Latest meaningful activity: creation, the close record, and the mtime of
 * the directory or any log file directly in it (lstat, symlinks excluded).
 * Not just the directory mtime - a live monitor appends to an old file
 * without touching the directory entry.
 */
function latestActivity(dir: string, stat: fs.Stats, metadata: OwnerMetadata): number {
	let latest = Math.max(stat.mtimeMs, metadata.createdAt);
	if (metadata.closedAt !== null) latest = Math.max(latest, metadata.closedAt);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return latest;
	}
	for (const name of names) {
		let entry: fs.Stats;
		try {
			entry = fs.lstatSync(path.join(dir, name));
		} catch {
			continue;
		}
		if (entry.isFile()) latest = Math.max(latest, entry.mtimeMs);
	}
	return latest;
}
