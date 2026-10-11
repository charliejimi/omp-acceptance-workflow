# Changelog

## [0.1.0] - 2026-10-11

### Added

- Per-item gate: a todo marked done must pass its acceptance check, with no change outside the allowed list or forbidden pattern in allowed files.
- Session-end check: reruns every check with a fresh `HOME` inside a time budget, compares changed files, and returns the work up to `maxBlocks` times.
- Verdict file next to the spec, with the last check's result, each task's latest todo status, and a `stale` flag that is written on every later change and at omp shutdown.
- Refusal of tool calls that name the spec, its folder, the verdict file, or the package folder (except `skills/`), and case-insensitive masking of tool output that shows them.
- `/acceptance status` and `/acceptance check`, shown to the user only.
- The `acceptance-workflow` skill and the `acceptance-verifier` agent.
- `scripts/ci-check.ts`: reruns the checks in a fresh checkout and exits 0 (`PASS`), 2 (`INCOMPLETE`), or 1 (`FAIL`); a stale verdict defers to the reruns and the latest claims.
- Tests through omp's extension loader, runner, and discovery on a bundled five-task exercise.
