# omp-acceptance-workflow

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) package that checks an AI coding agent's work against acceptance checks the agent cannot edit, both while it works and when it finishes.

[中文說明](README.zh-TW.md)

## Why

When an agent says "done", that is its own claim. In one test with five tasks, two of them impossible, a model marked all five done: it rewrote the test under check so it passed, and answered the staging health check with a local server it started itself. The tests were green and the todo list was all ticks.

This package moves the decision to a spec written by whoever assigns the work, kept outside the agent's working directory:

- When the agent marks a todo item done, that item's check runs first. If it fails, the item stays open and the agent is told why.
- When the agent finishes, every check reruns with a fresh `HOME`, changed files are compared with an allowed list, and the work is returned up to N times.
- A task that cannot be done can still be closed honestly: the agent marks it blocked with the reason, and the result is `INCOMPLETE` instead of `FAIL`.

## What is in the package

| Part | File | What it does |
|---|---|---|
| Extension | `src/index.ts` (with `src/spec.ts`, `src/checks.ts`) | Per-item gate, session-end check, verdict file, refusal of calls that name the spec, output masking, `/acceptance` command |
| Skill | `skills/acceptance-workflow/SKILL.md` | The procedure for the agent: exact todo titles, a failing test first, done only when it passes, blocked with a reason when it cannot be done |
| Agent | `agents/acceptance-verifier.md` | An independent verifier to run before a pull request; its job is to refute each "done" with command output |
| CI script | `scripts/ci-check.ts` | Reruns the checks in a fresh checkout and exits 0, 1, or 2 |

## Requirements

- omp 18.2.8 or later (tested with 18.2.8)
- Bun 1.3.14 or later

## Quick start

1. Clone this repository.
2. Write a spec and keep it outside the agent's working directory, ideally where the agent's user cannot write. See [`examples/acceptance.example.json`](examples/acceptance.example.json).
3. Start omp with the package and the spec:

   ```bash
   omp -e /path/to/omp-acceptance-workflow --acceptance /path/outside/the/repo/acceptance.json
   ```

4. Assign the work through the skill, followed by the task list:

   ```text
   /skill:acceptance-workflow Track these tasks with your todo list: 1. Change port to 8080 2. Add multiply with a test ...
   ```

5. Check the result, shown to you only and never sent to the model:

   ```text
   /acceptance status
   /acceptance check
   ```

   `status` shows the verdict file; `check` reruns every check now without writing it.

Without `--acceptance`, the package loads but does nothing. If `--acceptance` names a spec that is missing, invalid, or inside the working directory, both the per-item gate and the session-end check block, and their reasons never show the spec's path.

## The spec

| Field | Required | Meaning |
|---|---|---|
| `tasks` | yes | Each task's todo title `todo` and its check command `check`. The agent's todo items must use the same titles. A check runs in the working directory and passes on exit code 0. |
| `allowedChanges` | yes | The only files the agent may change, relative to the working directory. Any other changed file is a problem. |
| `forbid` | no | Patterns that must not appear in changed allowed files: `pattern` (regex), `reason` (shown to the agent), and `files` (regex limiting which files the rule applies to). |
| `maxBlocks` | no | How many times the session-end check returns the work before letting it finish with `FAIL`. Default 3. |
| `checkTimeoutMs` | no | Time limit for each check. Default 4000. |
| `stopBudgetMs` | no | Time limit for all checks at session end. Default 25000; tasks not reached count as problems. |

## The verdict file

The package writes `<spec name>.verdict.json` next to the spec:

- `verdict`: the last session-end check — `PASS` (every check passes), `INCOMPLETE` (every failing task was marked blocked or abandoned), `FAIL` (anything else), or `UNCHECKED` (no session-end check has run).
- `claims`: each task's latest todo status, updated on every todo change.
- `stale`: `true` when the work or the todo claims changed after the last session-end check, so `verdict` no longer describes the final state.
- `trigger`: what wrote the file — `session_stop` (the session-end check), `update` (a later change), or `shutdown` (omp exiting).
- `blocks`, `checkedAt`, `tasks`, `unexpected`, `problems`: details of the last check.

omp gives an extension 2 seconds when it exits, so at shutdown the package records the final claims and `stale` without rerunning checks. A session cut off by a time limit still leaves its final state.

## Protected places and masking

- A tool call is refused when its arguments name the spec's path, the spec's folder, the verdict file, either file name, the word `allowedChanges`, or this package's folder. The package's `skills/` folder is allowed, because the skill invocation points the agent there. A folder that contains the working directory, or a shared folder such as `/`, the home folder, or the temp folder, is never treated as the spec's folder.
- Tool output that contains any of these, in any case, is replaced with a withheld notice.

## CI

Run the script at the root of a fresh checkout of the change, with the spec and the verdict file taken from a place the agent cannot edit:

```bash
bun /path/to/omp-acceptance-workflow/scripts/ci-check.ts --spec /protected/acceptance.json --base origin/main --verdict /protected/acceptance.verdict.json
```

It lists the files changed in `<base>...HEAD` (plus uncommitted and untracked files), reruns every check (60 s each by default; change it with `--timeout`), and prints a JSON report.

| Exit code | Result | When |
|---|---|---|
| 0 | `PASS` | Every check passes, and no file outside the allowed list or forbidden pattern changed |
| 2 | `INCOMPLETE` | `--verdict` is given, the verdict is not a current `FAIL`, and every failing task is blocked or abandoned in the latest claims |
| 1 | `FAIL` | A change outside the allowed list, a forbidden pattern, any other failing check, a current `FAIL` verdict, a missing verdict, or a usage or spec error |

A stale or `UNCHECKED` verdict is not a result by itself: the script's own reruns decide, and the latest claims separate `INCOMPLETE` from `FAIL`. The report's `verdictStale` field marks this case.

## Limits

- omp does not run the session-end check in subagent sessions, delays it while the agent's background jobs run, and skips it when a session is interrupted or cut off. The verdict file is then `UNCHECKED` or stale and carries only the latest claims; CI's rerun decides.
- The session-end check must answer within omp's 30-second handler budget, which is why `stopBudgetMs` exists.
- The agent's free-text report is not checked; read the verdict file.
- Checks run with your privileges, with only `HOME` replaced. The spec is trusted input from whoever assigns the work.
- This is not a sandbox. Refusal and masking match paths and strings, so globs, encoded paths, or a `cd` followed by relative paths can still reach the spec and the package. The checks run inside omp's own process, so hiding the spec completely needs a separate environment.
- Matching is literal: ordinary output or commands that happen to contain these strings are withheld or refused too.
- The skill invocation includes the skill's folder, which tells the agent where the package is. The package's code is protected by refusal and masking only.

## Evaluation

A live A/B on the five-task exercise (Composer 2.5, three runs per arm) compared this package with the two original hooks it generalizes. Both stopped faked work equally: no impossible task passed, and no todo ended "completed" on a failing check. All six runs hit the 600-second limit. The run also found four gaps; version 0.1.0 fixes two of them, the stale verdict and the masking bypass. See [`docs/evaluation.md`](docs/evaluation.md).

## Development

```bash
bun install
bun test
```

The tests load the package through omp's own extension loader, runner, and discovery, on the bundled five-task exercise in `test/fixtures/`. They make no model calls.

## License

[MIT](LICENSE)
