/** Session-wide output admission. Terminal outcomes use a separate result path. */
export type OutputLevel = "turn" | "context" | "none";
export type TerminalLevel = Exclude<OutputLevel, "none">;
export type NotifyPolicy = { output: OutputLevel; terminal: TerminalLevel };
export const DEFAULT_NOTIFY: Readonly<NotifyPolicy> = { output: "turn", terminal: "turn" };
export const OUTPUT_WINDOW_MS = 60_000;
export const OUTPUT_WINDOW_CAPACITY = 20;

/** Output policy is a ceiling: individual watches may lower, never bypass, it. */
export function outputLevel(policy: OutputLevel, requested: OutputLevel = policy): OutputLevel {
	if (policy === "none" || requested === "none") return "none";
	return policy === "context" || requested === "context" ? "context" : "turn";
}
export function strongerLevel(a: OutputLevel, b: OutputLevel): OutputLevel {
	return a === "turn" || b === "turn" ? "turn" : a === "context" || b === "context" ? "context" : "none";
}

/** A fixed window, not a token bucket that could admit two capacities per minute. */
export class OutputBudget {
	private start: number;
	private used = 0;
	private readonly now: () => number;
	constructor(private readonly options: { capacity?: number; windowMs?: number; now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
		this.start = this.now();
	}
	private refresh(): void {
		const now = this.now();
		if (now < this.start || now - this.start >= (this.options.windowMs ?? OUTPUT_WINDOW_MS)) {
			this.start = now;
			this.used = 0;
		}
	}
	take(): boolean {
		this.refresh();
		if (this.used >= (this.options.capacity ?? OUTPUT_WINDOW_CAPACITY)) return false;
		this.used++;
		return true;
	}
	remainingMs(): number {
		this.refresh();
		return Math.max(1, this.start + (this.options.windowMs ?? OUTPUT_WINDOW_MS) - this.now());
	}
}
