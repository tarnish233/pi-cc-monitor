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
import fs from "node:fs";

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
	onStdout: (chunk: Buffer) => void;
	onStderr: (chunk: Buffer) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError: (error: Error) => void;
}

/** Keep the existing polite-stop grace; confirmation has its own short bound. */
export const KILL_ESCALATION_MS = 2000;
export const KILL_CONFIRMATION_MS = 1000;

export function spawnMonitor(options: SpawnOptions): ChildProcess {
	const stdoutStream = fs.createWriteStream(options.stdoutPath, { flags: "a", mode: 0o600 });
	const stderrStream = fs.createWriteStream(options.stderrPath, { flags: "a", mode: 0o600 });
	// The logs are a copy for the read tool; losing them (a full disk, a deleted
	// temp dir, too many open files) must not end the watch. A stream "error"
	// without a listener is an uncaught exception, and Pi exits on those.
	stdoutStream.on("error", () => {});
	stderrStream.on("error", () => {});

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
	// "close" fires after the process exited *and* its stdio streams are
	// closed. "exit" can fire while stdout is still buffered, which would report
	// the end of the watch before the last lines were delivered. But "close" is
	// still not the end of the copy: the piped WriteStreams can hold queued
	// writes, and a tail read at that moment would present mid-stream output as
	// final. End both log streams first, then report the exit only once each has
	// finished flushing. `finished` settles however a stream ends — flushed,
	// errored (the error listeners above keep that from crashing Pi) or
	// destroyed — so a write error cannot crash Pi or suppress the result by
	// itself, and the callback still fires exactly once after both streams settle.
	child.on("close", (code, signal) => {
		stdoutStream.end();
		stderrStream.end();
		Promise.allSettled([finished(stdoutStream), finished(stderrStream)]).then(() => {
			options.onExit(code, signal);
		});
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
