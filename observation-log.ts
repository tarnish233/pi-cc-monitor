/** Bounded disposable observation copies, independent from the runner's real logs. */
import fs from "node:fs";
import { finished } from "node:stream/promises";
import { createBoundedLog, type BoundedLog } from "./bounded-log.ts";
import { KILL_CONFIRMATION_MS } from "./process.ts";
import type { OutputStream } from "./watches.ts";

export const LOG_BACKLOG_LIMIT_BYTES = 4 * 1024 * 1024;

export class ObservationLog {
	private streams: Partial<Record<OutputStream, BoundedLog>> = {};
	private closing?: Promise<void>;
	private degraded = false;
	private inactiveNotified = false;
	get active(): boolean { return Object.values(this.streams).some(stream => stream && !stream.closed); }

	constructor(
		paths: Partial<Record<OutputStream, string>>,
		maxBytes: number,
		private readonly onError: (error: string) => void,
		onTruncate: () => void,
		onCreated?: (log: ObservationLog) => void,
		private readonly onInactive?: () => void,
	) {
		// Register the cleanup handle before opening streams, including partial setup failures.
		onCreated?.(this);
		const names = (["stdout", "stderr"] as const).filter((name): name is OutputStream => Boolean(paths[name]));
		const streamLimit = Math.floor(maxBytes / Math.max(1, names.length));
		try {
			for (const name of names) {
				const target = paths[name]!;
				const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
				let stream: BoundedLog;
				try { stream = createBoundedLog(target, { fd, maxBytes: streamLimit, onTruncate }); }
				catch (error) { fs.closeSync(fd); throw error; }
				this.streams[name] = stream;
				stream.on("error", (error: Error) => this.degrade(`observation log write failed: ${error.message}`));
				stream.once("close", () => this.notifyInactive());
			}
		} catch (error) {
			for (const stream of Object.values(this.streams)) stream?.destroy();
			throw error;
		}
	}

	private notifyInactive(): void {
		if (this.active || this.inactiveNotified) return;
		this.inactiveNotified = true;
		try { this.onInactive?.(); } catch { /* a late close must not crash a disposed runtime */ }
	}

	private degrade(reason: string): void {
		if (this.degraded) return;
		this.degraded = true;
		for (const stream of Object.values(this.streams)) stream?.destroy();
		try { this.onError(reason); } catch { /* an accounting callback must not crash the reader */ }
	}

	write(name: OutputStream, data: Buffer): void {
		const stream = this.streams[name];
		if (this.degraded || !stream || stream.destroyed || stream.writableEnded) return;
		if (Object.values(this.streams).reduce((n, s) => n + (s?.writableLength ?? 0), 0) + data.length > LOG_BACKLOG_LIMIT_BYTES) {
			this.degrade("disk writes fell behind (4 MiB log backlog cap)");
			return;
		}
		stream.write(data);
	}

	closeNow(): void {
		if (!this.degraded && Object.values(this.streams).some(stream => stream && stream.writableLength > 0)) {
			this.degrade("observation log buffers discarded during forced stop");
		} else {
			for (const stream of Object.values(this.streams)) stream?.destroy();
		}
		this.notifyInactive();
	}

	close(force = false): Promise<void> {
		if (force) this.closeNow();
		if (this.closing) return this.closing;
		const active = Object.values(this.streams).filter((s): s is BoundedLog => Boolean(s));
		for (const stream of active) if (!stream.destroyed && !stream.writableEnded) stream.end();
		this.closing = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled(active.map(s => finished(s))),
					new Promise<void>(resolve => {
						timer = setTimeout(() => {
							this.degrade("observation log flush timed out; retained output may be incomplete");
							resolve();
						}, KILL_CONFIRMATION_MS);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
				this.notifyInactive();
			}
		})();
		return this.closing;
	}
}
