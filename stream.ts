/**
 * Line splitting, event batching and flood detection.
 *
 * Claude Code: "Stdout lines within 200ms are batched into a single
 * notification, so multiline output from a single event groups naturally."
 *
 * The flood guard reuses the runtime constants Claude Code applies to
 * monitors: output that keeps arriving with less than `quietGapMs` between
 * lines for longer than `killAfterMs` is treated as a firehose and the
 * monitor is stopped.
 */

export interface BatcherOptions {
	/** Lines arriving within this window are merged into one notification. */
	windowMs: number;
	/** Called with the batched lines. */
	onBatch: (lines: string[]) => void;
	/** Called for every line, before batching. */
	onLine?: (line: string) => void;
}

export class LineBatcher {
	private buffer = "";
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: BatcherOptions) {}

	/** Feed raw output. Returns the complete lines that were extracted. */
	push(chunk: string | Buffer): string[] {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		for (const line of lines) {
			this.options.onLine?.(line);
			this.pending.push(line);
			this.schedule();
		}
		return lines;
	}

	/** Emit whatever is pending right away (used when the monitor ends). */
	flush(): void {
		this.clearTimer();
		if (!this.pending.length) return;
		const lines = this.pending;
		this.pending = [];
		this.options.onBatch(lines);
	}

	/** Emit the trailing partial line, if any (the stream ended mid-line). */
	flushRemainder(): void {
		if (this.buffer) {
			const line = this.buffer;
			this.buffer = "";
			this.options.onLine?.(line);
			this.pending.push(line);
		}
		this.flush();
	}

	get pendingCount(): number {
		return this.pending.length;
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, this.options.windowMs);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
}

export interface FloodGuardOptions {
	/** A gap shorter than this counts as continuous output. */
	quietGapMs: number;
	/** Continuous output for this long is a firehose. */
	killAfterMs: number;
	/** Called once when the monitor is judged to be flooding. */
	onFlood: () => void;
}

export class FloodGuard {
	private lastOutputAt = 0;
	private burstStartedAt: number | undefined;
	private flooded = false;

	constructor(private readonly options: FloodGuardOptions) {}

	/** Record that output arrived. */
	noteOutput(now = Date.now()): void {
		if (now - this.lastOutputAt >= this.options.quietGapMs) {
			this.burstStartedAt = now;
		}
		this.lastOutputAt = now;
	}

	/** True once the monitor has been flooding for too long. */
	isFlooding(now = Date.now()): boolean {
		if (this.flooded) return true;
		if (this.burstStartedAt === undefined) return false;
		if (now - this.burstStartedAt < this.options.killAfterMs) return false;
		this.flooded = true;
		this.options.onFlood();
		return true;
	}

	get startedAt(): number | undefined {
		return this.burstStartedAt;
	}
}
