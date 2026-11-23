# Changelog — pi-cc-monitor

## [Unreleased]

## [0.14.2] - 2026-11-23

### Fixed
- Clear notification hover before native input dispatch without replacing ccstyle's viewport handler; preserve clicks, scrolling, focus-loss cleanup and reloads.
- Trim a copy of Pi's cached settings rows, fixing the readonly-array type error and preventing render-cache mutation.

### Changed
- Synchronize stable shared settings and current message/key descriptions; leave unfinished custom action pages out of the release.
- Require tests and typechecking against Pi 1.6.0 in a read-only validation job before trusted npm publishing.

## [0.14.1] - 2026-11-23

### Fixed
- An expanded card taller than the fullscreen viewport made Pi's alternate screen fall back to a full redraw on every frame, and the card's background then painted the whole screen green. The expansion is now capped at 60% of the viewport height and 24 rows, ending with `… +N more rows · see /tasks`; the full output stays in the log path and in `/tasks`.
- The hover wrapper was lost by every `/reload`: the new session installs it in `session_start`, then the old session's `session_shutdown` restores the original method, and both run against the same module state. Every hint the pointer had crossed stayed lit. The next render now re-arms it.

## [0.14.0] - 2026-11-23

### Changed
- Redraw the asynchronous card in Claude Code's notification shape: a status icon, a Title Case label, and one collapsed line. The icon is a pure function of the card's tone, and process and outcome are told apart: `✓` completed, `✗` failed, `⚠` timeout/flood, `✻` (accent) an in-progress event batch, `■` (violet) a neutral outcome (manual stop, terminated command, closed socket). The title carries the same colour as its icon, so an outcome is readable without parsing the label. The violet comes from `syntaxFunction`, the only distinct non-status hue pi-cc's dark theme exposes; a theme that leaves it undefined falls back to `accent`. Every card collapses to that single row, event batches included: the output is one click or one Ctrl+O away, and Ctrl+O expands every card at once, so a preview row costs more than it buys.
- Replace the flat identity line with a tool-card background and a `├`/`│`/`└` section tree on expansion: `Description`, `Status`, `Source`, `Events`, `Output`, `Command`, `Socket`, `Limits`, `Logs`, `Loop`, each only when the payload has it. Every field the old card showed is still reachable.
- Adapt the expand affordance to the host screen through native interfaces only: the fullscreen alt screen says `click to show more` and toggles on a left click (`Component.handleMouse`, whose handled result already asks the host to render); the regular screen says `ctrl+o to show more` from `options.keyHint("app.tools.expand", …)` because it delivers no mouse events. Ctrl+O still goes through the host's own `CustomMessageComponent.setExpanded`. Click state is remembered per message, so a rebuild does not reset it, and a host expand discards it. The hover highlight is driven the way pi-cc-extensions drives its own: intercepting the fullscreen viewport input, because Pi only delivers `move` to the component under the pointer and a card never learns that the pointer left. SGR parsing is a copy of pi-cc-extensions' (MIT); the packages stay independent.
- A neutral card expands on the pending background, not the success one: `■ Monitor Stopped` on a green card read as a win.
- Protocol notices (`[Monitor stopped]`, the "source command was not stopped" caveat) moved from `Output` to `Status`. They describe the monitor, not captured output.
### Fixed
- An events-mode watcher whose command exited 0 was drawn as a neutral square while the same exit 0 in completion mode was a green check. The exit code is now the verdict in both modes: `✓` for 0, `⚠` for a non-zero watcher exit (the monitor did not fail), `✗` for a failed completion. `■` is reserved for cards with no verdict at all: a manual stop, a closed socket, a signal (`exitCode === null`).
- An unconfirmed stop (`stop_timeout`) is a failure, not a warning: the label already says "Stop Failed" and the resource is still alive, so it now uses `✗` and the error colour, matching the `isError` result `monitor_stop` returns.
- The legacy padded card (`compactMessages` off) printed the identity line twice: once from the body and once from the new `Status` section.
- The hint highlight could outlive the pointer: expanding and collapsing the card, or scrolling the transcript, left it lit. A click now clears it, and a wheel tick is treated like motion.
- The expand hint no longer rescans keystrokes for SGR mouse packets.
### Removed
- The unused `renderBlock` helper in the shared `render.ts`.

## [0.13.1] - 2026-11-20

### Fixed
- Deliver protected completion and events terminal outcomes at the next successful response/tool-batch boundary instead of waiting for the entire agent run to settle. Pi's context-only append lane keeps them outside Esc-clearable queues; turn-level outcomes request at most one continuation, while context-only outcomes never do.
- Preserve interrupted/error response fallback, idle wakeups, manual compaction, cancelled navigation, loop-stop silence and resource cleanup; a handled boundary outcome does not wake a second run after final settlement.

### Changed
- Align completion guidance with safe-boundary delivery: continue independent work, hand off when only waiting, and verify required results before reporting. A launch receipt is not a result, and a completion notification no longer unconditionally demands the overall final report. Keep the five static guidelines and no polling/sleep discipline.

## [0.13.0] - 2026-11-20

### Removed
- Revert the 0.12.0 `Monitor({ action: "wait" })` closeout join and all of its delivery-proof machinery. Models used it to block the launch turn right after starting background work, which defeated the purpose of Monitor. start/update, monitor_stop and monitor_list are back to the 0.11.2 behavior.

### Changed
- Prompt-only reporting contract for completion tasks. The launch receipt now unconditionally requires ending the turn with a short "started, will report" message and forbids results, conclusions or estimates in the launch turn (previously only "end your turn if you are only waiting").
- The tool description and static guidelines state the same two-turn rule, and add that one finished task out of several pending ones is partial progress, not overall completion.
- The terminal completion notice now explicitly triggers the reporting step: read and verify the required outputs/files, then write the final report; nonzero exits or missing outputs must be reported honestly, and the log tail is not verification.

## [0.12.0] - 2026-11-19

### Added
- `Monitor({ action: "wait", ids, wait_timeout_ms? })` joins explicit command/completion dependencies at report closeout while start remains asynchronous. Return each task's real outcome, bounded log tails and complete paths; a separate wait budget/cancellation never stops work.

### Fixed
- Deduplicate waited terminal notices only after the complete receipt or intact JSON result reaches persisted model-visible output; execution-only nested metadata, ignored/modified/truncated results and failed parents retain the protected outbox. Fresh UUIDs and immutable payload snapshots reject old receipts even when call IDs are reused.
- Preserve terminal cause, signals and bounded infrastructure errors in wait/list results, including failures with empty stderr.
- Skip conversation-history scanning on the ordinary no-wait notification path, and remove eager per-wait history copies.
- Give running persistent commands their own start guidance rather than asking the model to wait on an unsupported target.
- Distinguish launch/progress handoffs from completed final reports in static guidelines and receipts; require necessary output/file verification after waiting.

## [0.11.2] - 2026-11-18

### Fixed
- Ignore late command-exit resource probes once ownership was confirmed released, while retaining exit-code correction and cleanup of still-owned background groups.
- Recover terminal results stranded by cancelled/failed tree navigation using a pending-only idle fallback that stores them context-only, without restarting an interrupted run.
- Bound pending event text before flushing, keep complete event counts, and detach retained prefixes from giant source-string backing storage.
- Keep partial-line tail clipping from producing an orphan low surrogate in direct output and source observers.
- Make shared settings-panel save errors nonfatal and preserve unreadable settings; fit long/wide task-detail labels without losing value text.
- Report late log-write failures truthfully after a watch has already ended rather than claiming it still observes.

### Changed
- Cap WebSocket queued log writes at 4 MiB. On backlog overflow or write failure, stop logging but keep the socket/event stream, expose logError/log-incomplete markers, and send one context-only infrastructure warning even when ordinary output is muted. Healthy logs still flush on close.
- Consolidate the protected terminal outbox and its policy, remove redundant footer/terminal/degradation state and the duplicate empty-list branch, and avoid constructing discarded event prefixes.
- Document the conservative context-only idle fallback, log degradation and current Pi 1.5.2 validation; add real-navigation, blocked-Writable and memory-bound regression tests.

## [0.11.1] - 2026-11-18

### Fixed
- `monitor_stop` reports the record's real status instead of always claiming `stop_timeout`, so it agrees with `monitor_list` when a command exited but a background process group is still alive.
- Stop polling an unkillable resource once the session is disposed, and disarm source-observer timeout and batch timers during shutdown.
- Reject carriage returns in a command, which could overwrite earlier text in the approval dialog.
- `/tasks`: keep Detail/Stop clickable when a long "new task" announcement is shown, drop invisible hit regions in the single-line layout, repaint after a scrollbar press so clicks match the painted frame, and ignore presses on a one-row scrollbar instead of jumping back to the top.
- `/tasks`: always offer a mouse Back/Close when the title control is unavailable — short terminals, narrow frames, and the status line shown after a stop.
- Log tails no longer discard a complete first line when the byte limit lands exactly on a line boundary.

## [0.11.0] - 2026-11-17

### Added
- Support native mouse navigation throughout `/tasks`: clickable tabs/tasks/actions, single-click selection, double-click details, draggable scrollbars, visible scroll ranges, and source-group collapse/expand with mouse or arrow keys.

### Changed
- Show task root groups and siblings newest-first by their creation timestamps, including mixed-provider All views, while retaining source grouping and stable selection on refresh.

### Fixed
- Handle Pi's native wheel/trackpad input in task lists and details using live viewport bounds. Contain scrolling at either end and during stop confirmation so the underlying transcript never moves.
- Make long stop-scope explanations scrollable while Cancel/Stop remain visible; repeated mouse clicks cannot reuse a dismissed confirmation or stop a task twice.

## [0.10.0] - 2026-11-14

### Added
- Retain at most 50 delivered, resource-released terminal Monitor records. Active work, pending outcomes, cleanup and referenced sources are never evicted.

### Changed
- Shorten the Monitor tool description while preserving mode selection, waiting discipline and observer ownership. Omitted mode remains `events` for backward compatibility.
- Simplify shared task/settings UI: a sole provider gets one named tab, settings show only loaded-package pages, unchanged logs are cached across clock refreshes, and long log lines wrap for scrolling.
- Scope `/pi_cc` ownership and capabilities to each Pi runtime so independent sessions no longer suppress one another; retain text-command preconfiguration and mixed-version compatibility.

### Fixed
- Keep blank WebSocket text frames in raw logs without turning them into events or consuming notification budgets.
- Cap completion notification headers, including long Unicode descriptions, without changing raw metadata or the independent completion log-tail budget.
- Add a bounded fallback when a descendant holds stdout/stderr after its parent exits: prefer normal close/flush, then detach stale pipes after five seconds, flush queued writes once and continue process-group cleanup.

## [0.9.0] - 2026-11-14

### Added
- TUI role vocabulary (`task` / `watcher` / `socket` / `subscription`), factual start/update/stop receipts, and compact role/source snapshots; all existing structured output fields are preserved.
- Transparent `✻ monitor` asynchronous cards with visible identity/source relation, two physical output rows, semantic outcome colors, real stderr-first failure previews and complete expansion; raw logs and model-facing asynchronous content are unchanged.
- Real-source task/subscription grouping, semantic Monitor detail sections, and wrapped resource-specific local stop confirmation in the shared task overlay. Flat Loop providers, selection identity, runtime isolation, existing panel theme/limits and no-turn UI behavior are preserved.
- `Monitor.mode`: `completion` runs a command in the background, keeps stdout/stderr in log files and sends one terminal result (exit 0 → completed, nonzero/signal → failed) with a bounded output tail and full log paths; `events` preserves the per-line/WebSocket notification stream. Omitted mode remains `events` for backward compatibility.
- `Monitor({ source: { monitorId } })`: an events observer subscribes to an existing running command's future stdout/stderr without another process. Stopping, expiring, flooding or muting the observer never stops or restarts the work; the source result remains authoritative.
- Literal `watches` for source observers: stable ids, stream selection, once/repeat, independent turn/context levels, atomic updates, and unchanged-rule trigger state on `action=update`. `watches: []` mutes; omitted rules observe stdout.
- `notify.output` (turn/context/none) and `notify.terminal` (turn/context), defaults `turn`. A watch may lower output within the Monitor ceiling, never raise or bypass a `context`/`none` policy or hide failures. Explicit user stops are context-only.
- Completion gets its own deadlines: `timeout_ms` defaults to 1800000ms (30 minutes) with a 7200000ms (2 hours) maximum, and its timeout notice names the background time limit instead of `monitor expired`. Events keeps 300000ms/3600000ms. `persistent` remains an intentional session-lifetime flag, not cross-process preservation.
- Route long commands and one-shot waits away from foreground Bash through explicit model-facing selection guidance and static tool `promptGuidelines`; no dynamic prompt hook is registered. Completion results follow the active turn; event notifications retain immediate steer delivery.
- Expose the selected mode in launch results, `monitor_list`, notification metadata and `/tasks`, with codemode schemas and real-process coverage for quiet logging, exit codes and timeouts.

### Fixed
- Preserve the not-yet-sent final batch and combine it with the exit/timeout/stop result, instead of losing up to one 200ms batch when a monitor ends.
- Stop now reports `stopping`, then attempts bounded SIGTERM→SIGKILL cleanup and only reports `stopped` after the owned process group disappears. An unconfirmed stop remains `stop_timeout`, listed and retryable; natural `exited` is a logical outcome while real resources remain tracked until gone.
- Orderly shutdown and abrupt Pi exit synchronously SIGKILL all still-live owned groups; the exit hook stays installed until every resource is released, so a TERM-ignoring child cannot outlive the session.
- Critical events-mode terminal notices use the protected completion outbox, so Esc/queue clearing cannot discard the sole outcome; they are context-only when the interrupted turn must not restart.

### Changed
- Preserve a complete flat task-detail fallback for older Loop-owned panels; newer panels prefer semantic sections without duplicating the fallback rows.
- Highlight normal manual stops and ordinary source endings with the theme accent color in asynchronous cards and the task panel, instead of low-contrast muted/dim text. Success, failure and abnormal-ending colors keep their existing priority.
- Tool calls and results are rendered by Pi or `pi-cc-extensions`; this package does not register tool renderers, require `excludeRenderers`, or ask users to turn ccstyle off. Only asynchronous Monitor notifications use the custom `✻ monitor` event cards.
- Add a session-wide fixed output window (20 messages/minute). Excess output is counted, visible in `monitor_list`, summarized without starting a turn, and never stops work; terminal results do not consume it, and the accounting summary does not need an output slot. Per-Monitor source rate limiting remains.
- `action=update` amends only notification policy on a running Monitor and watches on an attached source observer; command/source/lifetime fields are refused, an unknown id never falls back to starting work, and changing policy discards only unpublished buffered notification data, not raw logs.
- Preserve the ending of huge newline-terminated log lines, report per-line clipping truthfully, and keep model-facing tails free of TUI ANSI sequences.
- Isolate logs in private runtime directories and clean only validated closed/dead owners after three days of last activity; never delete quiet live-owner or unowned legacy logs.
- Unwind WebSocket log initialization failures to a failed record, and close an allocated descriptor on synchronous stream-construction errors.
- Include truncation markers inside event line/batch length budgets without splitting surrogate pairs.
- Bound the final events message after composing its header and rate-suppression notice, so the entire content stays within 3000 characters. Keep content and output metadata on the same clipped lines; completion tails and raw logs are unchanged.
- Sanitize and flatten every model-facing notification header, including completion descriptions, while keeping the original description in metadata.

- Keep the retired Background integration out of shared settings and task panels; task code covers Monitor/Loop only.
- Share a small Node-only log-tail helper between the task overlay and completion notices.
- Use portable Pi/TypeScript discovery for type checking and give each test worker an isolated temp/log namespace.
- Trimmed the Monitor tool description to a concise mode-selection contract (one completion vs. one notification per occurrence, per-mode timeouts, waiting discipline, events filter/batching rules): the CC-style scripting essay and duplicated examples are gone. `promptGuidelines` stays three static mode-selection/waiting/update entries; deadline numbers are shared with the runtime rather than duplicated there.
- Generate task-panel tabs from loaded providers so Monitor and Loop share one overlay without empty tabs for packages that are not installed.
- Use CC-style count-first footer labels: `1 monitor` / `2 monitors`, aligned with `1 loop` / `2 loops`.

## [0.8.0] - 2026-11-10

### Added
- Shared native Monitor/Loop task overlay with All, Monitor and Loop tabs, live task details, bounded sanitized stdout/stderr tails, and locally confirmed stop actions. Ended monitor records remain available for inspection.
- A compact themed task card with solid backgrounds, selection/tab highlighting, responsive terminal resizing and keyboard navigation. Opening, refreshing and closing the panel never starts a model turn or changes the tool set.
- Task-panel regression coverage for standalone use, shared event buses, runtime isolation, log inspection, stop actions and non-TUI behavior.

### Changed
- Register exactly one task-panel command after startup discovery: `/tasks` when the name is free, otherwise `/cc-tasks` when already-loaded extension commands or prompt templates own it. No unconditional alias or legacy underscore entry is registered.
- Share one panel registry with pi-cc-loop in the same runtime while keeping independent sessions isolated. Reload closes the old overlay and reevaluates command ownership.
- Task details distinguish running WebSockets, ended monitors and configured timeouts accurately; stopping from the panel reuses the normal monitor lifecycle rather than aborting the main agent.

## [0.7.9] - 2026-11-03

### Changed
- Tool-schema tests use the installed Pi's real `validateToolArguments`, with TypeBox on older releases and `pi-schema` on Pi 1.5.0. They strictly check complete coerced arguments, Pi's rejection messages, JSON-visible data, and symbol metadata, and run in isolated single-release installations.
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
