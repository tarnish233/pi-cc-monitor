/** Bounded cleanup for owned observation helpers only. Never accepts a runner/job PID. */
import { spawnSync, type ChildProcess } from "node:child_process";
import { isPidAlive } from "./plugin-settings.ts";

const KILL_ESCALATION_MS = 2000;
export const KILL_CONFIRMATION_MS = 1000;

/** Signal the owned process group synchronously; callers retain the cleanup handle. */
export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!child || child.pid === undefined) return;
	if (process.platform === "win32") {
		try {
			const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			if (!result.error && result.status === 0) return;
		} catch { /* fall back to the child handle */ }
	} else {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch { /* already gone, or try the direct child */ }
	}
	try { child.kill(signal); } catch { /* best effort; confirmation decides the outcome */ }
}

/** Only ESRCH proves a POSIX group gone; permission/probe failures are not success. */
export function processGroupAlive(child: ChildProcess | undefined): boolean {
	if (!child || child.pid === undefined) return false;
	if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
	return isPidAlive(child.pid, true);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupAlive(child)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		// Internal OS cleanup confirmation, not model polling. Ref'd while a stop is awaited.
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
	}
	return true;
}

/** Bound a stop attempt, then keep unconfirmed resources with the runtime's exit backstop. */
export async function stopProcessGroup(
	child: ChildProcess | undefined,
	options: { force?: boolean; graceMs?: number; confirmationMs?: number } = {},
): Promise<boolean> {
	if (!child || !processGroupAlive(child)) return true;
	killTree(child, options.force ? "SIGKILL" : "SIGTERM");
	if (!options.force && await waitForExit(child, options.graceMs ?? KILL_ESCALATION_MS)) return true;
	killTree(child, "SIGKILL");
	return waitForExit(child, options.confirmationMs ?? KILL_CONFIRMATION_MS);
}
