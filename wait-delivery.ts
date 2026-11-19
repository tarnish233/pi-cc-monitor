/** Model-visible wait delivery proof. Execution metadata alone contains no result. */
const MAX_PROOF_CHARS = 100_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_CANDIDATES = 32;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

/** Allow extra wrapper/debug fields, but never a missing or changed result field. */
function containsResult(actual: unknown, expected: unknown): boolean {
	if (actual === expected) return true;
	if (Array.isArray(expected)) {
		return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => containsResult(actual[index], value));
	}
	if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object" || Array.isArray(actual)) return false;
	return Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && containsResult((actual as Record<string, unknown>)[key], value));
}

/** Accept the complete emitted receipt, or an intact JSON result inside normal
 * codemode text/return output (including pretty JSON and wrapper objects).
 * The scan is bounded, quote-aware and conservative when output was truncated. */
export function isWaitResultVisible(content: unknown, expectedJson?: string, expectedText?: string): boolean {
	const text = contentText(content);
	if (!text || text.length > MAX_PROOF_CHARS) return false;
	if (expectedText && text.includes(expectedText)) return true;
	if (!expectedJson) return false;
	let expected: { action?: string; waitId?: string };
	try { expected = JSON.parse(expectedJson); } catch { return false; }
	if (!expected || typeof expected !== "object" || expected.action !== "wait" || typeof expected.waitId !== "string") return false;
	const marker = JSON.stringify(expected.waitId);
	let nextMarker = text.indexOf(marker);
	if (nextMarker < 0) return false;
	const stack: { start: number; kind: "{" | "["; hasMarker: boolean }[] = [];
	let quoted = false, escaped = false, candidates = 0;
	for (let index = 0; index < text.length; index++) {
		if (index === nextMarker) {
			if (stack.length) stack[stack.length - 1]!.hasMarker = true;
			nextMarker = text.indexOf(marker, index + marker.length);
		}
		const char = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"' && stack.length) { quoted = true; continue; }
		if (char === "{" || char === "[") {
			if (stack.length >= MAX_JSON_DEPTH) return false;
			stack.push({ start: index, kind: char, hasMarker: false });
		} else if ((char === "}" || char === "]") && stack.length) {
			const frame = stack.pop()!;
			if (frame.kind !== (char === "}" ? "{" : "[")) { stack.length = 0; continue; }
			if (!frame.hasMarker) continue;
			if (stack.length) stack[stack.length - 1]!.hasMarker = true;
			if (frame.kind !== "{") continue;
			if (++candidates > MAX_JSON_CANDIDATES) return false;
			try {
				const value = JSON.parse(text.slice(frame.start, index + 1));
				if (value?.action === "wait" && value.waitId === expected.waitId && containsResult(value, expected)) return true;
			} catch { /* Not a complete JSON object; keep looking without guessing. */ }
		}
	}
	return false;
}
