/**
 * Line splitting, event batching and flood detection.
 *
 * Claude Code: "Stdout lines within 200ms are batched into a single
 * notification, so multiline output from a single event groups naturally."
 *
 * Notifications are capped the way Claude Code caps them: a line keeps at
 * most 500 characters, a notification at most 3000, and a line that never
 * ends keeps only its last megabyte. Blank lines are not events.
 *
 * The flood guard stops a monitor whose output keeps arriving with less than
 * `quietGapMs` between lines for longer than `killAfterMs`.
 */

import { StringDecoder } from "node:string_decoder";

/** Claude Code truncates a single line to this many characters. */
export const MAX_LINE_CHARS = 500;
/** Claude Code truncates a single notification to this many characters. */
export const MAX_BATCH_CHARS = 3000;
/** Claude Code keeps at most this much of a line that has not ended yet. */
export const MAX_PARTIAL_LINE_CHARS = 1_048_576;
/** The marker Claude Code appends to truncated output. */
export const TRUNCATED = "...(truncated)";

export interface BatcherOptions {
	/** Lines arriving within this window are merged into one notification. */
	windowMs: number;
	/** Called with the batched lines (capped) and the number of events they hold. */
	onBatch: (lines: string[], count: number) => void;
	/** Called for every line, before batching. */
	onLine?: (line: string) => void;
	maxLineChars?: number;
	maxBatchChars?: number;
	maxPartialLineChars?: number;
}

export class LineBatcher {
	private buffer = "";
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** Keeps a multi-byte character that is split across two chunks intact. */
	private decoder = new StringDecoder("utf8");
	private closed = false;

	constructor(private readonly options: BatcherOptions) {}

	/** Feed raw output. Ignored once the batcher is closed. */
	push(chunk: string | Buffer): void {
		if (this.closed) return;
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			this.accept(this.buffer.slice(0, index));
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
		}
		const cap = this.options.maxPartialLineChars ?? MAX_PARTIAL_LINE_CHARS;
		if (this.buffer.length > cap) this.buffer = this.buffer.slice(-cap);
	}

	/** Emit whatever is pending right away. */
	flush(): void {
		this.clearTimer();
		if (!this.pending.length) return;
		const count = this.pending.length;
		let text = this.pending.join("\n");
		this.pending = [];
		const cap = this.options.maxBatchChars ?? MAX_BATCH_CHARS;
		if (text.length > cap) text = `${text.slice(0, cap)}\n${TRUNCATED}`;
		this.options.onBatch(text.split("\n"), count);
	}

	/** Emit the trailing partial line too (the stream ended mid-line). */
	flushRemainder(): void {
		if (this.closed) return;
		const rest = this.buffer + this.decoder.end();
		this.buffer = "";
		if (rest) this.accept(rest);
		this.flush();
	}

	/** Drop anything pending and ignore all later output. */
	close(): void {
		this.closed = true;
		this.clearTimer();
		this.pending = [];
		this.buffer = "";
	}

	private accept(raw: string): void {
		const line = raw.trimEnd();
		if (!line) return;
		this.options.onLine?.(line);
		const cap = this.options.maxLineChars ?? MAX_LINE_CHARS;
		this.pending.push(line.length > cap ? `${line.slice(0, cap)}${TRUNCATED}` : line);
		this.schedule();
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
