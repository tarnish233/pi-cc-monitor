/** Literal output matching. No regex execution, filesystem polling, or process ownership. */
import { StringDecoder } from "node:string_decoder";
import type { TerminalLevel } from "./notification-budget.ts";
import { strongerLevel } from "./notification-budget.ts";
import { MAX_PARTIAL_LINE_CHARS } from "./stream.ts";

export type OutputStream = "stdout" | "stderr";
export type WatchRule = {
	id: string;
	text: string;
	stream?: OutputStream | "both";
	once?: boolean;
	notify?: TerminalLevel;
};
export type WatchState = WatchRule & { fired: boolean };
export const MAX_WATCHES = 20;
export const MAX_WATCH_TEXT = 500;

export function validateWatches(rules: WatchRule[]): void {
	if (!Array.isArray(rules) || rules.length > MAX_WATCHES) throw new Error(`watches must be an array of at most ${MAX_WATCHES} rules`);
	const ids = new Set<string>();
	for (const rule of rules) {
		if (!rule || typeof rule.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rule.id)) throw new Error("watch id must be 1–64 letters, digits, underscores or hyphens");
		if (ids.has(rule.id)) throw new Error(`Duplicate watch id: ${rule.id}`);
		ids.add(rule.id);
		if (typeof rule.text !== "string" || !rule.text.length || rule.text.length > MAX_WATCH_TEXT) throw new Error(`watch text must contain 1–${MAX_WATCH_TEXT} characters`);
		if (rule.stream !== undefined && !["stdout", "stderr", "both"].includes(rule.stream)) throw new Error("watch stream must be stdout, stderr or both");
		if (rule.once !== undefined && typeof rule.once !== "boolean") throw new Error("watch once must be boolean");
		if (rule.notify !== undefined && !["turn", "context"].includes(rule.notify)) throw new Error("watch notify must be turn or context");
	}
}

/** Stable IDs preserve unchanged once state. Changed conditions reset only that rule. */
export class WatchRules {
	private rules: WatchState[] = [];
	constructor(rules: WatchRule[]) { this.update(rules); }
	update(rules: WatchRule[]): void {
		validateWatches(rules); // Validate everything before mutating anything.
		const old = new Map(this.rules.map((rule) => [rule.id, rule]));
		this.rules = rules.map((rule) => {
			const normalized = { id: rule.id, text: rule.text, stream: rule.stream ?? "stdout", once: rule.once ?? false, notify: rule.notify ?? "turn" };
			const previous = old.get(rule.id);
			const sameCondition = previous && previous.text === normalized.text && previous.stream === normalized.stream && previous.once === normalized.once;
			return { ...normalized, fired: sameCondition ? previous.fired : false };
		});
	}
	snapshot(): WatchState[] { return this.rules.map((rule) => ({ ...rule })); }
	hasRules(): boolean { return this.rules.some((rule) => !rule.once || !rule.fired); }
	match(line: string, stream: OutputStream): { ids: string[]; level: TerminalLevel } | undefined {
		const ids: string[] = [];
		let level: TerminalLevel = "context";
		for (const rule of this.rules) {
			if (rule.once && rule.fired || rule.stream !== "both" && rule.stream !== stream || !line.includes(rule.text)) continue;
			rule.fired = true;
			ids.push(rule.id);
			level = strongerLevel(level, rule.notify ?? "turn") as TerminalLevel;
		}
		return ids.length ? { ids, level } : undefined;
	}
}

/** Separate decoders per stream: match complete raw lines before display clipping. */
export class OutputLines {
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	constructor(private readonly accept: (line: string) => void) {}
	push(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim()) this.accept(line);
		}
		if (this.buffer.length > MAX_PARTIAL_LINE_CHARS) this.buffer = this.buffer.slice(-MAX_PARTIAL_LINE_CHARS);
	}
	finish(): void {
		const line = this.buffer + this.decoder.end();
		this.buffer = "";
		if (line.trim()) this.accept(line);
	}
	clear(): void { this.buffer = ""; this.decoder = new StringDecoder("utf8"); }
}
