/**
 * Model-facing text for the monitor tools.
 *
 * Selection rule (from Claude Code 2.1.318): one completion uses a background
 * command; repeated occurrences use the event stream. This extension combines
 * both into Monitor.mode; the default stays events for backward compatibility.
 * Keep the selection guidance concise and share deadlines with the runtime.
 */

export const MONITOR_TIMEOUTS = {
	events: { defaultMs: 300_000, maxMs: 3_600_000 },
	completion: { defaultMs: 1_800_000, maxMs: 7_200_000 },
} as const;

export const MONITOR_DESCRIPTION = `Run a background command, stream command/WebSocket events, or observe selected output from an existing command Monitor. Choose by notification shape:
- **One terminal result** → \`mode: "completion"\`. Use this for builds, tests, and commands that pend or wait for an external condition (for example, \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`).
- **One notification per occurrence** → \`mode: "events"\` with \`tail -f\`, \`inotifywait -m\`, or a loop that prints one line per occurrence.
- **Selected output from running work** → start once with \`mode: "completion"\`, then attach an events observer using \`source: { monitorId }\` and optional literal \`watches\`. The observer owns no process; stopping, expiring or flooding it never stops the work. Omitted watches mean all stdout; \`watches: []\` mutes.
Omitted mode stays \`events\` for backward compatibility.

**completion**: use Monitor instead of foreground bash for long-running or externally gated commands. Start returns immediately and the command keeps running in the background; the tool result is a LAUNCH RECEIPT, not a result. Continue independent work. If only waiting for Monitor, end your turn with a short message saying what is running and that you will report when it finishes. Do not poll, sleep, re-read its logs, or start duplicate commands merely to wait. Do not claim this task's results, conclusions, scores, findings, or recommendations while it is pending. stdout and stderr are only written to log files; one result arrives at the next response/tool-batch boundary, before the next model request, or from idle. It does not interrupt the current response or tool batch. Exit 0 is "completed", nonzero exit or signal is "failed". If the current response is aborted, the result is stored without restarting it. When notified with its exit status and log paths, read and verify the required outputs/files before using the result. Continue necessary independent work; a completed task is not automatically a finished report. Write the final report only after all results it needs have been obtained and verified. Unrelated background tasks do not delay other answers. A launch receipt, a log tail, or partial output is never proof of completion. Set \`timeout_ms\` to cover the expected runtime: default ${MONITOR_TIMEOUTS.completion.defaultMs}ms (30 minutes), max ${MONITOR_TIMEOUTS.completion.maxMs}ms (2 hours). \`persistent: true\` is only for intentional session-lifetime processes, not cross-process preservation.

**events**: Each stdout line is an event. stderr is logged but is not an event; merge it with \`2>&1\` only when running the source directly. Flush every pipe stage per line: grep needs --line-buffered, Python needs -u; head cannot. Do not run the real long-lived work here—use completion plus a source observer. \`ws\` streams text frames and represents binary frames with placeholders. Events may arrive while waiting for the user; an event is not their reply.

**notification policy**: \`notify.output\` is turn/context/none (defaults turn) and applies only to live events. Do not pass \`notify.terminal\`: end, failure and stop always wake the model, and that cannot be chosen at start. A watch can lower live output, never raise it. Terminal outcomes stay protected until a safe response/tool-batch boundary or idle; an interrupted agent reply is not restarted, but a task that ends after that still wakes from idle. Output budgets can suppress ordinary events without changing disk logging. Disk logs have independent rotation limits; logTruncated means older output was discarded. A command events source whose output stays suppressed for 30 seconds is stopped.

**artifacts**: Logs and disposable helper files are stored in private owned directories. The launch receipt includes artifactDir, logLimitBytes, outputArchivePath and stderrArchivePath. Commands can put disposable scripts/intermediate results in $PI_MONITOR_ARTIFACT_DIR without changing the project cwd. Read a .1 archive before its current log when present; logTruncated means even these retained segments are not the full output. Keep formal outputs outside artifactDir. Delivered, resource-free, unreferenced task artifacts get a 10-minute read grace, then may be reclaimed by retention or quota; never assume paths exist indefinitely.

**update**: \`{action: "update", id, watches?, notify?}\` changes only observer watches and notification policy. It never starts/restarts work, changes source/lifetime, or resets unchanged rules. Use \`monitor_stop\` to end a subscription or the work itself; \`monitor_list\` shows status and counts.`;

export const MONITOR_PROMPT_GUIDELINES = [
	"For commands expected to run long, wait on an external condition or approach a foreground bash timeout, use Monitor with mode=\"completion\" instead of foreground bash. Use mode=\"events\" when each output line/frame should notify.",
	"A Monitor launch receipt is not a result. Continue independent work; if only waiting for Monitor, end your turn with a short started/will-report message. Never write a pending task's results, conclusions or recommendations as obtained. Unrelated background tasks do not delay other answers.",
	"Monitor completion notifications arrive at safe response/tool-batch boundaries, not by interrupting active work. Read and verify the required outputs/files before using the result; a notification does not require immediately finishing the overall report. Do not poll, sleep, or re-read logs to pass the time.",
	"If several tasks are pending, a finished one is partial progress, not overall completion. Report the final result only after every task the report depends on has ended and its outputs were read.",
	"Use a Monitor completion for long-lived work and an attached source observer for selected output; changing watches with action=update must not restart or stop the work.",
	"Put Monitor disposable helper scripts and intermediate outputs in $PI_MONITOR_ARTIFACT_DIR (artifactDir in the receipt), not arbitrary loose /tmp files. Keep formal outputs elsewhere. Logs are bounded: read .1 archives before current segments when present, honor logTruncated, and do not claim truncated logs are complete.",
];

export const MONITOR_SNIPPET = "Run commands in the background with one completion notice, stream events, or attach watches to a running command";
export const MONITOR_STOP_SNIPPET = "Stop a running monitor or output subscription by id";
export const MONITOR_LIST_SNIPPET = "List monitors with their modes, status, event counts and exit codes";
