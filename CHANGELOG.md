# Changelog — pi-cc-monitor

## [Unreleased]

## [0.7.9] - 2026-11-03

### Changed
- Tool-schema tests use the installed Pi's real `validateToolArguments`, with TypeBox on older releases and `pi-schema` on Pi 1.5.0. They strictly check complete coerced arguments, Pi's rejection messages, JSON-visible data, and symbol metadata, and run in isolated single-release installations.
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
