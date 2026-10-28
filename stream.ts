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
 * The rate limiter is Claude Code's: a burst of 10 notifications, then one
 * every 2 seconds, and a monitor whose output stays over that budget for 30
 * seconds is stopped.
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

	/** A WebSocket text frame is one event, even when it contains newlines. */
	pushEvent(frame: string): void {
		if (!this.closed) this.accept(frame, false);
	}

	/** Emit whatever is pending right away. */
	flush(): void {
		this.clearTimer();
		if (!this.pending.length) return;
		const pending = this.pending;
		const count = pending.length;
		this.pending = [];
		const cap = this.options.maxBatchChars ?? MAX_BATCH_CHARS;
		if (pending.join("\n").length > cap) {
			const clipped: string[] = [];
			let size = 0;
			for (const frame of pending) {
				const separator = clipped.length ? 1 : 0;
				const remaining = cap - size - separator;
				if (remaining < 0) break;
				clipped.push(frame.slice(0, remaining));
				size += separator + Math.min(frame.length, remaining);
				if (remaining < frame.length) break;
			}
			this.options.onBatch([...clipped, TRUNCATED], count);
			return;
		}
		this.options.onBatch(pending, count);
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

	private accept(raw: string, trim = true): void {
		const line = trim ? raw.trimEnd() : raw;
		if (trim && !line) return;
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

/** Claude Code's notification budget: a burst of 10, then one every 2 seconds. */
export const BUCKET_CAPACITY = 10;
export const TOKEN_REFILL_MS = 2_000;
/** Suppression that goes on for longer than this is a firehose: the monitor is stopped. */
export const SUSTAINED_SUPPRESSION_KILL_MS = 30_000;
/** A pause this long since the last suppressed batch starts a fresh suppression window. */
export const QUIET_GAP_MS = TOKEN_REFILL_MS * 3;

export interface RateLimiterOptions {
	capacity?: number;
	refillMs?: number;
	killAfterMs?: number;
	quietGapMs?: number;
	now?: () => number;
}

export type RateVerdict =
	| { deliver: true; suppressed: number }
	| { deliver: false; flood: boolean; suppressedForMs: number };

/**
 * Claude Code's monitor rate limit. Every batch costs one token from a bucket
 * of 10 that refills one token every 2 seconds. A batch without a token is
 * suppressed; the next batch that gets through reports how many events were
 * suppressed in between. When suppression lasts longer than 30 seconds the
 * monitor is a firehose and should be stopped.
 */
export class RateLimiter {
	private tokens: number;
	private refilledAt: number;
	/** Events suppressed since the last batch that got through. */
	private pending = 0;
	private suppressionStart: number | undefined;
	private lastSuppressedAt: number | undefined;

	constructor(private readonly options: RateLimiterOptions = {}) {
		this.tokens = options.capacity ?? BUCKET_CAPACITY;
		this.refilledAt = this.now();
	}

	/** Ask to deliver a batch of `count` events. */
	take(count: number): RateVerdict {
		const now = this.now();
		this.refill(now);
		if (this.tokens > 0) {
			this.tokens -= 1;
			const suppressed = this.pending;
			this.pending = 0;
			const quietGap = this.options.quietGapMs ?? QUIET_GAP_MS;
			if (this.lastSuppressedAt !== undefined && now - this.lastSuppressedAt > quietGap) {
				this.suppressionStart = undefined;
			}
			return { deliver: true, suppressed };
		}
		this.pending += count;
		this.lastSuppressedAt = now;
		this.suppressionStart ??= now;
		const suppressedForMs = now - this.suppressionStart;
		return {
			deliver: false,
			flood: suppressedForMs > (this.options.killAfterMs ?? SUSTAINED_SUPPRESSION_KILL_MS),
			suppressedForMs,
		};
	}

	private refill(now: number): void {
		const refillMs = this.options.refillMs ?? TOKEN_REFILL_MS;
		const earned = Math.floor((now - this.refilledAt) / refillMs);
		if (earned <= 0) return;
		this.tokens = Math.min(this.options.capacity ?? BUCKET_CAPACITY, this.tokens + earned);
		this.refilledAt += earned * refillMs;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}
