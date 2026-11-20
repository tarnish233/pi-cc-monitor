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

**completion**: use Monitor instead of foreground bash for long-running or externally gated commands. Start returns immediately and the command keeps running in the background; the tool result is a LAUNCH RECEIPT, not a result. After starting a completion task you MUST end your turn in the same response. Do not wait for it, do not poll, sleep, re-read its logs, or start duplicate commands to check on it. Your reply may only state what was started and that you will report when it finishes. You MUST NOT include the task's results, conclusions, scores, findings, or recommendations in this turn — they do not exist yet. If the user asked for a report or analysis, that report is produced LATER, when the completion notification arrives, never in the launch turn. stdout and stderr are only written to log files; one result arrives after the active turn: exit 0 is "completed", nonzero exit or signal is "failed". If that turn is aborted, the result is stored without restarting it. When the task ends you are notified with its exit status and log paths; only then read the required outputs/files, verify them, and write the final report. A launch receipt, a log tail, or partial output is never proof of completion. Set \`timeout_ms\` to cover the expected runtime: default ${MONITOR_TIMEOUTS.completion.defaultMs}ms (30 minutes), max ${MONITOR_TIMEOUTS.completion.maxMs}ms (2 hours). \`persistent: true\` is only for intentional session-lifetime processes, not cross-process preservation.

**events**: Each stdout line is an event. stderr is logged but is not an event; merge it with \`2>&1\` only when running the source directly. Flush every pipe stage per line: grep needs --line-buffered, Python needs -u; head cannot. Do not run the real long-lived work here—use completion plus a source observer. \`ws\` streams text frames and represents binary frames with placeholders. Events may arrive while waiting for the user; an event is not their reply.

**notification policy**: \`notify.output\` is turn/context/none and \`notify.terminal\` is turn/context (defaults turn). A watch can lower, never raise, this ceiling. User stops never start a turn. Terminal outcomes use protected settled delivery; output budgets can suppress ordinary events while raw logs stay complete. A command events source whose output stays suppressed for 30 seconds is stopped.

**update**: \`{action: "update", id, watches?, notify?}\` changes only observer watches and notification policy. It never starts/restarts work, changes source/lifetime, or resets unchanged rules. Use \`monitor_stop\` to end a subscription or the work itself; \`monitor_list\` shows status and counts.`;

export const MONITOR_PROMPT_GUIDELINES = [
	"For commands expected to run long, wait on an external condition or approach a foreground bash timeout, use Monitor with mode=\"completion\" instead of foreground bash. Use mode=\"events\" when each output line/frame should notify.",
	"A Monitor launch receipt is not a result. After starting a completion task, end your turn immediately: state only what is running and that you will report when it finishes. Never write the task's results, conclusions or recommendations in the launch turn.",
	"The final report belongs to the completion-notification turn: read and verify the required outputs/files there, then report. While a task is pending you may give progress only, never a final conclusion. Do not poll, sleep, or re-read logs to pass the time.",
	"If several tasks are pending, a finished one is partial progress, not overall completion. Report the final result only after every task the report depends on has ended and its outputs were read.",
	"Use a Monitor completion for long-lived work and an attached source observer for selected output; changing watches with action=update must not restart or stop the work.",
];

export const MONITOR_SNIPPET = "Run commands in the background with one completion notice, stream events, or attach watches to a running command";
export const MONITOR_STOP_SNIPPET = "Stop a running monitor or output subscription by id";
export const MONITOR_LIST_SNIPPET = "List monitors with their modes, status, event counts and exit codes";
