/** Typed observation targets and a runner-independent file/status watcher. */
import { Type } from "typebox";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sourcePath, validateHost, parseJobManifest, parseJobStatus, jobSnapshot, isTerminal, MAX_METADATA_BYTES, type ResolvedJob, type JobSnapshot, type JobStatus } from "./job-protocol.ts";
import { LocalSourceReader, READ_CHUNK_BYTES, type SourceReader, type FileSlice, type ReadRequest } from "./source-reader.ts";
import { SshSourceReader } from "./ssh-reader.ts";
import type { OutputStream } from "./watches.ts";

export type Replay = "tail" | "now";
export type FileSource = { kind: "file"; stdout?: string; stderr?: string; host?: string; from?: Replay };
export type JobSource = { kind: "job"; manifest: string; host?: string; from?: Replay };
export type SocketSource = { kind: "ws"; url: string; protocols?: string[] };
export type ObservationSource = FileSource | JobSource | SocketSource;
export function cloneSource(source: ObservationSource): ObservationSource {
	return source.kind === "ws" ? { ...source, ...(source.protocols ? { protocols: [...source.protocols] } : {}) } : { ...source };
}
export const MAX_WS_URL_LENGTH = 4096;
export const WS_URL_PATTERN = "^[Ww][Ss][Ss]?://(?![^/?#]*@)[\\x21-\\x22\\x24-\\x7e]+$(?![\\s\\S])";
const WS_URL = new RegExp(WS_URL_PATTERN);
const WS_TOKEN_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\\s\\S])";
const stringPath = () => Type.String({ minLength: 1, maxLength: 4096 });
const replay = () => Type.Optional(Type.Union([Type.Literal("tail"), Type.Literal("now")], { description: "tail (default) replays at most the latest 64 KiB per source stream, then follows new bytes; now observes only new bytes." }));
const host = () => Type.Optional(Type.String({ minLength: 1, maxLength: 255, description: "SSH destination on the execution host; uses existing ssh_config. No options or commands. Remote paths must be absolute. Python 3 must already be available there." }));
export const ObservationSourceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("file"), stdout: Type.Optional(stringPath()), stderr: Type.Optional(stringPath()), host: host(), from: replay() }, { additionalProperties: false, anyOf: [{ required: ["stdout"] }, { required: ["stderr"] }] }),
	Type.Object({ kind: Type.Literal("job"), manifest: stringPath(), host: host(), from: replay() }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("ws"), url: Type.String({ minLength: 6, maxLength: MAX_WS_URL_LENGTH, pattern: WS_URL_PATTERN }), protocols: Type.Optional(Type.Array(Type.String({ pattern: WS_TOKEN_PATTERN }), { uniqueItems: true })) }, { additionalProperties: false }),
]);
const WS_TOKEN = new RegExp(WS_TOKEN_PATTERN);
export function normalizeSource(input: unknown, cwd: string): ObservationSource {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("source must describe a file, job manifest or WebSocket");
	const raw = input as Record<string, unknown>;
	const allowed = raw.kind === "file" ? ["kind", "stdout", "stderr", "host", "from"] : raw.kind === "job" ? ["kind", "manifest", "host", "from"] : raw.kind === "ws" ? ["kind", "url", "protocols"] : [];
	if (!allowed.length || Object.keys(raw).some(k => !allowed.includes(k))) throw new Error("Monitor accepts only typed observation sources; command and source.monitorId are no longer supported. Submit business work through an external runner.");
	if (raw.kind === "ws") {
		if (typeof raw.url !== "string" || raw.url.length > MAX_WS_URL_LENGTH || !WS_URL.test(raw.url)) throw new Error("url must be an ASCII ws:// or wss:// URL without credentials, fragments or whitespace (at most 4096 characters)");
		let url: URL; try { url = new URL(raw.url); } catch { throw new Error("invalid WebSocket URL"); }
		if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid WebSocket URL or embedded credentials");
		const protocols = raw.protocols;
		if (protocols !== undefined && (!Array.isArray(protocols) || protocols.some(p => typeof p !== "string" || !WS_TOKEN.test(p)) || new Set(protocols).size !== protocols.length)) throw new Error("protocols must be unique RFC 6455 tokens");
		return { kind: "ws", url: raw.url, ...(protocols !== undefined ? { protocols: [...protocols] as string[] } : {}) };
	}
	const destination = validateHost(raw.host);
	const from = raw.from ?? "tail";
	if (from !== "tail" && from !== "now") throw new Error("from must be tail or now");
	const shared: { host?: string; from: Replay } = { ...(destination ? { host: destination } : {}), from };
	if (raw.kind === "job") return { kind: "job", manifest: sourcePath(raw.manifest, cwd, destination), ...shared };
	const stdout = raw.stdout === undefined ? undefined : sourcePath(raw.stdout, cwd, destination);
	const stderr = raw.stderr === undefined ? undefined : sourcePath(raw.stderr, cwd, destination);
	if (!stdout && !stderr) throw new Error("file source requires stdout or stderr");
	if (stdout && stdout === stderr) throw new Error("stdout and stderr sources must be distinct");
	return { kind: "file", ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}), ...shared };
}
export interface ObservationCallbacks {
	onData(stream: OutputStream, data: Buffer): void;
	onGap(stream: OutputStream, reason: string): void;
	onIssue(error?: string): void;
	onJob(job: JobSnapshot): void;
	onComplete(job: JobSnapshot): void;
	/** Internal resource release only, including after the session is disposed. */
	onInactive?(): void;
}
export const DRAIN_MAX_READS = 8;
export const DRAIN_MAX_BYTES = DRAIN_MAX_READS * READ_CHUNK_BYTES;
const DRAIN_MAX_MS = 50;
/** A catch-up re-arm yields briefly so a fast log cannot spin the event loop. */
export const DRAIN_REARM_MS = 15;
export const MAX_CATCHUP_BYTES = 8 * 1024 * 1024;
interface Cursor { identity: string; offset: number; anchor: Buffer }
interface StreamState {
	/** A tail relocation survives a drain-budget yield; it must not re-probe the old cursor. */
	position: "skip" | "start" | "tail" | "follow";
	cursor?: Cursor;
	unavailable?: boolean;
	pending?: boolean;
	finalEnd?: number;
}
interface DrainBudget { reads: number; bytes: number; startedAt: number }
function cursorAt(slice: FileSlice, skipExisting = false): Cursor {
	// Keep the window before the new offset, not only this read's data. Short
	// appends must retain (and grow from) the verified prefix of the old guard.
	const bytes = slice.data.length >= 64 ? slice.data : Buffer.concat([slice.guard, slice.data]);
	const anchor = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 64)));
	return { identity: slice.identity, offset: skipExisting ? slice.size : slice.offset + slice.data.length, anchor };
}
/** No signal is ever sent to a business job. Only this reader/timer can be stopped. */
export class FileObservation {
	private closed = false;
	private inactiveNotified = false;
	private timer?: ReturnType<typeof setTimeout>;
	private tickPromise?: Promise<void>;
	private reader: SourceReader;
	private job?: ResolvedJob;
	private streams: Partial<Record<OutputStream, StreamState>> = {};
	private lastIssue?: string;
	private lastJob?: string;
	private lastStatus?: JobStatus;
	private terminalReading = false;
	private terminalSeen = false;
	constructor(readonly source: FileSource | JobSource, private readonly callbacks: ObservationCallbacks, onPid?: (pid: number | null) => void) {
		this.reader = source.host ? new SshSourceReader(source.host, pid => {
			onPid?.(pid);
			if (pid === null) this.notifyInactive();
		}) : new LocalSourceReader();
	}
	get pid(): number | undefined { return this.reader.pid; }
	get active(): boolean { return !this.closed || this.tickPromise !== undefined || this.reader.active; }
	/** Both source kinds name their streams stdout/stderr; a job manifest adds paths. */
	private paths(): FileSource { return this.job ? { kind: "file", ...(this.job.stdout ? { stdout: this.job.stdout } : {}), ...(this.job.stderr ? { stderr: this.job.stderr } : {}) } : this.source as FileSource; }
	private boundary(): { root?: string } { return this.source.kind === "job" ? { root: this.source.host ? path.posix.dirname(this.source.manifest) : path.dirname(this.source.manifest) } : {}; }
	private read(file: string, extra: Partial<Omit<ReadRequest, "path" | "root">> = {}): Promise<FileSlice> {
		const operation = this.reader.read({ path: file, maxBytes: READ_CHUNK_BYTES, ...this.boundary(), ...extra });
		// A prepare/read may settle after the bounded stop has already returned.
		void operation.then(() => this.notifyInactive(), () => this.notifyInactive());
		return operation;
	}
	private async metadata(file: string): Promise<string> {
		const slice = await this.read(file, { maxBytes: MAX_METADATA_BYTES + 1 });
		if (slice.size > MAX_METADATA_BYTES || slice.data.length > MAX_METADATA_BYTES) throw new Error("observation metadata exceeds 64 KiB");
		if (slice.data.length !== slice.size) throw new Error("observation metadata read was incomplete; wait for an atomic complete update");
		return slice.data.toString("utf8");
	}
	async prepare(): Promise<void> {
		if (this.source.kind === "job") {
			const job = parseJobManifest(await this.metadata(this.source.manifest), this.source.manifest, this.source.host);
			if (this.closed) throw new Error("observation was stopped during setup");
			this.job = job; this.reportJob(jobSnapshot(job));
		}
		if (this.source.from === "now") {
			const streams = this.paths();
			for (const name of ["stdout", "stderr"] as const) {
				const file = streams[name]; if (!file || this.closed) continue;
				try { this.streams[name] = { position: "follow", cursor: cursorAt(await this.read(file, { tail: true }), true) }; }
				catch (error) {
					// Only confirmed absence establishes that there were no bytes to skip.
					// Permission/transport errors cannot promise a valid "now" baseline.
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					this.streams[name] = { position: "start" };
				}
			}
		}
	}
	start(): void {
		if (this.closed || this.terminalSeen || this.timer || this.tickPromise) return;
		this.schedule(0);
	}
	private schedule(delay: number): void {
		if (this.closed || this.terminalSeen) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const operation = this.tick(); this.tickPromise = operation;
			void operation.then(() => this.finished(), () => this.finished());
		}, delay);
		this.timer.unref?.();
	}
	private finished(): void {
		this.tickPromise = undefined;
		this.notifyInactive();
		if (!this.closed && !this.terminalSeen) this.schedule(Object.values(this.streams).some(state => state?.pending) ? DRAIN_REARM_MS : this.source.host ? 1000 : 250);
	}
	private notifyInactive(): void {
		if (!this.closed || this.active || this.inactiveNotified) return;
		this.inactiveNotified = true;
		try { this.callbacks.onInactive?.(); } catch { /* cleanup must not crash a late I/O callback */ }
	}
	private reportJob(job: JobSnapshot): void {
		const value = JSON.stringify(job);
		if (!this.closed && value !== this.lastJob) { this.lastJob = value; this.callbacks.onJob(job); }
	}
	private issue(error?: string): void {
		const short = error?.slice(0, 1024);
		if (!this.closed && short !== this.lastIssue) { this.lastIssue = short; this.callbacks.onIssue(short); }
	}
	private canRead(budget: DrainBudget): boolean {
		return budget.reads < DRAIN_MAX_READS && budget.bytes < DRAIN_MAX_BYTES && (budget.reads === 0 || performance.now() - budget.startedAt < DRAIN_MAX_MS);
	}
	private async readStream(file: string, budget: DrainBudget, extra: Partial<Omit<ReadRequest, "path" | "root">>): Promise<FileSlice> {
		const maxBytes = Math.min(READ_CHUNK_BYTES, DRAIN_MAX_BYTES - budget.bytes, extra.maxBytes ?? READ_CHUNK_BYTES);
		budget.reads++;
		const slice = await this.read(file, { ...extra, maxBytes });
		budget.bytes += slice.data.length;
		return slice;
	}
	private async stream(name: OutputStream, file: string, budget: DrainBudget, final = false): Promise<void> {
		const state = this.streams[name] ??= { position: this.source.from === "now" ? "skip" : "tail" };
		state.pending = false;
		try {
			while (!this.closed) {
				const cursor = state.position === "follow" ? state.cursor : undefined;
				if (final && state.finalEnd !== undefined && cursor && cursor.offset >= state.finalEnd) return;
				if (!this.canRead(budget)) { state.pending = true; return; }
				const relocating = state.position === "tail" && state.cursor !== undefined;
				const slice = await this.readStream(file, budget, cursor ? {
					offset: cursor.offset, guardBytes: cursor.anchor.length,
					...(final && state.finalEnd !== undefined ? { maxBytes: Math.max(1, state.finalEnd - cursor.offset) } : {}),
				} : state.position === "start" ? { offset: 0 }
					: final && state.finalEnd !== undefined ? {
						offset: Math.max(0, state.finalEnd - READ_CHUNK_BYTES),
						maxBytes: Math.max(1, Math.min(READ_CHUNK_BYTES, state.finalEnd)),
					} : { tail: true });
				if (this.closed) return;
				if (state.position === "skip" && !final) {
					state.cursor = cursorAt(slice, true);
					state.position = "follow";
					return;
				}
				const reset = cursor && (state.unavailable || cursor.identity !== slice.identity || slice.size < cursor.offset || !cursor.anchor.equals(slice.guard));
				const limit = final ? state.finalEnd ?? slice.size : slice.size;
				const lag = cursor && limit - cursor.offset > MAX_CATCHUP_BYTES;
				if (reset || lag) {
					this.callbacks.onGap(name, reset ? "source was replaced, truncated or temporarily unavailable; resumed from its retained tail" : "source backlog exceeded the 8 MiB catch-up limit; resumed from its retained tail");
					state.position = "tail";
					if (reset) state.finalEnd = undefined;
					else if (final) state.finalEnd ??= slice.size;
					// Save the relocation before yielding. Its next read must not use the old cursor.
					continue;
				}
				if (!cursor && !relocating && slice.offset > 0) this.callbacks.onGap(name, "only the latest 64 KiB was replayed; older source bytes remain outside this observation copy");
				if (final) state.finalEnd ??= slice.size;
				if (slice.data.length) this.callbacks.onData(name, slice.data);
				state.cursor = cursorAt(slice);
				state.position = "follow";
				state.unavailable = false;
				const target = final ? state.finalEnd! : slice.size;
				if (state.cursor.offset >= target) return;
				if (!slice.data.length) throw new Error("source shortened during its bounded read; retained output may be incomplete");
				state.pending = true;
			}
		} catch (error) {
			state.pending = false;
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && state.position === "start") return;
			state.unavailable = true;
			throw error;
		}
	}
	private async tick(): Promise<void> {
		if (this.closed) return;
		const errors: string[] = [];
		const streamFailures: Array<{ name: OutputStream; error: unknown }> = [];
		const failedStreams = new Set<OutputStream>();
		const streams = this.paths();
		const budgets: Partial<Record<OutputStream, DrainBudget>> = {};
		for (const name of ["stdout", "stderr"] as const) {
			const file = streams[name]; if (!file || this.closed) continue;
			const budget = budgets[name] = { reads: 0, bytes: 0, startedAt: performance.now() };
			try { await this.stream(name, file, budget, this.terminalReading); } catch (error) { failedStreams.add(name); streamFailures.push({ name, error }); }
		}
		let terminal: JobSnapshot | undefined;
		if (this.job && !this.closed) {
			try {
				const current = parseJobManifest(await this.metadata(this.job.manifestPath), this.job.manifestPath, this.job.host);
				if (JSON.stringify(current) !== JSON.stringify(this.job)) throw new Error("job manifest changed; refusing to adopt a different run or source");
				const status = parseJobStatus(await this.metadata(this.job.status), this.job);
				if (this.lastStatus && status.updatedAt < this.lastStatus.updatedAt) throw new Error("stale job status predates the last valid report for this run");
				this.lastStatus = status;
				const snapshot = jobSnapshot(this.job, status); this.reportJob(snapshot);
				if (isTerminal(status.state)) terminal = snapshot;
			} catch (error) { const reason = error instanceof Error ? error.message : String(error); errors.push("job status: " + reason); this.reportJob(jobSnapshot(this.job, undefined, reason)); }
		}
		for (const { name, error } of streamFailures) {
			if (!terminal && (error as NodeJS.ErrnoException)?.code === "ENOENT" && this.lastStatus?.state === "queued") {
				if (this.streams[name]) this.streams[name]!.unavailable = false;
				continue;
			}
			errors.unshift(name + ": " + (error instanceof Error ? error.message : String(error)));
		}
		this.terminalReading = terminal !== undefined;
		if (terminal) {
			for (const name of ["stdout", "stderr"] as const) {
				const file = this.job?.[name]; if (!file || this.closed || failedStreams.has(name)) continue;
				try { await this.stream(name, file, budgets[name]!, true); } catch (error) { errors.push(name + ": " + (error instanceof Error ? error.message : String(error))); }
			}
		} else for (const state of Object.values(this.streams)) if (state) state.finalEnd = undefined;
		this.issue(errors.length ? errors.join("; ") : undefined);
		if (terminal && !this.closed && !this.terminalSeen && !Object.values(this.streams).some(state => state?.pending)) {
			this.terminalSeen = true; this.callbacks.onComplete(terminal);
		}
	}
	closeNow(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.reader.closeNow();
		this.notifyInactive();
	}
	async stop(force = false): Promise<boolean> {
		this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
		await this.reader.stop(force);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { if (this.tickPromise) await Promise.race([this.tickPromise.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
		finally { if (timer) clearTimeout(timer); }
		this.notifyInactive();
		// The reader may finish during the later tick wait; confirm its current state.
		return !this.active;
	}
}
