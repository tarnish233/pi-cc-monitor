/**
 * Process handling for command monitors.
 *
 * A monitor runs detached so it gets its own process group. Stopping it must
 * take the whole group down, otherwise a script that backgrounds children
 * leaves orphans behind. This mirrors what Claude Code does when it kills a
 * monitor.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { finished } from "node:stream/promises";
import { createBoundedLog } from "./bounded-log.ts";

export interface SpawnOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: string;
	shellArgs: string[];
	/** "argv" runs `shell <args> <command>`, "stdin" pipes the command in. */
	commandTransport: "argv" | "stdin";
	stdoutPath: string;
	stderrPath: string;
	/** Combined stdout/stderr disk limit, including rotation archives. */
	maxLogBytes?: number;
	onLogTruncated?: () => void;
	onLogError?: (error: Error) => void;
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError: (error: Error) => void;
	/** Bound a stuck stdio close after the process exit; tests may shorten it. */
	exitGraceMs?: number;
}

/** Keep the existing polite-stop grace; confirmation has its own short bound. */
export const KILL_ESCALATION_MS = 2000;
export const KILL_CONFIRMATION_MS = 1000;
/** A descendant can hold the parent's pipes after the parent itself exited. */
export const EXIT_STDIO_GRACE_MS = 5000;

export function spawnMonitor(options: SpawnOptions): ChildProcess {
	const maxBytes = Math.max(2, Math.floor((options.maxLogBytes ?? 20 * 1024 * 1024) / 2));
	const stdoutStream = createBoundedLog(options.stdoutPath, { maxBytes, onTruncate: options.onLogTruncated });
	const stderrStream = createBoundedLog(options.stderrPath, { maxBytes, onTruncate: options.onLogTruncated });
	// The logs are a copy for the read tool; losing them (a full disk, a deleted
	// temp dir, too many open files) must not end the watch. A stream "error"
	// without a listener is an uncaught exception, and Pi exits on those.
	const logError = (error: Error) => { try { options.onLogError?.(error); } catch { /* logging cannot fail the process */ } };
	stdoutStream.on("error", logError);
	stderrStream.on("error", logError);

	const useStdin = options.commandTransport === "stdin";
	let child: ChildProcess;
	try {
		child = spawn(options.shell, useStdin ? options.shellArgs : [...options.shellArgs, options.command], {
			cwd: options.cwd,
			env: options.env,
			// detached gives the child its own process group, so the whole tree can
			// be signalled with a negative pid.
			detached: process.platform !== "win32",
			// stdout and stderr stay piped: event watches consume stdout, and
			// both streams are always copied to their output files.
			stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		// Nothing will ever close the logs if the process never started.
		stdoutStream.end();
		stderrStream.end();
		throw error;
	}

	if (useStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.command);
	}

	child.stdout?.pipe(stdoutStream);
	child.stderr?.pipe(stderrStream);
	child.stdout?.on("data", options.onStdout);
	child.stderr?.on("data", options.onStderr);
	child.on("error", (error) => options.onError(error));
	// "close" is the preferred path: the process exited and its stdio closed,
	// so ending and flushing both logs preserves every final line. A descendant
	// can inherit those pipes and prevent "close" forever, however. In that case
	// the earlier "exit" starts a bounded fallback: detach the inherited pipes,
	// flush writes already queued, and let the owner clean up its process group.
	let finalizing = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	const finish = (code: number | null, signal: NodeJS.Signals | null, stuckPipes: boolean) => {
		if (finalizing) return;
		finalizing = true;
		if (exitTimer) clearTimeout(exitTimer);
		exitTimer = undefined;
		if (stuckPipes) {
			child.stdout?.unpipe(stdoutStream);
			child.stderr?.unpipe(stderrStream);
		}
		stdoutStream.end();
		stderrStream.end();
		// `finished` settles on flush, error or destroy; log failures still cannot
		// crash Pi or suppress the process result by themselves.
		void Promise.allSettled([finished(stdoutStream), finished(stderrStream)]).then(() => {
			options.onExit(code, signal);
		});
	};
	child.on("close", (code, signal) => finish(code, signal, false));
	child.on("exit", (code, signal) => {
		if (finalizing) return;
		const grace = options.exitGraceMs ?? EXIT_STDIO_GRACE_MS;
		if (grace <= 0) {
			finish(code, signal, true);
			return;
		}
		exitTimer = setTimeout(() => finish(code, signal, true), grace);
		exitTimer.unref?.();
	});

	return child;
}

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
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
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
