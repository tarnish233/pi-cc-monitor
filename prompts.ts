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

export const MONITOR_DESCRIPTION = `Run a shell command in the background without blocking, watch a command/WebSocket for events, or attach literal watches to an existing command Monitor. Pick the mode by how many notifications you need:
- **One terminal notification** ("tell me when the build finishes / the server is ready") → \`mode: "completion"\` with a command that exits when done, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`.
- **One per occurrence** ("tell me every time an ERROR line appears") → \`mode: "events"\` with \`tail -f\`, \`inotifywait -m\` or a poll loop that emits one line per occurrence.
- **Selected output of a running command** → start the work once with \`mode: "completion"\`, then attach an events observer with \`source: { monitorId }\` and optional literal \`watches\`. The observer owns no process; stopping, expiring or flooding it never stops the work. No rules means all stdout; \`watches: []\` mutes.
Omitted mode stays \`events\` for backward compatibility.

**completion**: for any command expected to run long, pend, or wait on an external condition, use Monitor with \`mode: "completion"\` instead of foreground bash. It returns immediately; keep working or end your turn, and the result arrives after the active turn. If that turn is aborted, the result is stored without restarting it. stdout and stderr are only written to log files — output lines never wake you. Exit 0 reports "completed", nonzero exit or signal "failed". Set \`timeout_ms\` to cover the expected runtime: default ${MONITOR_TIMEOUTS.completion.defaultMs}ms (30 minutes), max ${MONITOR_TIMEOUTS.completion.maxMs}ms (2 hours). While waiting, do not poll, sleep, or re-read the logs. \`persistent: true\` is for intentional session-lifetime processes only, not cross-process preservation.

**events (command)**: the script's stdout is the event stream. Each stdout line is an event. stderr is logged but is not an event; merge it with \`2>&1\` only when the source really is being run directly. Every pipe stage must flush per line: grep needs --line-buffered, Python needs -u; head cannot. Don't run the real long-lived work in an events command: a deadline or sustained flood stops that source. Use completion plus a source observer instead. \`ws\` opens a WebSocket and streams text frames; binary frames become placeholders. Events may arrive while you are waiting for the user — an event is not their reply.

**notification policy**: \`notify.output\` is turn/context/none and \`notify.terminal\` is turn/context (defaults turn). A watch's own level can lower output within this policy but never raise it above the Monitor ceiling. User stops never start a turn. Events-mode terminal outcomes use the same protected settled delivery as completion; per-event output can still be suppressed by the per-Monitor and session-wide budgets while raw logs stay complete. Budget summaries are context-only and do not consume output slots. Lines within 200ms are batched; each Monitor has a burst of 10 notifications then one per 2 seconds, and a command events source whose output stays suppressed for 30 seconds is stopped. Complete events text is at most 3000 characters including its header/notices (500/line). Terminal output is merged with the not-yet-sent final batch.

**update**: \`{action: "update", id, watches?, notify?}\` changes only watches (on an attached source observer) and notification policy. It never starts work, changes command/source/lifetime, or resets a rule whose id and conditions are unchanged. Use \`monitor_stop\` to end a subscription or the work itself. \`monitor_list\` shows status and counts.`;

export const MONITOR_PROMPT_GUIDELINES = [
	"For commands expected to run long, wait on an external condition or approach a foreground bash timeout, use Monitor with mode=\"completion\" instead of foreground bash. Use mode=\"events\" when each output line/frame should notify.",
	"If the only work left is waiting for Monitor, end your turn now: it will notify you. Do not poll, sleep or re-read its logs unless the user asks for progress or you need an output line to continue.",
	"Use a Monitor completion for long-lived work and an attached source observer for selected output; changing watches with action=update must not restart or stop the work.",
];

export const MONITOR_SNIPPET = "Run commands in the background with one completion notice, stream events, or attach watches to a running command";
export const MONITOR_STOP_SNIPPET = "Stop a running monitor or output subscription by id";
export const MONITOR_LIST_SNIPPET = "List monitors with their modes, status, event counts and exit codes";
