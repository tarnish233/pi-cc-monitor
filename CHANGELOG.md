# Changelog — pi-cc-monitor

## [Unreleased]

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
