# Changelog — pi-cc-monitor

## [Unreleased]

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
